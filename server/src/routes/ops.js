'use strict';
// Session-authenticated operations API: events, cases, logs, dashboard,
// analytics, alert rules, notifications, incidents, live stream (SSE).
const express = require('express');
const crypto = require('crypto');
// The shim is bound to `store` rather than the usual `q`: GET /logs already has a
// local `q` (the search term), and a module-scope statement table shadowed by a
// local would turn a statement lookup into a query-parameter lookup silently.
const store = require('../db/shim');
const { now, sha256, clampInt, isStr, optStr, httpError, SseHub, RateLimiter, isId, utcDaySql, utcDayLabel } = require('../util');
const config = require('../config');
const sec = require('../security');
const pipeline = require('../engine/pipeline');
const inc = require('../lib/incidents');
const cases = require('../lib/cases');
const chain = require('../engine/alert-chain');

const router = express.Router();
router.use(sec.requireSessionOrToken);

const hub = new SseHub();
pipeline.on('log', (l) => hub.broadcast('log', l, l.orgId));
// `publicEvent` reads the assignee row, so it is async since the shim conversion
// while `emit()` is still a SYNCHRONOUS fan-out (engine/pipeline.js) whose
// per-listener try/catch cannot see a rejected promise. The catch is therefore
// spelled out here, and it logs exactly what emit's own catch logged — otherwise
// a failed lookup on the SSE path would become an unhandledRejection and, under
// NODE_ENV=test, take the process down. `hub.broadcast` itself stays
// synchronous: the row is resolved in the argument expression, so the frame is
// still written in one go.
pipeline.on('event', async (e) => {
  try { hub.broadcast('event', await publicEvent(e), e.org_id); } catch (err) { console.error('listener error', err); }
});

const userLite = store.prepare('SELECT id, name, color FROM users WHERE id = ?');
// org-scoped existence check used to validate assignees (tenant isolation):
// a user may act in this org only if they hold a membership in it.
const userInOrg = store.prepare('SELECT user_id AS id FROM memberships WHERE user_id = ? AND org_id = ?');
function initials(name) {
  return name.split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
}
async function assignedView(userId) {
  if (!userId) return null;
  const u = await userLite.get(userId);
  return u ? { id: u.id, n: u.name, i: initials(u.name), c: u.color } : null;
}
async function publicEvent(e) {
  return {
    id: e.id, name: e.name, device: e.device, ip: e.ip, target: e.target,
    description: e.description, severity: e.severity, hits: e.hits, status: e.status,
    firstSeen: e.first_seen, lastSeen: e.last_seen,
    assigned: await assignedView(e.assigned_user_id),
  };
}

/**
 * The 10-point cumulative sparkline the UI draws, per event id, from the last 30
 * minutes of per-minute buckets. One query for however many events are passed.
 *
 * Shared on purpose: only the LIST endpoint used to compute this, so the slide-over
 * asked for one event, got no `spark`, and drew its HIT TREND as an empty box —
 * a hole nothing could report, because the same panel on the same screen showed a
 * correct sparkline in the row behind it.
 */
async function sparksFor(rows) {
  const out = new Map();
  if (!rows.length) return out;
  const ids = rows.map((r) => r.id);
  const nowMin = Math.floor(now() / 60000);
  const bRows = await store.prepare(`SELECT event_id, bucket, count FROM event_buckets
    WHERE bucket >= ? AND event_id IN (${ids.map(() => '?').join(',')})`)
    .all(nowMin - 30, ...ids);
  const byEvent = new Map();
  for (const b of bRows) {
    if (!byEvent.has(b.event_id)) byEvent.set(b.event_id, []);
    byEvent.get(b.event_id).push([b.bucket, b.count]);
  }
  for (const e of rows) {
    const buckets = Array(30).fill(0);
    for (const [bucket, count] of (byEvent.get(e.id) || [])) {
      const idx = 29 - (nowMin - bucket);
      if (idx >= 0 && idx < 30) buckets[idx] = count;
    }
    const spark = [];
    let acc = Math.max(0, e.hits - buckets.reduce((a, b) => a + b, 0));
    for (let i = 0; i < 30; i += 3) {
      acc += buckets.slice(i, i + 3).reduce((a, b) => a + b, 0);
      spark.push(acc);
    }
    out.set(e.id, spark);
  }
  return out;
}

// ---- live stream ----
router.get('/stream', (req, res) => hub.handler(req, res, req.orgId));

// ---- team roster (lightweight; any session) ----
// Assignee pickers need names/colors without exposing emails or last-seen —
// the full user list stays behind lead+ in /api/admin/users.
router.get('/team', async (req, res) => {
  res.json((await store.prepare(`SELECT u.id, u.name, u.color, m.role FROM memberships m
    JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND u.active = 1 ORDER BY u.name`).all(req.orgId))
    .map((u) => ({ id: u.id, name: u.name, i: initials(u.name), color: u.color, role: u.role })));
});

// ---- events ----
router.get('/events', async (req, res) => {
  const status = ['active', 'finished', 'downgraded', 'all'].includes(req.query.status)
    ? req.query.status : 'active';
  const limit = clampInt(req.query.limit, 1, 500, 200);
  const rows = status === 'all'
    ? await store.prepare('SELECT * FROM events WHERE org_id = ? ORDER BY severity DESC, last_seen DESC LIMIT ?').all(req.orgId, limit)
    : await store.prepare('SELECT * FROM events WHERE status = ? AND org_id = ? ORDER BY severity DESC, last_seen DESC LIMIT ?')
        .all(status, req.orgId, limit);
  const sparks = await sparksFor(rows);
  res.json(await Promise.all(rows.map(async (e) => ({ ...(await publicEvent(e)), spark: sparks.get(e.id) }))));
});

/**
 * Who did what to this event, oldest first.
 *
 * The "detected" entry is DERIVED from `events.first_seen` rather than written at
 * ingest: it is true for every event that ever existed, including the ones that
 * predate the table, so no backfill can be wrong or missing. Everything after it is
 * a real recorded action.
 *
 * It carries no severity ON PURPOSE. `events.severity` is the CURRENT value, so a
 * derived line reading "detected — severity 67" claimed as fact something that only
 * became true after a downgrade an hour later. A derived entry may only state what
 * the row it is derived from actually proves; the severity's own history is the
 * downgrade entries ("92 → 67"), which are recorded, not inferred.
 */
async function timelineFor(e) {
  const rows = await store.prepare(`SELECT ts, user_id, action, detail FROM event_timeline
    WHERE event_id = ? AND org_id = ? ORDER BY ts, id`).all(e.id, e.org_id);
  return [
    { ts: e.first_seen, user: null, action: 'detected', detail: null },
    ...await Promise.all(rows.map(async (r) => ({
      ts: r.ts, user: await assignedView(r.user_id), action: r.action, detail: r.detail,
    }))),
  ];
}

/** Append one entry. `userId` null means the platform acted, not a person. */
async function recordEvent(orgId, eventId, userId, action, detail) {
  await store.prepare(`INSERT INTO event_timeline (org_id, event_id, ts, user_id, action, detail)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(orgId, eventId, now(), userId || null, action, detail ? String(detail).slice(0, 2000) : null);
}

/**
 * Add one note to the open case of an event — an APPEND, done in SQL.
 *
 * `cases.note` is the text the Cases page shows and lets an operator edit, and
 * every writer of it but one used `SET note = ?`: two people typing into the
 * same case at the same moment leave one of them with no note, no error and no
 * way to tell it happened. Reading the column and concatenating in JS does not
 * fix that, it only narrows the window — the concatenation has to BE the write.
 * The model is `closeWithNote` in lib/cases.js, which is where this belongs and
 * where it should move (replacing the now-callerless `setNoteForEvent`) the next
 * time that file is open; it lives here meanwhile so the panel and the MCP tool
 * share one implementation rather than growing two.
 *
 * The newline is BOUND, not spelled: SQLite has `char(10)`, Postgres `chr(10)`,
 * and a parameter needs neither. `NULLIF(note, '')` is what keeps an empty
 * column from yielding a leading blank line — same expression as the incident
 * note append in lib/incidents.js, deliberately character for character.
 */
const appendNoteStmt = store.prepare(`UPDATE cases SET note = COALESCE(NULLIF(note, '') || ?, '') || ?
  WHERE event_id = ? AND org_id = ? AND status != 'closed'`);
async function appendCaseNote(orgId, eventId, note) {
  return (await appendNoteStmt.run('\n', note, eventId, orgId)).changes;
}

router.get('/events/:id', async (req, res) => {
  const e = await store.prepare('SELECT * FROM events WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!e) return httpError(res, 404, 'event not found');
  const logs = await store.prepare(`SELECT ts, device, line, sev FROM logs
    WHERE device = ? AND org_id = ? ORDER BY ts DESC LIMIT 20`).all(e.device, req.orgId);
  const caseRow = await store.prepare('SELECT id, status FROM cases WHERE event_id = ? AND org_id = ? ORDER BY id DESC LIMIT 1')
    .get(e.id, req.orgId);
  res.json({ ...(await publicEvent(e)), spark: (await sparksFor([e])).get(e.id), recentLogs: logs,
    timeline: await timelineFor(e),
    case: caseRow ? { label: `C-${1000 + caseRow.id}`, id: caseRow.id, status: caseRow.status } : null });
});

router.post('/events/:id/action', async (req, res) => {
  const e = await store.prepare('SELECT * FROM events WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!e) return httpError(res, 404, 'event not found');
  const { action } = req.body || {};
  const t = now();
  // Every branch below is an at-most-once gate: the condition that decides
  // whether the action is still possible lives in the UPDATE's own WHERE, and
  // `changes` is the answer. Read the row, decide in JS, then write, and the
  // 409s CLAUDE.md mandates ("an action that cannot change anything is disabled
  // AND refused") stop refusing the moment an `await` lands between the read and
  // the write: four parallel finish clicks all read status='active', all four
  // answer 200, and the history shows four people closing one event.
  // e2e-concurrency.js is the standing assertion on exactly this.
  if (action === 'finish') {
    const w = await store.prepare(`UPDATE events SET status = 'finished', finished_at = ?, finished_by = ?
      WHERE id = ? AND org_id = ? AND status != 'finished'`).run(t, req.user.id, e.id, req.orgId);
    // already finished: nothing to do, and recording a second "finished" would put a
    // line in the history for a click that changed nothing
    if (w.changes !== 1) return httpError(res, 409, 'event already finished');
    // through lib/cases so the alert chain stops in the same breath — the
    // problem is over, and second line must not be woken about it five minutes
    // from now (docs/ONCALL-V1.md §5)
    await cases.closeForEvent(req.orgId, e.id, { at: t });
    await recordEvent(req.orgId, e.id, req.user.id, 'finish', null);
  } else if (action === 'downgrade') {
    if (e.severity <= 10) return httpError(res, 409, 'severity is already at the floor');
    const newSev = Math.max(10, e.severity - 25);
    // compare-and-swap on the severity we read, rather than a blind SET: the
    // timeline entry names a BEFORE and an AFTER, and it may only claim the pair
    // that actually happened. Two overlapping downgrades of a 90 would otherwise
    // both write 65 and record "90 → 65" twice for one 25-point drop.
    const w = await store.prepare('UPDATE events SET severity = ? WHERE id = ? AND org_id = ? AND severity = ?')
      .run(newSev, e.id, req.orgId, e.severity);
    if (w.changes !== 1) return httpError(res, 409, 'severity changed while this was open — reload');
    await recordEvent(req.orgId, e.id, req.user.id, 'downgrade', `${e.severity} → ${newSev}`);
  } else if (action === 'assign') {
    const uid = req.body.userId || req.user.id;
    // awaited deliberately: `!aPromise` is `false`, so a missed await here does
    // not weaken this guard, it DELETES it — any string would name a member of
    // this org. The type gate cannot see a boolean context (CLAUDE.md § the
    // async conversion), so this one is checked by hand.
    if (!await userInOrg.get(uid, req.orgId)) return httpError(res, 400, 'unknown user');
    // `assigned_user_id != ?` is NULL, not true, for an unassigned event — SQL
    // three-valued logic, so the unassigned case is spelled out or nobody can
    // ever take the first assignment.
    const w = await store.prepare(`UPDATE events SET assigned_user_id = ?
      WHERE id = ? AND org_id = ? AND (assigned_user_id IS NULL OR assigned_user_id <> ?)`)
      .run(uid, e.id, req.orgId, uid);
    if (w.changes !== 1) return httpError(res, 409, 'already assigned to that user');
    await cases.assignForEvent(req.orgId, e.id, uid);
    // who it went TO, since that is not always who clicked
    const to = await assignedView(uid);
    await recordEvent(req.orgId, e.id, req.user.id, 'assign', to ? to.n : null);
  } else if (action === 'note') {
    if (!isStr(req.body.note, 2000)) return httpError(res, 400, 'note required');
    // Appended, never overwritten: cases.note is what the Cases page shows and
    // edits, and a second operator's note used to replace the first one's with
    // no error anywhere. The timeline still keeps each note with its author.
    await appendCaseNote(req.orgId, e.id, req.body.note);
    await recordEvent(req.orgId, e.id, req.user.id, 'note', req.body.note);
  } else {
    return httpError(res, 400, 'unknown action');
  }
  sec.audit(req.user.id, `event_${action}`, `event ${e.id} ${e.name}@${e.device}`, req.orgId);
  const updated = await store.prepare('SELECT * FROM events WHERE id = ? AND org_id = ?').get(e.id, req.orgId);
  // resolved in the argument expression: hub.broadcast writes the frame
  // synchronously and must never be handed a pending query
  hub.broadcast('event', await publicEvent(updated), req.orgId);
  res.json(await publicEvent(updated));
});

// ---- cases ----
router.get('/cases', async (req, res) => {
  const filter = ['open', 'assigned', 'closed', 'all'].includes(req.query.status)
    ? req.query.status : 'all';
  const limit = clampInt(req.query.limit, 1, 500, 200);
  const rows = filter === 'all'
    ? await store.prepare('SELECT * FROM cases WHERE org_id = ? ORDER BY opened_at DESC LIMIT ?').all(req.orgId, limit)
    : await store.prepare('SELECT * FROM cases WHERE status = ? AND org_id = ? ORDER BY opened_at DESC LIMIT ?').all(filter, req.orgId, limit);
  const t = now();
  // Live alerts in ONE query, not one per row: "is anybody being woken about
  // this case, and how far up the ladder are we" belongs next to the case, and
  // it is the column a NOC reads first during a handover.
  const live = new Map();
  for (const a of await store.prepare(`SELECT * FROM alerts WHERE org_id = ? AND subject_kind = 'case'
    AND status IN ('active','acked') ORDER BY created_at`).all(req.orgId)) live.set(a.subject_id, a);
  res.json(await Promise.all(rows.map(async (c) => ({
    id: c.id, label: cases.label(c.id), eventId: c.event_id, name: c.name, device: c.device,
    severity: c.severity, status: c.status, assigned: await assignedView(c.assigned_user_id),
    rootCause: c.root_cause, note: c.note, openedAt: c.opened_at, closedAt: c.closed_at,
    ackedAt: c.acked_at, ackedBy: await assignedView(c.acked_by),
    incident: await inc.incidentOfCase(c.id),
    alert: live.has(c.id) ? await chain.view(live.get(c.id)) : null,
    durationMs: (c.closed_at || t) - c.opened_at,
  }))));
});

// "I have seen it, stop ringing." Acknowledging the CASE acknowledges whatever
// is escalating about it — the two are the same statement made from different
// screens, and a button that stopped one but not the other would be a trap.
// Deliberately does not assign (docs/ONCALL-V1.md §13.4).
router.post('/cases/:id/ack', async (req, res) => {
  const c = await cases.byId(req.orgId, req.params.id);
  if (!c) return httpError(res, 404, 'case not found');
  const first = await cases.acknowledge(req.orgId, c.id, req.user.id);
  const live = await store.prepare(`SELECT id FROM alerts WHERE org_id = ? AND subject_kind = 'case'
    AND subject_id = ? AND status = 'active'`).all(req.orgId, c.id);
  for (const a of live) await chain.ack(req.orgId, a.id, req.user.id, 'case');
  // Already acknowledged AND nothing left ringing: the click changed nothing,
  // and saying so is the whole point of the 409.
  if (!first && !live.length) return httpError(res, 409, 'case is already acknowledged');
  if (c.event_id) await recordEvent(req.orgId, c.event_id, req.user.id, 'acknowledge', null);
  sec.audit(req.user.id, 'case_ack', `case ${c.id}`, req.orgId);
  res.json({ ok: true, ackedAlerts: live.length });
});

router.patch('/cases/:id', async (req, res) => {
  const c = await store.prepare('SELECT * FROM cases WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!c) return httpError(res, 404, 'case not found');
  const { status, assignedUserId, rootCause, note } = req.body || {};
  if (status && !['open', 'assigned', 'closed'].includes(status)) return httpError(res, 400, 'bad status');
  if (!optStr(rootCause, 200) || !optStr(note, 2000)) return httpError(res, 400, 'bad fields');
  // awaited by hand — see the assign branch above: unawaited, this guard is
  // `!Promise`, i.e. always false, and any id at all becomes a valid assignee.
  if (assignedUserId && !await userInOrg.get(assignedUserId, req.orgId)) return httpError(res, 400, 'unknown user');
  await cases.update(req.orgId, c.id, { status, assignedUserId, rootCause, note });
  // The Cases editor writes the SAME `cases.note` column the slide-over does, so a
  // note typed here has to reach the same history — otherwise "who wrote this?" has
  // a different answer depending on which screen it was written from. Only what
  // actually changed is recorded; re-saving a form must not fill the timeline with
  // lines about fields nobody touched.
  if (c.event_id) {
    if (note != null && note !== c.note) await recordEvent(req.orgId, c.event_id, req.user.id, 'note', note);
    if (status && status !== c.status) {
      await recordEvent(req.orgId, c.event_id, req.user.id, 'case_status', `${c.status} → ${status}`);
    }
    if (assignedUserId && assignedUserId !== c.assigned_user_id) {
      const to = await assignedView(assignedUserId);
      await recordEvent(req.orgId, c.event_id, req.user.id, 'assign', to ? to.n : null);
    }
    if (rootCause != null && rootCause !== c.root_cause) {
      await recordEvent(req.orgId, c.event_id, req.user.id, 'root_cause', rootCause);
    }
  }
  sec.audit(req.user.id, 'case_update', `case ${c.id}`, req.orgId);
  res.json({ ok: true });
});

// ---- logs ----
// `hours` is the relative window the page has always used. `from`/`to` are an
// ABSOLUTE window, which is what a link from elsewhere needs: "the lines behind
// this Scout template" and "the lines in the spike you dragged over on the
// throughput chart" both name a fixed span in the past, and re-deriving it as
// "hours ago" turns stale the moment the tab is left open.
router.get('/logs', async (req, res) => {
  const limit = clampInt(req.query.limit, 1, 1000, 300);
  // NB: this `q` is the SEARCH TERM, which is why the shim is imported as
  // `store` in this file — a module-scope `q` shadowed here would silently turn
  // every statement lookup in this handler into a lookup on a string.
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
  const t = now();
  const from = clampInt(req.query.from, 0, Number.MAX_SAFE_INTEGER, 0);
  const to = clampInt(req.query.to, 0, Number.MAX_SAFE_INTEGER, 0);
  const since = from || t - clampInt(req.query.hours, 1, 720, 2) * 3600000;
  const until = to || Number.MAX_SAFE_INTEGER;
  const where = 'ts >= ? AND ts <= ? AND org_id = ?';
  const args = [since, until, req.orgId];
  const rows = q
    // plain substring match (safe); regex filtering happens client-side
    ? await store.prepare(`SELECT ts, device, line, sev FROM logs
        WHERE ${where} AND (lower(line) LIKE lower(?) OR lower(device) LIKE lower(?)) ORDER BY ts DESC LIMIT ?`)
      .all(...args, `%${q}%`, `%${q}%`, limit)
    : await store.prepare(`SELECT ts, device, line, sev FROM logs
        WHERE ${where} ORDER BY ts DESC LIMIT ?`).all(...args, limit);
  res.json(rows);
});

// ---- dashboard + analytics ----
router.get('/dashboard', async (req, res) => {
  const t = now();
  const sevCounts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const r of await store.prepare(`SELECT CASE WHEN severity >= 80 THEN 'critical' WHEN severity >= 60 THEN 'high'
      WHEN severity >= 40 THEN 'medium' WHEN severity >= 20 THEN 'low' ELSE 'info' END AS band, COUNT(*) c
      FROM events WHERE status = 'active' AND org_id = ? GROUP BY band`).all(req.orgId)) {
    sevCounts[r.band] = r.c;
  }
  const openCases = (await store.prepare("SELECT COUNT(*) c FROM cases WHERE status != 'closed' AND org_id = ?").get(req.orgId)).c;
  const mttr = (await store.prepare(`SELECT AVG(closed_at - opened_at) v FROM cases
    WHERE status = 'closed' AND closed_at >= ? AND org_id = ?`).get(t - 7 * 86400000, req.orgId)).v;
  const logs24 = (await store.prepare('SELECT COUNT(*) c FROM logs WHERE ts >= ? AND org_id = ?').get(t - 86400000, req.orgId)).c;
  const events24 = (await store.prepare('SELECT COUNT(*) c FROM events WHERE last_seen >= ? AND org_id = ?').get(t - 86400000, req.orgId)).c;
  const casesByAnalyst = (await store.prepare(`SELECT u.id, u.name, u.color, COUNT(*) c FROM cases
    JOIN users u ON u.id = cases.assigned_user_id
    WHERE cases.opened_at >= ? AND cases.org_id = ? GROUP BY u.id ORDER BY c DESC LIMIT 8`).all(t - 7 * 86400000, req.orgId))
    .map((r) => ({ name: r.name, i: initials(r.name), color: r.color, count: r.c }));
  res.json({ sevCounts, openCases, mttrMs: mttr || 0, logs24, events24, casesByAnalyst });
});

router.get('/analytics', async (req, res) => {
  const range = { '24h': 1, '7d': 7, '30d': 30 }[req.query.range] || 7;
  const t = now();
  const since = t - range * 86400000;
  // The bucket is integer arithmetic, not a date function — see utcDaySql in
  // util.js for why neither engine gets to decide what a day is. Pinned by
  // e2e-pipeline, which puts a row 30 minutes either side of midnight UTC.
  const volume = (await store.prepare(`SELECT ${utcDaySql('ts')} bucket,
      SUM(CASE WHEN sev <= 2 THEN 1 ELSE 0 END) c,
      SUM(CASE WHEN sev = 3 THEN 1 ELSE 0 END) h,
      SUM(CASE WHEN sev = 4 THEN 1 ELSE 0 END) m,
      SUM(CASE WHEN sev >= 5 THEN 1 ELSE 0 END) l
    FROM logs WHERE ts >= ? AND org_id = ? GROUP BY bucket ORDER BY bucket`)
    .all(since, req.orgId))
    .map((r) => ({ d: utcDayLabel(r.bucket), c: r.c, h: r.h, m: r.m, l: r.l }));
  // The bucket is integer arithmetic, not a date function — see utcDaySql in
  // util.js for why neither engine gets to decide what a day is. Pinned by
  // e2e-pipeline, which puts a row 30 minutes either side of midnight UTC.
  const mttrDaily = (await store.prepare(`SELECT ${utcDaySql('closed_at')} bucket,
      AVG(closed_at - opened_at) v FROM cases
    WHERE status = 'closed' AND closed_at >= ? AND org_id = ? GROUP BY bucket ORDER BY bucket`)
    .all(since, req.orgId))
    .map((r) => ({ d: utcDayLabel(r.bucket), v: r.v }));
  const topTypes = await store.prepare(`SELECT name n, COUNT(*) v FROM events WHERE last_seen >= ? AND org_id = ?
    GROUP BY name ORDER BY v DESC LIMIT 8`).all(since, req.orgId);
  const topServers = await store.prepare(`SELECT device n, COUNT(*) v FROM events WHERE last_seen >= ? AND org_id = ?
    GROUP BY device ORDER BY v DESC LIMIT 8`).all(since, req.orgId);
  const totals = {
    events: (await store.prepare('SELECT COUNT(*) c FROM events WHERE last_seen >= ? AND org_id = ?').get(since, req.orgId)).c,
    mttrMs: (await store.prepare(`SELECT AVG(closed_at - opened_at) v FROM cases
      WHERE status = 'closed' AND closed_at >= ? AND org_id = ?`).get(since, req.orgId)).v || 0,
    resolutionRate: await (async () => {
      const r = await store.prepare(`SELECT
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) closed, COUNT(*) total
        FROM cases WHERE opened_at >= ? AND org_id = ?`).get(since, req.orgId);
      return r.total ? Math.round((r.closed / r.total) * 100) : 100;
    })(),
    notifications: (await store.prepare('SELECT COUNT(*) c FROM notifications WHERE ts >= ? AND org_id = ?').get(since, req.orgId)).c,
    notificationsFailed: (await store.prepare('SELECT COUNT(*) c FROM notifications WHERE ts >= ? AND ok = 0 AND org_id = ?')
      .get(since, req.orgId)).c,
  };
  res.json({ volume, mttrDaily, topTypes, topServers, totals });
});

// ---- alert rules + notifications ----
const RULE_CHANNELS = ['email', 'msteams', 'webhook', 'slack', 'telegram', 'discord', 'ntfy', 'pushover'];
// A rule either notifies a CHANNEL or raises an ALERT against an escalation
// policy (docs/ONCALL-V1.md §8). The column defaults to 'channel', so every
// rule written before On-Call existed keeps its behaviour untouched.
const RULE_TARGETS = ['channel', 'policy'];
const policyOfOrg = store.prepare('SELECT id FROM escalation_policies WHERE id = ? AND org_id = ?');

router.get('/rules', async (req, res) => {
  const rules = (await store.prepare('SELECT * FROM alert_rules WHERE org_id = ? ORDER BY id').all(req.orgId))
    .map((r) => ({ id: r.id, name: r.name, enabled: !!r.enabled, channel: r.channel,
      triggerName: r.trigger_name, severityMin: r.severity_min, cooldownM: r.cooldown_m,
      targetType: r.target_type || 'channel', policyId: r.policy_id,
      recipients: JSON.parse(r.recipients || '[]') }));
  res.json(rules);
});

router.post('/rules', sec.requireRole('lead'), async (req, res) => {
  const { name, channel, triggerName, severityMin, cooldownM, recipients, targetType, policyId } = req.body || {};
  if (!isStr(name, 100)) return httpError(res, 400, 'name required');
  if (!RULE_CHANNELS.includes(channel)) return httpError(res, 400, 'bad channel');
  const target = RULE_TARGETS.includes(targetType) ? targetType : 'channel';
  // A policy rule with no policy would look configured and reach nobody.
  // (awaited by hand: boolean context, invisible to the type gate)
  if (target === 'policy' && !await policyOfOrg.get(policyId, req.orgId)) {
    return httpError(res, 400, 'unknown escalation policy');
  }
  const rec = Array.isArray(recipients) ? recipients.filter((r) => typeof r === 'string').slice(0, 20) : [];
  const id = await store.prepare(`INSERT INTO alert_rules (org_id, name, enabled, channel, trigger_name, severity_min,
    cooldown_m, recipients, target_type, policy_id, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .insert(req.orgId, name, channel, optStr(triggerName, 100) && triggerName ? triggerName : null,
      clampInt(severityMin, 0, 100, 60), clampInt(cooldownM, 1, 1440, 15), JSON.stringify(rec),
      target, target === 'policy' ? Number(policyId) : null, now());
  sec.audit(req.user.id, 'rule_create', name, req.orgId);
  res.json({ id });
});

router.patch('/rules/:id', sec.requireRole('lead'), async (req, res) => {
  const r = await store.prepare('SELECT * FROM alert_rules WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!r) return httpError(res, 404, 'rule not found');
  const b = req.body || {};
  const rec = Array.isArray(b.recipients)
    ? JSON.stringify(b.recipients.filter((x) => typeof x === 'string').slice(0, 20)) : null;
  const target = RULE_TARGETS.includes(b.targetType) ? b.targetType : null;
  // The target and its policy move together: switching a rule to 'policy'
  // without naming one would leave it enabled, matching, and silent.
  const nextTarget = target || r.target_type || 'channel';
  const nextPolicy = b.policyId === undefined ? r.policy_id : Number(b.policyId);
  // (awaited by hand: boolean context, invisible to the type gate)
  if (nextTarget === 'policy' && !await policyOfOrg.get(nextPolicy, req.orgId)) {
    return httpError(res, 400, 'unknown escalation policy');
  }
  await store.prepare(`UPDATE alert_rules SET
      name = COALESCE(?, name), enabled = COALESCE(?, enabled), channel = COALESCE(?, channel),
      trigger_name = CASE WHEN ? THEN ? ELSE trigger_name END,
      severity_min = COALESCE(?, severity_min), cooldown_m = COALESCE(?, cooldown_m),
      recipients = COALESCE(?, recipients), target_type = ?, policy_id = ?
    WHERE id = ? AND org_id = ?`)
    .run(isStr(b.name, 100) ? b.name : null,
      typeof b.enabled === 'boolean' ? (b.enabled ? 1 : 0) : null,
      RULE_CHANNELS.includes(b.channel) ? b.channel : null,
      b.triggerName !== undefined ? 1 : 0, b.triggerName || null,
      Number.isFinite(b.severityMin) ? clampInt(b.severityMin, 0, 100, 60) : null,
      Number.isFinite(b.cooldownM) ? clampInt(b.cooldownM, 1, 1440, 15) : null,
      rec, nextTarget, nextTarget === 'policy' ? nextPolicy : null, r.id, req.orgId);
  sec.audit(req.user.id, 'rule_update', `rule ${r.id}`, req.orgId);
  res.json({ ok: true });
});

router.delete('/rules/:id', sec.requireRole('lead'), async (req, res) => {
  await store.prepare('DELETE FROM alert_rules WHERE id = ? AND org_id = ?').run(req.params.id, req.orgId);
  sec.audit(req.user.id, 'rule_delete', `rule ${req.params.id}`, req.orgId);
  res.json({ ok: true });
});

// Fire a clearly-marked synthetic event through a rule's REAL channel so the
// configuration is verifiable without waiting for a genuine alert. Uses the
// exact dispatch path production uses; no dedupe/cooldown state is touched,
// and the attempt lands in the notification log tagged "(test)".
const alerts = require('../engine/alerts');
const testAlertLimiter = new RateLimiter({ perMinute: 6, burst: 3 });
const insTestNotif = store.prepare(`INSERT INTO notifications
  (org_id, ts, rule_id, rule_name, event_id, case_label, channel, ok, error)
  VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)`);

router.post('/rules/:id/test', sec.requireRole('lead'), async (req, res) => {
  const rule = await store.prepare('SELECT * FROM alert_rules WHERE id = ? AND org_id = ?')
    .get(req.params.id, req.orgId);
  if (!rule) return httpError(res, 404, 'rule not found');
  if (!testAlertLimiter.allow(`o${req.orgId}`)) return httpError(res, 429, 'rate limit exceeded');
  const ev = {
    id: 0,
    name: 'TEST ALERT',
    device: 'opscat-test',
    ip: null,
    target: null,
    severity: Math.max(rule.severity_min || 0, 60),
    hits: 1,
    description: `Test alert for rule "${rule.name}", sent by `
      + `${req.user.name || req.user.email}. If you can read this, the channel works. No action needed.`,
    last_seen: now(),
  };
  const t0 = Date.now();
  try {
    await alerts.dispatch(rule, ev);
    await insTestNotif.run(req.orgId, now(), rule.id, `${rule.name} (test)`, rule.channel, 1, null);
    sec.audit(req.user.id, 'rule_test', `rule ${rule.id} (${rule.channel}) ok`, req.orgId);
    res.json({ ok: true, channel: rule.channel, latencyMs: Date.now() - t0 });
  } catch (e) {
    const msg = String(e.message).slice(0, 300);
    await insTestNotif.run(req.orgId, now(), rule.id, `${rule.name} (test)`, rule.channel, 0, msg);
    sec.audit(req.user.id, 'rule_test', `rule ${rule.id} (${rule.channel}) failed`, req.orgId);
    httpError(res, 502, msg);
  }
});

router.get('/notifications', async (req, res) => {
  const rows = await store.prepare('SELECT * FROM notifications WHERE org_id = ? ORDER BY ts DESC LIMIT 50').all(req.orgId);
  res.json(rows.map((n) => ({ ts: n.ts, rule: n.rule_name, event: n.case_label || (n.event_id ? `E-${n.event_id}` : ''),
    channel: n.channel, ok: !!n.ok, error: n.error })));
});

// ---- heartbeats (dead-man's-switch monitors) ----
function heartbeatStatus(hb, t) {
  const base = hb.last_ping_at || hb.created_at;
  if (!hb.enabled) return 'disabled';
  if (t > base + (hb.interval_s + hb.grace_s) * 1000) return 'missing';
  if (t > base + hb.interval_s * 1000) return 'late';
  return hb.last_ping_at ? 'ok' : 'waiting';
}

router.get('/heartbeats', async (req, res) => {
  const t = now();
  res.json((await store.prepare('SELECT * FROM heartbeats WHERE org_id = ? ORDER BY id').all(req.orgId))
    .map((hb) => ({ id: hb.id, name: hb.name, intervalS: hb.interval_s, graceS: hb.grace_s,
      enabled: !!hb.enabled, lastPingAt: hb.last_ping_at, status: heartbeatStatus(hb, t) })));
});

router.post('/heartbeats', sec.requireRole('lead'), async (req, res) => {
  const { name, intervalS, graceS } = req.body || {};
  if (!isStr(name, 100)) return httpError(res, 400, 'name required');
  const token = 'och_' + crypto.randomBytes(24).toString('hex');
  const id = await store.prepare(`INSERT INTO heartbeats (org_id, name, token_hash, interval_s, grace_s,
    enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)`)
    .insert(req.orgId, name, sha256(token), clampInt(intervalS, 30, 30 * 86400, 3600),
      clampInt(graceS, 0, 86400, 300), now());
  sec.audit(req.user.id, 'heartbeat_create', name, req.orgId);
  // ping URL returned once — only the token hash is stored
  res.json({ id, pingUrl: `${config.baseUrl}/v1/heartbeat/${token}` });
});

router.patch('/heartbeats/:id', sec.requireRole('lead'), async (req, res) => {
  const hb = await store.prepare('SELECT * FROM heartbeats WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!hb) return httpError(res, 404, 'heartbeat not found');
  const b = req.body || {};
  await store.prepare(`UPDATE heartbeats SET name = COALESCE(?, name), enabled = COALESCE(?, enabled),
      interval_s = COALESCE(?, interval_s), grace_s = COALESCE(?, grace_s) WHERE id = ? AND org_id = ?`)
    .run(isStr(b.name, 100) ? b.name : null,
      typeof b.enabled === 'boolean' ? (b.enabled ? 1 : 0) : null,
      Number.isFinite(b.intervalS) ? clampInt(b.intervalS, 30, 30 * 86400, 3600) : null,
      Number.isFinite(b.graceS) ? clampInt(b.graceS, 0, 86400, 300) : null, hb.id, req.orgId);
  sec.audit(req.user.id, 'heartbeat_update', hb.name, req.orgId);
  res.json({ ok: true });
});

router.delete('/heartbeats/:id', sec.requireRole('lead'), async (req, res) => {
  await store.prepare('DELETE FROM heartbeats WHERE id = ? AND org_id = ?').run(req.params.id, req.orgId);
  sec.audit(req.user.id, 'heartbeat_delete', `heartbeat ${req.params.id}`, req.orgId);
  res.json({ ok: true });
});

// ---- maintenance windows (planned work: alerts suppressed while active) ----
router.get('/maintenance', async (req, res) => {
  const t = now();
  res.json((await store.prepare('SELECT * FROM maintenance_windows WHERE org_id = ? ORDER BY starts_at DESC').all(req.orgId))
    .map((w) => ({ id: w.id, name: w.name, startsAt: w.starts_at, endsAt: w.ends_at,
      active: w.starts_at <= t && w.ends_at >= t })));
});

router.post('/maintenance', sec.requireRole('lead'), async (req, res) => {
  const { name, startsAt, endsAt } = req.body || {};
  if (!isStr(name, 100)) return httpError(res, 400, 'name required');
  const s = Number(startsAt);
  const e = Number(endsAt);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) {
    return httpError(res, 400, 'startsAt/endsAt required (ms epoch, endsAt > startsAt)');
  }
  if (e - s > 30 * 86400000) return httpError(res, 400, 'window longer than 30 days');
  const id = await store.prepare(`INSERT INTO maintenance_windows (org_id, name, starts_at, ends_at, created_at)
    VALUES (?, ?, ?, ?, ?)`).insert(req.orgId, name, s, e, now());
  sec.audit(req.user.id, 'maintenance_create', name, req.orgId);
  res.json({ id });
});

router.delete('/maintenance/:id', sec.requireRole('lead'), async (req, res) => {
  await store.prepare('DELETE FROM maintenance_windows WHERE id = ? AND org_id = ?').run(req.params.id, req.orgId);
  sec.audit(req.user.id, 'maintenance_delete', `window ${req.params.id}`, req.orgId);
  res.json({ ok: true });
});

// ---- status-page user reports (submitted anonymously on /status) ----
router.get('/status-reports', async (req, res) => {
  const hours = clampInt(req.query.hours, 1, 720, 24);
  const since = now() - hours * 3600000;
  const rows = (await store.prepare(`SELECT r.ts, r.message, c.name AS component
    FROM status_reports r LEFT JOIN components c ON c.id = r.component_id
    WHERE r.org_id = ? AND r.ts >= ? ORDER BY r.ts DESC LIMIT 200`).all(req.orgId, since))
    .map((r) => ({ ts: r.ts, component: r.component, message: r.message }));
  const total = (await store.prepare('SELECT COUNT(*) c FROM status_reports WHERE org_id = ? AND ts >= ?')
    .get(req.orgId, since)).c;
  res.json({ total, reports: rows });
});

// ---- assets: every monitored counterparty in one list ----
// Agents, SNMP targets and synthetic checks are configured objects; "sources"
// are implicit — any device name seen in logs/events (SDK, OTLP, webhooks).
router.get('/assets', async (req, res) => {
  const t = now();
  const rows = [];
  const agents = await store.prepare('SELECT * FROM agents WHERE org_id = ?').all(req.orgId);
  const agentNames = new Set(agents.flatMap((a) => [a.name, a.hostname]).filter(Boolean));
  for (const a of agents) {
    rows.push({ kind: 'agent', id: a.id, name: a.name, detail: a.hostname || a.platform || '',
      status: !a.active ? 'disabled'
        : a.last_seen_at && t - a.last_seen_at < 3 * 60 * 1000 ? 'online' : 'offline',
      lastSeen: a.last_seen_at || null });
  }
  for (const s of await store.prepare('SELECT * FROM snmp_targets WHERE org_id = ?').all(req.orgId)) {
    rows.push({ kind: 'snmp', id: s.id, name: s.name, detail: `${s.host}:${s.port}`,
      status: !s.enabled ? 'disabled' : s.last_status === 'ok' ? 'ok' : (s.last_status || 'pending'),
      lastSeen: s.last_seen_at || null });
  }
  // `SELECT ok, meta, MAX(ts)` with no GROUP BY: SQLite has a documented extension
  // that picks ok/meta FROM the max-ts row, Postgres rejects the statement outright.
  // ORDER BY + LIMIT 1 says the same thing in both, and adds the tie-break SQLite
  // never had — `ts` is millisecond-resolution, so two results in the same
  // millisecond were previously resolved arbitrarily.
  // No-rows behaves identically: this returns undefined where the aggregate
  // returned an all-NULL row, and both callers already test `!last || last.ts == null`.
  const lastResult = store.prepare(`SELECT ok, meta, ts FROM synthetic_results
    WHERE check_id = ? ORDER BY ts DESC, id DESC LIMIT 1`);
  const everyLabel = (s) => (s >= 3600 && s % 3600 === 0 ? `every ${s / 3600}h`
    : s >= 3600 ? `every ${(s / 3600).toFixed(1)}h`
      : s >= 60 ? `every ${Math.round(s / 60)}m` : `every ${s}s`);
  for (const c of await store.prepare('SELECT * FROM synthetic_checks WHERE org_id = ?').all(req.orgId)) {
    const last = await lastResult.get(c.id);
    rows.push({
      kind: 'check', id: c.id, name: `${c.type} ${c.target}`,
      detail: `every ${c.interval_s}s`,
      status: !c.enabled ? 'disabled'
        : (!last || last.ts == null) ? 'pending' : last.ok ? 'ok' : 'failing',
      lastSeen: last ? last.ts : null,
    });
  }
  // Reputation is its own feature (own page, own tables) and surfaces as its own
  // kind — otherwise it hides among the reachability checks. The run's stored
  // status IS the asset status: the distinction that matters here, a real
  // listing versus a run that could not complete, was decided by the engine
  // when it had the evidence in hand, so nothing is reconstructed from a blob.
  const lastRepRun = store.prepare(
    'SELECT status, ts FROM reputation_runs WHERE asset_id = ? ORDER BY ts DESC, id DESC LIMIT 1');
  // 'clean' and 'informational' are both fine on an inventory screen; only a real
  // listing or an incomplete run deserve attention here.
  const REP_STATUS = { clean: 'ok', informational: 'ok', listed: 'listed', unknown: 'unknown' };
  for (const a of await store.prepare('SELECT * FROM reputation_assets WHERE org_id = ?').all(req.orgId)) {
    const run = await lastRepRun.get(a.id);
    rows.push({
      kind: 'reputation', id: a.id, name: a.target,
      detail: `blocklists · ${everyLabel(a.interval_s)}`,
      status: !a.enabled ? 'disabled' : run ? (REP_STATUS[run.status] || run.status) : 'pending',
      lastSeen: run ? run.ts : null,
    });
  }
  for (const hb of await store.prepare('SELECT * FROM heartbeats WHERE org_id = ?').all(req.orgId)) {
    rows.push({ kind: 'heartbeat', id: hb.id, name: hb.name, detail: `every ${hb.interval_s}s (+${hb.grace_s}s grace)`,
      status: heartbeatStatus(hb, t), lastSeen: hb.last_ping_at || null });
  }
  // containers: latest snapshot per agent (reported minute-bucketed)
  for (const a of agents) {
    const lastTs = (await store.prepare('SELECT MAX(ts) ts FROM agent_containers WHERE agent_id = ?').get(a.id)).ts;
    if (!lastTs || t - lastTs > 10 * 60 * 1000) continue; // stale snapshot → skip
    for (const c of await store.prepare('SELECT * FROM agent_containers WHERE agent_id = ? AND ts = ?').all(a.id, lastTs)) {
      rows.push({ kind: 'container', id: null, name: `${a.name}/${c.name}`,
        detail: c.image || '', status: c.state || 'unknown', lastSeen: lastTs });
    }
  }
  for (const v of await store.prepare('SELECT * FROM vendors WHERE org_id = ?').all(req.orgId)) {
    rows.push({ kind: 'vendor', id: v.id, name: v.name, detail: `status feed · every ${v.interval_s}s`,
      status: !v.enabled ? 'disabled' : v.last_error ? 'error' : v.status,
      lastSeen: v.last_checked_at || null });
  }
  const sources = new Map();
  for (const r of await store.prepare('SELECT device, MAX(ts) AS ls FROM logs WHERE org_id = ? GROUP BY device').all(req.orgId)) {
    sources.set(r.device, r.ls);
  }
  for (const r of await store.prepare('SELECT device, MAX(last_seen) AS ls FROM events WHERE org_id = ? GROUP BY device').all(req.orgId)) {
    if ((sources.get(r.device) || 0) < r.ls) sources.set(r.device, r.ls);
  }
  for (const [device, ls] of sources) {
    if (agentNames.has(device)) continue; // agent hosts are already listed above
    rows.push({ kind: 'source', id: null, name: device, detail: 'logs / events',
      status: 'active', lastSeen: ls });
  }
  rows.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  res.json(rows);
});

// ---- incidents ----
// All mutations go through lib/incidents — the one place that emits the
// synthetic lifecycle events and recomputes derived component status
// (docs/INCIDENTS-V2.md §3). Routes validate, audit and render.
//
// lib/incidents, lib/cases and engine/alert-chain are all on the storage shim
// now, so every verb below is awaited.

router.get('/incidents', async (req, res) => {
  res.json(await Promise.all((await store.prepare('SELECT * FROM incidents WHERE org_id = ? ORDER BY started_at DESC LIMIT 100').all(req.orgId)).map((i) => inc.view(i))));
});

router.post('/incidents', sec.requireRole('lead'), async (req, res) => {
  const b = req.body || {};
  if (!isStr(b.title, 200)) return httpError(res, 400, 'title required');
  const components = await inc.cleanComponents(req.orgId, b.components);
  if (components === null) return httpError(res, 400, 'bad components');
  const row = await inc.create(req.orgId, req.user.id, {
    title: b.title, severity: clampInt(b.severity, 0, 100, 50),
    message: isStr(b.message, 2000) ? b.message : undefined,
    components, assigneeId: isId(b.assigneeId) ? b.assigneeId : null,
  });
  sec.audit(req.user.id, 'incident_create', b.title, req.orgId);
  res.json(await inc.view(row));
});

router.post('/incidents/:id/status', sec.requireRole('lead'), async (req, res) => {
  const { status, message } = req.body || {};
  const row = await inc.setStatus(req.orgId, req.user.id, Number(req.params.id), status,
    isStr(message, 2000) ? message : undefined);
  if (!row) return httpError(res, 404, 'incident not found or bad status');
  sec.audit(req.user.id, 'incident_status', `${inc.label(row.id)} → ${status}`, req.orgId);
  res.json(await inc.view(row));
});

router.patch('/incidents/:id', sec.requireRole('lead'), async (req, res) => {
  const i = await store.prepare('SELECT * FROM incidents WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!i) return httpError(res, 404, 'incident not found');
  const b = req.body || {};
  const rca = b.rca || {};
  for (const f of ['summary', 'impact', 'rootCause', 'resolution', 'actions']) {
    if (!optStr(rca[f], 10000)) return httpError(res, 400, 'RCA field too long');
  }
  if ('assigneeId' in b) {
    /* Three cases, and they must stay three.
     *
     * This site was the last one still deciding with `Number.isInteger`, left
     * over from before ids became uuids (the two beside it were converted with
     * migration 21). A uuid is not an integer, so every REAL assignee was
     * replaced by `null`: the endpoint answered 200, assigned nobody, and wrote
     * "Unassigned." into the timeline. Silently, on both engines, for as long as
     * ids have been uuids.
     *
     * Swapping in `isId` alone fixes that and breaks the other end: a garbage id
     * would then also fall to `null` and be treated as a deliberate unassign,
     * answering 200 for what is plainly a bad request. So `null` means unassign,
     * a well-formed id is looked up (and refused by `assign` if it is not a
     * member), and anything else is a 400 rather than a silent no-op.
     */
    if (b.assigneeId !== null && !isId(b.assigneeId)) return httpError(res, 400, 'bad assigneeId');
    const r = await inc.assign(req.orgId, req.user.id, i.id, b.assigneeId);
    if (r && r.error) return httpError(res, 400, r.error);
  }
  if (b.components !== undefined) {
    const components = await inc.cleanComponents(req.orgId, b.components);
    if (components === null || components === undefined) return httpError(res, 400, 'bad components');
    await inc.setComponents(req.orgId, i.id, components);
  }
  await store.prepare(`UPDATE incidents SET
      title = COALESCE(?, title), severity = COALESCE(?, severity),
      rca_summary = COALESCE(?, rca_summary), rca_impact = COALESCE(?, rca_impact),
      rca_root_cause = COALESCE(?, rca_root_cause), rca_resolution = COALESCE(?, rca_resolution),
      rca_actions = COALESCE(?, rca_actions)
    WHERE id = ? AND org_id = ?`)
    .run(isStr(b.title, 200) ? b.title : null,
      Number.isFinite(b.severity) ? clampInt(b.severity, 0, 100, 50) : null,
      rca.summary ?? null, rca.impact ?? null, rca.rootCause ?? null,
      rca.resolution ?? null, rca.actions ?? null, i.id, req.orgId);
  // published goes through the verb AFTER title/rca land, so the first
  // subscriber mail carries the final wording
  if (typeof b.published === 'boolean') await inc.setPublished(req.orgId, req.user.id, i.id, b.published);
  sec.audit(req.user.id, 'incident_update', inc.label(i.id), req.orgId);
  res.json(await inc.view(await store.prepare('SELECT * FROM incidents WHERE id = ? AND org_id = ?').get(i.id, req.orgId)));
});

// promote a case to an incident (docs/INCIDENTS-V2.md §3.1): prefills
// title/severity from the case, links the case and its event, drops a case
// note. Idempotent-ish: an open incident already linked to the case is
// returned instead of a second one.
router.post('/cases/:id/promote', sec.requireRole('lead'), async (req, res) => {
  const b = req.body || {};
  if (b.title !== undefined && !isStr(b.title, 200)) return httpError(res, 400, 'bad title');
  const components = await inc.cleanComponents(req.orgId, b.components);
  if (components === null) return httpError(res, 400, 'bad components');
  const result = await inc.promote(req.orgId, req.user.id, Number(req.params.id), {
    title: b.title, severity: Number.isFinite(b.severity) ? clampInt(b.severity, 0, 100, 50) : undefined,
    components, assigneeId: isId(b.assigneeId) ? b.assigneeId : undefined,
  });
  if (!result) return httpError(res, 404, 'case not found');
  if (result.already) return res.json({ ok: true, already: true, incident: result.already });
  sec.audit(req.user.id, 'incident_create', `${result.incident.title} (promoted from C-${1000 + Number(req.params.id)})`, req.orgId);
  res.json({ ok: true, already: false, incident: await inc.view(result.incident) });
});

module.exports = router;
// The live-update bus, so writes made outside this router (the MCP tools) can
// push the same SSE frames the UI already listens for.
module.exports.hub = hub;
module.exports.publicEvent = publicEvent;
// …and the same history, so an action taken by an agent is not a gap in it.
module.exports.recordEvent = recordEvent;
// …and the same note append, so an agent's note does not overwrite an operator's.
module.exports.appendCaseNote = appendCaseNote;
