'use strict';
// Session-authenticated operations API: events, cases, logs, dashboard,
// analytics, alert rules, notifications, incidents, live stream (SSE).
const express = require('express');
const { db } = require('../db');
const { now, clampInt, isStr, optStr, httpError, SseHub } = require('../util');
const sec = require('../security');
const pipeline = require('../engine/pipeline');

const router = express.Router();
router.use(sec.requireSession);

const hub = new SseHub();
pipeline.on('log', (l) => hub.broadcast('log', l, l.orgId));
pipeline.on('event', (e) => hub.broadcast('event', publicEvent(e), e.org_id));

const userLite = db.prepare('SELECT id, name, color FROM users WHERE id = ?');
// org-scoped existence check used to validate assignees (tenant isolation)
const userInOrg = db.prepare('SELECT id FROM users WHERE id = ? AND org_id = ?');
function initials(name) {
  return name.split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
}
function assignedView(userId) {
  if (!userId) return null;
  const u = userLite.get(userId);
  return u ? { id: u.id, n: u.name, i: initials(u.name), c: u.color } : null;
}
function publicEvent(e) {
  return {
    id: e.id, name: e.name, device: e.device, ip: e.ip, target: e.target,
    description: e.description, severity: e.severity, hits: e.hits, status: e.status,
    firstSeen: e.first_seen, lastSeen: e.last_seen,
    assigned: assignedView(e.assigned_user_id),
  };
}

// ---- live stream ----
router.get('/stream', (req, res) => hub.handler(req, res, req.orgId));

// ---- team roster (lightweight; any session) ----
// Assignee pickers need names/colors without exposing emails or last-seen —
// the full user list stays behind lead+ in /api/admin/users.
router.get('/team', (req, res) => {
  res.json(db.prepare("SELECT id, name, color, role FROM users WHERE active = 1 AND org_id = ? ORDER BY name").all(req.orgId)
    .map((u) => ({ id: u.id, name: u.name, i: initials(u.name), color: u.color, role: u.role })));
});

// ---- events ----
router.get('/events', (req, res) => {
  const status = ['active', 'finished', 'downgraded', 'all'].includes(req.query.status)
    ? req.query.status : 'active';
  const limit = clampInt(req.query.limit, 1, 500, 200);
  const rows = status === 'all'
    ? db.prepare('SELECT * FROM events WHERE org_id = ? ORDER BY severity DESC, last_seen DESC LIMIT ?').all(req.orgId, limit)
    : db.prepare('SELECT * FROM events WHERE status = ? AND org_id = ? ORDER BY severity DESC, last_seen DESC LIMIT ?')
        .all(status, req.orgId, limit);
  // sparkline: last 30 minutes of buckets per event, in one query
  const ids = rows.map((r) => r.id);
  const sparks = new Map();
  if (ids.length) {
    const since = Math.floor((now() - 30 * 60000) / 60000);
    const bRows = db.prepare(`SELECT event_id, bucket, count FROM event_buckets
      WHERE bucket >= ? AND event_id IN (${ids.map(() => '?').join(',')})`).all(since, ...ids);
    for (const b of bRows) {
      if (!sparks.has(b.event_id)) sparks.set(b.event_id, []);
      sparks.get(b.event_id).push([b.bucket, b.count]);
    }
  }
  res.json(rows.map((e) => {
    const pts = (sparks.get(e.id) || []).sort((a, b) => a[0] - b[0]);
    // cumulative sparkline like the design (10 points)
    const nowMin = Math.floor(now() / 60000);
    const buckets = Array(30).fill(0);
    for (const [bucket, count] of pts) {
      const idx = 29 - (nowMin - bucket);
      if (idx >= 0 && idx < 30) buckets[idx] = count;
    }
    const spark = [];
    let acc = Math.max(0, e.hits - buckets.reduce((a, b) => a + b, 0));
    for (let i = 0; i < 30; i += 3) {
      acc += buckets.slice(i, i + 3).reduce((a, b) => a + b, 0);
      spark.push(acc);
    }
    return { ...publicEvent(e), spark };
  }));
});

router.get('/events/:id', (req, res) => {
  const e = db.prepare('SELECT * FROM events WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!e) return httpError(res, 404, 'event not found');
  const logs = db.prepare(`SELECT ts, device, line, sev FROM logs
    WHERE device = ? AND org_id = ? ORDER BY ts DESC LIMIT 20`).all(e.device, req.orgId);
  const caseRow = db.prepare('SELECT id, status FROM cases WHERE event_id = ? AND org_id = ? ORDER BY id DESC LIMIT 1')
    .get(e.id, req.orgId);
  res.json({ ...publicEvent(e), recentLogs: logs,
    case: caseRow ? { label: `C-${1000 + caseRow.id}`, id: caseRow.id, status: caseRow.status } : null });
});

router.post('/events/:id/action', (req, res) => {
  const e = db.prepare('SELECT * FROM events WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!e) return httpError(res, 404, 'event not found');
  const { action } = req.body || {};
  const t = now();
  if (action === 'finish') {
    db.prepare("UPDATE events SET status = 'finished', finished_at = ?, finished_by = ? WHERE id = ? AND org_id = ?")
      .run(t, req.user.id, e.id, req.orgId);
    db.prepare("UPDATE cases SET status = 'closed', closed_at = ? WHERE event_id = ? AND status != 'closed' AND org_id = ?")
      .run(t, e.id, req.orgId);
  } else if (action === 'downgrade') {
    const newSev = Math.max(10, e.severity - 25);
    db.prepare('UPDATE events SET severity = ? WHERE id = ? AND org_id = ?').run(newSev, e.id, req.orgId);
  } else if (action === 'assign') {
    const uid = req.body.userId || req.user.id;
    if (!userInOrg.get(uid, req.orgId)) return httpError(res, 400, 'unknown user');
    db.prepare('UPDATE events SET assigned_user_id = ? WHERE id = ? AND org_id = ?').run(uid, e.id, req.orgId);
    db.prepare("UPDATE cases SET assigned_user_id = ?, status = 'assigned' WHERE event_id = ? AND status = 'open' AND org_id = ?")
      .run(uid, e.id, req.orgId);
  } else if (action === 'note') {
    if (!isStr(req.body.note, 2000)) return httpError(res, 400, 'note required');
    db.prepare("UPDATE cases SET note = ? WHERE event_id = ? AND status != 'closed' AND org_id = ?")
      .run(req.body.note, e.id, req.orgId);
  } else {
    return httpError(res, 400, 'unknown action');
  }
  sec.audit(req.user.id, `event_${action}`, `event ${e.id} ${e.name}@${e.device}`, req.orgId);
  const updated = db.prepare('SELECT * FROM events WHERE id = ? AND org_id = ?').get(e.id, req.orgId);
  hub.broadcast('event', publicEvent(updated), req.orgId);
  res.json(publicEvent(updated));
});

// ---- cases ----
router.get('/cases', (req, res) => {
  const filter = ['open', 'assigned', 'closed', 'all'].includes(req.query.status)
    ? req.query.status : 'all';
  const limit = clampInt(req.query.limit, 1, 500, 200);
  const rows = filter === 'all'
    ? db.prepare('SELECT * FROM cases WHERE org_id = ? ORDER BY opened_at DESC LIMIT ?').all(req.orgId, limit)
    : db.prepare('SELECT * FROM cases WHERE status = ? AND org_id = ? ORDER BY opened_at DESC LIMIT ?').all(filter, req.orgId, limit);
  const t = now();
  res.json(rows.map((c) => ({
    id: c.id, label: `C-${1000 + c.id}`, eventId: c.event_id, name: c.name, device: c.device,
    severity: c.severity, status: c.status, assigned: assignedView(c.assigned_user_id),
    rootCause: c.root_cause, note: c.note, openedAt: c.opened_at, closedAt: c.closed_at,
    durationMs: (c.closed_at || t) - c.opened_at,
  })));
});

router.patch('/cases/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM cases WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!c) return httpError(res, 404, 'case not found');
  const { status, assignedUserId, rootCause, note } = req.body || {};
  if (status && !['open', 'assigned', 'closed'].includes(status)) return httpError(res, 400, 'bad status');
  if (!optStr(rootCause, 200) || !optStr(note, 2000)) return httpError(res, 400, 'bad fields');
  if (assignedUserId && !userInOrg.get(assignedUserId, req.orgId)) return httpError(res, 400, 'unknown user');
  db.prepare(`UPDATE cases SET
      status = COALESCE(?, status),
      assigned_user_id = COALESCE(?, assigned_user_id),
      root_cause = COALESCE(?, root_cause),
      note = COALESCE(?, note),
      closed_at = CASE WHEN ? = 'closed' AND closed_at IS NULL THEN ? ELSE closed_at END
    WHERE id = ? AND org_id = ?`)
    .run(status || null, assignedUserId || null, rootCause ?? null, note ?? null,
      status || null, now(), c.id, req.orgId);
  sec.audit(req.user.id, 'case_update', `case ${c.id}`, req.orgId);
  res.json({ ok: true });
});

// ---- logs ----
router.get('/logs', (req, res) => {
  const hours = clampInt(req.query.hours, 1, 168, 2);
  const limit = clampInt(req.query.limit, 1, 1000, 300);
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
  const since = now() - hours * 3600000;
  let rows;
  if (q) {
    // plain substring match (safe); regex filtering happens client-side
    rows = db.prepare(`SELECT ts, device, line, sev FROM logs
      WHERE ts >= ? AND org_id = ? AND (line LIKE ? OR device LIKE ?) ORDER BY ts DESC LIMIT ?`)
      .all(since, req.orgId, `%${q}%`, `%${q}%`, limit);
  } else {
    rows = db.prepare('SELECT ts, device, line, sev FROM logs WHERE ts >= ? AND org_id = ? ORDER BY ts DESC LIMIT ?')
      .all(since, req.orgId, limit);
  }
  res.json(rows);
});

// ---- dashboard + analytics ----
router.get('/dashboard', (req, res) => {
  const t = now();
  const sevCounts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const r of db.prepare(`SELECT CASE WHEN severity >= 80 THEN 'critical' WHEN severity >= 60 THEN 'high'
      WHEN severity >= 40 THEN 'medium' WHEN severity >= 20 THEN 'low' ELSE 'info' END AS band, COUNT(*) c
      FROM events WHERE status = 'active' AND org_id = ? GROUP BY band`).all(req.orgId)) {
    sevCounts[r.band] = r.c;
  }
  const openCases = db.prepare("SELECT COUNT(*) c FROM cases WHERE status != 'closed' AND org_id = ?").get(req.orgId).c;
  const mttr = db.prepare(`SELECT AVG(closed_at - opened_at) v FROM cases
    WHERE status = 'closed' AND closed_at >= ? AND org_id = ?`).get(t - 7 * 86400000, req.orgId).v;
  const logs24 = db.prepare('SELECT COUNT(*) c FROM logs WHERE ts >= ? AND org_id = ?').get(t - 86400000, req.orgId).c;
  const events24 = db.prepare('SELECT COUNT(*) c FROM events WHERE last_seen >= ? AND org_id = ?').get(t - 86400000, req.orgId).c;
  const casesByAnalyst = db.prepare(`SELECT u.id, u.name, u.color, COUNT(*) c FROM cases
    JOIN users u ON u.id = cases.assigned_user_id
    WHERE cases.opened_at >= ? AND cases.org_id = ? GROUP BY u.id ORDER BY c DESC LIMIT 8`).all(t - 7 * 86400000, req.orgId)
    .map((r) => ({ name: r.name, i: initials(r.name), color: r.color, count: r.c }));
  res.json({ sevCounts, openCases, mttrMs: mttr || 0, logs24, events24, casesByAnalyst });
});

router.get('/analytics', (req, res) => {
  const range = { '24h': 1, '7d': 7, '30d': 30 }[req.query.range] || 7;
  const t = now();
  const since = t - range * 86400000;
  const volume = db.prepare(`SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch') d,
      SUM(CASE WHEN sev <= 2 THEN 1 ELSE 0 END) c,
      SUM(CASE WHEN sev = 3 THEN 1 ELSE 0 END) h,
      SUM(CASE WHEN sev = 4 THEN 1 ELSE 0 END) m,
      SUM(CASE WHEN sev >= 5 THEN 1 ELSE 0 END) l
    FROM logs WHERE ts >= ? AND org_id = ? GROUP BY d ORDER BY d`).all(since, req.orgId);
  const mttrDaily = db.prepare(`SELECT strftime('%Y-%m-%d', closed_at / 1000, 'unixepoch') d,
      AVG(closed_at - opened_at) v FROM cases
    WHERE status = 'closed' AND closed_at >= ? AND org_id = ? GROUP BY d ORDER BY d`).all(since, req.orgId);
  const topTypes = db.prepare(`SELECT name n, COUNT(*) v FROM events WHERE last_seen >= ? AND org_id = ?
    GROUP BY name ORDER BY v DESC LIMIT 8`).all(since, req.orgId);
  const topServers = db.prepare(`SELECT device n, COUNT(*) v FROM events WHERE last_seen >= ? AND org_id = ?
    GROUP BY device ORDER BY v DESC LIMIT 8`).all(since, req.orgId);
  const totals = {
    events: db.prepare('SELECT COUNT(*) c FROM events WHERE last_seen >= ? AND org_id = ?').get(since, req.orgId).c,
    mttrMs: db.prepare(`SELECT AVG(closed_at - opened_at) v FROM cases
      WHERE status = 'closed' AND closed_at >= ? AND org_id = ?`).get(since, req.orgId).v || 0,
    resolutionRate: (() => {
      const r = db.prepare(`SELECT
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) closed, COUNT(*) total
        FROM cases WHERE opened_at >= ? AND org_id = ?`).get(since, req.orgId);
      return r.total ? Math.round((r.closed / r.total) * 100) : 100;
    })(),
    notifications: db.prepare('SELECT COUNT(*) c FROM notifications WHERE ts >= ? AND org_id = ?').get(since, req.orgId).c,
    notificationsFailed: db.prepare('SELECT COUNT(*) c FROM notifications WHERE ts >= ? AND ok = 0 AND org_id = ?')
      .get(since, req.orgId).c,
  };
  res.json({ volume, mttrDaily, topTypes, topServers, totals });
});

// ---- alert rules + notifications ----
router.get('/rules', (req, res) => {
  const rules = db.prepare('SELECT * FROM alert_rules WHERE org_id = ? ORDER BY id').all(req.orgId)
    .map((r) => ({ id: r.id, name: r.name, enabled: !!r.enabled, channel: r.channel,
      triggerName: r.trigger_name, severityMin: r.severity_min, cooldownM: r.cooldown_m,
      recipients: JSON.parse(r.recipients || '[]') }));
  res.json(rules);
});

router.post('/rules', sec.requireRole('lead'), (req, res) => {
  const { name, channel, triggerName, severityMin, cooldownM, recipients } = req.body || {};
  if (!isStr(name, 100)) return httpError(res, 400, 'name required');
  if (!['email', 'teams', 'webhook'].includes(channel)) return httpError(res, 400, 'bad channel');
  const rec = Array.isArray(recipients) ? recipients.filter((r) => typeof r === 'string').slice(0, 20) : [];
  const info = db.prepare(`INSERT INTO alert_rules (org_id, name, enabled, channel, trigger_name, severity_min,
    cooldown_m, recipients, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`)
    .run(req.orgId, name, channel, optStr(triggerName, 100) && triggerName ? triggerName : null,
      clampInt(severityMin, 0, 100, 60), clampInt(cooldownM, 1, 1440, 15), JSON.stringify(rec), now());
  sec.audit(req.user.id, 'rule_create', name, req.orgId);
  res.json({ id: info.lastInsertRowid });
});

router.patch('/rules/:id', sec.requireRole('lead'), (req, res) => {
  const r = db.prepare('SELECT * FROM alert_rules WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!r) return httpError(res, 404, 'rule not found');
  const b = req.body || {};
  const rec = Array.isArray(b.recipients)
    ? JSON.stringify(b.recipients.filter((x) => typeof x === 'string').slice(0, 20)) : null;
  db.prepare(`UPDATE alert_rules SET
      name = COALESCE(?, name), enabled = COALESCE(?, enabled), channel = COALESCE(?, channel),
      trigger_name = CASE WHEN ? THEN ? ELSE trigger_name END,
      severity_min = COALESCE(?, severity_min), cooldown_m = COALESCE(?, cooldown_m),
      recipients = COALESCE(?, recipients)
    WHERE id = ? AND org_id = ?`)
    .run(isStr(b.name, 100) ? b.name : null,
      typeof b.enabled === 'boolean' ? (b.enabled ? 1 : 0) : null,
      ['email', 'teams', 'webhook'].includes(b.channel) ? b.channel : null,
      b.triggerName !== undefined ? 1 : 0, b.triggerName || null,
      Number.isFinite(b.severityMin) ? clampInt(b.severityMin, 0, 100, 60) : null,
      Number.isFinite(b.cooldownM) ? clampInt(b.cooldownM, 1, 1440, 15) : null,
      rec, r.id, req.orgId);
  sec.audit(req.user.id, 'rule_update', `rule ${r.id}`, req.orgId);
  res.json({ ok: true });
});

router.delete('/rules/:id', sec.requireRole('lead'), (req, res) => {
  db.prepare('DELETE FROM alert_rules WHERE id = ? AND org_id = ?').run(req.params.id, req.orgId);
  sec.audit(req.user.id, 'rule_delete', `rule ${req.params.id}`, req.orgId);
  res.json({ ok: true });
});

router.get('/notifications', (req, res) => {
  const rows = db.prepare('SELECT * FROM notifications WHERE org_id = ? ORDER BY ts DESC LIMIT 50').all(req.orgId);
  res.json(rows.map((n) => ({ ts: n.ts, rule: n.rule_name, event: n.case_label || (n.event_id ? `E-${n.event_id}` : ''),
    channel: n.channel, ok: !!n.ok, error: n.error })));
});

// ---- incidents ----
function incidentView(i) {
  const updates = db.prepare(
    'SELECT ts, status, message FROM incident_updates WHERE incident_id = ? ORDER BY ts').all(i.id);
  return {
    id: i.id, label: `INC-${2000 + i.id}`, title: i.title, severity: i.severity, status: i.status,
    published: !!i.published, startedAt: i.started_at, resolvedAt: i.resolved_at,
    durationMs: (i.resolved_at || now()) - i.started_at,
    updates,
    rca: { summary: i.rca_summary, impact: i.rca_impact, rootCause: i.rca_root_cause,
      resolution: i.rca_resolution, actions: i.rca_actions },
  };
}

router.get('/incidents', (req, res) => {
  res.json(db.prepare('SELECT * FROM incidents WHERE org_id = ? ORDER BY started_at DESC LIMIT 100').all(req.orgId).map(incidentView));
});

router.post('/incidents', sec.requireRole('lead'), (req, res) => {
  const { title, severity } = req.body || {};
  if (!isStr(title, 200)) return httpError(res, 400, 'title required');
  const t = now();
  const info = db.prepare(`INSERT INTO incidents (org_id, title, severity, status, started_at, created_by)
    VALUES (?, ?, ?, 'investigating', ?, ?)`)
    .run(req.orgId, title, clampInt(severity, 0, 100, 50), t, req.user.id);
  db.prepare(`INSERT INTO incident_updates (incident_id, ts, status, message, user_id)
    VALUES (?, ?, 'investigating', ?, ?)`)
    .run(info.lastInsertRowid, t, req.body.message || 'Incident opened.', req.user.id);
  sec.audit(req.user.id, 'incident_create', title, req.orgId);
  res.json(incidentView(db.prepare('SELECT * FROM incidents WHERE id = ? AND org_id = ?').get(info.lastInsertRowid, req.orgId)));
});

router.post('/incidents/:id/status', sec.requireRole('lead'), (req, res) => {
  const i = db.prepare('SELECT * FROM incidents WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!i) return httpError(res, 404, 'incident not found');
  const { status, message } = req.body || {};
  if (!['investigating', 'identified', 'monitoring', 'resolved'].includes(status)) {
    return httpError(res, 400, 'bad status');
  }
  const t = now();
  db.prepare('UPDATE incidents SET status = ?, resolved_at = ? WHERE id = ? AND org_id = ?')
    .run(status, status === 'resolved' ? t : null, i.id, req.orgId);
  db.prepare(`INSERT INTO incident_updates (incident_id, ts, status, message, user_id)
    VALUES (?, ?, ?, ?, ?)`)
    .run(i.id, t, status, isStr(message, 2000) ? message : `Status changed to ${status}.`, req.user.id);
  sec.audit(req.user.id, 'incident_status', `INC-${2000 + i.id} → ${status}`, req.orgId);
  res.json(incidentView(db.prepare('SELECT * FROM incidents WHERE id = ? AND org_id = ?').get(i.id, req.orgId)));
});

router.patch('/incidents/:id', sec.requireRole('lead'), (req, res) => {
  const i = db.prepare('SELECT * FROM incidents WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!i) return httpError(res, 404, 'incident not found');
  const b = req.body || {};
  const rca = b.rca || {};
  for (const f of ['summary', 'impact', 'rootCause', 'resolution', 'actions']) {
    if (!optStr(rca[f], 10000)) return httpError(res, 400, 'RCA field too long');
  }
  db.prepare(`UPDATE incidents SET
      title = COALESCE(?, title), severity = COALESCE(?, severity),
      published = COALESCE(?, published),
      rca_summary = COALESCE(?, rca_summary), rca_impact = COALESCE(?, rca_impact),
      rca_root_cause = COALESCE(?, rca_root_cause), rca_resolution = COALESCE(?, rca_resolution),
      rca_actions = COALESCE(?, rca_actions)
    WHERE id = ? AND org_id = ?`)
    .run(isStr(b.title, 200) ? b.title : null,
      Number.isFinite(b.severity) ? clampInt(b.severity, 0, 100, 50) : null,
      typeof b.published === 'boolean' ? (b.published ? 1 : 0) : null,
      rca.summary ?? null, rca.impact ?? null, rca.rootCause ?? null,
      rca.resolution ?? null, rca.actions ?? null, i.id, req.orgId);
  sec.audit(req.user.id, 'incident_update', `INC-${2000 + i.id}`, req.orgId);
  res.json(incidentView(db.prepare('SELECT * FROM incidents WHERE id = ? AND org_id = ?').get(i.id, req.orgId)));
});

module.exports = router;
