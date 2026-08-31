'use strict';
// MCP tool definitions.
//
// Two rules hold across every entry here:
//
//   1. ANNOTATIONS AND outputSchema ON EVERY TOOL. The spec's default for an
//      un-annotated tool is `readOnlyHint: false` + `destructiveHint: true`, so
//      an unannotated read tool reads as dangerous to the host and a genuinely
//      destructive one is indistinguishable from it. A host cannot make a
//      sensible auto-approve decision about either.
//   2. EVERY QUERY IS ORG-SCOPED by the principal's org, which came from the
//      token, which came from a membership verified at consent time. No tool
//      takes an organization argument — that would put the tenant boundary in a
//      field a model can be talked into changing.
//
// Roles mirror the app exactly (docs/MCP-PLAN.md §0): a tool requires the same
// role the equivalent UI action requires, neither more nor less.

const { z } = require('zod');
const { McpEventSchema, toMcpEvent } = require('../schemas/domain');
const q = require('../db/shim');
const logs = require('../db/log-store');   // log LINES may not be in `q` — see db/log-store.js
const { now, isStr, clampInt, sha256, encrypt } = require('../util');
const sec = require('../security');
const config = require('../config');
const tokens = require('../lib/tokens');   // credential namespace + mint(); see lib/tokens.js
const plans = require('../plans');         // per-plan resource caps, mirrored from the REST create paths
const incidents = require('../lib/incidents');
const cases = require('../lib/cases');
const chain = require('../engine/alert-chain');

const SEVERITY_HINT = 'OpsCat severity is 0-100; >=80 is critical, >=60 major, >=40 minor.';

// Lazy require: routes/ops.js pulls in the pipeline, and requiring it at module
// load would create a cycle through the MCP router. Only the write tools need it.
function opsBus() { return require('../routes/ops'); }

// Every mutation is attributed to the HUMAN who authorized the connection, with
// the client noted — an agent's action is never anonymous in the audit log.
function auditTool(p, action, detail) {
  sec.audit(p.user.id, action, `${detail} [mcp client=${p.clientId}]`, p.orgId);
}

// Ask the user to confirm before something irreversible. Elicitation (MCP
// 2025-11-25) is a client capability, so a client that lacks it gets the
// fallback: an explicit `confirm: true` argument. Never silently proceed.
async function confirmDestructive(ctx, args, message) {
  if (args.confirm === true) return { ok: true };
  try {
    const out = await ctx.server.server.elicitInput({
      message,
      requestedSchema: {
        type: 'object',
        properties: { confirm: { type: 'boolean', title: 'Confirm', description: message } },
        required: ['confirm'],
      },
    });
    if (out.action === 'accept' && out.content && out.content.confirm === true) return { ok: true };
    return { ok: false, reason: out.action === 'accept' ? 'Not confirmed.' : `User ${out.action}led.` };
  } catch {
    // Client cannot elicit — require the explicit argument instead.
    return { ok: false, reason: `${message} Re-run with confirm: true to proceed.` };
  }
}

// ── shared shapes ──────────────────────────────────────────────────────────

/* Derived from the REST projection in ../schemas/domain.js rather than declared
 * here: this shape and routes/ops.js publicEvent() describe the same DB row, and
 * two independent declarations of one row is how they drift. A rename over there
 * now breaks the .pick() at load instead of silently producing two different
 * public descriptions of the same event. */
const eventShape = McpEventSchema.shape;

/* `'text'` is pinned to the literal type rather than left to widen to `string`.
 * Every handler is async since the shim conversion, so what these two return is
 * what `server.registerTool`'s callback returns — and the SDK types that as a
 * union of content kinds discriminated on `type`. Widened to `string` the whole
 * `Promise<…>` fails to assign, which the type gate reports as a MISSED AWAIT
 * (its rule is "any error mentioning a Promise"). Nothing is wrong at runtime;
 * the annotation is what keeps the gate's one signal from being a false alarm.
 * @returns {{ content: { type: 'text', text: string }[], structuredContent: any }}
 */
function ok(structured) {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

/** @returns {{ content: { type: 'text', text: string }[], isError: true }} */
function fail(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ── tool registry ──────────────────────────────────────────────────────────
// Each entry: { name, title, description, scope, role, inputSchema, outputSchema,
//               annotations, handler(args, principal) }

const READ = 'read';
const WRITE = 'write';

const TOOLS = [
  {
    // The only tool that is NOT about one organization — it answers which ones
    // there are, so it cannot itself require the argument it exists to supply.
    // `orgless` is read in mcp/server.js: no `organization` parameter, no
    // resolution, no per-org role check.
    name: 'opscat_list_organizations',
    title: 'List organizations',
    description: 'The organizations this connection covers, with your role in each. '
      + 'Pass one of these names as `organization` to every other tool. '
      + 'A connection covering exactly one organization needs no such argument.',
    scope: READ, role: 'analyst', orgless: true,
    inputSchema: {},
    outputSchema: {
      organizations: z.array(z.object({
        name: z.string(), slug: z.string(), role: z.string(), plan: z.string(),
      })),
      count: z.number(),
      // What a model needs in order to know whether it may omit the argument.
      argumentRequired: z.boolean(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (a, p) => {
      const orgs = (p.orgs && p.orgs.length ? p.orgs : [{
        name: p.org.name, slug: p.org.slug, role: p.role, plan: p.org.plan,
      }]).map((o) => ({ name: o.name, slug: o.slug, role: o.role, plan: o.plan }));
      return ok({ organizations: orgs, count: orgs.length, argumentRequired: orgs.length > 1 });
    },
  },

  {
    name: 'opscat_list_events',
    title: 'List events',
    description: `List events (deduplicated alerts) for your organization, newest and most severe first. ${SEVERITY_HINT}`,
    scope: READ, role: 'analyst',
    inputSchema: {
      status: z.enum(['active', 'finished', 'downgraded', 'all']).optional()
        .describe('Default "active" — what an on-call engineer usually wants.'),
      minSeverity: z.number().min(0).max(100).optional(),
      limit: z.number().min(1).max(200).optional(),
    },
    outputSchema: { events: z.array(z.object(eventShape)), count: z.number() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (a, p) => {
      const status = a.status || 'active';
      const limit = Math.min(a.limit || 50, 200);
      const minSev = a.minSeverity || 0;
      const rows = status === 'all'
        ? await q.prepare(`SELECT * FROM events WHERE org_id = ? AND severity >= ?
             ORDER BY severity DESC, last_seen DESC LIMIT ?`).all(p.orgId, minSev, limit)
        : await q.prepare(`SELECT * FROM events WHERE org_id = ? AND status = ? AND severity >= ?
             ORDER BY severity DESC, last_seen DESC LIMIT ?`).all(p.orgId, status, minSev, limit);
      const events = rows.map(toMcpEvent);
      return ok({ events, count: events.length });
    },
  },

  {
    name: 'opscat_get_event',
    title: 'Get event detail',
    description: 'One event with its recent log lines and linked case, for root-cause work.',
    scope: READ, role: 'analyst',
    inputSchema: { id: z.number().describe('Event id from opscat_list_events.') },
    outputSchema: {
      event: z.object(eventShape).nullable(),
      // `sev` is a syslog severity 0..7 and has always arrived as a NUMBER —
      // better-sqlite3 returned INTEGER as one, and pg.js's int8 type parser
      // coerces it. Declared as a string since the MCP server shipped (#44),
      // which made every response carrying a log line fail output validation.
      // Nothing caught it because no harness invoked a tool that returns one.
      recentLogs: z.array(z.object({ ts: z.number(), device: z.string().nullable(), line: z.string(), sev: z.number().nullable() })),
      case: z.object({ id: z.number(), label: z.string(), status: z.string() }).nullable(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (a, p) => {
      const e = await q.prepare('SELECT * FROM events WHERE id = ? AND org_id = ?').get(a.id, p.orgId);
      if (!e) return fail(`No event ${a.id} in this organization.`);
      const recentLogs = await logs.deviceTail({ orgId: p.orgId, device: e.device, limit: 20 });
      const c = await q.prepare(`SELECT id, status FROM cases WHERE org_id = ? AND event_id = ?
        ORDER BY id DESC LIMIT 1`).get(p.orgId, e.id);
      return ok({
        event: toMcpEvent(e),
        recentLogs,
        case: c ? { id: c.id, label: `C-${1000 + c.id}`, status: c.status } : null,
      });
    },
  },

  {
    name: 'opscat_list_cases',
    title: 'List cases',
    description: 'Cases opened from events — the unit of on-call work. Default: open cases.',
    scope: READ, role: 'analyst',
    inputSchema: {
      status: z.enum(['open', 'acknowledged', 'closed', 'all']).optional(),
      limit: z.number().min(1).max(200).optional(),
    },
    outputSchema: {
      cases: z.array(z.object({
        id: z.number(), label: z.string(), name: z.string(), device: z.string().nullable(),
        severity: z.number(), status: z.string(), openedAt: z.number(), closedAt: z.number().nullable(),
      })),
      count: z.number(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (a, p) => {
      const limit = Math.min(a.limit || 50, 200);
      const rows = (!a.status || a.status === 'all')
        ? await q.prepare('SELECT * FROM cases WHERE org_id = ? ORDER BY opened_at DESC LIMIT ?').all(p.orgId, limit)
        : await q.prepare('SELECT * FROM cases WHERE org_id = ? AND status = ? ORDER BY opened_at DESC LIMIT ?')
            .all(p.orgId, a.status, limit);
      const out = rows.map((c) => ({
        id: c.id, label: cases.label(c.id), name: c.name, device: c.device,
        severity: c.severity, status: c.status, openedAt: c.opened_at, closedAt: c.closed_at,
      }));
      return ok({ cases: out, count: out.length });
    },
  },

  {
    name: 'opscat_search_logs',
    title: 'Search logs',
    description: 'Search ingested log lines. Use `device` and `since` to narrow — this can return a lot of text.',
    scope: READ, role: 'analyst',
    inputSchema: {
      query: z.string().optional().describe('Substring match on the log line.'),
      device: z.string().optional(),
      sinceMinutes: z.number().min(1).max(10080).optional().describe('Default 60.'),
      limit: z.number().min(1).max(200).optional(),
    },
    outputSchema: {
      logs: z.array(z.object({
        ts: z.number(), device: z.string().nullable(), line: z.string(),
        sev: z.number().nullable(), source: z.string().nullable(),   // see opscat_get_event
      })),
      count: z.number(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (a, p) => {
      const since = now() - (a.sinceMinutes || 60) * 60000;
      const limit = Math.min(a.limit || 50, 200);
      /* `query` now matches the DEVICE name as well as the line, which is what
       * the web Logs page has always done. It is a deliberate widening: keeping
       * the old line-only behaviour would have meant a second search
       * implementation in the log store, and `device` is still available as an
       * exact filter for an agent that wants precision. */
      const rows = await logs.search({
        orgId: p.orgId, since, until: Number.MAX_SAFE_INTEGER,
        term: a.query || '', device: a.device || null, limit,
      });
      return ok({ logs: rows, count: rows.length });
    },
  },

  {
    name: 'opscat_who_is_oncall',
    title: 'Who is on call',
    description: 'Who has the duty right now, per schedule — the first question of every handover, '
      + 'and the one nobody could ask before. `user` is null when a schedule resolves to NOBODY, '
      + 'which is a gap worth reporting, not an empty answer.',
    scope: READ, role: 'analyst',
    inputSchema: {},
    outputSchema: {
      at: z.number(),
      schedules: z.array(z.object({
        scheduleId: z.number(), name: z.string(), timezone: z.string(),
        user: z.object({ id: z.string(), name: z.string(), email: z.string() }).nullable(),
        via: z.string().nullable(),
        configured: z.boolean(),
      })),
      gaps: z.array(z.string()),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (a, p) => {
      const at = now();
      const rows = (await require('../engine/oncall').onCallNow(p.orgId, at)).map((r) => ({
        scheduleId: r.scheduleId, name: r.name, timezone: r.timezone,
        user: r.user ? { id: r.user.id, name: r.user.name, email: r.user.email } : null,
        via: r.via, configured: r.configured,
      }));
      // Named separately so an agent does not have to notice a null in a list.
      const gaps = rows.filter((r) => r.configured && !r.user).map((r) => r.name);
      return ok({ at, schedules: rows, gaps });
    },
  },

  {
    name: 'opscat_list_alerts',
    title: 'List alerts',
    description: 'On-call alerts — who is being woken, at which escalation step, and whether anyone '
      + 'has acknowledged. Default: everything still live (active or acknowledged).',
    scope: READ, role: 'analyst',
    inputSchema: {
      status: z.enum(['live', 'active', 'acked', 'exhausted', 'canceled', 'resolved', 'all']).optional(),
      limit: z.number().optional(),
    },
    outputSchema: {
      alerts: z.array(z.object({
        id: z.number(), status: z.string(), urgency: z.string(),
        subject: z.string().nullable(), policy: z.string().nullable(),
        step: z.number(), round: z.number(), createdAt: z.number(),
        ackedBy: z.string().nullable(), ackMinutes: z.number().nullable(),
      })),
      count: z.number(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (a, p) => {
      const filter = a.status || 'live';
      const limit = Math.min(a.limit || 50, 200);
      const rows = await q.prepare(`SELECT * FROM alerts WHERE org_id = ?
        AND (? = 'all' OR (? = 'live' AND status IN ('active','acked')) OR status = ?)
        ORDER BY created_at DESC LIMIT ?`).all(p.orgId, filter, filter, filter, limit);
      const out = (await Promise.all(rows.map((r) => chain.view(r)))).map((v) => ({
        id: v.id, status: v.status, urgency: v.urgency,
        subject: v.subjectLabel, policy: v.policyName,
        step: v.step, round: v.round, createdAt: v.createdAt,
        ackedBy: v.ackedBy ? v.ackedBy.name : null, ackMinutes: v.ackMinutes,
      }));
      return ok({ alerts: out, count: out.length });
    },
  },

  {
    name: 'opscat_ack_alert',
    title: 'Acknowledge an alert',
    description: 'Stop an alert escalating — "I have seen it". Does NOT assign the case to anyone; '
      + 'owning the work is a separate statement. Refuses an alert that is not active.',
    scope: WRITE, role: 'analyst',
    inputSchema: { id: z.number().describe('Alert id.') },
    outputSchema: { id: z.number(), status: z.string(), acked: z.boolean() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (a, p) => {
      const r = await chain.ack(p.orgId, a.id, p.user.id, `mcp:${p.clientId}`);
      // An alert that is already acknowledged is not an error to hide: the agent
      // is told the state so it can say "somebody got there first".
      if (r.error) return fail(`${r.error}.`);
      auditTool(p, 'alert_ack', `alert ${a.id}`);
      return ok({ id: r.alert.id, status: r.alert.status, acked: true });
    },
  },
  {
    name: 'opscat_list_checks',
    title: 'List synthetic checks',
    description: 'Synthetic monitoring checks with their latest result — the fastest read on "what is down".',
    scope: READ, role: 'analyst',
    inputSchema: { onlyFailing: z.boolean().optional() },
    outputSchema: {
      checks: z.array(z.object({
        id: z.number(), type: z.string(), target: z.string(), enabled: z.number(),
        intervalSeconds: z.number(),
        lastOk: z.boolean().nullable(), lastLatencyMs: z.number().nullable(), lastCheckedAt: z.number().nullable(),
      })),
      count: z.number(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (a, p) => {
      // Reputation assets are excluded here for the same reason they are excluded
      // from GET /api/synthetics/checks: they are their own feature (blocklist
      // state, not reachability) and `lastOk:false` on one means "listed", not
      // "down" — an agent reading this list would report an outage that is not one.
      const rows = await q.prepare(
        'SELECT * FROM synthetic_checks WHERE org_id = ? ORDER BY id').all(p.orgId);
      const last = q.prepare(`SELECT ok, latency_ms, ts FROM synthetic_results
        WHERE check_id = ? ORDER BY ts DESC LIMIT 1`);
      let checks = await Promise.all(rows.map(async (c) => {
        const r = await last.get(c.id);
        return {
          id: c.id, type: c.type, target: c.target, enabled: c.enabled, intervalSeconds: c.interval_s,
          lastOk: r ? !!r.ok : null, lastLatencyMs: r ? r.latency_ms : null, lastCheckedAt: r ? r.ts : null,
        };
      }));
      if (a.onlyFailing) checks = checks.filter((c) => c.lastOk === false);
      return ok({ checks, count: checks.length });
    },
  },

  {
    name: 'opscat_list_incidents',
    title: 'List incidents',
    description: 'Incidents, including whether each is published to the public status page.',
    scope: READ, role: 'analyst',
    inputSchema: { limit: z.number().min(1).max(100).optional() },
    outputSchema: {
      incidents: z.array(z.object({
        // `severity` said `string` and `incidents.severity` is a BIGINT, so this
        // tool answered an output-VALIDATION error for any org that had an
        // incident — i.e. it worked only while there was nothing to report, and
        // the empty array validated happily. Found by listing incidents in an
        // org that had one, which no check had done before.
        id: z.number(), label: z.string(), title: z.string(), severity: z.number(),
        // boolean like its two siblings (create/update). Nothing depends on the
        // old shape: the non-empty path has never returned successfully.
        status: z.string(), published: z.boolean(), startedAt: z.number(), resolvedAt: z.number().nullable(),
      })),
      count: z.number(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (a, p) => {
      const rows = await q.prepare('SELECT * FROM incidents WHERE org_id = ? ORDER BY started_at DESC LIMIT ?')
        .all(p.orgId, Math.min(a.limit || 25, 100));
      const incidents = rows.map((i) => ({
        id: i.id, label: `INC-${1000 + i.id}`, title: i.title, severity: i.severity,
        status: i.status, published: !!i.published, startedAt: i.started_at, resolvedAt: i.resolved_at,
      }));
      return ok({ incidents, count: incidents.length });
    },
  },

  {
    name: 'opscat_list_infrastructure',
    title: 'List monitored infrastructure',
    description: 'Agents, SNMP targets and heartbeats with their last-seen times — the inventory view.',
    scope: READ, role: 'analyst',
    inputSchema: {},
    outputSchema: {
      agents: z.array(z.object({ id: z.number(), name: z.string(), hostname: z.string().nullable(), platform: z.string().nullable(), version: z.string().nullable(), active: z.number(), lastSeenAt: z.number().nullable() })),
      snmpTargets: z.array(z.object({ id: z.number(), name: z.string(), host: z.string(), enabled: z.number(), lastStatus: z.string().nullable(), lastSeenAt: z.number().nullable() })),
      heartbeats: z.array(z.object({ id: z.number(), name: z.string(), enabled: z.number(), intervalSeconds: z.number(), lastPingAt: z.number().nullable() })),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (_a, p) => ok({
      agents: (await q.prepare(`SELECT id, name, hostname, platform, version, active, last_seen_at
        FROM agents WHERE org_id = ? ORDER BY name`).all(p.orgId))
        .map((r) => ({ id: r.id, name: r.name, hostname: r.hostname, platform: r.platform, version: r.version, active: r.active, lastSeenAt: r.last_seen_at })),
      snmpTargets: (await q.prepare(`SELECT id, name, host, enabled, last_status, last_seen_at
        FROM snmp_targets WHERE org_id = ? ORDER BY name`).all(p.orgId))
        .map((r) => ({ id: r.id, name: r.name, host: r.host, enabled: r.enabled, lastStatus: r.last_status, lastSeenAt: r.last_seen_at })),
      heartbeats: (await q.prepare(`SELECT id, name, enabled, interval_s, last_ping_at
        FROM heartbeats WHERE org_id = ? ORDER BY name`).all(p.orgId))
        .map((r) => ({ id: r.id, name: r.name, enabled: r.enabled, intervalSeconds: r.interval_s, lastPingAt: r.last_ping_at })),
    }),
  },

  {
    name: 'opscat_get_agent_metrics',
    title: 'Get host agent metrics',
    description: 'Recent CPU / load / memory / disk for one host agent — the "how is this box doing?" read. '
      + 'Identify the agent by numeric id (from opscat_list_infrastructure) or by name. Returns the latest '
      + 'sample plus a summary over the window; a healthy box that has simply never reported has 0 samples.',
    scope: READ, role: 'analyst',
    inputSchema: {
      agentId: z.number().optional().describe('Agent id from opscat_list_infrastructure.'),
      name: z.string().optional().describe('Agent name — alternative to agentId.'),
      hours: z.number().min(1).max(168).optional().describe('Look-back window in hours. Default 24.'),
    },
    outputSchema: {
      agent: z.object({
        id: z.number(), name: z.string(), hostname: z.string().nullable(),
        platform: z.string().nullable(), version: z.string().nullable(), lastSeenAt: z.number().nullable(),
      }).nullable(),
      windowHours: z.number(), samples: z.number(),
      latest: z.object({
        ts: z.number(), cpuPct: z.number().nullable(), load1: z.number().nullable(),
        memUsedPct: z.number().nullable(), diskUsedPct: z.number().nullable(),
      }).nullable(),
      summary: z.object({ cpuAvgPct: z.number(), cpuMaxPct: z.number(), load1Max: z.number() }).nullable(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (a, p) => {
      // The agent is resolved WITHIN the org — agent_metrics itself is org-less
      // (it keys on agent_id), so the org boundary lives entirely in this lookup,
      // exactly as GET /api/admin/agents/:id/metrics guards it before returning.
      const agent = a.agentId
        ? await q.prepare(`SELECT id, name, hostname, platform, version, last_seen_at
            FROM agents WHERE id = ? AND org_id = ?`).get(a.agentId, p.orgId)
        : (isStr(a.name, 100)
          ? await q.prepare(`SELECT id, name, hostname, platform, version, last_seen_at
              FROM agents WHERE name = ? AND org_id = ?`).get(a.name, p.orgId)
          : null);
      const hours = clampInt(a.hours, 1, 168, 24);
      if (!agent) {
        // A read tool always answers: with neither agentId nor name supplied
        // there is nothing to resolve, so return an empty but VALID payload
        // (agent null). A bad id/name that WAS supplied is a real mistake and
        // still errors.
        if (a.agentId != null || isStr(a.name, 100)) {
          return fail('No agent with that id or name in this organization.');
        }
        return ok({ agent: null, windowHours: hours, samples: 0, latest: null, summary: null });
      }
      const rows = await q.prepare(`SELECT ts, cpu_pct, load1, mem_used, mem_total, disk_used, disk_total
        FROM agent_metrics WHERE agent_id = ? AND ts >= ? ORDER BY ts`).all(agent.id, now() - hours * 3600000);
      const info = {
        id: agent.id, name: agent.name, hostname: agent.hostname,
        platform: agent.platform, version: agent.version, lastSeenAt: agent.last_seen_at,
      };
      if (!rows.length) return ok({ agent: info, windowHours: hours, samples: 0, latest: null, summary: null });
      const pct = (u, t) => (t ? Math.round((u / t) * 1000) / 10 : null);
      const round1 = (n) => Math.round(n * 10) / 10;
      let cpuSum = 0; let cpuMax = 0; let loadMax = 0;
      for (const r of rows) {
        cpuSum += r.cpu_pct || 0;
        if ((r.cpu_pct || 0) > cpuMax) cpuMax = r.cpu_pct;
        if ((r.load1 || 0) > loadMax) loadMax = r.load1;
      }
      const l = rows[rows.length - 1];
      return ok({
        agent: info, windowHours: hours, samples: rows.length,
        latest: {
          ts: l.ts, cpuPct: l.cpu_pct, load1: l.load1,
          memUsedPct: pct(l.mem_used, l.mem_total), diskUsedPct: pct(l.disk_used, l.disk_total),
        },
        summary: { cpuAvgPct: round1(cpuSum / rows.length), cpuMaxPct: round1(cpuMax), load1Max: round1(loadMax) },
      });
    },
  },

  {
    name: 'opscat_get_dashboard',
    title: 'Get dashboard summary',
    description: 'One-call overview: open cases, active events by severity, failing checks, live incidents. Start here.',
    scope: READ, role: 'analyst',
    inputSchema: {},
    outputSchema: {
      organization: z.string(),
      activeEvents: z.number(), criticalEvents: z.number(),
      openCases: z.number(), failingChecks: z.number(), openIncidents: z.number(),
      maintenanceActive: z.number(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (_a, p) => {
      const one = async (sql, ...args) => (await q.prepare(sql).get(p.orgId, ...args)).c;
      const t = now();
      // Counted in a LOOP, not with `.filter()`. The predicate here asks a
      // second question of the database per row, and an async predicate returns
      // a Promise — which is truthy, so every enabled check would be counted as
      // failing, with nothing thrown, nothing logged and the type gate green
      // (CLAUDE.md § the async conversion: truthiness is the one hole no proxy
      // can close). The dashboard is the first call an agent makes, so this is
      // exactly the number it would report an outage from.
      let failing = 0;
      for (const c of await q.prepare('SELECT c.id FROM synthetic_checks c WHERE c.org_id = ? AND c.enabled = 1')
        .all(p.orgId)) {
        const r = await q.prepare('SELECT ok FROM synthetic_results WHERE check_id = ? ORDER BY ts DESC LIMIT 1').get(c.id);
        if (r && !r.ok) failing++;
      }
      return ok({
        organization: p.org.name,
        activeEvents: await one("SELECT COUNT(*) c FROM events WHERE org_id = ? AND status = 'active'"),
        criticalEvents: await one("SELECT COUNT(*) c FROM events WHERE org_id = ? AND status = 'active' AND severity >= 80"),
        openCases: await one("SELECT COUNT(*) c FROM cases WHERE org_id = ? AND status != 'closed'"),
        failingChecks: failing,
        openIncidents: await one("SELECT COUNT(*) c FROM incidents WHERE org_id = ? AND resolved_at IS NULL"),
        maintenanceActive: await one('SELECT COUNT(*) c FROM maintenance_windows WHERE org_id = ? AND starts_at <= ? AND ends_at >= ?', t, t),
      });
    },
  },
  {
    name: 'opscat_list_vendors',
    title: 'List tracked vendors',
    description: 'Third-party providers whose public status pages OpsCat tracks — the supply-chain view.',
    scope: READ, role: 'analyst',
    inputSchema: { onlyDisrupted: z.boolean().optional() },
    outputSchema: {
      vendors: z.array(z.object({
        id: z.number(), name: z.string(), status: z.string().nullable(),
        enabled: z.number(), pageUrl: z.string().nullable(), lastCheckedAt: z.number().nullable(),
      })),
      count: z.number(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (a, p) => {
      let rows = await q.prepare(`SELECT id, name, status, enabled, page_url, last_checked_at
        FROM vendors WHERE org_id = ? ORDER BY name`).all(p.orgId);
      if (a.onlyDisrupted) rows = rows.filter((v) => v.status && v.status !== 'operational');
      const vendors = rows.map((v) => ({
        id: v.id, name: v.name, status: v.status, enabled: v.enabled,
        pageUrl: v.page_url, lastCheckedAt: v.last_checked_at,
      }));
      return ok({ vendors, count: vendors.length });
    },
  },

  // ── write tools ──────────────────────────────────────────────────────────
  // Roles mirror the app exactly. Note that `POST /events/:id/action` and
  // `PATCH /cases/:id` carry NO requireRole in routes/ops.js — an analyst can
  // already do both in the UI, so these are `analyst` here too. Raising them for
  // MCP would invent a rule the product does not have (docs/MCP-PLAN.md §0).

  {
    name: 'opscat_update_case',
    title: 'Update a case',
    description: 'Change a case\'s status, root cause or note — the "acknowledge and write down what you found" tool.',
    scope: WRITE, role: 'analyst',
    inputSchema: {
      id: z.number().describe('Case id (the number, not the C-xxxx label).'),
      status: z.enum(['open', 'assigned', 'closed']).optional(),
      rootCause: z.string().max(200).optional(),
      note: z.string().max(2000).optional(),
    },
    outputSchema: { id: z.number(), status: z.string(), updated: z.boolean() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (a, p) => {
      // lib/cases is the one mutation path (docs/ONCALL-V1.md §5): closing here
      // has to stop the alert chain exactly as closing in the UI does, or an
      // agent tidying up leaves somebody's phone ringing.
      const after = await cases.update(p.orgId, a.id, {
        status: a.status, rootCause: a.rootCause, note: a.note,
      });
      if (!after) return fail(`No case ${a.id} in this organization.`);
      auditTool(p, 'case_update', `case ${after.id}`);
      return ok({ id: after.id, status: after.status, updated: true });
    },
  },

  {
    name: 'opscat_event_action',
    title: 'Act on an event',
    description: 'Finish an event (also closes its case), downgrade its severity, or attach a note to its case.',
    scope: WRITE, role: 'analyst',
    inputSchema: {
      id: z.number(),
      action: z.enum(['finish', 'downgrade', 'note']),
      note: z.string().max(2000).optional().describe('Required for action "note".'),
    },
    outputSchema: { id: z.number(), status: z.string(), severity: z.number() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler: async (a, p) => {
      const e = await q.prepare('SELECT * FROM events WHERE id = ? AND org_id = ?').get(a.id, p.orgId);
      if (!e) return fail(`No event ${a.id} in this organization.`);
      const t = now();
      // Same three writes as POST /events/:id/action, and the same timeline entry:
      // an event's history must not have a hole where an agent acted. The client id
      // rides along in the detail, so the panel says a tool did this, not a person
      // at a keyboard.
      // The two state changes carry their condition in the UPDATE's own WHERE and
      // record history only when `changes` says something actually moved. The
      // tool's ANSWER is unchanged — it reports the state after the call, so a
      // repeated finish still succeeds — but a repeat no longer puts a second
      // "finish" in the event's history for one state change, and an agent
      // retrying a call cannot record a 25-point downgrade twice.
      const via = ` [via ${p.clientId}]`;
      if (a.action === 'finish') {
        const w = await q.prepare(`UPDATE events SET status = 'finished', finished_at = ?, finished_by = ?
          WHERE id = ? AND org_id = ? AND status != 'finished'`).run(t, p.user.id, e.id, p.orgId);
        await cases.closeForEvent(p.orgId, e.id, { at: t });
        if (w.changes) await opsBus().recordEvent(p.orgId, e.id, p.user.id, 'finish', via.trim());
      } else if (a.action === 'downgrade') {
        const newSev = Math.max(10, e.severity - 25);
        // compare-and-swap on the severity we read: the history entry names a
        // before and an after, so it may only be written when that exact pair
        // is the transition the database performed.
        const w = await q.prepare('UPDATE events SET severity = ? WHERE id = ? AND org_id = ? AND severity = ?')
          .run(newSev, e.id, p.orgId, e.severity);
        if (w.changes) await opsBus().recordEvent(p.orgId, e.id, p.user.id, 'downgrade', `${e.severity} → ${newSev}${via}`);
      } else {
        if (!isStr(a.note, 2000)) return fail('action "note" requires a note.');
        // Appends in SQL rather than SET note = ? — an agent tidying up a case
        // must not silently delete the sentence the on-call engineer typed into
        // it thirty seconds earlier. Shared with the UI path so there is one
        // implementation of "add a note", not two that drift.
        await opsBus().appendCaseNote(p.orgId, e.id, a.note);
        await opsBus().recordEvent(p.orgId, e.id, p.user.id, 'note', `${a.note}${via}`);
      }
      auditTool(p, `event_${a.action}`, `event ${e.id} ${e.name}@${e.device}`);
      const after = await q.prepare('SELECT * FROM events WHERE id = ? AND org_id = ?').get(e.id, p.orgId);
      // Push the same SSE frame the UI already listens for, so a change made by
      // an agent shows up live rather than on the next refresh. `publicEvent`
      // reads the assignee row, so it is resolved in the argument expression —
      // `hub.broadcast` writes the frame synchronously and JSON.stringify of a
      // pending query would put "{}" on every subscribed browser.
      const bus = opsBus();
      bus.hub.broadcast('event', await bus.publicEvent(after), p.orgId);
      return ok({ id: after.id, status: after.status, severity: after.severity });
    },
  },

  {
    name: 'opscat_create_incident',
    title: 'Open an incident',
    description: 'Open an incident. Created UNPUBLISHED — it is not on the public status page until opscat_update_incident sets published.',
    scope: WRITE, role: 'lead',
    inputSchema: {
      title: z.string().max(200),
      severity: z.number().min(0).max(100).optional().describe('Default 50.'),
      message: z.string().max(2000).optional().describe('First update. Default "Incident opened."'),
    },
    outputSchema: { id: z.number(), label: z.string(), title: z.string(), status: z.string(), published: z.boolean() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler: async (a, p) => {
      if (!isStr(a.title, 200)) return fail('title required.');
      // through lib/incidents so the synthetic lifecycle events fire and the
      // audit/view stays identical to the REST path (docs/INCIDENTS-V2.md §3.2)
      const row = await incidents.create(p.orgId, p.user.id, {
        title: a.title, severity: clampInt(a.severity, 0, 100, 50),
        message: isStr(a.message, 2000) ? a.message : undefined,
      });
      auditTool(p, 'incident_create', a.title);
      return ok({
        id: row.id, label: incidents.label(row.id),
        title: row.title, status: row.status, published: !!row.published,
      });
    },
  },

  {
    name: 'opscat_post_incident_status',
    title: 'Post an incident update',
    description: 'Move an incident to a new status and append an update. If the incident is published, this text appears on the PUBLIC status page.',
    scope: WRITE, role: 'lead',
    inputSchema: {
      id: z.number(),
      status: z.enum(['investigating', 'identified', 'monitoring', 'resolved']),
      message: z.string().max(2000).optional(),
    },
    outputSchema: { id: z.number(), status: z.string(), published: z.boolean(), resolvedAt: z.number().nullable() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler: async (a, p) => {
      const after = await incidents.setStatus(p.orgId, p.user.id, a.id, a.status,
        isStr(a.message, 2000) ? a.message : undefined);
      if (!after) return fail(`No incident ${a.id} in this organization.`);
      auditTool(p, 'incident_status', `${incidents.label(after.id)} → ${a.status}`);
      return ok({ id: after.id, status: after.status, published: !!after.published, resolvedAt: after.resolved_at });
    },
  },

  {
    name: 'opscat_update_incident',
    title: 'Update an incident',
    description: 'Change an incident\'s title/severity, write its RCA, or PUBLISH it to the public status page. Publishing is externally visible — confirm with the user first.',
    scope: WRITE, role: 'lead',
    inputSchema: {
      id: z.number(),
      title: z.string().max(200).optional(),
      severity: z.number().min(0).max(100).optional(),
      published: z.boolean().optional().describe('true puts this incident on the PUBLIC status page.'),
      rcaSummary: z.string().max(10000).optional(),
      rcaResolution: z.string().max(10000).optional(),
      confirm: z.boolean().optional().describe('Set true to skip the confirmation prompt when publishing.'),
    },
    outputSchema: { id: z.number(), title: z.string(), published: z.boolean() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (a, p, ctx) => {
      const i = await q.prepare('SELECT * FROM incidents WHERE id = ? AND org_id = ?').get(a.id, p.orgId);
      if (!i) return fail(`No incident ${a.id} in this organization.`);
      // Publishing is the one externally-visible act here: it puts text in front
      // of the org's customers. Everything else stays internal.
      if (a.published === true && !i.published) {
        const c = await confirmDestructive(ctx, a,
          `Publish incident "${i.title}" to the PUBLIC status page? This is visible to everyone.`);
        if (!c.ok) return fail(c.reason);
      }
      await q.prepare(`UPDATE incidents SET
          title = COALESCE(?, title), severity = COALESCE(?, severity),
          rca_summary = COALESCE(?, rca_summary), rca_resolution = COALESCE(?, rca_resolution)
        WHERE id = ? AND org_id = ?`)
        .run(a.title ?? null, Number.isFinite(a.severity) ? a.severity : null,
          a.rcaSummary ?? null, a.rcaResolution ?? null, i.id, p.orgId);
      // through the verb: first-publish notifies the status-page subscribers
      if (a.published !== undefined) await incidents.setPublished(p.orgId, p.user.id, i.id, a.published);
      auditTool(p, 'incident_update', `${incidents.label(i.id)}${a.published === true ? ' published' : ''}`);
      const after = await q.prepare('SELECT * FROM incidents WHERE id = ? AND org_id = ?').get(i.id, p.orgId);
      return ok({ id: after.id, title: after.title, published: !!after.published });
    },
  },

  {
    name: 'opscat_create_maintenance',
    title: 'Schedule maintenance',
    description: 'Schedule a maintenance window (epoch milliseconds, max 30 days). Alerting is suppressed inside it.',
    scope: WRITE, role: 'lead',
    inputSchema: {
      name: z.string().max(100),
      startsAt: z.number().describe('Epoch milliseconds.'),
      endsAt: z.number().describe('Epoch milliseconds, after startsAt.'),
    },
    outputSchema: { id: z.number(), name: z.string(), startsAt: z.number(), endsAt: z.number() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler: async (a, p) => {
      if (!isStr(a.name, 100)) return fail('name required.');
      if (!Number.isFinite(a.startsAt) || !Number.isFinite(a.endsAt) || a.endsAt <= a.startsAt) {
        return fail('startsAt/endsAt required in epoch milliseconds, with endsAt after startsAt.');
      }
      if (a.endsAt - a.startsAt > 30 * 86400000) return fail('Window longer than 30 days.');
      const id = await q.prepare(`INSERT INTO maintenance_windows (org_id, name, starts_at, ends_at, created_at)
        VALUES (?,?,?,?,?)`).insert(p.orgId, a.name, a.startsAt, a.endsAt, now());
      auditTool(p, 'maintenance_create', a.name);
      return ok({ id: Number(id), name: a.name, startsAt: a.startsAt, endsAt: a.endsAt });
    },
  },

  {
    name: 'opscat_delete_maintenance',
    title: 'Delete a maintenance window',
    description: 'Delete a maintenance window. Irreversible, and alerting resumes immediately.',
    scope: WRITE, role: 'lead',
    inputSchema: {
      id: z.number(),
      confirm: z.boolean().optional().describe('Set true to skip the confirmation prompt.'),
    },
    outputSchema: { id: z.number(), deleted: z.boolean() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    handler: async (a, p, ctx) => {
      const w = await q.prepare('SELECT * FROM maintenance_windows WHERE id = ? AND org_id = ?').get(a.id, p.orgId);
      if (!w) return fail(`No maintenance window ${a.id} in this organization.`);
      const c = await confirmDestructive(ctx, a,
        `Delete maintenance window "${w.name}"? Alerting resumes immediately and this cannot be undone.`);
      if (!c.ok) return fail(c.reason);
      await q.prepare('DELETE FROM maintenance_windows WHERE id = ? AND org_id = ?').run(w.id, p.orgId);
      auditTool(p, 'maintenance_delete', `window ${w.id} ${w.name}`);
      return ok({ id: w.id, deleted: true });
    },
  },

  {
    name: 'opscat_run_checks',
    title: 'Run synthetic checks now',
    description: 'Run this organization\'s synthetic checks immediately instead of waiting for the schedule. Contacts the external targets.',
    scope: WRITE, role: 'analyst',
    inputSchema: {},
    outputSchema: {
      ran: z.number(),
      results: z.array(z.object({ checkId: z.number().optional(), ok: z.boolean().optional(), latencyMs: z.number().nullable().optional() })),
    },
    // openWorldHint: this reaches out to third-party targets, not just our DB.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: async (_a, p) => {
      const results = await require('../engine/synthetics').runAllNow(p.orgId);
      auditTool(p, 'synthetics_run', `${results.length} checks`);
      return ok({ ran: results.length, results: results.slice(0, 50) });
    },
  },

  {
    name: 'opscat_poll_vendor',
    title: 'Poll a vendor status page',
    description: 'Re-fetch one tracked vendor\'s status feed immediately. Contacts the vendor\'s public status page.',
    scope: WRITE, role: 'analyst',
    inputSchema: { id: z.number().describe('Vendor id from opscat_list_vendors.') },
    outputSchema: { id: z.number(), name: z.string(), status: z.string().nullable() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    handler: async (a, p) => {
      const v = await require('../engine/vendors').pollNow(a.id, p.orgId);
      if (!v) return fail(`No vendor ${a.id} in this organization.`);
      auditTool(p, 'vendor_poll', `vendor ${v.id} ${v.name}`);
      return ok({ id: v.id, name: v.name, status: v.status ?? null });
    },
  },

  // ── assets & provisioning write tools ───────────────────────────────────────
  // The "setup" half of the surface: register the things OpsCat then watches.
  // Each mirrors its REST create path (roles, plan caps, credential mint) so an
  // action taken through the MCP is indistinguishable from the same action in the
  // UI — including that a minted secret is RETURNED ONCE and only its hash stored.

  {
    name: 'opscat_add_agent',
    title: 'Add a host agent',
    description: 'Register a host agent and get its enrollment token PLUS a ready-to-run install command. '
      + 'Run the command on the target server (as root; needs Node >= 18) to start shipping heartbeat, '
      + 'CPU/RAM/disk metrics and — with --logs — journald logs. The token is shown ONCE and only its hash '
      + 'is stored. One record is ONE host: every report updates THIS record\'s hostname and metrics, so the '
      + 'same token on a second host overwrites the first. To enroll a fleet, call this once per host — which '
      + 'is exactly what a provisioning flow does, naming each agent after the server it bakes the token into.',
    scope: WRITE, role: 'lead',
    inputSchema: {
      name: z.string().max(100).describe('Display name for the agent record — use the target host\'s name; one record per host.'),
      group: z.string().max(100).optional().describe('Workspace/group label. Default "default".'),
      logs: z.boolean().optional().describe('Include --logs (ship journald logs) in the install command. Default true.'),
    },
    outputSchema: {
      id: z.number(), name: z.string(), token: z.string(), installCommand: z.string(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler: async (a, p) => {
      if (!isStr(a.name, 100)) return fail('name required.');
      // Agent name is globally UNIQUE (schema.sql: agents.name UNIQUE), so mirror
      // the REST check that spans all orgs — an org-scoped check would pass and
      // then the insert would trip the constraint with an opaque error.
      if (await q.prepare('SELECT id FROM agents WHERE name = ?').get(a.name)) {
        return fail(`An agent named "${a.name}" already exists.`);
      }
      const lim = await plans.checkLimit(p.orgId, p.org.plan, 'agents');
      if (!lim.ok) return fail(`Plan limit reached (${lim.used}/${lim.limit} agents) — upgrade the plan to add more.`);
      const token = tokens.mint('agentToken');
      const id = await q.prepare(`INSERT INTO agents (org_id, name, grp, token_hash, auto_update, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .insert(p.orgId, a.name, isStr(a.group, 100) ? a.group : 'default', sha256(token), 1, now());
      auditTool(p, 'agent_create', a.name);
      const base = config.baseUrl;
      const flags = a.logs === false ? '' : '--logs';
      // The canonical one-liner from the agent README: the instance serves
      // install.sh under /agent/, which downloads the agent when piped.
      const installCommand = `curl -fsSL ${base}/agent/install.sh | sudo `
        + `OPSCAT_URL=${base} OPSCAT_AGENT_TOKEN=${token} OPSCAT_AGENT_FLAGS="${flags}" sh`;
      return ok({ id: Number(id), name: a.name, token, installCommand });
    },
  },

  {
    name: 'opscat_add_heartbeat',
    title: 'Add a heartbeat monitor',
    description: 'Create a dead-man\'s-switch: a job (cron, backup, pipeline) pings the returned URL on '
      + 'success, and SILENCE past the interval + grace is the alert. The ping URL is returned ONCE — only '
      + 'its token hash is stored. Ideal for "did the nightly backup actually run?".',
    scope: WRITE, role: 'lead',
    inputSchema: {
      name: z.string().max(100),
      intervalS: z.number().optional().describe('Expected seconds between pings. Default 3600 (clamped 30..2592000).'),
      graceS: z.number().optional().describe('Grace period in seconds before alerting. Default 300 (clamped 0..86400).'),
    },
    outputSchema: { id: z.number(), name: z.string(), pingUrl: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler: async (a, p) => {
      if (!isStr(a.name, 100)) return fail('name required.');
      const token = tokens.mint('heartbeat');
      const id = await q.prepare(`INSERT INTO heartbeats (org_id, name, token_hash, interval_s, grace_s,
        enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)`)
        .insert(p.orgId, a.name, sha256(token), clampInt(a.intervalS, 30, 30 * 86400, 3600),
          clampInt(a.graceS, 0, 86400, 300), now());
      auditTool(p, 'heartbeat_create', a.name);
      // URL returned once, exactly as POST /v1/heartbeats does — the token IS the URL.
      return ok({ id: Number(id), name: a.name, pingUrl: `${config.baseUrl}/v1/heartbeat/${token}` });
    },
  },

  {
    name: 'opscat_add_check',
    title: 'Add a synthetic check',
    description: 'Create a synthetic monitoring check (http / icmp / dns / tcp / traceroute). It runs from all '
      + 'of the organization\'s agents on the given interval; use opscat_list_checks / opscat_run_checks to see '
      + 'results. HTTP assertions and per-location targeting are set in the UI.',
    scope: WRITE, role: 'lead',
    inputSchema: {
      type: z.enum(['http', 'icmp', 'dns', 'tcp', 'traceroute']),
      target: z.string().max(300).describe('URL for http, host for icmp/dns/traceroute, host:port for tcp.'),
      intervalS: z.number().optional().describe('Seconds between runs. Default 60 (floored by your plan; capped 3600).'),
      timeoutMs: z.number().optional().describe('Per-run timeout in ms. Default 5000 (clamped 500..60000).'),
    },
    outputSchema: { id: z.number(), type: z.string(), target: z.string(), intervalSeconds: z.number(), enabled: z.number() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler: async (a, p) => {
      if (!['http', 'icmp', 'dns', 'tcp', 'traceroute'].includes(a.type)) return fail('bad type.');
      if (!isStr(a.target, 300)) return fail('target required.');
      const minIv = plans.minIntervalFor(p.org.plan);   // plan-dependent cadence floor
      const intervalS = clampInt(a.intervalS, minIv, 3600, Math.max(60, minIv));
      // insertWithinLimit enforces the shared checks budget in the WHERE of the
      // insert itself — the same atomic cap the REST create uses, so an agent
      // cannot race past the plan limit. assertions/user_agent are UI-only here.
      const r = await plans.insertWithinLimit(p.orgId, p.org.plan, 'checks',
        `INSERT INTO synthetic_checks (org_id, type, target, interval_s, timeout_ms,
           enabled, assertions, user_agent, created_at)
         SELECT ?, ?, ?, ?, ?, 1, ?, ?, ?`,
        [p.orgId, a.type, a.target, intervalS, clampInt(a.timeoutMs, 500, 60000, 5000), null, null, now()],
        '', { returningId: true });
      if (r.refused) return fail('Plan check limit reached — upgrade the plan to add more checks.');
      auditTool(p, 'check_create', `${a.type} ${a.target}`);
      return ok({ id: r.id, type: a.type, target: a.target, intervalSeconds: intervalS, enabled: 1 });
    },
  },

  {
    name: 'opscat_add_snmp_target',
    title: 'Add an SNMP target',
    description: 'Register a device to poll over SNMP (router, switch, UPS, printer). Supports v2c (community) '
      + 'and v3 (user + auth/priv). Community and v3 keys are stored encrypted and never returned.',
    scope: WRITE, role: 'lead',
    inputSchema: {
      name: z.string().max(100),
      host: z.string().max(255),
      port: z.number().optional().describe('Default 161.'),
      version: z.enum(['2c', '3']).optional().describe('Default "2c".'),
      community: z.string().max(200).optional().describe('Required for v2c.'),
      intervalS: z.number().optional().describe('Poll interval seconds. Default 60 (clamped 15..3600).'),
      oids: z.array(z.object({ oid: z.string(), label: z.string().max(100) })).optional()
        .describe('Optional OIDs to collect (numeric OID + label), max 48.'),
      v3User: z.string().max(100).optional(),
      v3Level: z.enum(['noAuthNoPriv', 'authNoPriv', 'authPriv']).optional(),
      v3AuthProtocol: z.enum(['md5', 'sha']).optional(),
      v3AuthKey: z.string().max(200).optional(),
      v3PrivProtocol: z.enum(['des', 'aes']).optional(),
      v3PrivKey: z.string().max(200).optional(),
    },
    outputSchema: { id: z.number(), name: z.string(), host: z.string(), version: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler: async (a, p) => {
      if (!isStr(a.name, 100)) return fail('name required.');
      if (!isStr(a.host, 255)) return fail('host required.');
      const ver = a.version === '3' ? '3' : '2c';
      // v2c vs v3 validation mirrors POST /api/admin/snmp/targets exactly; keys
      // are encrypted with the platform secret and only their ciphertext stored.
      const v3 = { user: null, level: null, authProto: null, authKeyEnc: null, privProto: null, privKeyEnc: null };
      if (ver === '2c') {
        if (!isStr(a.community, 200)) return fail('community required for v2c.');
      } else {
        if (!isStr(a.v3User, 100)) return fail('v3User required for v3.');
        if (!['noAuthNoPriv', 'authNoPriv', 'authPriv'].includes(a.v3Level)) return fail('bad v3Level.');
        v3.user = a.v3User; v3.level = a.v3Level;
        if (a.v3Level !== 'noAuthNoPriv') {
          if (!isStr(a.v3AuthKey, 200) || a.v3AuthKey.length < 8) return fail('v3AuthKey required (min 8 chars).');
          v3.authProto = a.v3AuthProtocol === 'sha' ? 'sha' : 'md5';
          v3.authKeyEnc = encrypt(a.v3AuthKey, config.secret);
        }
        if (a.v3Level === 'authPriv') {
          if (!isStr(a.v3PrivKey, 200) || a.v3PrivKey.length < 8) return fail('v3PrivKey required (min 8 chars).');
          v3.privProto = a.v3PrivProtocol === 'aes' ? 'aes' : 'des';
          v3.privKeyEnc = encrypt(a.v3PrivKey, config.secret);
        }
      }
      const lim = await plans.checkLimit(p.orgId, p.org.plan, 'snmpTargets');
      if (!lim.ok) return fail(`Plan limit reached (${lim.used}/${lim.limit} SNMP targets) — upgrade the plan to add more.`);
      let oidsJson = '[]';
      if (Array.isArray(a.oids)) {
        const clean = a.oids.filter((o) => o && /^[0-9.]+$/.test(o.oid) && isStr(o.label, 100)).slice(0, 48);
        oidsJson = JSON.stringify(clean);
      }
      const id = await q.prepare(`INSERT INTO snmp_targets (org_id, name, host, port, version, community_enc, oids,
        interval_s, enabled, v3_user, v3_level, v3_auth_protocol, v3_auth_key_enc, v3_priv_protocol, v3_priv_key_enc,
        created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`)
        .insert(p.orgId, a.name, a.host, clampInt(a.port, 1, 65535, 161), ver,
          encrypt(ver === '2c' ? a.community : '', config.secret), oidsJson, clampInt(a.intervalS, 15, 3600, 60),
          v3.user, v3.level, v3.authProto, v3.authKeyEnc, v3.privProto, v3.privKeyEnc, now());
      auditTool(p, 'snmp_target_create', `${a.name} (${a.host}, v${ver})`);
      return ok({ id: Number(id), name: a.name, host: a.host, version: ver });
    },
  },
];

module.exports = { TOOLS, READ, WRITE, ok, fail };
