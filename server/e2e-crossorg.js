'use strict';
/* End-to-end check for CROSS-ORG ACCESS by a platform operator.
 *
 * A super-admin may act inside any organization — that is the point of the role,
 * and the platform console depends on it. What was missing is the record: writes
 * audit themselves, but a super-admin READING a customer's events, logs or
 * settings left no trace anywhere. "Who looked into org X, and when" could only
 * be answered from the web server's access log, which nobody keeps as an access
 * record and which the customer's own audit trail cannot see.
 *
 * Hermetic: throwaway database, no network, no mail.
 *
 * What it guards, in order:
 *   - entering a foreign org writes exactly ONE row, in the TARGET org's trail,
 *     naming the operator — and not one row per request, because opening a page
 *     fires a dozen calls and a log nobody can read is not a record;
 *   - a second org gets its own row (the de-duplication is per target, not
 *     per session);
 *   - the detail says how the org was named (link vs header) and which endpoint,
 *     but NEVER the query string — that carries log search terms, i.e. the
 *     customer's data, and an audit trail is the last place to accumulate it;
 *   - acting in an org the operator is a MEMBER of writes nothing: that is
 *     ordinary work, already covered by org_switch;
 *   - a non-super-admin cannot use the override at all — no access, no row;
 *   - the override works through both doors (?org= and X-OpsCat-Org).
 *
 * ── and the gate that decides all of the above ──────────────────────────────
 *
 * `requireSession` resolves the org for EVERY authenticated request, and the
 * three answers it can give were covered by nothing: the 403 for a session with
 * no membership in the requested org, the deliberate exemption that lets a
 * super-admin through without one, and the fallback that lands a stale session
 * back in an org the user is actually in.
 *
 * They are covered here rather than anywhere else because this is the harness
 * about who may act in which org — the 403 is three lines below the
 * `superOverride` branch these checks already drive, and the fixtures the gate
 * needs (two foreign orgs, a super-admin, a tenant admin) are already standing.
 *
 * The reason it is worth writing on code that cannot fail it: the moment
 * `getMembership` becomes async, a missed `await` makes `membership` a truthy
 * Promise. `!membership` is then `false`, the 403 never fires, and a user with
 * no membership in the requested org is served that org's data with a 200 and
 * no log line. Nothing reads a property off that Promise — it is only TESTED —
 * so neither the type gate nor the strict thenable can see it. Only a harness
 * can, and only if it exists before the conversion.
 *
 *   cd server && node e2e-crossorg.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { chk, untilAsync, report, onExit, die } = require('./e2e-lib').harness();
const { waitForServer } = require('./e2e-lib');

// Environment BEFORE any src/ require — db.js and config.js are singletons.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opscat-crossorg-'));
process.env.OPSCAT_DATA_DIR = tmp;
onExit(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.OPSCAT_SECRET = 'e2e-crossorg-secret';
process.env.PORT = '3125';
process.env.OPSCAT_EDITION = 'cloud';
process.env.OPSCAT_ADMIN_EMAIL = 'operator@e2e.test';
process.env.OPSCAT_ADMIN_PASSWORD = 'seed-admin-password-1';

require('./src/index.js'); // boots the app on :3125

const { addMembership } = require('./src/db');
// Fixtures and read-back go through the SHIM, so they land in the database
// `run-e2e.js` handed this process in DATABASE_URL — the same one the code under
// test reads. A connection the harness opened for itself would be a different
// session, and a fixture written there surfaces as a foreign-key violation
// several calls later, pointing at the wrong thing entirely.
const q = require('./src/db/shim');
const { hashPassword, now, newId, DEFAULT_ORG_ID } = require('./src/util');

const BASE = 'http://127.0.0.1:3125';
const PASS = 'e2e-user-password-1';

const ACME = newId();
const GLOBEX = newId();

async function mkOrg(id, name, slug) {
  await q.prepare(`INSERT INTO organizations (id, name, slug, plan, status, created_at)
    VALUES (?, ?, ?, 'business', 'active', ?)`).run(id, name, slug, now());
}

async function mkUser(email, orgId, { superAdmin = false } = {}) {
  const { salt, hash } = hashPassword(PASS);
  const uid = newId();
  await q.prepare(`INSERT INTO users (id, org_id, email, name, role, is_super_admin, pass_salt, pass_hash,
      color, active, must_change_password, created_at)
    VALUES (?, ?, ?, ?, 'admin', ?, ?, ?, '#388bfd', 1, 0, ?)`)
    .run(uid, orgId, email, email.split('@')[0], superAdmin ? 1 : 0, salt, hash, now());
  await addMembership(uid, orgId, 'admin');
  return uid;
}

async function login(email) {
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASS }),
    });
    if (r.status === 429) { await new Promise((res) => setTimeout(res, 1000)); continue; }
    const j = await r.json().catch(() => null);
    return { cookie: (r.headers.get('set-cookie') || '').split(';')[0], csrf: j && j.csrf };
  }
  throw new Error('login stayed rate-limited — the harness cannot continue');
}

// The session row is addressed by the cookie's value, so the checks below can
// reach in and make a session STALE the way a revoked membership would.
const sidOf = (sess) => String(sess.cookie).split('=')[1];

// `org` goes in as a query parameter unless `viaHeader` is set — both doors exist
// and the audit detail has to tell them apart.
async function get(sess, p, org, { viaHeader = false } = {}) {
  const headers = { cookie: sess.cookie };
  let url = BASE + p;
  if (org && viaHeader) headers['X-OpsCat-Org'] = org;
  else if (org) url += `${p.includes('?') ? '&' : '?'}org=${org}`;
  const r = await fetch(url, { headers });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// Async now, so every call site awaits: `rows(ACME).length` on an unawaited
// query reads a property off the strict thenable and throws, which is the
// design — a Promise is truthy and `.length` would otherwise be `undefined`.
const rows = (orgId, action = 'superadmin_org_access') => q.prepare(
  'SELECT * FROM audit_log WHERE org_id = ? AND action = ? ORDER BY id').all(orgId, action);
const rowCount = async (orgId, action) => (await rows(orgId, action)).length;
/* Positive counts are WAITED for: `audit()` is fire-and-forget by design, so the
 * row lands after the response and reading it on the next line is a bet on
 * scheduling — one this suite lost twice on a loaded CI runner. A NEGATIVE
 * ("no row anywhere") cannot be waited for and does not need to be: absence is
 * only ever provable by looking, and every one below follows a positive check
 * that has already settled the trail. */
const rowCountAtLeast = async (orgId, n = 1, action = 'superadmin_org_access') => {
  await untilAsync(async () => (await rowCount(orgId, action)) >= n);
  return rowCount(orgId, action);
};

async function main() {
  chk('server boots and answers /api/health', await waitForServer(BASE));
  await mkOrg(ACME, 'Acme', 'acme');
  await mkOrg(GLOBEX, 'Globex', 'globex');
  // Our own operator rather than the seeded one: that account carries
  // must_change_password, which is a different flow and not what this checks.
  const operator = await mkUser('op@e2e.test', DEFAULT_ORG_ID, { superAdmin: true });
  await mkUser('tenant@e2e.test', ACME);

  const op = await login('op@e2e.test');
  chk('the operator can log in', !!op.csrf);

  // ── entering a foreign org ────────────────────────────────────────────────
  const ev = await get(op, '/api/events?limit=1', ACME);
  chk('a super-admin may read a foreign org', ev.status === 200, `got ${ev.status}`);

  await rowCountAtLeast(ACME, 1);   // the row is written after the response
  const first = await rows(ACME);
  chk('entering it wrote exactly one audit row', first.length === 1, `${first.length} rows`);
  chk('…in the TARGET org, not the operator’s', first[0]?.org_id === ACME);
  chk('…naming the operator', first[0]?.user_id === operator);
  chk('…as superadmin_org_access', first[0]?.action === 'superadmin_org_access');
  chk('…recording the door and the endpoint',
    /^link · GET \/api\/events$/.test(first[0]?.detail || ''), first[0]?.detail);
  chk('…and NOT the query string (it carries customer data)',
    !/limit=|org=/.test(first[0]?.detail || ''), first[0]?.detail);

  // ── one row per entry, not per request ────────────────────────────────────
  for (const p of ['/api/events?limit=1', '/api/logs?hours=1&limit=1', '/api/dashboard',
    '/api/admin/settings', '/api/team']) await get(op, p, ACME);
  chk('further requests in the same org add nothing', await rowCountAtLeast(ACME, 1) === 1,
    `${await rowCount(ACME)} rows`);

  // ── a second org is its own record ────────────────────────────────────────
  await get(op, '/api/events?limit=1', GLOBEX);
  chk('a different org gets its own row', await rowCountAtLeast(GLOBEX, 1) === 1, `${await rowCount(GLOBEX)} rows`);
  chk('…and the first org still has exactly one', await rowCount(ACME) === 1);

  // ── the header door ───────────────────────────────────────────────────────
  const viaHeader = await get(op, '/api/events?limit=1', GLOBEX, { viaHeader: true });
  chk('the header door works too', viaHeader.status === 200, `got ${viaHeader.status}`);
  chk('…and is deduplicated with the link door', await rowCountAtLeast(GLOBEX, 1) === 1,
    `${await rowCount(GLOBEX)} rows`);

  // ── the operator's OWN org is not cross-org ───────────────────────────────
  await get(op, '/api/events?limit=1', DEFAULT_ORG_ID);
  chk('acting in an org they belong to writes nothing',
    await rowCount(DEFAULT_ORG_ID) === 0, `${await rowCount(DEFAULT_ORG_ID)} rows`);

  // ── a normal admin cannot use the override at all ─────────────────────────
  const tenant = await login('tenant@e2e.test');
  const stolen = await get(tenant, '/api/events?limit=1', GLOBEX);
  chk('a tenant admin naming another org is answered from their OWN org',
    stolen.status === 200, `got ${stolen.status}`);
  chk('…and it leaves no cross-org row', await rowCountAtLeast(GLOBEX, 1) === 1, `${await rowCount(GLOBEX)} rows`);
  const tenantId = (await q.prepare('SELECT id FROM users WHERE email = ?').get('tenant@e2e.test')).id;
  const audits = (await q.prepare('SELECT COUNT(*) c FROM audit_log WHERE user_id = ? AND action = ?')
    .get(tenantId, 'superadmin_org_access')).c;
  chk('…and none anywhere else either', audits === 0, `${audits} rows`);

  // ── the membership gate itself ────────────────────────────────────────────
  // Everything above rests on requireSession answering "may this session act in
  // this org?" correctly. Below is that answer, all three of its arms.

  // 1. NO membership in the requested org → 403, and no data.
  const orphan = await mkUser('orphan@e2e.test', ACME);
  const orphanSess = await login('orphan@e2e.test');
  const before = await get(orphanSess, '/api/auth/orgs', null);
  chk('a member of Acme is served Acme', before.status === 200, `got ${before.status}`);
  chk('…as their active org', before.body?.activeOrgId === ACME, String(before.body?.activeOrgId));

  await q.prepare('DELETE FROM memberships WHERE user_id = ?').run(orphan);
  const refused = await get(orphanSess, '/api/auth/orgs', null);
  chk('once the last membership is revoked the SAME session is refused',
    refused.status === 403, `got ${refused.status}`);
  chk('…with "no organization membership" — not a 401, and not an empty 200',
    refused.body?.error === 'no organization membership', JSON.stringify(refused.body));

  // The failure this guards is not the status code, it is the DATA behind it: a
  // gate that stops firing serves the org's events to somebody who left it.
  const leaked = await get(orphanSess, '/api/events?limit=1', null);
  chk('…and a data endpoint is refused too, not only the org list',
    leaked.status === 403, `got ${leaked.status}`);
  chk('…returning an error rather than rows', !Array.isArray(leaked.body?.events),
    JSON.stringify(leaked.body).slice(0, 120));
  const named = await get(orphanSess, '/api/events?limit=1', ACME);
  chk('…and naming the org explicitly does not get them back in',
    named.status === 403, `got ${named.status}`);

  // 2. A super-admin without a membership is STILL allowed. That is the role,
  //    and the same `!membership` expression decides it — so a change that
  //    fixes one arm by breaking the other has to be visible here.
  const lonely = await mkUser('lonely@e2e.test', DEFAULT_ORG_ID, { superAdmin: true });
  await q.prepare('DELETE FROM memberships WHERE user_id = ?').run(lonely);
  const lonelySess = await login('lonely@e2e.test');
  const home = await get(lonelySess, '/api/auth/orgs', null);
  chk('a super-admin who is a member of nothing is still served',
    home.status === 200, `got ${home.status}`);
  chk('…in their home org', home.body?.activeOrgId === DEFAULT_ORG_ID, String(home.body?.activeOrgId));
  const reach = await get(lonelySess, '/api/auth/orgs', GLOBEX);
  chk('…and may still enter a foreign org', reach.status === 200, `got ${reach.status}`);
  chk('…acting inside it', reach.body?.activeOrgId === GLOBEX, String(reach.body?.activeOrgId));

  // 3. The stale-active-org fallback: a session pointing at an org the user is
  //    not in must land in one they ARE in, and that choice must be PERSISTED —
  //    otherwise every later request re-derives it and the write is dead code.
  const drifted = await mkUser('drifted@e2e.test', ACME);           // member of Acme only
  const driftedSess = await login('drifted@e2e.test');
  const driftedSid = sidOf(driftedSess);
  await q.prepare('UPDATE sessions SET active_org_id = ? WHERE id = ?').run(GLOBEX, driftedSid);
  const fellBack = await get(driftedSess, '/api/auth/orgs', null);
  chk('a session whose active org the user left falls back to one they are in',
    fellBack.status === 200 && fellBack.body?.activeOrgId === ACME,
    `${fellBack.status} ${fellBack.body?.activeOrgId}`);
  const activeOrgOf = async (sid) => (await q.prepare(
    'SELECT active_org_id a FROM sessions WHERE id = ?').get(sid))?.a;
  chk('…and the fallback is written back to the session row',
    await activeOrgOf(driftedSid) === ACME, String(await activeOrgOf(driftedSid)));
  chk('…and no cross-org audit row is written for an ordinary member',
    await rowCountAtLeast(ACME, 1) === 1, `${await rowCount(ACME)} rows`);

  // 3b. The other arm of the same fallback: the HOME org is no good either, so
  //     the answer has to come from `anyMembership`. Both reads sit in one `||`
  //     chain, which is exactly the shape a single missed await hides in.
  const stray = await mkUser('stray@e2e.test', ACME);               // membership: Acme
  await q.prepare('UPDATE users SET org_id = ? WHERE id = ?').run(GLOBEX, stray);  // home: Globex
  const straySess = await login('stray@e2e.test');
  const strayed = await get(straySess, '/api/auth/orgs', null);
  chk('a user whose HOME org is not a membership falls through to any membership',
    strayed.status === 200 && strayed.body?.activeOrgId === ACME,
    `${strayed.status} ${strayed.body?.activeOrgId}`);

  /* 3c. switch-org: the OTHER membership guard on the session path.
   *
   * `requireSession` decides which org a request acts in; `/api/auth/switch-org`
   * decides which org the session POINTS at from now on. Same table, same
   * `if (!(await getMembership(...)))` shape, and it was covered by nothing —
   * measured: dropping that await left all 23 harnesses green at 1593/1593,
   * which means a user could park their session in ANY organization by id and
   * every later request would be served from it.
   */
  const switchTo = async (sess, orgId) => {
    const r = await fetch(`${BASE}/api/auth/switch-org`, {
      method: 'POST',
      headers: { cookie: sess.cookie, 'content-type': 'application/json', 'x-opscat-csrf': sess.csrf },
      body: JSON.stringify({ orgId }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const stolenSwitch = await switchTo(driftedSess, GLOBEX);
  chk('switching into an org you are not a member of is refused',
    stolenSwitch.status === 403, `got ${stolenSwitch.status}`);
  chk('…saying so, rather than switching silently',
    stolenSwitch.body?.error === 'not a member of that organization', JSON.stringify(stolenSwitch.body));
  chk('…and the session is still acting in the org it was in',
    (await get(driftedSess, '/api/auth/orgs', null)).body?.activeOrgId === ACME);
  const ownSwitch = await switchTo(driftedSess, ACME);
  chk('…while switching into an org you ARE in still works', ownSwitch.status === 200, `got ${ownSwitch.status}`);

  report();
}

main().catch(die);
