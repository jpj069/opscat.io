'use strict';
/* End-to-end check for On-Call slice 1 (docs/ONCALL-V1.md).
 *
 * Hermetic: throwaway database, no network, no mail. Boots the real app and
 * drives it like the browser (cookie + CSRF).
 *
 * What it guards, in order:
 *   - migration v23 (teams, schedules, layers, participants, overrides) and
 *     that every user/org reference is a uuid, not an integer;
 *   - the resolution function §4: rotation order, daily/weekly/custom periods,
 *     instants BEFORE the anchor, layers highest-position-first, a restricted
 *     layer yielding NOBODY outside its window rather than its participant
 *     anyway, and overrides outranking every layer;
 *   - **the DST rule** — a weekly handoff at 09:00 Europe/Berlin stays 09:00
 *     local across the March and October transitions. This is the check the
 *     whole timezone machinery exists for: counting fixed millisecond periods
 *     from a UTC anchor passes every other test in this file and fails only
 *     twice a year, in the middle of somebody's shift;
 *   - a gap is an EVENT, not a null: oncall_gap is raised once per episode,
 *     re-armed when covered again, and NOT raised for a schedule nobody has
 *     configured yet (half-built is not broken);
 *   - the timeline is coalesced and agrees with resolve() at every boundary —
 *     one source of truth, no second implementation;
 *   - role gating (lead+ to write), org scoping, and that a participant from
 *     another org is refused rather than silently dropped.
 *
 *   cd server && node e2e-oncall.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { chk, report, onExit, die } = require('./e2e-lib').harness();

// Environment BEFORE any src/ require — db.js and config.js are singletons.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opscat-oncall-'));
process.env.OPSCAT_DATA_DIR = tmp;
onExit(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.OPSCAT_SECRET = 'e2e-oncall-secret';
process.env.PORT = '3131';
process.env.OPSCAT_EDITION = 'community';
process.env.OPSCAT_BASE_URL = 'https://ops.e2e.test';
process.env.OPSCAT_ADMIN_EMAIL = 'seed-admin@e2e.test';
process.env.OPSCAT_ADMIN_PASSWORD = 'seed-admin-password-1';

require('./src/index.js');

const { addMembership, schemaVersion } = require('./src/db');
// Fixtures and read-back go through the SHIM, so they land in the database
// `run-e2e.js` handed this process in DATABASE_URL — the same one the code under
// test reads. A connection the harness opened for itself would be a different
// session, and a fixture written there surfaces as a foreign-key violation
// several calls later, pointing at the wrong thing entirely.
const q = require('./src/db/shim');
const { hashPassword, now, newId, DEFAULT_ORG_ID, isId } = require('./src/util');
const oncall = require('./src/engine/oncall');

const BASE = 'http://127.0.0.1:3131';
const PASS = 'e2e-user-password-1';
const DAY = 86400000;

async function mkOrg(name) {
  const id = newId();
  await q.prepare(`INSERT INTO organizations (id, name, slug, plan, status, created_at)
    VALUES (?, ?, ?, 'enterprise', 'active', ?)`).run(id, name, name.toLowerCase(), now());
  return id;
}
async function mkUser(email, role, orgId = DEFAULT_ORG_ID) {
  const { salt, hash } = hashPassword(PASS);
  const uid = newId();
  await q.prepare(`INSERT INTO users (id, org_id, email, name, role, is_super_admin, pass_salt, pass_hash,
      color, active, must_change_password, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, '#388bfd', 1, 0, ?)`)
    .run(uid, orgId, email, email.split('@')[0], role, salt, hash, now());
  await addMembership(uid, orgId, role);
  return { id: uid, email, name: email.split('@')[0] };
}
async function login(email, password = PASS) {
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (r.status === 429) { await new Promise((res) => setTimeout(res, 1000)); continue; }
    let j = null; try { j = await r.json(); } catch { /* non-JSON */ }
    return { cookie: (r.headers.get('set-cookie') || '').split(';')[0], csrf: j && j.csrf, status: r.status };
  }
  throw new Error(`login for ${email} stayed rate-limited`);
}
async function call(sess, method, p, body) {
  const headers = { cookie: sess.cookie };
  if (method !== 'GET') { headers['X-OpsCat-CSRF'] = sess.csrf; headers['Content-Type'] = 'application/json'; }
  const r = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, j };
}
async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch { /* not yet */ }
    await new Promise((res) => setTimeout(res, 100));
  }
  return false;
}

// UTC instant for a Berlin wall-clock time, found by search — the harness must
// not reuse the implementation's own conversion, or a bug would cancel out.
function berlinInstant(y, mo, d, hh, mi) {
  const target = `${String(d).padStart(2, '0')}.${String(mo).padStart(2, '0')}.${y}, ${String(hh).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
  const f = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  let t = Date.UTC(y, mo - 1, d, hh, mi) - 3 * 3600000;
  for (let i = 0; i < 8; i++) { if (f.format(new Date(t)) === target) return t; t += 3600000; }
  throw new Error(`no Berlin instant for ${target}`);
}

const nameAt = async (sched, at) => { const r = await oncall.resolve(sched, at); return r.user ? r.user.name : null; };
const schedRow = (id) => q.prepare('SELECT * FROM schedules WHERE id = ?').get(id);
const eventsNamed = (n) => q.prepare('SELECT * FROM events WHERE name = ? ORDER BY id').all(n);

/* Schema questions asked of whichever engine is underneath.
 *
 * `sqlite_master` and `PRAGMA table_info` are SQLite's own. The same question
 * has an answer on Postgres, in `information_schema`, so the CHECK is
 * unchanged and only the place it reads the answer from moves. A portable
 * "does it exist" is simply a statement that names the object: it parses when
 * the object is there and raises when it is not.
 */
async function tableExists(t) {
  try { await q.prepare(`SELECT 1 FROM ${t} LIMIT 1`).all(); return true; } catch { return false; }
}
/* The declared type of one column, normalised to a single upper-case word.
 *
 * A column that references users/organizations is `uuid`, and `BIGINT` is the
 * failure this guards against. A column that must stay TEXT because it holds
 * uuids AND integers is asserted as TEXT exactly, which is the whole point of
 * that check.
 */
async function colType(table, col) {
  const row = await q.prepare(`SELECT data_type FROM information_schema.columns
    WHERE table_name = ? AND column_name = ?`).get(table, col);
  return row ? row.data_type.toUpperCase() : null;
}
const UUIDISH = (t) => t === 'TEXT' || t === 'UUID';

async function main() {
  chk('server boots and answers /api/health', await waitForServer());

  // ---- users -------------------------------------------------------------
  const anna = await mkUser('anna@e2e.test', 'lead');
  const ben = await mkUser('ben@e2e.test', 'analyst');
  const cara = await mkUser('cara@e2e.test', 'analyst');
  const analyst = await mkUser('nobody@e2e.test', 'analyst');
  const otherOrg = await mkOrg('Outsiders');
  const outsider = await mkUser('out@e2e.test', 'admin', otherOrg);

  const lead = await login(anna.email);
  const low = await login(analyst.email);
  chk('lead can sign in', lead.status === 200, `status ${lead.status}`);

  // ---- migration ---------------------------------------------------------
  chk('migration reached version 23', await schemaVersion() >= 23);
  for (const t of ['teams', 'team_members', 'schedules', 'schedule_layers',
    'schedule_participants', 'schedule_overrides']) {
    // eslint-disable-next-line no-await-in-loop
    chk(`table ${t} exists`, await tableExists(t));
  }
  const schedOrg = await colType('schedules', 'org_id');
  chk('schedules.org_id is TEXT (uuid), not INTEGER', UUIDISH(schedOrg), schedOrg);
  const partUser = await colType('schedule_participants', 'user_id');
  chk('schedule_participants.user_id is TEXT (uuid)', UUIDISH(partUser), partUser);

  // ---- teams -------------------------------------------------------------
  let r = await call(lead, 'POST', '/api/oncall/teams', { name: 'Network', members: [anna.id, ben.id] });
  chk('lead creates a team', r.status === 201 && r.j.members.length === 2, JSON.stringify(r.j));
  const teamId = r.j.id;
  chk('team members carry uuids', r.j.members.every((m) => isId(m.id)));

  r = await call(low, 'POST', '/api/oncall/teams', { name: 'Nope' });
  chk('analyst cannot create a team', r.status === 403, `status ${r.status}`);

  r = await call(lead, 'POST', '/api/oncall/teams', { name: 'Network' });
  chk('a duplicate team name is refused', r.status === 409, `status ${r.status}`);

  r = await call(lead, 'PATCH', `/api/oncall/teams/${teamId}`, { members: [anna.id] });
  chk('member list is replaced wholesale', r.status === 200 && r.j.members.length === 1);

  // ---- schedule ----------------------------------------------------------
  r = await call(lead, 'POST', '/api/oncall/schedules', { name: 'Primary', timezone: 'Nowhere/Nope' });
  chk('an unknown timezone is refused on write', r.status === 400, `status ${r.status}`);

  r = await call(lead, 'POST', '/api/oncall/schedules',
    { name: 'Primary', timezone: 'Europe/Berlin', teamId });
  chk('lead creates a schedule', r.status === 201 && r.j.timezone === 'Europe/Berlin', JSON.stringify(r.j));
  const schedId = r.j.id;
  chk('a fresh schedule has nobody on call', r.j.onCall === null && r.j.via === null);

  // Weekly rotation, handing over Mondays 09:00 Berlin. Anchor: 2026-03-02.
  const anchor = berlinInstant(2026, 3, 2, 9, 0);
  r = await call(lead, 'PUT', `/api/oncall/schedules/${schedId}/layers`, {
    layers: [{ rotation: 'weekly', handoffAt: anchor, participants: [anna.id, ben.id, cara.id] }],
  });
  chk('layers are written', r.status === 200 && r.j.layers.length === 1
    && r.j.layers[0].participants.length === 3, JSON.stringify(r.j.layers));

  const S = await schedRow(schedId);
  chk('at the anchor the first participant is on', await nameAt(S, anchor) === 'anna', await nameAt(S, anchor));
  chk('one minute BEFORE the anchor it is still the previous shift',
    await nameAt(S, anchor - 60000) === 'cara', await nameAt(S, anchor - 60000));
  chk('week 2 is the second participant', await nameAt(S, anchor + 7 * DAY) === 'ben');
  chk('week 3 is the third', await nameAt(S, anchor + 14 * DAY) === 'cara');
  chk('week 4 wraps to the first', await nameAt(S, anchor + 21 * DAY) === 'anna');
  chk('mid-week does not change the person',
    await nameAt(S, anchor + 3 * DAY + 5 * 3600000) === 'anna');

  // ---- the DST rule ------------------------------------------------------
  // Europe/Berlin: +1 in winter, +2 in summer. 2026-03-29 is the spring change,
  // 2026-10-25 the autumn one. The handoff must stay at 09:00 LOCAL across both.
  const springMonday = berlinInstant(2026, 3, 30, 9, 0);   // Monday after the change
  chk('handoff after the spring DST change is exactly at 09:00 local — nobody yet at 08:59',
    await nameAt(S, springMonday - 60000) !== await nameAt(S, springMonday),
    `${await nameAt(S, springMonday - 60000)} / ${await nameAt(S, springMonday)}`);
  chk('the spring handoff is NOT an hour early (08:00 local is still the old shift)',
    await nameAt(S, berlinInstant(2026, 3, 30, 8, 0)) === await nameAt(S, springMonday - 60000));
  const autumnMonday = berlinInstant(2026, 10, 26, 9, 0);  // Monday after the autumn change
  chk('handoff after the autumn DST change is exactly at 09:00 local',
    await nameAt(S, autumnMonday - 60000) !== await nameAt(S, autumnMonday),
    `${await nameAt(S, autumnMonday - 60000)} / ${await nameAt(S, autumnMonday)}`);
  chk('the autumn handoff is NOT an hour late (10:00 local is already the new shift)',
    await nameAt(S, berlinInstant(2026, 10, 26, 10, 0)) === await nameAt(S, autumnMonday));
  // The whole point, stated as two assertions. The anchor is in CET and this
  // Monday is in CEST, so the two wall-clock-equal instants are one hour apart
  // in UTC: a fixed-millisecond implementation is off by exactly that hour and
  // hands over at 08:00 or 10:00 local instead of 09:00.
  // (An autumn date would NOT show this — both ends are CET again, the offsets
  // cancel, and the naive implementation passes. That is why this uses summer.)
  const summerMonday = berlinInstant(2026, 6, 1, 9, 0);
  const weeks = Math.round((summerMonday - anchor) / (7 * DAY));
  chk('anchor and summer handoff are NOT a whole number of UTC weeks apart — that is the drift',
    Math.abs((summerMonday - anchor) - weeks * 7 * DAY) === 3600000,
    `off by ${(summerMonday - anchor) - weeks * 7 * DAY} ms, expected 3600000`);
  chk('the handoff is still exactly 09:00 local in summer time',
    await nameAt(S, summerMonday - 60000) !== await nameAt(S, summerMonday),
    `${await nameAt(S, summerMonday - 60000)} / ${await nameAt(S, summerMonday)}`);
  chk('and the rotation lands on the person a whole-week count says it should',
    await nameAt(S, summerMonday) === ['anna', 'ben', 'cara'][weeks % 3],
    `${await nameAt(S, summerMonday)} vs expected ${['anna', 'ben', 'cara'][weeks % 3]}`);

  // ---- daily and custom rotations ----------------------------------------
  r = await call(lead, 'PUT', `/api/oncall/schedules/${schedId}/layers`, {
    layers: [{ rotation: 'daily', handoffAt: anchor, participants: [anna.id, ben.id] }],
  });
  const D = await schedRow(schedId);
  chk('daily rotation flips every day', await nameAt(D, anchor) === 'anna'
    && await nameAt(D, anchor + DAY) === 'ben' && await nameAt(D, anchor + 2 * DAY) === 'anna');

  r = await call(lead, 'PUT', `/api/oncall/schedules/${schedId}/layers`, {
    layers: [{ rotation: 'custom', intervalD: 3, handoffAt: anchor, participants: [anna.id, ben.id] }],
  });
  const C = await schedRow(schedId);
  chk('custom rotation holds for its interval', await nameAt(C, anchor + 2 * DAY) === 'anna'
    && await nameAt(C, anchor + 3 * DAY) === 'ben');

  // ---- layers and restrictions -------------------------------------------
  // Base: cara 24/7. On top: anna, weekdays 08:00–18:00 only.
  r = await call(lead, 'PUT', `/api/oncall/schedules/${schedId}/layers`, {
    layers: [
      { rotation: 'weekly', handoffAt: anchor, participants: [cara.id] },
      { rotation: 'weekly', handoffAt: anchor, participants: [anna.id],
        restrict: { days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' } },
    ],
  });
  const L = await schedRow(schedId);
  chk('inside the window the higher layer wins',
    await nameAt(L, berlinInstant(2026, 3, 3, 10, 0)) === 'anna', await nameAt(L, berlinInstant(2026, 3, 3, 10, 0)));
  chk('outside the window the restricted layer yields NOBODY, not its participant',
    await nameAt(L, berlinInstant(2026, 3, 3, 22, 0)) === 'cara', await nameAt(L, berlinInstant(2026, 3, 3, 22, 0)));
  chk('on a weekend the restricted layer is out',
    await nameAt(L, berlinInstant(2026, 3, 7, 10, 0)) === 'cara', await nameAt(L, berlinInstant(2026, 3, 7, 10, 0)));
  chk('the restriction is evaluated in the SCHEDULE timezone',
    await nameAt(L, berlinInstant(2026, 3, 3, 7, 59)) === 'cara'
    && await nameAt(L, berlinInstant(2026, 3, 3, 8, 1)) === 'anna');

  // overnight window (22:00–06:00) is a window, not a mistake
  r = await call(lead, 'PUT', `/api/oncall/schedules/${schedId}/layers`, {
    layers: [
      { rotation: 'weekly', handoffAt: anchor, participants: [cara.id] },
      { rotation: 'weekly', handoffAt: anchor, participants: [ben.id], restrict: { days: [], from: '22:00', to: '06:00' } },
    ],
  });
  const N = await schedRow(schedId);
  chk('an overnight window wraps past midnight',
    await nameAt(N, berlinInstant(2026, 3, 3, 23, 0)) === 'ben'
    && await nameAt(N, berlinInstant(2026, 3, 4, 5, 0)) === 'ben'
    && await nameAt(N, berlinInstant(2026, 3, 4, 7, 0)) === 'cara');

  // ---- overrides ---------------------------------------------------------
  const ovrFrom = berlinInstant(2026, 3, 4, 0, 0);
  r = await call(lead, 'POST', `/api/oncall/schedules/${schedId}/overrides`,
    { userId: anna.id, startsAt: ovrFrom, endsAt: ovrFrom + DAY });
  chk('lead creates an override', r.status === 201, `status ${r.status}`);
  const ovrId = r.j.id;
  const O = await schedRow(schedId);
  chk('an override outranks every layer', await nameAt(O, ovrFrom + 3600000) === 'anna',
    await nameAt(O, ovrFrom + 3600000));
  chk('outside its window the layers are back', await nameAt(O, ovrFrom + 2 * DAY) !== 'anna');
  r = await call(lead, 'POST', `/api/oncall/schedules/${schedId}/overrides`,
    { userId: ben.id, startsAt: ovrFrom, endsAt: ovrFrom + DAY });
  chk('the most recently created override wins a tie',
    await nameAt(await schedRow(schedId), ovrFrom + 3600000) === 'ben');
  r = await call(lead, 'POST', `/api/oncall/schedules/${schedId}/overrides`,
    { userId: anna.id, startsAt: ovrFrom + DAY, endsAt: ovrFrom });
  chk('an inverted window is refused', r.status === 400, `status ${r.status}`);
  r = await call(lead, 'DELETE', `/api/oncall/overrides/${ovrId}`);
  chk('an override can be deleted', r.status === 200);

  // ---- /now and the timeline ---------------------------------------------
  r = await call(lead, 'GET', '/api/oncall/now');
  chk('/api/oncall/now answers for every schedule', r.status === 200
    && Array.isArray(r.j.schedules) && r.j.schedules.length === 1, JSON.stringify(r.j).slice(0, 160));
  chk('/now reports whether the schedule is configured at all', r.j.schedules[0].configured === true);

  const from = berlinInstant(2026, 3, 2, 0, 0);
  r = await call(lead, 'GET', `/api/oncall/schedules/${schedId}/timeline?from=${from}&days=7`);
  chk('the timeline returns coalesced shifts', r.status === 200 && r.j.shifts.length > 1,
    `${r.j && r.j.shifts && r.j.shifts.length} shifts`);
  const contiguous = r.j.shifts.every((s, i, a) => i === 0 || a[i - 1].endsAt === s.startsAt);
  chk('timeline shifts are contiguous', contiguous);
  const coalesced = r.j.shifts.every((s, i, a) => i === 0 || a[i - 1].userId !== s.userId || a[i - 1].via !== s.via);
  chk('adjacent shifts never repeat the same person+source', coalesced);
  const T = await schedRow(schedId);
  let agrees = true;
  for (const s of r.j.shifts) {
    const mid = s.startsAt + Math.floor((s.endsAt - s.startsAt) / 2);
    const direct = (await oncall.resolve(T, mid)).user;
    if ((direct ? direct.id : null) !== s.userId) { agrees = false; break; }
  }
  chk('the timeline agrees with resolve() inside every shift — one source of truth', agrees);

  // ---- the gap is an event ------------------------------------------------
  // A schedule with participants but a hole: a single restricted layer.
  r = await call(lead, 'POST', '/api/oncall/schedules', { name: 'Holey', timezone: 'UTC' });
  const holeId = r.j.id;
  await call(lead, 'PUT', `/api/oncall/schedules/${holeId}/layers`, {
    layers: [{ rotation: 'weekly', handoffAt: anchor, participants: [ben.id],
      // a window that cannot contain "now": days = the weekday it is not
      restrict: { days: [((new Date().getUTCDay() + 6) % 7) + 1 === 1 ? 2 : 1], from: '00:00', to: '23:59' } }],
  });
  r = await call(lead, 'POST', '/api/oncall/schedules', { name: 'Unconfigured', timezone: 'UTC' });
  const emptyId = r.j.id;

  const beforeGaps = (await eventsNamed('oncall_gap')).length;
  await oncall.tick();
  const gaps = await eventsNamed('oncall_gap');
  chk('a schedule with a hole raises oncall_gap', gaps.length === beforeGaps + 1,
    `${gaps.length} vs ${beforeGaps + 1}`);
  chk('the gap event names the schedule and is severity 70',
    gaps.length > 0 && gaps[gaps.length - 1].device === 'Holey' && gaps[gaps.length - 1].severity === 70,
    JSON.stringify(gaps[gaps.length - 1] || {}).slice(0, 140));
  chk('an UNCONFIGURED schedule raises nothing — half-built is not broken',
    !gaps.some((g) => g.device === 'Unconfigured'));
  chk('gap_alerted_at is stamped', !!(await schedRow(holeId)).gap_alerted_at);

  await oncall.tick();
  chk('a second tick does not raise the gap again',
    (await eventsNamed('oncall_gap')).length === gaps.length);

  // cover it, and the watch re-arms
  const t0 = now();
  await call(lead, 'POST', `/api/oncall/schedules/${holeId}/overrides`,
    { userId: cara.id, startsAt: t0 - 3600000, endsAt: t0 + 3600000 });
  await oncall.tick();
  chk('covering the hole clears gap_alerted_at', !(await schedRow(holeId)).gap_alerted_at);
  chk('and /now shows the person', (await call(lead, 'GET', '/api/oncall/now'))
    .j.schedules.find((s) => s.scheduleId === holeId).user.name === 'cara');

  // ---- guards -------------------------------------------------------------
  r = await call(lead, 'PUT', `/api/oncall/schedules/${schedId}/layers`, {
    layers: [{ rotation: 'weekly', handoffAt: anchor, participants: [outsider.id] }],
  });
  chk('a participant from another org is REFUSED, not silently dropped', r.status === 400,
    `status ${r.status}`);
  r = await call(lead, 'PUT', `/api/oncall/schedules/${schedId}/layers`, {
    layers: [{ rotation: 'sometimes', handoffAt: anchor, participants: [anna.id] }],
  });
  chk('an unknown rotation is refused', r.status === 400, `status ${r.status}`);
  r = await call(low, 'PUT', `/api/oncall/schedules/${schedId}/layers`, { layers: [] });
  chk('analyst cannot write layers', r.status === 403, `status ${r.status}`);
  r = await call(low, 'GET', '/api/oncall/now');
  chk('analyst CAN read who is on call', r.status === 200, `status ${r.status}`);

  const outSess = await login(outsider.email);
  r = await call(outSess, 'GET', `/api/oncall/schedules/${schedId}`);
  chk("another org cannot read this org's schedule", r.status === 404, `status ${r.status}`);
  r = await call(outSess, 'GET', '/api/oncall/now');
  chk('another org sees only its own schedules', r.status === 200 && r.j.schedules.length === 0,
    JSON.stringify(r.j).slice(0, 120));

  r = await call(lead, 'DELETE', `/api/oncall/teams/${teamId}`);
  chk('deleting a team leaves its schedules alive', r.status === 200
    && !!(await schedRow(schedId)) && (await schedRow(schedId)).team_id === null);

  r = await call(lead, 'DELETE', `/api/oncall/schedules/${holeId}`);
  chk('deleting a schedule cascades its layers and overrides', r.status === 200
    && (await q.prepare('SELECT COUNT(*) c FROM schedule_overrides WHERE schedule_id = ?')
      .get(holeId)).c === 0);

  // ---- report -------------------------------------------------------------
  report();
}

main().catch(die);
