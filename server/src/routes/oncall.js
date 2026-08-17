'use strict';
// On-Call — teams, schedules and "who has the duty right now"
// (docs/ONCALL-V1.md slice 1). Escalation policies and alerts are slice 2; this
// half is deliberately read-heavy and has no side effects beyond CRUD.
//
// Reads are open to the org; every write is lead+.
const express = require('express');
const { db } = require('../db');
const { now, isStr, clampInt, httpError, isId } = require('../util');
const sec = require('../security');
const oncall = require('../engine/oncall');

const router = express.Router();
router.use(sec.requireSessionOrToken);

const MAX_LAYERS = 5;
const MAX_PARTICIPANTS = 50;
const MAX_TIMELINE_DAYS = 60;

const memberOfOrg = db.prepare(`SELECT u.id FROM memberships m JOIN users u ON u.id = m.user_id
  WHERE m.user_id = ? AND m.org_id = ? AND u.active = 1`);
const isMember = (userId, orgId) => isId(userId) && !!memberOfOrg.get(userId, orgId);

// ---- teams -----------------------------------------------------------------
const qTeams = db.prepare('SELECT * FROM teams WHERE org_id = ? ORDER BY name');
const qTeamMembers = db.prepare(`SELECT tm.user_id, u.name, u.email, u.color
  FROM team_members tm JOIN users u ON u.id = tm.user_id
  WHERE tm.team_id = ? AND u.active = 1 ORDER BY u.name`);
const qTeam = db.prepare('SELECT * FROM teams WHERE id = ? AND org_id = ?');

const teamView = (t) => ({
  id: t.id, name: t.name, createdAt: t.created_at,
  members: qTeamMembers.all(t.id).map((m) => ({ id: m.user_id, name: m.name, email: m.email, color: m.color })),
});

router.get('/teams', (req, res) => res.json(qTeams.all(req.orgId).map(teamView)));

// Members arrive as a whole list and REPLACE the current one — a team is a name
// and a member list, so there is nothing to patch member-by-member.
function writeMembers(teamId, orgId, members) {
  db.prepare('DELETE FROM team_members WHERE team_id = ?').run(teamId);
  const ins = db.prepare('INSERT OR IGNORE INTO team_members (team_id, user_id) VALUES (?, ?)');
  for (const uid of members) if (isMember(uid, orgId)) ins.run(teamId, uid);
}

router.post('/teams', sec.requireRole('lead'), (req, res) => {
  const { name, members } = req.body || {};
  if (!isStr(name, 80)) return httpError(res, 400, 'bad name');
  if (members !== undefined && !Array.isArray(members)) return httpError(res, 400, 'bad members');
  let id;
  try {
    id = db.prepare('INSERT INTO teams (org_id, name, created_at) VALUES (?, ?, ?)')
      .run(req.orgId, name.trim(), now()).lastInsertRowid;
  } catch { return httpError(res, 409, 'a team with that name already exists'); }
  writeMembers(id, req.orgId, members || []);
  sec.audit(req.user.id, 'oncall_team_create', name.trim(), req.orgId);
  res.status(201).json(teamView(qTeam.get(id, req.orgId)));
});

router.patch('/teams/:id', sec.requireRole('lead'), (req, res) => {
  const t = qTeam.get(req.params.id, req.orgId);
  if (!t) return httpError(res, 404, 'team not found');
  const { name, members } = req.body || {};
  if (name !== undefined) {
    if (!isStr(name, 80)) return httpError(res, 400, 'bad name');
    try { db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(name.trim(), t.id); }
    catch { return httpError(res, 409, 'a team with that name already exists'); }
  }
  if (members !== undefined) {
    if (!Array.isArray(members)) return httpError(res, 400, 'bad members');
    writeMembers(t.id, req.orgId, members);
  }
  sec.audit(req.user.id, 'oncall_team_update', `team ${t.id}`, req.orgId);
  res.json(teamView(qTeam.get(t.id, req.orgId)));
});

router.delete('/teams/:id', sec.requireRole('lead'), (req, res) => {
  const t = qTeam.get(req.params.id, req.orgId);
  if (!t) return httpError(res, 404, 'team not found');
  db.prepare('DELETE FROM teams WHERE id = ?').run(t.id);   // schedules.team_id -> NULL
  sec.audit(req.user.id, 'oncall_team_delete', `${t.name}`, req.orgId);
  res.json({ ok: true });
});

// ---- schedules -------------------------------------------------------------
const qSchedules = db.prepare('SELECT * FROM schedules WHERE org_id = ? ORDER BY name');
const qSchedule = db.prepare('SELECT * FROM schedules WHERE id = ? AND org_id = ?');
const qLayers = db.prepare('SELECT * FROM schedule_layers WHERE schedule_id = ? ORDER BY position');
const qParticipants = db.prepare(`SELECT sp.position, sp.user_id, u.name, u.email, u.color
  FROM schedule_participants sp JOIN users u ON u.id = sp.user_id
  WHERE sp.layer_id = ? ORDER BY sp.position`);
const qOverridesAll = db.prepare(`SELECT o.*, u.name, u.email, u.color FROM schedule_overrides o
  JOIN users u ON u.id = o.user_id WHERE o.schedule_id = ? AND o.ends_at > ?
  ORDER BY o.starts_at LIMIT 200`);

function scheduleView(s, at = now()) {
  const r = oncall.resolve(s, at);
  return {
    id: s.id, name: s.name, timezone: s.timezone, teamId: s.team_id, createdAt: s.created_at,
    onCall: r.user, via: r.via, gapSince: s.gap_alerted_at,
    layers: qLayers.all(s.id).map((l) => ({
      id: l.id, position: l.position, rotation: l.rotation, intervalD: l.interval_d,
      handoffAt: l.handoff_at,
      restrict: l.restrict_json ? JSON.parse(l.restrict_json) : null,
      participants: qParticipants.all(l.id)
        .map((p) => ({ id: p.user_id, name: p.name, email: p.email, color: p.color })),
    })),
    overrides: qOverridesAll.all(s.id, at).map((o) => ({
      id: o.id, startsAt: o.starts_at, endsAt: o.ends_at,
      user: { id: o.user_id, name: o.name, email: o.email, color: o.color },
    })),
  };
}

router.get('/schedules', (req, res) => {
  const at = now();
  res.json(qSchedules.all(req.orgId).map((s) => scheduleView(s, at)));
});

router.get('/schedules/:id', (req, res) => {
  const s = qSchedule.get(req.params.id, req.orgId);
  if (!s) return httpError(res, 404, 'schedule not found');
  res.json(scheduleView(s));
});

router.post('/schedules', sec.requireRole('lead'), (req, res) => {
  const { name, timezone, teamId } = req.body || {};
  if (!isStr(name, 80)) return httpError(res, 400, 'bad name');
  const tz = timezone === undefined || timezone === null || timezone === '' ? 'UTC' : String(timezone);
  // Validated on write so a bad zone can never reach the resolver, where the
  // only options would be crashing or silently pretending it is UTC.
  if (!oncall.validTimezone(tz)) return httpError(res, 400, 'unknown timezone');
  if (teamId !== undefined && teamId !== null && !qTeam.get(teamId, req.orgId)) {
    return httpError(res, 400, 'unknown team');
  }
  let id;
  try {
    id = db.prepare(`INSERT INTO schedules (org_id, team_id, name, timezone, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(req.orgId, teamId ?? null, name.trim(), tz, now()).lastInsertRowid;
  } catch { return httpError(res, 409, 'a schedule with that name already exists'); }
  sec.audit(req.user.id, 'oncall_schedule_create', name.trim(), req.orgId);
  res.status(201).json(scheduleView(qSchedule.get(id, req.orgId)));
});

router.patch('/schedules/:id', sec.requireRole('lead'), (req, res) => {
  const s = qSchedule.get(req.params.id, req.orgId);
  if (!s) return httpError(res, 404, 'schedule not found');
  const { name, timezone, teamId } = req.body || {};
  if (name !== undefined && !isStr(name, 80)) return httpError(res, 400, 'bad name');
  if (timezone !== undefined && !oncall.validTimezone(String(timezone))) {
    return httpError(res, 400, 'unknown timezone');
  }
  if (teamId !== undefined && teamId !== null && !qTeam.get(teamId, req.orgId)) {
    return httpError(res, 400, 'unknown team');
  }
  try {
    db.prepare(`UPDATE schedules SET name = COALESCE(?, name), timezone = COALESCE(?, timezone),
      team_id = CASE WHEN ? THEN ? ELSE team_id END WHERE id = ?`)
      .run(name ? name.trim() : null, timezone ? String(timezone) : null,
        teamId === undefined ? 0 : 1, teamId ?? null, s.id);
  } catch { return httpError(res, 409, 'a schedule with that name already exists'); }
  sec.audit(req.user.id, 'oncall_schedule_update', `schedule ${s.id}`, req.orgId);
  res.json(scheduleView(qSchedule.get(s.id, req.orgId)));
});

router.delete('/schedules/:id', sec.requireRole('lead'), (req, res) => {
  const s = qSchedule.get(req.params.id, req.orgId);
  if (!s) return httpError(res, 404, 'schedule not found');
  db.prepare('DELETE FROM schedules WHERE id = ?').run(s.id);
  sec.audit(req.user.id, 'oncall_schedule_delete', s.name, req.orgId);
  res.json({ ok: true });
});

// Layers are replaced as a SET, like the classifier rules: they are ordered and
// interdependent (position decides which one wins), so patching one at a time
// would let the client leave the ladder in a state the server never validated.
router.put('/schedules/:id/layers', sec.requireRole('lead'), (req, res) => {
  const s = qSchedule.get(req.params.id, req.orgId);
  if (!s) return httpError(res, 404, 'schedule not found');
  const layers = (req.body || {}).layers;
  if (!Array.isArray(layers) || layers.length > MAX_LAYERS) return httpError(res, 400, 'bad layers');

  const clean = [];
  for (const [i, l] of layers.entries()) {
    const rotation = String(l.rotation || 'weekly');
    if (!['daily', 'weekly', 'custom'].includes(rotation)) return httpError(res, 400, 'bad rotation');
    const intervalD = clampInt(l.intervalD, 1, 90, 1);
    const handoffAt = Number(l.handoffAt);
    if (!Number.isFinite(handoffAt)) return httpError(res, 400, 'bad handoffAt');
    if (!Array.isArray(l.participants) || l.participants.length > MAX_PARTICIPANTS) {
      return httpError(res, 400, 'bad participants');
    }
    // Silently dropping an unknown user would leave a rotation short by one and
    // nobody would know; refuse instead.
    for (const uid of l.participants) if (!isMember(uid, req.orgId)) return httpError(res, 400, 'unknown participant');
    let restrict = null;
    if (l.restrict) {
      const r = l.restrict;
      const days = Array.isArray(r.days) ? r.days.map(Number).filter((d) => d >= 1 && d <= 7) : [];
      const hm = (v) => (typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v) ? v : null);
      restrict = { days, from: hm(r.from), to: hm(r.to) };
      if (!days.length && !restrict.from) restrict = null;
    }
    clean.push({ position: i, rotation, intervalD, handoffAt, restrict, participants: l.participants });
  }

  db.transaction(() => {
    db.prepare('DELETE FROM schedule_layers WHERE schedule_id = ?').run(s.id);
    const insL = db.prepare(`INSERT INTO schedule_layers
      (schedule_id, position, rotation, interval_d, handoff_at, restrict_json) VALUES (?, ?, ?, ?, ?, ?)`);
    const insP = db.prepare('INSERT INTO schedule_participants (layer_id, position, user_id) VALUES (?, ?, ?)');
    for (const l of clean) {
      const lid = insL.run(s.id, l.position, l.rotation, l.intervalD, l.handoffAt,
        l.restrict ? JSON.stringify(l.restrict) : null).lastInsertRowid;
      l.participants.forEach((uid, i) => insP.run(lid, i, uid));
    }
  })();
  sec.audit(req.user.id, 'oncall_layers_update', `schedule ${s.id}: ${clean.length} layer(s)`, req.orgId);
  res.json(scheduleView(qSchedule.get(s.id, req.orgId)));
});

router.post('/schedules/:id/overrides', sec.requireRole('lead'), (req, res) => {
  const s = qSchedule.get(req.params.id, req.orgId);
  if (!s) return httpError(res, 404, 'schedule not found');
  const { userId, startsAt, endsAt } = req.body || {};
  if (!isMember(userId, req.orgId)) return httpError(res, 400, 'unknown user');
  const a = Number(startsAt); const b = Number(endsAt);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return httpError(res, 400, 'bad window');
  const id = db.prepare(`INSERT INTO schedule_overrides
    (schedule_id, user_id, starts_at, ends_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(s.id, userId, a, b, req.user.id, now()).lastInsertRowid;
  sec.audit(req.user.id, 'oncall_override_create', `schedule ${s.id} → user ${userId}`, req.orgId);
  res.status(201).json({ id, ...scheduleView(qSchedule.get(s.id, req.orgId)) });
});

router.delete('/overrides/:id', sec.requireRole('lead'), (req, res) => {
  const o = db.prepare(`SELECT o.* FROM schedule_overrides o JOIN schedules s ON s.id = o.schedule_id
    WHERE o.id = ? AND s.org_id = ?`).get(req.params.id, req.orgId);
  if (!o) return httpError(res, 404, 'override not found');
  db.prepare('DELETE FROM schedule_overrides WHERE id = ?').run(o.id);
  sec.audit(req.user.id, 'oncall_override_delete', `override ${o.id}`, req.orgId);
  res.json({ ok: true });
});

// ---- the question the module exists to answer ------------------------------
router.get('/now', (req, res) => res.json({ at: now(), schedules: oncall.onCallNow(req.orgId) }));

router.get('/schedules/:id/timeline', (req, res) => {
  const s = qSchedule.get(req.params.id, req.orgId);
  if (!s) return httpError(res, 404, 'schedule not found');
  const days = clampInt(req.query.days, 1, MAX_TIMELINE_DAYS, 14);
  const from = Number(req.query.from) || now();
  res.json({
    scheduleId: s.id, timezone: s.timezone, from, days,
    shifts: oncall.timeline(s, from, from + days * 86400000),
  });
});

module.exports = router;
