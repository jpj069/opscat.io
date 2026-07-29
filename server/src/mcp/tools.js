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
const { db } = require('../db');
const { now, isStr, clampInt } = require('../util');
const sec = require('../security');

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

const eventShape = {
  id: z.number(), name: z.string(), device: z.string().nullable(),
  severity: z.number(), hits: z.number(), status: z.string(),
  firstSeen: z.number(), lastSeen: z.number(), description: z.string().nullable(),
};

function ok(structured) {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

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
    handler: (a, p) => {
      const status = a.status || 'active';
      const limit = Math.min(a.limit || 50, 200);
      const minSev = a.minSeverity || 0;
      const rows = status === 'all'
        ? db.prepare(`SELECT * FROM events WHERE org_id = ? AND severity >= ?
             ORDER BY severity DESC, last_seen DESC LIMIT ?`).all(p.orgId, minSev, limit)
        : db.prepare(`SELECT * FROM events WHERE org_id = ? AND status = ? AND severity >= ?
             ORDER BY severity DESC, last_seen DESC LIMIT ?`).all(p.orgId, status, minSev, limit);
      const events = rows.map((e) => ({
        id: e.id, name: e.name, device: e.device, severity: e.severity, hits: e.hits,
        status: e.status, firstSeen: e.first_seen, lastSeen: e.last_seen, description: e.description,
      }));
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
      recentLogs: z.array(z.object({ ts: z.number(), device: z.string().nullable(), line: z.string(), sev: z.string().nullable() })),
      case: z.object({ id: z.number(), label: z.string(), status: z.string() }).nullable(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: (a, p) => {
      const e = db.prepare('SELECT * FROM events WHERE id = ? AND org_id = ?').get(a.id, p.orgId);
      if (!e) return fail(`No event ${a.id} in this organization.`);
      const recentLogs = db.prepare(`SELECT ts, device, line, sev FROM logs
        WHERE org_id = ? AND device = ? ORDER BY ts DESC LIMIT 20`).all(p.orgId, e.device);
      const c = db.prepare(`SELECT id, status FROM cases WHERE org_id = ? AND event_id = ?
        ORDER BY id DESC LIMIT 1`).get(p.orgId, e.id);
      return ok({
        event: {
          id: e.id, name: e.name, device: e.device, severity: e.severity, hits: e.hits,
          status: e.status, firstSeen: e.first_seen, lastSeen: e.last_seen, description: e.description,
        },
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
    handler: (a, p) => {
      const limit = Math.min(a.limit || 50, 200);
      const rows = (!a.status || a.status === 'all')
        ? db.prepare('SELECT * FROM cases WHERE org_id = ? ORDER BY opened_at DESC LIMIT ?').all(p.orgId, limit)
        : db.prepare('SELECT * FROM cases WHERE org_id = ? AND status = ? ORDER BY opened_at DESC LIMIT ?')
            .all(p.orgId, a.status, limit);
      const cases = rows.map((c) => ({
        id: c.id, label: `C-${1000 + c.id}`, name: c.name, device: c.device,
        severity: c.severity, status: c.status, openedAt: c.opened_at, closedAt: c.closed_at,
      }));
      return ok({ cases, count: cases.length });
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
        sev: z.string().nullable(), source: z.string().nullable(),
      })),
      count: z.number(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: (a, p) => {
      const since = now() - (a.sinceMinutes || 60) * 60000;
      const limit = Math.min(a.limit || 50, 200);
      const where = ['org_id = ?', 'ts >= ?'];
      const args = [p.orgId, since];
      if (a.device) { where.push('device = ?'); args.push(a.device); }
      if (a.query) { where.push('line LIKE ?'); args.push(`%${a.query}%`); }
      const logs = db.prepare(`SELECT ts, device, line, sev, source FROM logs
        WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ?`).all(...args, limit);
      return ok({ logs, count: logs.length });
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
    handler: (a, p) => {
      // Reputation assets are excluded here for the same reason they are excluded
      // from GET /api/synthetics/checks: they are their own feature (blocklist
      // state, not reachability) and `lastOk:false` on one means "listed", not
      // "down" — an agent reading this list would report an outage that is not one.
      const rows = db.prepare(
        "SELECT * FROM synthetic_checks WHERE org_id = ? AND type != 'reputation' ORDER BY id").all(p.orgId);
      const last = db.prepare(`SELECT ok, latency_ms, ts FROM synthetic_results
        WHERE check_id = ? ORDER BY ts DESC LIMIT 1`);
      let checks = rows.map((c) => {
        const r = last.get(c.id);
        return {
          id: c.id, type: c.type, target: c.target, enabled: c.enabled, intervalSeconds: c.interval_s,
          lastOk: r ? !!r.ok : null, lastLatencyMs: r ? r.latency_ms : null, lastCheckedAt: r ? r.ts : null,
        };
      });
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
        id: z.number(), label: z.string(), title: z.string(), severity: z.string().nullable(),
        status: z.string(), published: z.number(), startedAt: z.number(), resolvedAt: z.number().nullable(),
      })),
      count: z.number(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: (a, p) => {
      const rows = db.prepare('SELECT * FROM incidents WHERE org_id = ? ORDER BY started_at DESC LIMIT ?')
        .all(p.orgId, Math.min(a.limit || 25, 100));
      const incidents = rows.map((i) => ({
        id: i.id, label: `INC-${1000 + i.id}`, title: i.title, severity: i.severity,
        status: i.status, published: i.published, startedAt: i.started_at, resolvedAt: i.resolved_at,
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
    handler: (_a, p) => ok({
      agents: db.prepare(`SELECT id, name, hostname, platform, version, active, last_seen_at
        FROM agents WHERE org_id = ? ORDER BY name`).all(p.orgId)
        .map((r) => ({ id: r.id, name: r.name, hostname: r.hostname, platform: r.platform, version: r.version, active: r.active, lastSeenAt: r.last_seen_at })),
      snmpTargets: db.prepare(`SELECT id, name, host, enabled, last_status, last_seen_at
        FROM snmp_targets WHERE org_id = ? ORDER BY name`).all(p.orgId)
        .map((r) => ({ id: r.id, name: r.name, host: r.host, enabled: r.enabled, lastStatus: r.last_status, lastSeenAt: r.last_seen_at })),
      heartbeats: db.prepare(`SELECT id, name, enabled, interval_s, last_ping_at
        FROM heartbeats WHERE org_id = ? ORDER BY name`).all(p.orgId)
        .map((r) => ({ id: r.id, name: r.name, enabled: r.enabled, intervalSeconds: r.interval_s, lastPingAt: r.last_ping_at })),
    }),
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
    handler: (_a, p) => {
      const one = (sql, ...args) => db.prepare(sql).get(p.orgId, ...args).c;
      const t = now();
      const failing = db.prepare("SELECT c.id FROM synthetic_checks c WHERE c.org_id = ? AND c.enabled = 1 AND c.type != 'reputation'")
        .all(p.orgId)
        .filter((c) => {
          const r = db.prepare('SELECT ok FROM synthetic_results WHERE check_id = ? ORDER BY ts DESC LIMIT 1').get(c.id);
          return r && !r.ok;
        }).length;
      return ok({
        organization: p.org.name,
        activeEvents: one("SELECT COUNT(*) c FROM events WHERE org_id = ? AND status = 'active'"),
        criticalEvents: one("SELECT COUNT(*) c FROM events WHERE org_id = ? AND status = 'active' AND severity >= 80"),
        openCases: one("SELECT COUNT(*) c FROM cases WHERE org_id = ? AND status != 'closed'"),
        failingChecks: failing,
        openIncidents: one("SELECT COUNT(*) c FROM incidents WHERE org_id = ? AND resolved_at IS NULL"),
        maintenanceActive: one('SELECT COUNT(*) c FROM maintenance_windows WHERE org_id = ? AND starts_at <= ? AND ends_at >= ?', t, t),
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
    handler: (a, p) => {
      let rows = db.prepare(`SELECT id, name, status, enabled, page_url, last_checked_at
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
    handler: (a, p) => {
      const c = db.prepare('SELECT * FROM cases WHERE id = ? AND org_id = ?').get(a.id, p.orgId);
      if (!c) return fail(`No case ${a.id} in this organization.`);
      db.prepare(`UPDATE cases SET
          status = COALESCE(?, status),
          root_cause = COALESCE(?, root_cause),
          note = COALESCE(?, note),
          closed_at = CASE WHEN ? = 'closed' AND closed_at IS NULL THEN ? ELSE closed_at END
        WHERE id = ? AND org_id = ?`)
        .run(a.status || null, a.rootCause ?? null, a.note ?? null, a.status || null, now(), c.id, p.orgId);
      auditTool(p, 'case_update', `case ${c.id}`);
      const after = db.prepare('SELECT status FROM cases WHERE id = ? AND org_id = ?').get(c.id, p.orgId);
      return ok({ id: c.id, status: after.status, updated: true });
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
    handler: (a, p) => {
      const e = db.prepare('SELECT * FROM events WHERE id = ? AND org_id = ?').get(a.id, p.orgId);
      if (!e) return fail(`No event ${a.id} in this organization.`);
      const t = now();
      if (a.action === 'finish') {
        db.prepare("UPDATE events SET status = 'finished', finished_at = ?, finished_by = ? WHERE id = ? AND org_id = ?")
          .run(t, p.user.id, e.id, p.orgId);
        db.prepare("UPDATE cases SET status = 'closed', closed_at = ? WHERE event_id = ? AND status != 'closed' AND org_id = ?")
          .run(t, e.id, p.orgId);
      } else if (a.action === 'downgrade') {
        db.prepare('UPDATE events SET severity = ? WHERE id = ? AND org_id = ?')
          .run(Math.max(10, e.severity - 25), e.id, p.orgId);
      } else {
        if (!isStr(a.note, 2000)) return fail('action "note" requires a note.');
        db.prepare("UPDATE cases SET note = ? WHERE event_id = ? AND status != 'closed' AND org_id = ?")
          .run(a.note, e.id, p.orgId);
      }
      auditTool(p, `event_${a.action}`, `event ${e.id} ${e.name}@${e.device}`);
      const after = db.prepare('SELECT * FROM events WHERE id = ? AND org_id = ?').get(e.id, p.orgId);
      // Push the same SSE frame the UI already listens for, so a change made by
      // an agent shows up live rather than on the next refresh.
      const bus = opsBus();
      bus.hub.broadcast('event', bus.publicEvent(after), p.orgId);
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
    handler: (a, p) => {
      if (!isStr(a.title, 200)) return fail('title required.');
      const t = now();
      const info = db.prepare(`INSERT INTO incidents (org_id, title, severity, status, started_at, created_by)
        VALUES (?, ?, ?, 'investigating', ?, ?)`)
        .run(p.orgId, a.title, clampInt(a.severity, 0, 100, 50), t, p.user.id);
      db.prepare(`INSERT INTO incident_updates (incident_id, ts, status, message, user_id)
        VALUES (?, ?, 'investigating', ?, ?)`)
        .run(info.lastInsertRowid, t, a.message || 'Incident opened.', p.user.id);
      auditTool(p, 'incident_create', a.title);
      return ok({
        id: Number(info.lastInsertRowid), label: `INC-${1000 + Number(info.lastInsertRowid)}`,
        title: a.title, status: 'investigating', published: false,
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
    handler: (a, p) => {
      const i = db.prepare('SELECT * FROM incidents WHERE id = ? AND org_id = ?').get(a.id, p.orgId);
      if (!i) return fail(`No incident ${a.id} in this organization.`);
      const t = now();
      db.prepare('UPDATE incidents SET status = ?, resolved_at = ? WHERE id = ? AND org_id = ?')
        .run(a.status, a.status === 'resolved' ? t : null, i.id, p.orgId);
      db.prepare('INSERT INTO incident_updates (incident_id, ts, status, message, user_id) VALUES (?,?,?,?,?)')
        .run(i.id, t, a.status, isStr(a.message, 2000) ? a.message : `Status changed to ${a.status}.`, p.user.id);
      auditTool(p, 'incident_status', `INC-${1000 + i.id} → ${a.status}`);
      const after = db.prepare('SELECT * FROM incidents WHERE id = ? AND org_id = ?').get(i.id, p.orgId);
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
      const i = db.prepare('SELECT * FROM incidents WHERE id = ? AND org_id = ?').get(a.id, p.orgId);
      if (!i) return fail(`No incident ${a.id} in this organization.`);
      // Publishing is the one externally-visible act here: it puts text in front
      // of the org's customers. Everything else stays internal.
      if (a.published === true && !i.published) {
        const c = await confirmDestructive(ctx, a,
          `Publish incident "${i.title}" to the PUBLIC status page? This is visible to everyone.`);
        if (!c.ok) return fail(c.reason);
      }
      db.prepare(`UPDATE incidents SET
          title = COALESCE(?, title), severity = COALESCE(?, severity),
          published = COALESCE(?, published),
          rca_summary = COALESCE(?, rca_summary), rca_resolution = COALESCE(?, rca_resolution)
        WHERE id = ? AND org_id = ?`)
        .run(a.title ?? null, Number.isFinite(a.severity) ? a.severity : null,
          a.published === undefined ? null : (a.published ? 1 : 0),
          a.rcaSummary ?? null, a.rcaResolution ?? null, i.id, p.orgId);
      auditTool(p, 'incident_update', `INC-${1000 + i.id}${a.published === true ? ' published' : ''}`);
      const after = db.prepare('SELECT * FROM incidents WHERE id = ? AND org_id = ?').get(i.id, p.orgId);
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
    handler: (a, p) => {
      if (!isStr(a.name, 100)) return fail('name required.');
      if (!Number.isFinite(a.startsAt) || !Number.isFinite(a.endsAt) || a.endsAt <= a.startsAt) {
        return fail('startsAt/endsAt required in epoch milliseconds, with endsAt after startsAt.');
      }
      if (a.endsAt - a.startsAt > 30 * 86400000) return fail('Window longer than 30 days.');
      const info = db.prepare(`INSERT INTO maintenance_windows (org_id, name, starts_at, ends_at, created_at)
        VALUES (?,?,?,?,?)`).run(p.orgId, a.name, a.startsAt, a.endsAt, now());
      auditTool(p, 'maintenance_create', a.name);
      return ok({ id: Number(info.lastInsertRowid), name: a.name, startsAt: a.startsAt, endsAt: a.endsAt });
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
      const w = db.prepare('SELECT * FROM maintenance_windows WHERE id = ? AND org_id = ?').get(a.id, p.orgId);
      if (!w) return fail(`No maintenance window ${a.id} in this organization.`);
      const c = await confirmDestructive(ctx, a,
        `Delete maintenance window "${w.name}"? Alerting resumes immediately and this cannot be undone.`);
      if (!c.ok) return fail(c.reason);
      db.prepare('DELETE FROM maintenance_windows WHERE id = ? AND org_id = ?').run(w.id, p.orgId);
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
];

module.exports = { TOOLS, READ, WRITE, ok, fail };
