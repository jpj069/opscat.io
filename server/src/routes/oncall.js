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
const q = require('../db/shim');
const { now, sha256, isStr, optStr, isEmail, clampInt, isId, utcDaySql, utcDayLabel } = require('../util');
const sec = require('../security');
const oncall = require('../engine/oncall');
const chain = require('../engine/alert-chain');
const contacts = require('../lib/contacts');
const telephony = require('../lib/telephony');
const webpush = require('../lib/webpush');
const alerts = require('../engine/alerts');
const { createRouteRegistrar, ApiProblem, withStatus } = require('../lib/route-schema');
const S = require('../schemas/oncall');

const router = express.Router();
router.use(sec.requireSessionOrToken);
// Mounted at /api/oncall (see index.js) — the prefix only affects the paths
// written into the spec, never Express routing.
const route = createRouteRegistrar(router, '/api/oncall');

const MAX_LAYERS = 5;
const MAX_PARTICIPANTS = 50;
const MAX_TIMELINE_DAYS = 60;

const memberOfOrg = q.prepare(`SELECT u.id FROM memberships m JOIN users u ON u.id = m.user_id
  WHERE m.user_id = ? AND m.org_id = ? AND u.active = 1`);
const isMember = async (userId, orgId) => isId(userId) && !!(await memberOfOrg.get(userId, orgId));

// ---- teams -----------------------------------------------------------------
const qTeams = q.prepare('SELECT * FROM teams WHERE org_id = ? ORDER BY name');
const qTeamMembers = q.prepare(`SELECT tm.user_id, u.name, u.email, u.color
  FROM team_members tm JOIN users u ON u.id = tm.user_id
  WHERE tm.team_id = ? AND u.active = 1 ORDER BY u.name`);
const qTeam = q.prepare('SELECT * FROM teams WHERE id = ? AND org_id = ?');

const teamView = async (t) => ({
  id: t.id, name: t.name, createdAt: t.created_at,
  members: (await qTeamMembers.all(t.id)).map((m) => ({ id: m.user_id, name: m.name, email: m.email, color: m.color })),
});

route({
  method: 'get', path: '/teams',
  summary: 'List teams',
  tags: ['On-Call'], auth: 'session',
  responses: { 200: S.TeamListResponse },
}, async ({ req }) => Promise.all((await qTeams.all(req.orgId)).map(teamView)));

// Members arrive as a whole list and REPLACE the current one — a team is a name
// and a member list, so there is nothing to patch member-by-member.
async function writeMembers(teamId, orgId, members) {
  await q.prepare('DELETE FROM team_members WHERE team_id = ?').run(teamId);
  const ins = q.prepare('INSERT INTO team_members (team_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING');
  for (const uid of members) if (await isMember(uid, orgId)) await ins.run(teamId, uid);
}

route({
  method: 'post', path: '/teams',
  summary: 'Create a team',
  description: 'Configuration, so lead+. It decides who gets woken at 03:00, which is not an analyst\'s call to make alone.',
  tags: ['On-Call'], auth: 'session',
  middleware: [sec.requireRole('lead')],
  body: S.TeamWriteBody,
  responses: { 201: S.TeamSchema, 400: S.ErrorResponse, 409: S.ErrorResponse },
}, async ({ req }) => {
  const { name, members } = req.body || {};
  if (!isStr(name, 80)) throw new ApiProblem(400, 'bad name');
  if (members !== undefined && !Array.isArray(members)) throw new ApiProblem(400, 'bad members');
  let id;
  try {
    id = await q.prepare('INSERT INTO teams (org_id, name, created_at) VALUES (?, ?, ?)')
      .insert(req.orgId, name.trim(), now());
  } catch { throw new ApiProblem(409, 'a team with that name already exists'); }
  await writeMembers(id, req.orgId, members || []);
  sec.audit(req.user.id, 'oncall_team_create', name.trim(), req.orgId);
  return teamView(await qTeam.get(id, req.orgId));
});

route({
  method: 'patch', path: '/teams/:id',
  summary: 'Rename a team or replace its members',
  tags: ['On-Call'], auth: 'session',
  middleware: [sec.requireRole('lead')],
  params: S.IdParam, body: S.TeamWriteBody,
  responses: { 200: S.TeamSchema, 400: S.ErrorResponse, 404: S.ErrorResponse, 409: S.ErrorResponse },
}, async ({ req }) => {
  const t = await qTeam.get(req.params.id, req.orgId);
  if (!t) throw new ApiProblem(404, 'team not found');
  const { name, members } = req.body || {};
  if (name !== undefined) {
    if (!isStr(name, 80)) throw new ApiProblem(400, 'bad name');
    try { await q.prepare('UPDATE teams SET name = ? WHERE id = ?').run(name.trim(), t.id); }
    catch { throw new ApiProblem(409, 'a team with that name already exists'); }
  }
  if (members !== undefined) {
    if (!Array.isArray(members)) throw new ApiProblem(400, 'bad members');
    await writeMembers(t.id, req.orgId, members);
  }
  sec.audit(req.user.id, 'oncall_team_update', `team ${t.id}`, req.orgId);
  return teamView(await qTeam.get(t.id, req.orgId));
});

route({
  method: 'delete', path: '/teams/:id',
  summary: 'Delete a team',
  description: 'Schedules pointing at it keep working — their team_id becomes NULL.',
  tags: ['On-Call'], auth: 'session',
  middleware: [sec.requireRole('lead')],
  params: S.IdParam,
  responses: { 200: S.OkResponse, 404: S.ErrorResponse },
}, async ({ req }) => {
  const t = await qTeam.get(req.params.id, req.orgId);
  if (!t) throw new ApiProblem(404, 'team not found');
  await q.prepare('DELETE FROM teams WHERE id = ?').run(t.id);   // schedules.team_id -> NULL
  sec.audit(req.user.id, 'oncall_team_delete', `${t.name}`, req.orgId);
  return { ok: true };
});

// ---- schedules -------------------------------------------------------------
const qSchedules = q.prepare('SELECT * FROM schedules WHERE org_id = ? ORDER BY name');
const qSchedule = q.prepare('SELECT * FROM schedules WHERE id = ? AND org_id = ?');
const qLayers = q.prepare('SELECT * FROM schedule_layers WHERE schedule_id = ? ORDER BY position');
const qParticipants = q.prepare(`SELECT sp.position, sp.user_id, u.name, u.email, u.color
  FROM schedule_participants sp JOIN users u ON u.id = sp.user_id
  WHERE sp.layer_id = ? ORDER BY sp.position`);
const qOverridesAll = q.prepare(`SELECT o.*, u.name, u.email, u.color FROM schedule_overrides o
  JOIN users u ON u.id = o.user_id WHERE o.schedule_id = ? AND o.ends_at > ?
  ORDER BY o.starts_at LIMIT 200`);

async function scheduleView(s, at = now()) {
  const r = await oncall.resolve(s, at);
  return {
    id: s.id, name: s.name, timezone: s.timezone, teamId: s.team_id, createdAt: s.created_at,
    onCall: r.user, via: r.via, gapSince: s.gap_alerted_at,
    layers: await Promise.all((await qLayers.all(s.id)).map(async (l) => ({
      id: l.id, position: l.position, rotation: l.rotation, intervalD: l.interval_d,
      handoffAt: l.handoff_at,
      restrict: l.restrict_json ? JSON.parse(l.restrict_json) : null,
      participants: (await qParticipants.all(l.id))
        .map((p) => ({ id: p.user_id, name: p.name, email: p.email, color: p.color })),
    }))),
    overrides: (await qOverridesAll.all(s.id, at)).map((o) => ({
      id: o.id, startsAt: o.starts_at, endsAt: o.ends_at,
      user: { id: o.user_id, name: o.name, email: o.email, color: o.color },
    })),
  };
}

route({
  method: 'get', path: '/schedules',
  summary: 'List schedules',
  description: 'Each carries who is on call right now and how that answer was reached.',
  tags: ['On-Call'], auth: 'session',
  responses: { 200: S.ScheduleListResponse },
}, async ({ req }) => {
  const at = now();
  return Promise.all((await qSchedules.all(req.orgId)).map((s) => scheduleView(s, at)));
});

route({
  method: 'get', path: '/schedules/:id',
  summary: 'Get one schedule',
  tags: ['On-Call'], auth: 'session',
  params: S.IdParam,
  responses: { 200: S.ScheduleSchema, 404: S.ErrorResponse },
}, async ({ req }) => {
  const s = await qSchedule.get(req.params.id, req.orgId);
  if (!s) throw new ApiProblem(404, 'schedule not found');
  return scheduleView(s);
});

route({
  method: 'post', path: '/schedules',
  summary: 'Create a schedule',
  tags: ['On-Call'], auth: 'session',
  middleware: [sec.requireRole('lead')],
  body: S.ScheduleWriteBody,
  responses: { 201: S.ScheduleSchema, 400: S.ErrorResponse, 409: S.ErrorResponse },
}, async ({ req }) => {
  const { name, timezone, teamId } = req.body || {};
  if (!isStr(name, 80)) throw new ApiProblem(400, 'bad name');
  const tz = timezone === undefined || timezone === null || timezone === '' ? 'UTC' : String(timezone);
  // Validated on write so a bad zone can never reach the resolver, where the
  // only options would be crashing or silently pretending it is UTC.
  if (!oncall.validTimezone(tz)) throw new ApiProblem(400, 'unknown timezone');
  if (teamId !== undefined && teamId !== null && !(await qTeam.get(teamId, req.orgId))) {
    throw new ApiProblem(400, 'unknown team');
  }
  let id;
  try {
    id = await q.prepare(`INSERT INTO schedules (org_id, team_id, name, timezone, created_at)
      VALUES (?, ?, ?, ?, ?)`).insert(req.orgId, teamId ?? null, name.trim(), tz, now());
  } catch { throw new ApiProblem(409, 'a schedule with that name already exists'); }
  sec.audit(req.user.id, 'oncall_schedule_create', name.trim(), req.orgId);
  return scheduleView(await qSchedule.get(id, req.orgId));
});

route({
  method: 'patch', path: '/schedules/:id',
  summary: 'Update a schedule',
  tags: ['On-Call'], auth: 'session',
  middleware: [sec.requireRole('lead')],
  params: S.IdParam, body: S.ScheduleWriteBody,
  responses: { 200: S.ScheduleSchema, 400: S.ErrorResponse, 404: S.ErrorResponse, 409: S.ErrorResponse },
}, async ({ req }) => {
  const s = await qSchedule.get(req.params.id, req.orgId);
  if (!s) throw new ApiProblem(404, 'schedule not found');
  const { name, timezone, teamId } = req.body || {};
  if (name !== undefined && !isStr(name, 80)) throw new ApiProblem(400, 'bad name');
  if (timezone !== undefined && !oncall.validTimezone(String(timezone))) {
    throw new ApiProblem(400, 'unknown timezone');
  }
  if (teamId !== undefined && teamId !== null && !(await qTeam.get(teamId, req.orgId))) {
    throw new ApiProblem(400, 'unknown team');
  }
  try {
    await q.prepare(`UPDATE schedules SET name = COALESCE(?, name), timezone = COALESCE(?, timezone),
      team_id = CASE WHEN ? THEN ? ELSE team_id END WHERE id = ?`)
      .run(name ? name.trim() : null, timezone ? String(timezone) : null,
        teamId === undefined ? 0 : 1, teamId ?? null, s.id);
  } catch { throw new ApiProblem(409, 'a schedule with that name already exists'); }
  sec.audit(req.user.id, 'oncall_schedule_update', `schedule ${s.id}`, req.orgId);
  return scheduleView(await qSchedule.get(s.id, req.orgId));
});

route({
  method: 'delete', path: '/schedules/:id',
  summary: 'Delete a schedule',
  tags: ['On-Call'], auth: 'session',
  middleware: [sec.requireRole('lead')],
  params: S.IdParam,
  responses: { 200: S.OkResponse, 404: S.ErrorResponse },
}, async ({ req }) => {
  const s = await qSchedule.get(req.params.id, req.orgId);
  if (!s) throw new ApiProblem(404, 'schedule not found');
  await q.prepare('DELETE FROM schedules WHERE id = ?').run(s.id);
  sec.audit(req.user.id, 'oncall_schedule_delete', s.name, req.orgId);
  return { ok: true };
});

// Layers are replaced as a SET, like the classifier rules: they are ordered and
// interdependent (position decides which one wins), so patching one at a time
// would let the client leave the ladder in a state the server never validated.
route({
  method: 'put', path: '/schedules/:id/layers',
  summary: 'Replace a schedule\'s rotation layers',
  description: 'Layers are replaced as a SET. They are ordered and interdependent — position decides which one '
    + 'wins — so patching one at a time would let a client leave the ladder in a state the server never validated.',
  tags: ['On-Call'], auth: 'session',
  middleware: [sec.requireRole('lead')],
  params: S.IdParam, body: S.LayersBody,
  responses: { 200: S.ScheduleSchema, 400: S.ErrorResponse, 404: S.ErrorResponse },
}, async ({ req }) => {
  const s = await qSchedule.get(req.params.id, req.orgId);
  if (!s) throw new ApiProblem(404, 'schedule not found');
  const layers = (req.body || {}).layers;
  if (!Array.isArray(layers) || layers.length > MAX_LAYERS) throw new ApiProblem(400, 'bad layers');

  const clean = [];
  for (const [i, l] of layers.entries()) {
    const rotation = String(l.rotation || 'weekly');
    if (!['daily', 'weekly', 'custom'].includes(rotation)) throw new ApiProblem(400, 'bad rotation');
    const intervalD = clampInt(l.intervalD, 1, 90, 1);
    const handoffAt = Number(l.handoffAt);
    if (!Number.isFinite(handoffAt)) throw new ApiProblem(400, 'bad handoffAt');
    if (!Array.isArray(l.participants) || l.participants.length > MAX_PARTICIPANTS) {
      throw new ApiProblem(400, 'bad participants');
    }
    // Silently dropping an unknown user would leave a rotation short by one and
    // nobody would know; refuse instead.
    for (const uid of l.participants) {
      if (!(await isMember(uid, req.orgId))) throw new ApiProblem(400, 'unknown participant');
    }
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

  await q.withTx(async () => {
    await q.prepare('DELETE FROM schedule_layers WHERE schedule_id = ?').run(s.id);
    const insL = q.prepare(`INSERT INTO schedule_layers
      (schedule_id, position, rotation, interval_d, handoff_at, restrict_json) VALUES (?, ?, ?, ?, ?, ?)`);
    const insP = q.prepare('INSERT INTO schedule_participants (layer_id, position, user_id) VALUES (?, ?, ?)');
    for (const l of clean) {
      const lid = await insL.insert(s.id, l.position, l.rotation, l.intervalD, l.handoffAt,
        l.restrict ? JSON.stringify(l.restrict) : null);
      for (const [i, uid] of l.participants.entries()) await insP.run(lid, i, uid);
    }
  });
  sec.audit(req.user.id, 'oncall_layers_update', `schedule ${s.id}: ${clean.length} layer(s)`, req.orgId);
  return scheduleView(await qSchedule.get(s.id, req.orgId));
});

route({
  method: 'post', path: '/schedules/:id/overrides',
  summary: 'Override who is on call for a window',
  description: 'A human correcting the machine outranks everything — an override wins over every layer.',
  tags: ['On-Call'], auth: 'session',
  middleware: [sec.requireRole('lead')],
  params: S.IdParam, body: S.OverrideBody,
  responses: { 201: S.OverrideCreated, 400: S.ErrorResponse, 404: S.ErrorResponse },
}, async ({ req }) => {
  const s = await qSchedule.get(req.params.id, req.orgId);
  if (!s) throw new ApiProblem(404, 'schedule not found');
  const { userId, startsAt, endsAt } = req.body || {};
  if (!(await isMember(userId, req.orgId))) throw new ApiProblem(400, 'unknown user');
  const a = Number(startsAt); const b = Number(endsAt);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) throw new ApiProblem(400, 'bad window');
  const id = await q.prepare(`INSERT INTO schedule_overrides
    (schedule_id, user_id, starts_at, ends_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .insert(s.id, userId, a, b, req.user.id, now());
  sec.audit(req.user.id, 'oncall_override_create', `schedule ${s.id} → user ${userId}`, req.orgId);
  return { ...(await scheduleView(await qSchedule.get(s.id, req.orgId))), id };
});

route({
  method: 'delete', path: '/overrides/:id',
  summary: 'Remove an override',
  tags: ['On-Call'], auth: 'session',
  middleware: [sec.requireRole('lead')],
  params: S.IdParam,
  responses: { 200: S.OkResponse, 404: S.ErrorResponse },
}, async ({ req }) => {
  const o = await q.prepare(`SELECT o.* FROM schedule_overrides o JOIN schedules s ON s.id = o.schedule_id
    WHERE o.id = ? AND s.org_id = ?`).get(req.params.id, req.orgId);
  if (!o) throw new ApiProblem(404, 'override not found');
  await q.prepare('DELETE FROM schedule_overrides WHERE id = ?').run(o.id);
  sec.audit(req.user.id, 'oncall_override_delete', `override ${o.id}`, req.orgId);
  return { ok: true };
});

// ---- escalation policies (§3.3) --------------------------------------------
// A policy is a LADDER: an ordered list of steps with a timeout each. Steps are
// replaced as a SET for the same reason layers are — position decides what
// happens when, so patching a rung at a time would let the client leave a ladder
// the server never validated.
const qPolicies = q.prepare('SELECT * FROM escalation_policies WHERE org_id = ? ORDER BY name');
const qPolicy = q.prepare('SELECT * FROM escalation_policies WHERE id = ? AND org_id = ?');
const qSteps = q.prepare('SELECT * FROM escalation_steps WHERE policy_id = ? ORDER BY position');
const qTargets = q.prepare('SELECT kind, ref_id FROM escalation_targets WHERE step_id = ?');
const qUserLite = q.prepare('SELECT id, name, color FROM users WHERE id = ?');
const qTeamLite = q.prepare('SELECT id, name FROM teams WHERE id = ? AND org_id = ?');
const qSchedLite = q.prepare('SELECT id, name FROM schedules WHERE id = ? AND org_id = ?');

const MAX_STEPS = 10;
const MAX_TARGETS = 20;

async function targetLabel(orgId, t) {
  if (t.kind === 'user') { const u = await qUserLite.get(t.ref_id); return u ? u.name : 'unknown user'; }
  if (t.kind === 'team') { const x = await qTeamLite.get(Number(t.ref_id), orgId); return x ? x.name : 'unknown team'; }
  const s = await qSchedLite.get(Number(t.ref_id), orgId);
  return s ? s.name : 'unknown schedule';
}

async function policyView(p) {
  const steps = await Promise.all((await qSteps.all(p.id)).map(async (s) => ({
    position: s.position, timeoutM: s.timeout_m,
    targets: await Promise.all((await qTargets.all(s.id))
      .map(async (t) => ({ kind: t.kind, refId: t.ref_id, label: await targetLabel(p.org_id, t) }))),
  })));
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
async function cleanSteps(orgId, raw) {
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
      if (kind === 'user') { if (!(await isMember(ref, orgId))) return { error: 'unknown user target' }; }
      else if (kind === 'team') { if (!(await qTeamLite.get(Number(ref), orgId))) return { error: 'unknown team target' }; }
      else if (kind === 'schedule') { if (!(await qSchedLite.get(Number(ref), orgId))) return { error: 'unknown schedule target' }; }
      else return { error: 'bad target kind' };
      clean.push({ kind, refId: ref });
    }
    out.push({ position: i, timeoutM, targets: clean });
  }
  return { steps: out };
}

async function writeSteps(policyId, steps) {
  await q.prepare('DELETE FROM escalation_steps WHERE policy_id = ?').run(policyId);
  const insS = q.prepare('INSERT INTO escalation_steps (policy_id, position, timeout_m) VALUES (?, ?, ?)');
  const insT = q.prepare('INSERT INTO escalation_targets (step_id, kind, ref_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING');
  for (const s of steps) {
    const sid = await insS.insert(policyId, s.position, s.timeoutM);
    for (const t of s.targets) await insT.run(sid, t.kind, t.refId);
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

route({
  method: 'get', path: '/policies',
  summary: 'List escalation policies',
  description: 'A policy is a LADDER: an ordered list of steps with a timeout each.',
  tags: ['On-Call'], auth: 'session',
  responses: { 200: S.PolicyListResponse },
}, async ({ req }) => Promise.all((await qPolicies.all(req.orgId)).map(policyView)));

route({
  method: 'post', path: '/policies',
  summary: 'Create an escalation policy',
  tags: ['On-Call'], auth: 'session',
  middleware: [sec.requireRole('lead')],
  body: S.PolicyWriteBody,
  responses: { 201: S.PolicySchema, 400: S.ErrorResponse, 409: S.ErrorResponse },
}, async ({ req }) => {
  const { name, repeatN, highMin, hours, steps } = req.body || {};
  if (!isStr(name, 80)) throw new ApiProblem(400, 'bad name');
  const cleaned = await cleanSteps(req.orgId, steps || []);
  if (cleaned.error) throw new ApiProblem(400, cleaned.error);
  const h = cleanHours(hours);
  let id;
  try {
    id = await q.prepare(`INSERT INTO escalation_policies
      (org_id, name, repeat_n, high_min, hours_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .insert(req.orgId, name.trim(), clampInt(repeatN, 0, 5, 0), clampInt(highMin, 0, 100, 80),
        h ? JSON.stringify(h) : null, now());
  } catch { throw new ApiProblem(409, 'a policy with that name already exists'); }
  await writeSteps(id, cleaned.steps);
  sec.audit(req.user.id, 'oncall_policy_create', name.trim(), req.orgId);
  return policyView(await qPolicy.get(id, req.orgId));
});

route({
  method: 'patch', path: '/policies/:id',
  summary: 'Update an escalation policy',
  tags: ['On-Call'], auth: 'session',
  middleware: [sec.requireRole('lead')],
  params: S.IdParam, body: S.PolicyWriteBody,
  responses: { 200: S.PolicySchema, 400: S.ErrorResponse, 404: S.ErrorResponse, 409: S.ErrorResponse },
}, async ({ req }) => {
  const p = await qPolicy.get(req.params.id, req.orgId);
  if (!p) throw new ApiProblem(404, 'policy not found');
  const { name, repeatN, highMin, hours, steps } = req.body || {};
  if (name !== undefined && !isStr(name, 80)) throw new ApiProblem(400, 'bad name');
  let cleaned = null;
  if (steps !== undefined) {
    cleaned = await cleanSteps(req.orgId, steps);
    if (cleaned.error) throw new ApiProblem(400, cleaned.error);
  }
  const h = cleanHours(hours);
  try {
    await q.prepare(`UPDATE escalation_policies SET name = COALESCE(?, name),
      repeat_n = COALESCE(?, repeat_n), high_min = COALESCE(?, high_min),
      hours_json = CASE WHEN ? THEN ? ELSE hours_json END WHERE id = ?`)
      .run(name ? name.trim() : null,
        repeatN === undefined ? null : clampInt(repeatN, 0, 5, 0),
        highMin === undefined ? null : clampInt(highMin, 0, 100, 80),
        h === undefined ? 0 : 1, h ? JSON.stringify(h) : null, p.id);
  } catch { throw new ApiProblem(409, 'a policy with that name already exists'); }
  if (cleaned) await q.withTx(() => writeSteps(p.id, cleaned.steps));
  sec.audit(req.user.id, 'oncall_policy_update', `policy ${p.id}`, req.orgId);
  return policyView(await qPolicy.get(p.id, req.orgId));
});

route({
  method: 'delete', path: '/policies/:id',
  summary: 'Delete an escalation policy',
  tags: ['On-Call'], auth: 'session',
  middleware: [sec.requireRole('lead')],
  params: S.IdParam,
  responses: { 200: S.OkResponse, 404: S.ErrorResponse },
}, async ({ req }) => {
  const p = await qPolicy.get(req.params.id, req.orgId);
  if (!p) throw new ApiProblem(404, 'policy not found');
  await q.prepare('DELETE FROM escalation_policies WHERE id = ?').run(p.id);
  sec.audit(req.user.id, 'oncall_policy_delete', p.name, req.orgId);
  return { ok: true };
});

// ---- alerts (§3.5) ---------------------------------------------------------
// Raising, acknowledging and cancelling are OPERATIONAL acts, not configuration:
// they are open to every member including analysts, because the person the alert
// woke is often the one with the least seniority and the most context.
const qAlerts = q.prepare(`SELECT * FROM alerts WHERE org_id = ?
  AND (? = 'all' OR (? = 'live' AND status IN ('active','acked')) OR status = ?)
  ORDER BY created_at DESC LIMIT ?`);
const qAlert = q.prepare('SELECT * FROM alerts WHERE id = ? AND org_id = ?');

route({
  method: 'get', path: '/alerts',
  summary: 'List alerts',
  description: 'Raising, acknowledging and cancelling are OPERATIONAL acts, open to every member including '
    + 'analysts: the person the alert woke is often the one with the least seniority and the most context.',
  tags: ['On-Call'], auth: 'session',
  query: S.AlertsQuery,
  responses: { 200: S.AlertListResponse },
}, async ({ req }) => {
  const filter = ['all', 'live', 'active', 'acked', 'resolved', 'exhausted', 'canceled']
    .includes(req.query.status) ? req.query.status : 'live';
  const limit = clampInt(req.query.limit, 1, 500, 100);
  return Promise.all((await qAlerts.all(req.orgId, filter, filter, filter, limit))
    .map((a) => chain.view(a)));
});

route({
  method: 'get', path: '/alerts/:id',
  summary: 'Get one alert, with every notification attempt',
  tags: ['On-Call'], auth: 'session',
  params: S.IdParam,
  responses: { 200: S.AlertSchema, 404: S.ErrorResponse },
}, async ({ req }) => {
  const a = await qAlert.get(req.params.id, req.orgId);
  if (!a) throw new ApiProblem(404, 'alert not found');
  return chain.view(a, { includeAttempts: true });
});

route({
  method: 'post', path: '/alerts',
  summary: 'Raise an alert against an escalation policy',
  description: 'Three different success answers, and the difference matters to the caller: **201** a new alert is '
    + 'ringing, **200** one was already live for this subject and is returned instead of a twin, **202** nobody was '
    + 'woken because a maintenance window or the policy\'s support hours suppressed it.',
  tags: ['On-Call'], auth: 'session',
  body: S.RaiseAlertBody,
  successStatus: 201,
  responses: { 201: S.AlertSchema, 200: S.AlertSchema, 202: S.AlertSuppressed, 400: S.ErrorResponse },
}, async ({ req }) => {
  const { subjectKind, subjectId, policyId, urgency, message } = req.body || {};
  if (!['case', 'incident'].includes(subjectKind)) throw new ApiProblem(400, 'bad subjectKind');
  if (!optStr(message, 500)) throw new ApiProblem(400, 'bad message');
  const r = await chain.raise(req.orgId, {
    subjectKind, subjectId: Number(subjectId), policyId: Number(policyId),
    urgency, message: message || null, source: `user:${req.user.id}`,
  });
  if (r.error) throw new ApiProblem(400, r.error);
  if (r.suppressed) return withStatus(202, { suppressed: r.suppressed });
  sec.audit(req.user.id, 'alert_raise', `${subjectKind} ${subjectId} → policy ${policyId}`, req.orgId);
  const view = await chain.view(r.alert, { includeAttempts: true });
  return r.already ? withStatus(200, view) : view;
});

route({
  method: 'post', path: '/alerts/:id/ack',
  summary: 'Acknowledge an alert',
  description: 'An alert that is already acknowledged, cancelled or exhausted cannot be acknowledged again. The UI '
    + 'disables the button; the endpoint refuses it — a disabled button is a courtesy, not a lock, and the API has other callers.',
  tags: ['On-Call'], auth: 'session',
  params: S.IdParam,
  responses: { 200: S.AlertSchema, 404: S.ErrorResponse, 409: S.ErrorResponse },
}, async ({ req }) => {
  const r = await chain.ack(req.orgId, Number(req.params.id), req.user.id, 'app');
  // An alert that is already acknowledged, cancelled or exhausted cannot be
  // acknowledged again. The UI disables the button; the endpoint refuses it —
  // a disabled button is a courtesy, not a lock, and the API has other callers.
  if (r.error) throw new ApiProblem(r.alert ? 409 : 404, r.error);
  sec.audit(req.user.id, 'alert_ack', `alert ${req.params.id}`, req.orgId);
  return chain.view(r.alert, { includeAttempts: true });
});

route({
  method: 'post', path: '/alerts/:id/cancel',
  summary: 'Cancel an alert',
  description: 'Stops the whole chain for that subject, not just this alert row.',
  tags: ['On-Call'], auth: 'session',
  params: S.IdParam,
  responses: { 200: S.AlertSchema, 404: S.ErrorResponse, 409: S.ErrorResponse },
}, async ({ req }) => {
  const a = await qAlert.get(req.params.id, req.orgId);
  if (!a) throw new ApiProblem(404, 'alert not found');
  if (!['active', 'acked'].includes(a.status)) throw new ApiProblem(409, `alert is ${a.status}`);
  await chain.cancelFor(req.orgId, a.subject_kind, a.subject_id, `canceled by ${req.user.name}`);
  sec.audit(req.user.id, 'alert_cancel', `alert ${a.id}`, req.orgId);
  return chain.view(await qAlert.get(a.id, req.orgId));
});

// ---- my on-call (§3.4) -----------------------------------------------------
// Contact methods belong to the PERSON, not the org, and are visible ONLY to
// their owner: an admin may see that a method exists elsewhere in the product,
// never the address. Every query below is scoped to req.user.id, which is what
// makes that true rather than merely intended (§7 Personal data).
const qMethods = q.prepare('SELECT * FROM contact_methods WHERE user_id = ? ORDER BY id');
const qMethod = q.prepare('SELECT * FROM contact_methods WHERE id = ? AND user_id = ?');
const qMyRules = q.prepare(`SELECT r.* FROM notification_rules r
  WHERE r.user_id = ? ORDER BY r.urgency, r.delay_m, r.id`);

// Every kind a person can TYPE. `push` is absent on purpose: a subscription is
// handed over by the browser through its own endpoint below, not typed.
const METHOD_KINDS = contacts.TYPED_KINDS;

// A verification code is six digits, so the try counter is the only thing
// between it and a brute force. Five attempts, then the code is spent.
const VERIFY_TRIES = 5;
const VERIFY_TTL_MS = 15 * 60 * 1000;

route({
  method: 'get', path: '/me',
  summary: 'My contact methods, notification rules and shifts',
  description: 'Contact methods belong to the PERSON, not the org, and are visible ONLY to their owner: an admin '
    + 'may see elsewhere in the product that a method exists, never the address. Every query here is scoped to the '
    + 'caller, which is what makes that true rather than merely intended.',
  tags: ['On-Call'], auth: 'session',
  responses: { 200: S.MeResponse },
}, async ({ req }) => {
  const at = now();
  const mine = [];
  for (const s of await qSchedules.all(req.orgId)) {
    for (const shift of await oncall.timeline(s, at, at + 14 * 86400000)) {
      if (shift.userId === req.user.id) {
        mine.push({ scheduleId: s.id, schedule: s.name, startsAt: shift.startsAt, endsAt: shift.endsAt, via: shift.via });
      }
    }
  }
  return {
    methods: await Promise.all((await qMethods.all(req.user.id)).map(async (m) => {
      const gate = await contacts.usable(m, req.orgId);
      return {
        id: m.id, kind: m.kind, address: contacts.displayAddress(m), label: m.label,
        verifiedAt: m.verified_at, createdAt: m.created_at,
        needsVerification: contacts.isMetered(m.kind) && !m.verified_at,
        // Why this method will not be used, in the words the notification log
        // would use. A method that is quietly skipped is the failure mode.
        blockedReason: gate.ok ? null : gate.reason,
      };
    })),
    // Whether the org can use the metered channels at all, so the screen can say
    // so BEFORE somebody types a number and waits for a call that never comes.
    telephonyConfigured: telephony.isConfigured(req.orgId),
    rules: (await qMyRules.all(req.user.id)).map((r) => ({
      id: r.id, urgency: r.urgency, delayM: r.delay_m, methodId: r.method_id,
    })),
    // The implicit fallback, stated rather than hidden: a person with no rules
    // is still reachable, and the screen has to say so or they will assume the
    // opposite and configure nothing.
    fallbackEmail: req.user.email,
    shifts: mine.sort((a, b) => a.startsAt - b.startsAt).slice(0, 20),
  };
});

route({
  method: 'post', path: '/me/methods',
  summary: 'Add one of my contact methods',
  tags: ['On-Call'], auth: 'session',
  body: S.MethodCreateBody,
  responses: { 201: S.MethodCreated, 400: S.ErrorResponse },
}, async ({ req }) => {
  const { kind, address, label } = req.body || {};
  if (!METHOD_KINDS.includes(kind)) throw new ApiProblem(400, 'bad kind');
  if (!isStr(address, 300)) throw new ApiProblem(400, 'bad address');
  if (!optStr(label, 40)) throw new ApiProblem(400, 'bad label');
  let value = address.trim();
  if (kind === 'email' && !isEmail(value)) throw new ApiProblem(400, 'bad e-mail address');
  if (kind === 'ntfy' && !/^https?:\/\//i.test(value)) throw new ApiProblem(400, 'ntfy needs a topic URL');
  if (contacts.isMetered(kind)) {
    // Strict E.164, not a clever guess: every provider wants +<country><number>,
    // and inferring a country code is how a German mobile becomes a US landline.
    const e164 = contacts.normalisePhone(value);
    if (!e164) throw new ApiProblem(400, 'a phone number must be in international format, e.g. +4915112345678');
    value = e164;
  }
  const enc = contacts.encodeAddress(kind, value);
  const id = await q.prepare(`INSERT INTO contact_methods (user_id, kind, address, encrypted, label, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .insert(req.user.id, kind, enc.address, enc.encrypted, (label || '').trim(), now());
  // The address is deliberately NOT in the audit detail.
  sec.audit(req.user.id, 'contact_method_add', kind, req.orgId);
  return { id, needsVerification: contacts.isMetered(kind) };
});

// ---- verification (§7) ------------------------------------------------------
// An sms/voice method is dead until it is proven to belong to the person who
// typed it. The code goes to the address itself — that IS the proof — and it
// goes over the channel being verified, so a number that cannot receive an SMS
// never becomes an SMS method.
route({
  method: 'post', path: '/me/methods/:id/verify',
  summary: 'Send a verification code to one of my methods',
  description: 'An sms/voice method is dead until it is proven to belong to the person who typed it. The code goes '
    + 'to the address itself — that IS the proof — and always by SMS, even for a voice method: reading six digits '
    + 'aloud to somebody who has to type them back is worse in every way.',
  tags: ['On-Call'], auth: 'session',
  params: S.IdParam,
  responses: { 200: S.VerifySentResponse, 400: S.ErrorResponse, 404: S.ErrorResponse, 500: S.ErrorResponse, 502: S.ErrorResponse },
}, async ({ req }) => {
  const m = await qMethod.get(req.params.id, req.user.id);
  if (!m) throw new ApiProblem(404, 'method not found');
  if (!contacts.isMetered(m.kind)) throw new ApiProblem(400, 'this kind needs no verification');
  if (!telephony.isConfigured(req.orgId)) {
    throw new ApiProblem(400, 'no SMS/voice provider is configured for this organization yet');
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const address = contacts.decodeAddress(m);
  if (!address) throw new ApiProblem(500, 'stored number is unreadable');
  try {
    // Verification always goes by SMS, even for a voice method: reading six
    // digits aloud to someone who has to type them back is worse in every way,
    // and both kinds are the same number on the same handset.
    await telephony.sendSms(req.orgId, address, `OpsCat verification code: ${code}`);
  } catch (e) {
    throw new ApiProblem(502, String(e.message).slice(0, 200));
  }
  await q.prepare(`UPDATE contact_methods SET verify_hash = ?, verify_expires_at = ?, verify_tries = 0
    WHERE id = ?`).run(sha256(code), now() + VERIFY_TTL_MS, m.id);
  sec.audit(req.user.id, 'contact_method_verify_sent', m.kind, req.orgId);
  return { ok: true, expiresAt: now() + VERIFY_TTL_MS };
});

route({
  method: 'post', path: '/me/methods/:id/verify/confirm',
  summary: 'Confirm a verification code',
  description: 'Six digits, so the try counter is the only thing between it and a brute force: five attempts and the code is spent.',
  tags: ['On-Call'], auth: 'session',
  params: S.IdParam, body: S.VerifyConfirmBody,
  responses: { 200: S.OkResponse, 400: S.ErrorResponse, 404: S.ErrorResponse, 409: S.ErrorResponse, 429: S.ErrorResponse },
}, async ({ req }) => {
  const m = await qMethod.get(req.params.id, req.user.id);
  if (!m) throw new ApiProblem(404, 'method not found');
  if (m.verified_at) throw new ApiProblem(409, 'already verified');
  if (!m.verify_hash || !m.verify_expires_at || m.verify_expires_at < now()) {
    throw new ApiProblem(400, 'no code was sent, or it has expired');
  }
  if (m.verify_tries >= VERIFY_TRIES) throw new ApiProblem(429, 'too many attempts — send a new code');
  const code = String((req.body || {}).code || '');
  if (sha256(code) !== m.verify_hash) {
    await q.prepare('UPDATE contact_methods SET verify_tries = verify_tries + 1 WHERE id = ?').run(m.id);
    throw new ApiProblem(400, 'wrong code');
  }
  await q.prepare(`UPDATE contact_methods SET verified_at = ?, verify_hash = NULL, verify_expires_at = NULL
    WHERE id = ?`).run(now(), m.id);
  sec.audit(req.user.id, 'contact_method_verified', m.kind, req.orgId);
  return { ok: true };
});

// ---- Web Push ---------------------------------------------------------------
// The public VAPID key is exactly that: public. The browser needs it before it
// can ask for permission, so it is readable by any signed-in member.
route({
  method: 'get', path: '/me/push-key',
  summary: 'The public VAPID key',
  description: 'Public by definition: the browser needs it before it can ask for permission, so any signed-in member may read it.',
  tags: ['On-Call'], auth: 'session',
  responses: { 200: S.PushKeyResponse },
}, async () => ({ key: await webpush.publicKey() }));

route({
  method: 'post', path: '/me/push',
  summary: 'Subscribe this browser to Web Push',
  description: 'One row per browser. Re-subscribing in the same browser produces the same endpoint, and a second '
    + 'row would ring the same device twice on every rung — so an existing endpoint answers 200 with already:true '
    + 'instead of creating a twin.',
  tags: ['On-Call'], auth: 'session',
  body: S.PushSubscribeBody,
  successStatus: 201,
  responses: { 201: S.PushSubscribed, 200: S.PushSubscribed, 400: S.ErrorResponse },
}, async ({ req }) => {
  const sub = (req.body || {}).subscription;
  if (!webpush.isSubscription(sub)) throw new ApiProblem(400, 'bad push subscription');
  const label = isStr((req.body || {}).label, 40) ? req.body.label.trim() : 'this browser';
  const json = JSON.stringify({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
  // One row per browser. Re-subscribing in the same browser produces the same
  // endpoint, and a second row would ring the same device twice on every rung.
  for (const m of await qMethods.all(req.user.id)) {
    if (m.kind !== 'push') continue;
    const existing = contacts.decodeAddress(m);
    if (existing && JSON.parse(existing).endpoint === sub.endpoint) {
      return withStatus(200, { id: m.id, already: true });
    }
  }
  const enc = contacts.encodeAddress('push', json);
  const id = await q.prepare(`INSERT INTO contact_methods (user_id, kind, address, encrypted, label, verified_at, created_at)
    VALUES (?, 'push', ?, ?, ?, ?, ?)`)
    .insert(req.user.id, enc.address, enc.encrypted, label, now(), now());
  sec.audit(req.user.id, 'contact_method_add', 'push', req.orgId);
  return { id };
});

// Send a test message through one of MY methods — the same path an alert takes,
// so "it works" means the real thing works and not a second code path.
route({
  method: 'post', path: '/me/methods/:id/test',
  summary: 'Send a test notification through one of my methods',
  description: 'The same path an alert takes, so "it works" means the real thing works and not a second code path. '
    + 'A voice test would need a live alert to acknowledge; there is none, so the voice path is tested by the ack round trip instead.',
  tags: ['On-Call'], auth: 'session',
  params: S.IdParam,
  responses: { 200: S.MethodTestResponse, 400: S.ErrorResponse, 404: S.ErrorResponse, 500: S.ErrorResponse, 502: S.ErrorResponse },
}, async ({ req }) => {
  const m = await qMethod.get(req.params.id, req.user.id);
  if (!m) throw new ApiProblem(404, 'method not found');
  const gate = await contacts.usable(m, req.orgId);
  if (!gate.ok) throw new ApiProblem(400, gate.reason);
  const address = contacts.decodeAddress(m);
  if (!address) throw new ApiProblem(500, 'stored address is unreadable');
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
    return { ok: true, latencyMs: now() - t0 };
  } catch (e) {
    if (e instanceof ApiProblem) throw e;
    throw new ApiProblem(502, String(e.message).slice(0, 300));
  }
});

route({
  method: 'delete', path: '/me/methods/:id',
  summary: 'Delete one of my contact methods',
  tags: ['On-Call'], auth: 'session',
  params: S.IdParam,
  responses: { 200: S.OkResponse, 404: S.ErrorResponse },
}, async ({ req }) => {
  const m = await qMethod.get(req.params.id, req.user.id);
  if (!m) throw new ApiProblem(404, 'method not found');
  await q.prepare('DELETE FROM contact_methods WHERE id = ?').run(m.id);  // rules cascade
  sec.audit(req.user.id, 'contact_method_delete', m.kind, req.orgId);
  return { ok: true };
});

// Rules are a whole set per urgency: they are an ordered escalation of channels
// for one person, so the same argument as layers and steps applies.
route({
  method: 'put', path: '/me/rules',
  summary: 'Replace my notification rules',
  description: 'A whole set per urgency: an ordered escalation of channels for one person, so the same argument as layers and steps applies.',
  tags: ['On-Call'], auth: 'session',
  body: S.RulesBody,
  responses: { 200: S.RulesWritten, 400: S.ErrorResponse },
}, async ({ req }) => {
  const raw = (req.body || {}).rules;
  if (!Array.isArray(raw) || raw.length > 20) throw new ApiProblem(400, 'bad rules');
  const clean = [];
  for (const r of raw) {
    if (!['high', 'low'].includes(r.urgency)) throw new ApiProblem(400, 'bad urgency');
    if (!(await qMethod.get(Number(r.methodId), req.user.id))) throw new ApiProblem(400, 'unknown contact method');
    clean.push({ urgency: r.urgency, delayM: clampInt(r.delayM, 0, 24 * 60, 0), methodId: Number(r.methodId) });
  }
  await q.withTx(async () => {
    await q.prepare('DELETE FROM notification_rules WHERE user_id = ?').run(req.user.id);
    const ins = q.prepare(`INSERT INTO notification_rules (user_id, urgency, delay_m, method_id)
      VALUES (?, ?, ?, ?)`);
    for (const r of clean) await ins.run(req.user.id, r.urgency, r.delayM, r.methodId);
  });
  sec.audit(req.user.id, 'notification_rules_update', `${clean.length} rule(s)`, req.orgId);
  return { ok: true, count: clean.length };
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

const qAttemptsInRange = q.prepare(`SELECT at.user_id, at.notified_at, at.via, at.step_position, at.round,
    u.name, u.color, u.timezone
  FROM alert_attempts at
  JOIN alerts a ON a.id = at.alert_id
  JOIN users u ON u.id = at.user_id
  WHERE a.org_id = ? AND at.notified_at >= ?
  ORDER BY at.notified_at DESC LIMIT ?`);

route({
  method: 'get', path: '/analytics',
  summary: 'The four numbers a PagerDuty replacement is judged by',
  description: 'MTTA (how long until anybody said "I have it"), escalation rate (near zero means the ladder is '
    + 'decoration; near 100 means rung one points at the wrong person), out-of-hours load PER PERSON (the one that '
    + 'changes behaviour — a fair-looking rotation can still be wearing one person out), and alerts per schedule. '
    + 'Out-of-hours is folded in JS through the rotation engine\'s own localParts, because it is a question about '
    + 'LOCAL time and SQL has no timezone database.',
  tags: ['On-Call'], auth: 'session',
  query: S.OncallAnalyticsQuery,
  responses: { 200: S.OncallAnalyticsResponse },
}, async ({ req }) => {
  const days = { '7d': 7, '30d': 30, '90d': 90 }[req.query.range] || 30;
  const t = now();
  const since = t - days * 86400000;

  // MTTA — over CASES, because that is where an acknowledgement is recorded, and
  // it counts only cases that were actually acknowledged. Averaging in the
  // un-acknowledged ones as zero would make a team that answers nothing look fast.
  const mtta = await q.prepare(`SELECT AVG(acked_at - opened_at) v, COUNT(*) c FROM cases
    WHERE org_id = ? AND acked_at IS NOT NULL AND acked_at >= ?`).get(req.orgId, since);
  // The bucket is integer arithmetic, not a date function — see utcDaySql in
  // util.js for why neither engine gets to decide what a day is.
  const mttaDaily = (await q.prepare(`SELECT ${utcDaySql('acked_at')} bucket,
      AVG(acked_at - opened_at) v FROM cases
    WHERE org_id = ? AND acked_at IS NOT NULL AND acked_at >= ? GROUP BY bucket ORDER BY bucket`)
    .all(req.orgId, since))
    .map((r) => ({ d: utcDayLabel(r.bucket), v: r.v }));
  const unacked = (await q.prepare(`SELECT COUNT(*) c FROM cases
    WHERE org_id = ? AND opened_at >= ? AND acked_at IS NULL`).get(req.orgId, since)).c;

  // Escalation. `escalated` counts an alert that ever left rung one — the
  // attempt rows are the evidence, since step_position on the alert row is only
  // where it STOPPED.
  const raised = (await q.prepare('SELECT COUNT(*) c FROM alerts WHERE org_id = ? AND created_at >= ?')
    .get(req.orgId, since)).c;
  const escalated = (await q.prepare(`SELECT COUNT(DISTINCT a.id) c FROM alerts a
    JOIN alert_attempts at ON at.alert_id = a.id
    WHERE a.org_id = ? AND a.created_at >= ? AND (at.step_position > 0 OR at.round > 0)`)
    .get(req.orgId, since)).c;
  const byStatus = {};
  for (const r of await q.prepare(`SELECT status, COUNT(*) c FROM alerts
    WHERE org_id = ? AND created_at >= ? GROUP BY status`).all(req.orgId, since)) byStatus[r.status] = r.c;

  // Per person, folded in each person's OWN local time. A responder without a
  // timezone is counted in the zone of the schedule that reached them, and only
  // then in UTC — the fallback is named in the response so a suspicious number
  // can be explained rather than argued about.
  const schedTz = new Map();
  for (const sc of await qSchedules.all(req.orgId)) schedTz.set(`schedule:${sc.id}`, sc.timezone);
  const rows = await qAttemptsInRange.all(req.orgId, since, MAX_ATTEMPTS_SCANNED);
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
  for (const sc of await qSchedules.all(req.orgId)) {
    const c = (await q.prepare(`SELECT COUNT(DISTINCT a.id) c FROM alerts a
      JOIN alert_attempts at ON at.alert_id = a.id
      WHERE a.org_id = ? AND a.created_at >= ? AND at.via = ?`)
      .get(req.orgId, since, `schedule:${sc.id}`)).c;
    perSchedule.push({ scheduleId: sc.id, name: sc.name, alerts: c,
      perWeek: Math.round((c / days) * 7 * 10) / 10 });
  }

  // What the loud channels cost. Only sms/voice ever set it (slice 3), so this
  // is the metered spend and nothing else.
  const cost = await q.prepare(`SELECT COALESCE(SUM(cost_micros), 0) micros,
      COUNT(*) messages FROM notifications
    WHERE org_id = ? AND ts >= ? AND cost_micros IS NOT NULL AND cost_micros > 0`)
    .get(req.orgId, since);

  return {
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
  };
});

// ---- the question the module exists to answer ------------------------------
route({
  method: 'get', path: '/now',
  summary: 'Who is on call right now',
  description: 'The question the module exists to answer. `configured: false` marks a schedule with neither '
    + 'participants nor overrides — the gap that matters.',
  tags: ['On-Call'], auth: 'session',
  responses: { 200: S.NowResponse },
}, async ({ req }) => ({ at: now(), schedules: await oncall.onCallNow(req.orgId) }));

route({
  method: 'get', path: '/schedules/:id/timeline',
  summary: 'Project a schedule forward',
  description: 'Resolved every 30 minutes and collapsed into shifts, so a restriction that ends mid-day shows as two shifts rather than one wrong one.',
  tags: ['On-Call'], auth: 'session',
  params: S.IdParam, query: S.TimelineQuery,
  responses: { 200: S.TimelineResponse, 404: S.ErrorResponse },
}, async ({ req }) => {
  const s = await qSchedule.get(req.params.id, req.orgId);
  if (!s) throw new ApiProblem(404, 'schedule not found');
  const days = clampInt(req.query.days, 1, MAX_TIMELINE_DAYS, 14);
  const from = Number(req.query.from) || now();
  return {
    scheduleId: s.id, timezone: s.timezone, from, days,
    shifts: await oncall.timeline(s, from, from + days * 86400000),
  };
});

module.exports = router;
