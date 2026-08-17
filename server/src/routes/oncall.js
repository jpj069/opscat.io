'use strict';
// On-Call — teams, schedules, escalation policies, alerts and a person's own
// contact methods (docs/ONCALL-V1.md slices 1 and 2).
//
// Two different kinds of write live here and they are gated differently:
//
//  - CONFIGURATION (teams, schedules, rotations, policies) is lead+. It decides
//    who gets woken at 03:00, which is not an analyst's call to make alone.
//  - OPERATION (raise, acknowledge, cancel an alert; a person's own contact
//    methods and notification rules) is open to every member. The human the
//    alert reached is often the most junior one on the rota, and an ack they
//    cannot perform is an escalation nobody can stop.
const express = require('express');
const { db } = require('../db');
const { now, sha256, isStr, optStr, isEmail, clampInt, httpError, isId } = require('../util');
const sec = require('../security');
const oncall = require('../engine/oncall');
const chain = require('../engine/alert-chain');
const contacts = require('../lib/contacts');
const telephony = require('../lib/telephony');
const webpush = require('../lib/webpush');
const alerts = require('../engine/alerts');

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
  const ins = db.prepare('INSERT INTO team_members (team_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING');
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

// ---- escalation policies (§3.3) --------------------------------------------
// A policy is a LADDER: an ordered list of steps with a timeout each. Steps are
// replaced as a SET for the same reason layers are — position decides what
// happens when, so patching a rung at a time would let the client leave a ladder
// the server never validated.
const qPolicies = db.prepare('SELECT * FROM escalation_policies WHERE org_id = ? ORDER BY name');
const qPolicy = db.prepare('SELECT * FROM escalation_policies WHERE id = ? AND org_id = ?');
const qSteps = db.prepare('SELECT * FROM escalation_steps WHERE policy_id = ? ORDER BY position');
const qTargets = db.prepare('SELECT kind, ref_id FROM escalation_targets WHERE step_id = ?');
const qUserLite = db.prepare('SELECT id, name, color FROM users WHERE id = ?');
const qTeamLite = db.prepare('SELECT id, name FROM teams WHERE id = ? AND org_id = ?');
const qSchedLite = db.prepare('SELECT id, name FROM schedules WHERE id = ? AND org_id = ?');

const MAX_STEPS = 10;
const MAX_TARGETS = 20;

function targetLabel(orgId, t) {
  if (t.kind === 'user') { const u = qUserLite.get(t.ref_id); return u ? u.name : 'unknown user'; }
  if (t.kind === 'team') { const x = qTeamLite.get(Number(t.ref_id), orgId); return x ? x.name : 'unknown team'; }
  const s = qSchedLite.get(Number(t.ref_id), orgId);
  return s ? s.name : 'unknown schedule';
}

function policyView(p) {
  const steps = qSteps.all(p.id).map((s) => ({
    position: s.position, timeoutM: s.timeout_m,
    targets: qTargets.all(s.id).map((t) => ({ kind: t.kind, refId: t.ref_id, label: targetLabel(p.org_id, t) })),
  }));
  return {
    id: p.id, name: p.name, repeatN: p.repeat_n, highMin: p.high_min,
    hours: p.hours_json ? JSON.parse(p.hours_json) : null,
    createdAt: p.created_at, steps,
    // The unit humans reason in. "3 steps × 5 min × 2 passes" is an abstract
    // counter; "rings for at most 30 minutes" is the setting explaining itself
    // (§13.3), and it is computed HERE so the editor cannot show a second answer.
    worstCaseMinutes: steps.reduce((a, s) => a + s.timeoutM, 0) * (p.repeat_n + 1),
  };
}

// Every reference is checked against THIS org — a policy that names another
// tenant's schedule would be a cross-org read with a phone call attached.
function cleanSteps(orgId, raw) {
  if (!Array.isArray(raw) || raw.length > MAX_STEPS) return { error: 'bad steps' };
  const out = [];
  for (const [i, s] of raw.entries()) {
    const timeoutM = clampInt(s.timeoutM, 1, 24 * 60, 5);
    const targets = Array.isArray(s.targets) ? s.targets : [];
    if (targets.length > MAX_TARGETS) return { error: 'too many targets on one step' };
    const clean = [];
    for (const t of targets) {
      const kind = String(t.kind || '');
      const ref = String(t.refId ?? '');
      if (kind === 'user') { if (!isMember(ref, orgId)) return { error: 'unknown user target' }; }
      else if (kind === 'team') { if (!qTeamLite.get(Number(ref), orgId)) return { error: 'unknown team target' }; }
      else if (kind === 'schedule') { if (!qSchedLite.get(Number(ref), orgId)) return { error: 'unknown schedule target' }; }
      else return { error: 'bad target kind' };
      clean.push({ kind, refId: ref });
    }
    out.push({ position: i, timeoutM, targets: clean });
  }
  return { steps: out };
}

function writeSteps(policyId, steps) {
  db.prepare('DELETE FROM escalation_steps WHERE policy_id = ?').run(policyId);
  const insS = db.prepare('INSERT INTO escalation_steps (policy_id, position, timeout_m) VALUES (?, ?, ?)');
  const insT = db.prepare('INSERT INTO escalation_targets (step_id, kind, ref_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING');
  for (const s of steps) {
    const sid = insS.run(policyId, s.position, s.timeoutM).lastInsertRowid;
    for (const t of s.targets) insT.run(sid, t.kind, t.refId);
  }
}

// Support hours use the SAME shape as a layer restriction, and are evaluated by
// the same function (engine/oncall.restrictionCovers). A second time-window
// implementation is a second set of off-by-one bugs.
function cleanHours(raw) {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'object') return undefined;
  const days = Array.isArray(raw.days) ? raw.days.map(Number).filter((d) => d >= 1 && d <= 7) : [];
  const hm = (v) => (typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v) ? v : null);
  const tz = typeof raw.tz === 'string' && oncall.validTimezone(raw.tz) ? raw.tz : 'UTC';
  const out = { days, from: hm(raw.from), to: hm(raw.to), tz };
  return (!days.length && !out.from) ? null : out;
}

router.get('/policies', (req, res) => res.json(qPolicies.all(req.orgId).map(policyView)));

router.post('/policies', sec.requireRole('lead'), (req, res) => {
  const { name, repeatN, highMin, hours, steps } = req.body || {};
  if (!isStr(name, 80)) return httpError(res, 400, 'bad name');
  const cleaned = cleanSteps(req.orgId, steps || []);
  if (cleaned.error) return httpError(res, 400, cleaned.error);
  const h = cleanHours(hours);
  let id;
  try {
    id = db.prepare(`INSERT INTO escalation_policies
      (org_id, name, repeat_n, high_min, hours_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(req.orgId, name.trim(), clampInt(repeatN, 0, 5, 0), clampInt(highMin, 0, 100, 80),
        h ? JSON.stringify(h) : null, now()).lastInsertRowid;
  } catch { return httpError(res, 409, 'a policy with that name already exists'); }
  writeSteps(id, cleaned.steps);
  sec.audit(req.user.id, 'oncall_policy_create', name.trim(), req.orgId);
  res.status(201).json(policyView(qPolicy.get(id, req.orgId)));
});

router.patch('/policies/:id', sec.requireRole('lead'), (req, res) => {
  const p = qPolicy.get(req.params.id, req.orgId);
  if (!p) return httpError(res, 404, 'policy not found');
  const { name, repeatN, highMin, hours, steps } = req.body || {};
  if (name !== undefined && !isStr(name, 80)) return httpError(res, 400, 'bad name');
  let cleaned = null;
  if (steps !== undefined) {
    cleaned = cleanSteps(req.orgId, steps);
    if (cleaned.error) return httpError(res, 400, cleaned.error);
  }
  const h = cleanHours(hours);
  try {
    db.prepare(`UPDATE escalation_policies SET name = COALESCE(?, name),
      repeat_n = COALESCE(?, repeat_n), high_min = COALESCE(?, high_min),
      hours_json = CASE WHEN ? THEN ? ELSE hours_json END WHERE id = ?`)
      .run(name ? name.trim() : null,
        repeatN === undefined ? null : clampInt(repeatN, 0, 5, 0),
        highMin === undefined ? null : clampInt(highMin, 0, 100, 80),
        h === undefined ? 0 : 1, h ? JSON.stringify(h) : null, p.id);
  } catch { return httpError(res, 409, 'a policy with that name already exists'); }
  if (cleaned) db.transaction(() => writeSteps(p.id, cleaned.steps))();
  sec.audit(req.user.id, 'oncall_policy_update', `policy ${p.id}`, req.orgId);
  res.json(policyView(qPolicy.get(p.id, req.orgId)));
});

router.delete('/policies/:id', sec.requireRole('lead'), (req, res) => {
  const p = qPolicy.get(req.params.id, req.orgId);
  if (!p) return httpError(res, 404, 'policy not found');
  db.prepare('DELETE FROM escalation_policies WHERE id = ?').run(p.id);
  sec.audit(req.user.id, 'oncall_policy_delete', p.name, req.orgId);
  res.json({ ok: true });
});

// ---- alerts (§3.5) ---------------------------------------------------------
// Raising, acknowledging and cancelling are OPERATIONAL acts, not configuration:
// they are open to every member including analysts, because the person the alert
// woke is often the one with the least seniority and the most context.
const qAlerts = db.prepare(`SELECT * FROM alerts WHERE org_id = ?
  AND (? = 'all' OR (? = 'live' AND status IN ('active','acked')) OR status = ?)
  ORDER BY created_at DESC LIMIT ?`);
const qAlert = db.prepare('SELECT * FROM alerts WHERE id = ? AND org_id = ?');

router.get('/alerts', (req, res) => {
  const filter = ['all', 'live', 'active', 'acked', 'resolved', 'exhausted', 'canceled']
    .includes(req.query.status) ? req.query.status : 'live';
  const limit = clampInt(req.query.limit, 1, 500, 100);
  res.json(qAlerts.all(req.orgId, filter, filter, filter, limit).map((a) => chain.view(a)));
});

router.get('/alerts/:id', (req, res) => {
  const a = qAlert.get(req.params.id, req.orgId);
  if (!a) return httpError(res, 404, 'alert not found');
  res.json(chain.view(a, { includeAttempts: true }));
});

router.post('/alerts', (req, res) => {
  const { subjectKind, subjectId, policyId, urgency, message } = req.body || {};
  if (!['case', 'incident'].includes(subjectKind)) return httpError(res, 400, 'bad subjectKind');
  if (!optStr(message, 500)) return httpError(res, 400, 'bad message');
  const r = chain.raise(req.orgId, {
    subjectKind, subjectId: Number(subjectId), policyId: Number(policyId),
    urgency, message: message || null, source: `user:${req.user.id}`,
  });
  if (r.error) return httpError(res, 400, r.error);
  if (r.suppressed) return res.status(202).json({ suppressed: r.suppressed });
  sec.audit(req.user.id, 'alert_raise', `${subjectKind} ${subjectId} → policy ${policyId}`, req.orgId);
  res.status(r.already ? 200 : 201).json(chain.view(r.alert, { includeAttempts: true }));
});

router.post('/alerts/:id/ack', (req, res) => {
  const r = chain.ack(req.orgId, Number(req.params.id), req.user.id, 'app');
  // An alert that is already acknowledged, cancelled or exhausted cannot be
  // acknowledged again. The UI disables the button; the endpoint refuses it —
  // a disabled button is a courtesy, not a lock, and the API has other callers.
  if (r.error) return httpError(res, r.alert ? 409 : 404, r.error);
  sec.audit(req.user.id, 'alert_ack', `alert ${req.params.id}`, req.orgId);
  res.json(chain.view(r.alert, { includeAttempts: true }));
});

router.post('/alerts/:id/cancel', (req, res) => {
  const a = qAlert.get(req.params.id, req.orgId);
  if (!a) return httpError(res, 404, 'alert not found');
  if (!['active', 'acked'].includes(a.status)) return httpError(res, 409, `alert is ${a.status}`);
  chain.cancelFor(req.orgId, a.subject_kind, a.subject_id, `canceled by ${req.user.name}`);
  sec.audit(req.user.id, 'alert_cancel', `alert ${a.id}`, req.orgId);
  res.json(chain.view(qAlert.get(a.id, req.orgId)));
});

// ---- my on-call (§3.4) -----------------------------------------------------
// Contact methods belong to the PERSON, not the org, and are visible ONLY to
// their owner: an admin may see that a method exists elsewhere in the product,
// never the address. Every query below is scoped to req.user.id, which is what
// makes that true rather than merely intended (§7 Personal data).
const qMethods = db.prepare('SELECT * FROM contact_methods WHERE user_id = ? ORDER BY id');
const qMethod = db.prepare('SELECT * FROM contact_methods WHERE id = ? AND user_id = ?');
const qMyRules = db.prepare(`SELECT r.* FROM notification_rules r
  WHERE r.user_id = ? ORDER BY r.urgency, r.delay_m, r.id`);

// Every kind a person can TYPE. `push` is absent on purpose: a subscription is
// handed over by the browser through its own endpoint below, not typed.
const METHOD_KINDS = contacts.TYPED_KINDS;

// A verification code is six digits, so the try counter is the only thing
// between it and a brute force. Five attempts, then the code is spent.
const VERIFY_TRIES = 5;
const VERIFY_TTL_MS = 15 * 60 * 1000;

router.get('/me', (req, res) => {
  const at = now();
  const mine = [];
  for (const s of qSchedules.all(req.orgId)) {
    for (const shift of oncall.timeline(s, at, at + 14 * 86400000)) {
      if (shift.userId === req.user.id) {
        mine.push({ scheduleId: s.id, schedule: s.name, startsAt: shift.startsAt, endsAt: shift.endsAt, via: shift.via });
      }
    }
  }
  res.json({
    methods: qMethods.all(req.user.id).map((m) => {
      const gate = contacts.usable(m, req.orgId);
      return {
        id: m.id, kind: m.kind, address: contacts.displayAddress(m), label: m.label,
        verifiedAt: m.verified_at, createdAt: m.created_at,
        needsVerification: contacts.isMetered(m.kind) && !m.verified_at,
        // Why this method will not be used, in the words the notification log
        // would use. A method that is quietly skipped is the failure mode.
        blockedReason: gate.ok ? null : gate.reason,
      };
    }),
    // Whether the org can use the metered channels at all, so the screen can say
    // so BEFORE somebody types a number and waits for a call that never comes.
    telephonyConfigured: telephony.isConfigured(req.orgId),
    rules: qMyRules.all(req.user.id).map((r) => ({
      id: r.id, urgency: r.urgency, delayM: r.delay_m, methodId: r.method_id,
    })),
    // The implicit fallback, stated rather than hidden: a person with no rules
    // is still reachable, and the screen has to say so or they will assume the
    // opposite and configure nothing.
    fallbackEmail: req.user.email,
    shifts: mine.sort((a, b) => a.startsAt - b.startsAt).slice(0, 20),
  });
});

router.post('/me/methods', (req, res) => {
  const { kind, address, label } = req.body || {};
  if (!METHOD_KINDS.includes(kind)) return httpError(res, 400, 'bad kind');
  if (!isStr(address, 300)) return httpError(res, 400, 'bad address');
  if (!optStr(label, 40)) return httpError(res, 400, 'bad label');
  let value = address.trim();
  if (kind === 'email' && !isEmail(value)) return httpError(res, 400, 'bad e-mail address');
  if (kind === 'ntfy' && !/^https?:\/\//i.test(value)) return httpError(res, 400, 'ntfy needs a topic URL');
  if (contacts.isMetered(kind)) {
    // Strict E.164, not a clever guess: every provider wants +<country><number>,
    // and inferring a country code is how a German mobile becomes a US landline.
    const e164 = contacts.normalisePhone(value);
    if (!e164) return httpError(res, 400, 'a phone number must be in international format, e.g. +4915112345678');
    value = e164;
  }
  const enc = contacts.encodeAddress(kind, value);
  const id = db.prepare(`INSERT INTO contact_methods (user_id, kind, address, encrypted, label, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(req.user.id, kind, enc.address, enc.encrypted, (label || '').trim(), now()).lastInsertRowid;
  // The address is deliberately NOT in the audit detail.
  sec.audit(req.user.id, 'contact_method_add', kind, req.orgId);
  res.status(201).json({ id, needsVerification: contacts.isMetered(kind) });
});

// ---- verification (§7) ------------------------------------------------------
// An sms/voice method is dead until it is proven to belong to the person who
// typed it. The code goes to the address itself — that IS the proof — and it
// goes over the channel being verified, so a number that cannot receive an SMS
// never becomes an SMS method.
router.post('/me/methods/:id/verify', async (req, res) => {
  const m = qMethod.get(req.params.id, req.user.id);
  if (!m) return httpError(res, 404, 'method not found');
  if (!contacts.isMetered(m.kind)) return httpError(res, 400, 'this kind needs no verification');
  if (!telephony.isConfigured(req.orgId)) {
    return httpError(res, 400, 'no SMS/voice provider is configured for this organization yet');
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const address = contacts.decodeAddress(m);
  if (!address) return httpError(res, 500, 'stored number is unreadable');
  try {
    // Verification always goes by SMS, even for a voice method: reading six
    // digits aloud to someone who has to type them back is worse in every way,
    // and both kinds are the same number on the same handset.
    await telephony.sendSms(req.orgId, address, `OpsCat verification code: ${code}`);
  } catch (e) {
    return httpError(res, 502, String(e.message).slice(0, 200));
  }
  db.prepare(`UPDATE contact_methods SET verify_hash = ?, verify_expires_at = ?, verify_tries = 0
    WHERE id = ?`).run(sha256(code), now() + VERIFY_TTL_MS, m.id);
  sec.audit(req.user.id, 'contact_method_verify_sent', m.kind, req.orgId);
  res.json({ ok: true, expiresAt: now() + VERIFY_TTL_MS });
});

router.post('/me/methods/:id/verify/confirm', (req, res) => {
  const m = qMethod.get(req.params.id, req.user.id);
  if (!m) return httpError(res, 404, 'method not found');
  if (m.verified_at) return httpError(res, 409, 'already verified');
  if (!m.verify_hash || !m.verify_expires_at || m.verify_expires_at < now()) {
    return httpError(res, 400, 'no code was sent, or it has expired');
  }
  if (m.verify_tries >= VERIFY_TRIES) return httpError(res, 429, 'too many attempts — send a new code');
  const code = String((req.body || {}).code || '');
  if (sha256(code) !== m.verify_hash) {
    db.prepare('UPDATE contact_methods SET verify_tries = verify_tries + 1 WHERE id = ?').run(m.id);
    return httpError(res, 400, 'wrong code');
  }
  db.prepare(`UPDATE contact_methods SET verified_at = ?, verify_hash = NULL, verify_expires_at = NULL
    WHERE id = ?`).run(now(), m.id);
  sec.audit(req.user.id, 'contact_method_verified', m.kind, req.orgId);
  res.json({ ok: true });
});

// ---- Web Push ---------------------------------------------------------------
// The public VAPID key is exactly that: public. The browser needs it before it
// can ask for permission, so it is readable by any signed-in member.
router.get('/me/push-key', (req, res) => res.json({ key: webpush.publicKey() }));

router.post('/me/push', (req, res) => {
  const sub = (req.body || {}).subscription;
  if (!webpush.isSubscription(sub)) return httpError(res, 400, 'bad push subscription');
  const label = isStr((req.body || {}).label, 40) ? req.body.label.trim() : 'this browser';
  const json = JSON.stringify({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
  // One row per browser. Re-subscribing in the same browser produces the same
  // endpoint, and a second row would ring the same device twice on every rung.
  for (const m of qMethods.all(req.user.id)) {
    if (m.kind !== 'push') continue;
    const existing = contacts.decodeAddress(m);
    if (existing && JSON.parse(existing).endpoint === sub.endpoint) {
      return res.json({ id: m.id, already: true });
    }
  }
  const enc = contacts.encodeAddress('push', json);
  const id = db.prepare(`INSERT INTO contact_methods (user_id, kind, address, encrypted, label, verified_at, created_at)
    VALUES (?, 'push', ?, ?, ?, ?, ?)`)
    .run(req.user.id, enc.address, enc.encrypted, label, now(), now()).lastInsertRowid;
  sec.audit(req.user.id, 'contact_method_add', 'push', req.orgId);
  res.status(201).json({ id });
});

// Send a test message through one of MY methods — the same path an alert takes,
// so "it works" means the real thing works and not a second code path.
router.post('/me/methods/:id/test', async (req, res) => {
  const m = qMethod.get(req.params.id, req.user.id);
  if (!m) return httpError(res, 404, 'method not found');
  const gate = contacts.usable(m, req.orgId);
  if (!gate.ok) return httpError(res, 400, gate.reason);
  const address = contacts.decodeAddress(m);
  if (!address) return httpError(res, 500, 'stored address is unreadable');
  const t0 = now();
  try {
    await alerts.sendVia(m.kind, address, {
      title: '[OpsCat] test notification',
      text: 'This is a test from OpsCat — no action needed.\nIf this reached you, this contact method works.',
      severity: 40, orgId: req.orgId, methodId: m.id,
      // A voice test would need a live alert to acknowledge; there is none, so
      // the voice path is tested by the ack round trip rather than from here.
      token: null,
    });
    res.json({ ok: true, latencyMs: now() - t0 });
  } catch (e) {
    httpError(res, 502, String(e.message).slice(0, 300));
  }
});

router.delete('/me/methods/:id', (req, res) => {
  const m = qMethod.get(req.params.id, req.user.id);
  if (!m) return httpError(res, 404, 'method not found');
  db.prepare('DELETE FROM contact_methods WHERE id = ?').run(m.id);  // rules cascade
  sec.audit(req.user.id, 'contact_method_delete', m.kind, req.orgId);
  res.json({ ok: true });
});

// Rules are a whole set per urgency: they are an ordered escalation of channels
// for one person, so the same argument as layers and steps applies.
router.put('/me/rules', (req, res) => {
  const raw = (req.body || {}).rules;
  if (!Array.isArray(raw) || raw.length > 20) return httpError(res, 400, 'bad rules');
  const clean = [];
  for (const r of raw) {
    if (!['high', 'low'].includes(r.urgency)) return httpError(res, 400, 'bad urgency');
    if (!qMethod.get(Number(r.methodId), req.user.id)) return httpError(res, 400, 'unknown contact method');
    clean.push({ urgency: r.urgency, delayM: clampInt(r.delayM, 0, 24 * 60, 0), methodId: Number(r.methodId) });
  }
  db.transaction(() => {
    db.prepare('DELETE FROM notification_rules WHERE user_id = ?').run(req.user.id);
    const ins = db.prepare(`INSERT INTO notification_rules (user_id, urgency, delay_m, method_id)
      VALUES (?, ?, ?, ?)`);
    for (const r of clean) ins.run(req.user.id, r.urgency, r.delayM, r.methodId);
  })();
  sec.audit(req.user.id, 'notification_rules_update', `${clean.length} rule(s)`, req.orgId);
  res.json({ ok: true, count: clean.length });
});

// ---- analytics (§8, slice 5) -----------------------------------------------
/**
 * The four numbers a PagerDuty replacement is judged by once the migration is
 * over, plus what the metered channels cost.
 *
 *  - **MTTA** — the one that only became answerable when `cases.acked_at` did.
 *    MTTR says how long a problem lasted; MTTA says how long it took anybody to
 *    say "I have it", which is the thing on-call is actually about.
 *  - **Escalation rate** — how often rung one was not enough. A rate near zero
 *    means the ladder is decoration; a rate near one means the first rung points
 *    at the wrong person.
 *  - **Out-of-hours load PER PERSON** — the one that changes behaviour. An org
 *    with a fair-looking rotation can still be wearing one person out, and the
 *    only way to see it is to count nights per name.
 *  - **Alerts per schedule** — where the noise comes from.
 *
 * Out-of-hours cannot be computed in SQL: it is a question about LOCAL time, and
 * SQLite has no timezone database. So the attempts are read out and folded in
 * JS through the same `localParts` the rotation engine uses — one implementation
 * of "what time was it for this person", not two.
 */
const OOH_FROM = 18 * 60;   // 18:00 — after this is out of hours
const OOH_TO = 8 * 60;      // 08:00 — before this is out of hours
const NIGHT_FROM = 22 * 60; // 22:00-06:00 is a night, and nights are what wear people out
const NIGHT_TO = 6 * 60;
const MAX_ATTEMPTS_SCANNED = 20000;

const qAttemptsInRange = db.prepare(`SELECT at.user_id, at.notified_at, at.via, at.step_position, at.round,
    u.name, u.color, u.timezone
  FROM alert_attempts at
  JOIN alerts a ON a.id = at.alert_id
  JOIN users u ON u.id = at.user_id
  WHERE a.org_id = ? AND at.notified_at >= ?
  ORDER BY at.notified_at DESC LIMIT ?`);

router.get('/analytics', (req, res) => {
  const days = { '7d': 7, '30d': 30, '90d': 90 }[req.query.range] || 30;
  const t = now();
  const since = t - days * 86400000;

  // MTTA — over CASES, because that is where an acknowledgement is recorded, and
  // it counts only cases that were actually acknowledged. Averaging in the
  // un-acknowledged ones as zero would make a team that answers nothing look fast.
  const mtta = db.prepare(`SELECT AVG(acked_at - opened_at) v, COUNT(*) c FROM cases
    WHERE org_id = ? AND acked_at IS NOT NULL AND acked_at >= ?`).get(req.orgId, since);
  // `strftime(…, 'unixepoch')` renders in UTC — SQLite only leaves UTC if you add
  // 'localtime'. Postgres has no strftime, and its replacement `to_timestamp()`
  // renders in the SESSION TimeZone, so a literal translation shifts every bucket
  // by the server's offset. Charts still look plausible, which is why the port
  // must spell UTC out (`AT TIME ZONE 'UTC'`) rather than inherit it. Pinned by
  // e2e-pipeline: a timestamp 30 minutes either side of midnight UTC must land on
  // the UTC day, so a session-timezone translation fails there instead of here.
  const mttaDaily = db.prepare(`SELECT strftime('%Y-%m-%d', acked_at / 1000, 'unixepoch') d,
      AVG(acked_at - opened_at) v FROM cases
    WHERE org_id = ? AND acked_at IS NOT NULL AND acked_at >= ? GROUP BY d ORDER BY d`)
    .all(req.orgId, since);
  const unacked = db.prepare(`SELECT COUNT(*) c FROM cases
    WHERE org_id = ? AND opened_at >= ? AND acked_at IS NULL`).get(req.orgId, since).c;

  // Escalation. `escalated` counts an alert that ever left rung one — the
  // attempt rows are the evidence, since step_position on the alert row is only
  // where it STOPPED.
  const raised = db.prepare('SELECT COUNT(*) c FROM alerts WHERE org_id = ? AND created_at >= ?')
    .get(req.orgId, since).c;
  const escalated = db.prepare(`SELECT COUNT(DISTINCT a.id) c FROM alerts a
    JOIN alert_attempts at ON at.alert_id = a.id
    WHERE a.org_id = ? AND a.created_at >= ? AND (at.step_position > 0 OR at.round > 0)`)
    .get(req.orgId, since).c;
  const byStatus = {};
  for (const r of db.prepare(`SELECT status, COUNT(*) c FROM alerts
    WHERE org_id = ? AND created_at >= ? GROUP BY status`).all(req.orgId, since)) byStatus[r.status] = r.c;

  // Per person, folded in each person's OWN local time. A responder without a
  // timezone is counted in the zone of the schedule that reached them, and only
  // then in UTC — the fallback is named in the response so a suspicious number
  // can be explained rather than argued about.
  const schedTz = new Map();
  for (const sc of qSchedules.all(req.orgId)) schedTz.set(`schedule:${sc.id}`, sc.timezone);
  const rows = qAttemptsInRange.all(req.orgId, since, MAX_ATTEMPTS_SCANNED);
  const people = new Map();
  for (const r of rows) {
    let p = people.get(r.user_id);
    if (!p) {
      p = { user: { id: r.user_id, name: r.name, color: r.color },
        total: 0, outOfHours: 0, nights: 0, timezone: r.timezone || null,
        tzSource: r.timezone ? 'user' : null };
      people.set(r.user_id, p);
    }
    const tz = r.timezone || schedTz.get(r.via) || 'UTC';
    if (!p.timezone) { p.timezone = tz; p.tzSource = schedTz.get(r.via) ? 'schedule' : 'utc-fallback'; }
    const { minutes, weekday } = oncall.localParts(r.notified_at, tz);
    p.total += 1;
    if (weekday >= 6 || minutes >= OOH_FROM || minutes < OOH_TO) p.outOfHours += 1;
    if (minutes >= NIGHT_FROM || minutes < NIGHT_TO) p.nights += 1;
  }

  // Per schedule. `via` carries how the person was reached, so this is the
  // schedule's OWN noise rather than every alert that happened to exist.
  const perSchedule = [];
  for (const sc of qSchedules.all(req.orgId)) {
    const c = db.prepare(`SELECT COUNT(DISTINCT a.id) c FROM alerts a
      JOIN alert_attempts at ON at.alert_id = a.id
      WHERE a.org_id = ? AND a.created_at >= ? AND at.via = ?`)
      .get(req.orgId, since, `schedule:${sc.id}`).c;
    perSchedule.push({ scheduleId: sc.id, name: sc.name, alerts: c,
      perWeek: Math.round((c / days) * 7 * 10) / 10 });
  }

  // What the loud channels cost. Only sms/voice ever set it (slice 3), so this
  // is the metered spend and nothing else.
  const cost = db.prepare(`SELECT COALESCE(SUM(cost_micros), 0) micros,
      COUNT(*) messages FROM notifications
    WHERE org_id = ? AND ts >= ? AND cost_micros IS NOT NULL AND cost_micros > 0`)
    .get(req.orgId, since);

  res.json({
    range: `${days}d`, since, at: t,
    mtta: { avgMs: mtta.v || 0, acked: mtta.c, unacked, daily: mttaDaily },
    escalation: {
      raised, escalated,
      acked: byStatus.acked || 0,
      exhausted: byStatus.exhausted || 0,
      canceled: byStatus.canceled || 0,
      resolved: byStatus.resolved || 0,
      rate: raised ? Math.round((escalated / raised) * 100) : 0,
      exhaustedRate: raised ? Math.round(((byStatus.exhausted || 0) / raised) * 100) : 0,
    },
    perPerson: [...people.values()].sort((a, b) => b.outOfHours - a.outOfHours || b.total - a.total).slice(0, 20),
    perSchedule: perSchedule.sort((a, b) => b.alerts - a.alerts),
    cost: { micros: cost.micros, messages: cost.messages },
    // Said rather than hidden: past this many attempts the per-person fold is a
    // sample, and a number presented as a total when it is a sample is a lie.
    truncated: rows.length >= MAX_ATTEMPTS_SCANNED,
  });
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
