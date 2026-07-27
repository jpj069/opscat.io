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
const { now } = require('../util');
const sec = require('../security');

const SEVERITY_HINT = 'OpsCat severity is 0-100; >=80 is critical, >=60 major, >=40 minor.';

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
      const rows = db.prepare('SELECT * FROM synthetic_checks WHERE org_id = ? ORDER BY id').all(p.orgId);
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
      const failing = db.prepare(`SELECT c.id FROM synthetic_checks c WHERE c.org_id = ? AND c.enabled = 1`)
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
];

module.exports = { TOOLS, READ, WRITE, ok, fail };
