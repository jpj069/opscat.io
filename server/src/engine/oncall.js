'use strict';
// On-Call (docs/ONCALL-V1.md slice 1): who has the duty, for any instant.
//
// Rotations are COMPUTED, never materialised as shift rows. Generating shifts
// forward would have to run forever, be regenerated on every roster edit, and
// would disagree with the formula the moment one generation was missed. The
// only stored exceptions are overrides, which are exceptions by definition.
//
// Three things this has to get right, all of them easy to get wrong:
//
//  1. The period is counted in the SCHEDULE'S TIMEZONE, not in UTC. A weekly
//     rotation handing over Mondays 09:00 Europe/Berlin must hand over at 09:00
//     local on both sides of a DST change. Counting fixed millisecond periods
//     from a UTC anchor moves the handoff by an hour twice a year — into the
//     middle of a shift, in a way nobody notices until it is somebody else's
//     turn. So we count whole LOCAL CALENDAR DAYS and compare local wall time.
//  2. A layer restriction filters the LAYER, not the person: a restricted layer
//     must yield NOBODY outside its window rather than its participant anyway.
//     That is what makes "business hours over a 24/7 base layer" work.
//  3. A gap is an EVENT, not a null. See tick() at the bottom.
const q = require('../db/shim');
const { now } = require('../util');
const pipeline = require('./pipeline');

// ---- local-time helpers ----------------------------------------------------
// Intl is the only timezone database Node ships; a formatter per zone is cached
// because building one is the expensive part.
const fmtCache = new Map();
function formatterFor(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

function validTimezone(tz) {
  try { formatterFor(String(tz)); return true; } catch { return false; }
}

// { dayIndex, minutes, weekday } — dayIndex counts local calendar days since the
// epoch, so subtracting two of them is a whole-day count that DST cannot skew.
function localParts(ms, tz) {
  let parts;
  try { parts = formatterFor(tz).formatToParts(new Date(ms)); }
  catch { parts = formatterFor('UTC').formatToParts(new Date(ms)); } // never crash on a bad zone
  const p = {};
  for (const { type, value } of parts) if (type !== 'literal') p[type] = value;
  const y = Number(p.year); const mo = Number(p.month); const d = Number(p.day);
  const utcNoon = Date.UTC(y, mo - 1, d);
  return {
    dayIndex: Math.floor(utcNoon / 86400000),
    minutes: Number(p.hour) * 60 + Number(p.minute),
    weekday: ((new Date(utcNoon).getUTCDay() + 6) % 7) + 1, // ISO: 1 = Monday
  };
}

const hhmm = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v >= 0 && v <= 1440 ? v : null;
};

// Does this layer's restriction cover `at`? No restriction = always.
function restrictionCovers(restrict, at, tz) {
  if (!restrict) return true;
  const { minutes, weekday } = localParts(at, tz);
  if (Array.isArray(restrict.days) && restrict.days.length && !restrict.days.includes(weekday)) return false;
  const from = hhmm(restrict.from); const to = hhmm(restrict.to);
  if (from === null || to === null || from === to) return true; // whole day
  // from > to is an overnight window (22:00–06:00), not a mistake.
  return from < to ? (minutes >= from && minutes < to) : (minutes >= from || minutes < to);
}

const PERIOD_DAYS = (layer) => (layer.rotation === 'daily' ? 1
  : layer.rotation === 'weekly' ? 7
    : Math.max(1, Number(layer.interval_d) || 1));

// Which participant of this layer is up at `at`? Index into the rotation order.
function shiftIndex(layer, at, tz) {
  const a = localParts(layer.handoff_at, tz);
  const b = localParts(at, tz);
  let days = b.dayIndex - a.dayIndex;
  // Before today's handoff time-of-day we are still in the previous shift.
  if (b.minutes < a.minutes) days -= 1;
  return Math.floor(days / PERIOD_DAYS(layer));
}

// ---- queries ---------------------------------------------------------------
const qSchedule = q.prepare('SELECT * FROM schedules WHERE id = ? AND org_id = ?');
const qSchedulesOfOrg = q.prepare('SELECT * FROM schedules WHERE org_id = ? ORDER BY name');
const qAllSchedules = q.prepare('SELECT * FROM schedules');
const qScheduleAny = q.prepare('SELECT * FROM schedules WHERE id = ?');
const qLayers = q.prepare('SELECT * FROM schedule_layers WHERE schedule_id = ? ORDER BY position DESC');
const qParticipants = q.prepare(`SELECT sp.user_id, u.name, u.email, u.color
  FROM schedule_participants sp JOIN users u ON u.id = sp.user_id
  WHERE sp.layer_id = ? AND u.active = 1 ORDER BY sp.position`);
const qOverrides = q.prepare(`SELECT o.*, u.name, u.email, u.color FROM schedule_overrides o
  JOIN users u ON u.id = o.user_id
  WHERE o.schedule_id = ? AND o.starts_at <= ? AND o.ends_at > ?
  ORDER BY o.created_at DESC, o.id DESC LIMIT 1`);
const qCountParticipants = q.prepare(`SELECT COUNT(*) c FROM schedule_participants sp
  JOIN schedule_layers l ON l.id = sp.layer_id WHERE l.schedule_id = ?`);
const qCountOverrides = q.prepare('SELECT COUNT(*) c FROM schedule_overrides WHERE schedule_id = ?');
const setGapAlerted = q.prepare('UPDATE schedules SET gap_alerted_at = ? WHERE id = ?');

/**
 * Who is on call on `schedule` at instant `at`?
 * Returns { user: {id,name,email,color}|null, via } — `via` is 'override',
 * 'layer:<position>' or null. Pure: no writes, no side effects.
 */
async function resolve(schedule, at = now()) {
  const tz = schedule.timezone || 'UTC';
  // 1. Overrides first. A human correcting the machine outranks everything.
  const ovr = await qOverrides.get(schedule.id, at, at);
  if (ovr) {
    return { user: { id: ovr.user_id, name: ovr.name, email: ovr.email, color: ovr.color }, via: 'override' };
  }
  // 2. Then layers, highest position downward.
  for (const layer of await qLayers.all(schedule.id)) {
    if (!restrictionCovers(parseRestrict(layer.restrict_json), at, tz)) continue;
    const people = await qParticipants.all(layer.id);
    if (!people.length) continue;
    const n = people.length;
    const idx = ((shiftIndex(layer, at, tz) % n) + n) % n;
    const p = people[idx];
    return { user: { id: p.user_id, name: p.name, email: p.email, color: p.color }, via: `layer:${layer.position}` };
  }
  // 3. Nobody. The caller decides what that means — see tick().
  return { user: null, via: null };
}

function parseRestrict(json) {
  if (!json) return null;
  try { const r = JSON.parse(json); return r && typeof r === 'object' ? r : null; } catch { return null; }
}

// `resolve` by id, org-scoped. Returns null when the schedule is not the org's.
async function whoIsOnCall(orgId, scheduleId, at = now()) {
  const s = await qSchedule.get(scheduleId, orgId);
  return s ? { schedule: s, ...(await resolve(s, at)) } : null;
}

// Every schedule of an org, resolved for the same instant — the Dashboard strip,
// the API and the MCP tool all read this.
async function onCallNow(orgId, at = now()) {
  const out = [];
  for (const s of await qSchedulesOfOrg.all(orgId)) {
    const r = await resolve(s, at);
    out.push({
      scheduleId: s.id, name: s.name, timezone: s.timezone, teamId: s.team_id,
      user: r.user, via: r.via,
      configured: (await qCountParticipants.get(s.id)).c > 0
        || (await qCountOverrides.get(s.id)).c > 0,
    });
  }
  return out;
}

/**
 * Coalesced shifts across a window — what the calendar draws.
 *
 * Sampled rather than solved. Boundaries fall out of three interacting things
 * (rotation period, layer restrictions, overrides), and a closed-form walk over
 * them would be a SECOND implementation of `resolve` that can disagree with the
 * first. Sampling keeps one source of truth; 30 minutes is the finest a
 * restriction can express, so nothing is missed.
 */
async function timeline(schedule, fromMs, toMs, stepMs = 30 * 60 * 1000) {
  const out = [];
  for (let t = fromMs; t < toMs; t += stepMs) {
    const r = await resolve(schedule, t);
    const id = r.user ? r.user.id : null;
    const last = out[out.length - 1];
    if (last && last.userId === id && last.via === r.via) { last.endsAt = t + stepMs; continue; }
    out.push({ startsAt: t, endsAt: t + stepMs, userId: id, user: r.user, via: r.via });
  }
  if (out.length) out[out.length - 1].endsAt = Math.min(out[out.length - 1].endsAt, toMs);
  return out;
}

// ---- the gap watch ---------------------------------------------------------
// "No answer" must never be rendered as a benign one. A schedule that resolves
// to NOBODY — empty rotation, expired override, a layer restricted to hours
// that do not cover now — is the single worst failure this module can have,
// because from inside the product it looks exactly like a quiet night.
//
// Only schedules that are MEANT to cover something raise it: one with no
// participants and no overrides is half-built, not broken, and alarming while
// somebody is still creating it would train the team to ignore the event.
// Guarded by gap_alerted_at so one gap is one event, re-armed when covered
// again (the heartbeats engine does the same).
/**
 * Report that `schedule` has nobody on call, once per episode.
 *
 * Called from two places — the minute tick below, and the escalation chain when
 * a policy step resolves a schedule to nobody (docs/ONCALL-V1.md §4). They must
 * share the `gap_alerted_at` guard: two callers with two guards is two events
 * for one hole, and the second one trains the team to ignore both.
 */
async function raiseGap(schedule, at = now()) {
  const s = (await qScheduleAny.get(schedule.id)) || schedule;
  if (s.gap_alerted_at) return false;
  await setGapAlerted.run(at, s.id);
  await pipeline.ingestEvent({
    name: 'oncall_gap', device: s.name, target: null, severity: 70,
    description: `oncall_gap ${s.name} — nobody is on call (${s.timezone})`,
  }, 'oncall', false, s.org_id);
  return true;
}

async function tick() {
  const t = now();
  for (const s of await qAllSchedules.all()) {
    const configured = (await qCountParticipants.get(s.id)).c > 0
      || (await qCountOverrides.get(s.id)).c > 0;
    if (!configured) continue;
    const covered = !!(await resolve(s, t)).user;
    if (covered) {
      if (s.gap_alerted_at) await setGapAlerted.run(null, s.id);
      continue;
    }
    await raiseGap(s, t);
  }
}

function start() {
  // tick() is async now, so a throw inside it is a rejected promise rather than
  // an exception the timer would surface. Handled here, or NODE_ENV=test exits
  // non-zero on the unhandled rejection and production loses the gap watch.
  const iv = setInterval(() => {
    tick().catch((e) => console.error('oncall gap watch error', e.message));
  }, 60000);
  iv.unref();
}

module.exports = {
  start, tick, raiseGap, resolve, whoIsOnCall, onCallNow, timeline,
  validTimezone, localParts, restrictionCovers, shiftIndex, PERIOD_DAYS,
};
