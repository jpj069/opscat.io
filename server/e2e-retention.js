'use strict';
/* End-to-end check for LOG RETENTION — the one housekeeping job that deletes
 * customer data, and the one plan limit that was sold but never enforced.
 *
 * Hermetic: throwaway database, no network. It runs in the **cloud** edition on
 * purpose — the community edition unlocks everything (`edition.js` sets
 * `enforce=false`), so a community harness cannot tell a working plan ceiling
 * from a missing one. The last two checks flip enforcement off again to prove the
 * self-hosted promise ("bounded only by your disk") still holds.
 *
 * What it guards, in order:
 *   - each org is pruned with ITS OWN retention, not org 1's. This is the bug it
 *     exists for: the cleanup read `getOrgSetting(1, …)` — org 1's setting, back
 *     when ids were integers — and then deleted across
 *     the whole logs table with no org_id, so a Business customer paying for 90
 *     days kept whatever our own org had set (7), and the per-plan `retentionDays`
 *     was a number nothing in the code ever read;
 *   - the plan is a CEILING the org may shorten but not raise — shortening is a
 *     legitimate request ("keep three days"), lengthening is what the tier sells;
 *   - a garbage setting falls back to the ceiling instead of switching the cleanup
 *     off: parseInt('abc') is NaN, `ts < NaN` matches no row, and the table then
 *     grows silently forever;
 *   - the settings endpoint refuses a value past the plan (400, not a silent
 *     clamp) and reports the ceiling so the form can name it;
 *   - the community edition keeps no ceiling at all.
 *
 * It then guards the two OTHER plan limits, which had no harness anywhere — the
 * SEAT cap and the DAILY INGEST VOLUME cap. Both are enforced at a call site
 * whose answer is only ever read as a boolean:
 *
 *     if (!(await withinPlan(req, res, 'users'))) return undefined;   // admin.js
 *     if (!(await withinIngestPlan(req.orgId, res))) return;          // ingest.js
 *
 * `!Promise` is `false`, so a lost `await` there does not throw, does not fail
 * the type gate and does not reach the strict thenable — the cap simply stops
 * applying, with a 200 and no log line. Measured before these checks existed:
 * dropping either await left all 23 harnesses green at 1607/1607.
 *
 * For each cap: the boundary in both directions (one below accepted, AT the cap
 * refused), the refusal shape the UI reads (402/429 + the `error` string that
 * quotes used/limit), that the number is the org's PLAN ceiling rather than a
 * constant — raise the plan and the same request goes through, drop it back and
 * the org is over its allowance without losing what it already has — and that
 * the community edition applies no cap at all.
 *
 *   cd server && node e2e-retention.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { chk, report, onExit, die } = require('./e2e-lib').harness();
const { waitForServer } = require('./e2e-lib');

// Environment BEFORE any src/ require — db.js and config.js are singletons.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opscat-retention-'));
process.env.OPSCAT_DATA_DIR = tmp;
onExit(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.OPSCAT_SECRET = 'e2e-retention-secret';
process.env.PORT = '3135';
process.env.OPSCAT_EDITION = 'cloud';
process.env.OPSCAT_ADMIN_EMAIL = 'seed-admin@e2e.test';
process.env.OPSCAT_ADMIN_PASSWORD = 'seed-admin-password-1';
// The seat-cap checks CREATE users, and creating a user mails an activation
// link whenever a transport is configured. On any machine with these exported
// (this one has RESEND_API_KEY) the harness would send live mail to addresses
// that do not exist and then race a network round trip. Same reasoning as
// e2e-alerts.js, which removes them for the e-mail fallback in the ladder.
delete process.env.RESEND_API_KEY;
delete process.env.SMTP_HOST;

require('./src/index.js'); // boots the app on :3135

const { setOrgSetting, addMembership } = require('./src/db');
// Fixtures and read-back go through the SHIM, so they land in the database
// `run-e2e.js` handed this process in DATABASE_URL — the same one the code under
// test reads. A connection the harness opened for itself would be a different
// session, and a fixture written there surfaces as a foreign-key violation
// several calls later, pointing at the wrong thing entirely.
const q = require('./src/db/shim');
const { hashPassword, sha256, now, newId, DEFAULT_ORG_ID } = require('./src/util');
const plans = require('./src/plans');
const retention = require('./src/engine/retention');

const BASE = 'http://127.0.0.1:3135';
const PASS = 'e2e-user-password-1';
const DAY = 86400000;

// Tenant ids are uuids now, so the fixtures name them instead of counting.
const FREE = newId();
const PRO = newId();
const BIZ = newId();
const ENT = newId();

async function mkOrg(id, name, plan, slug) {
  await q.prepare(`INSERT INTO organizations (id, name, slug, plan, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(id, name, slug, plan, now());
}

async function mkAdmin(email, orgId) {
  const { salt, hash } = hashPassword(PASS);
  const uid = newId();
  await q.prepare(`INSERT INTO users (id, org_id, email, name, role, is_super_admin, pass_salt, pass_hash,
      color, active, must_change_password, created_at)
    VALUES (?, ?, ?, ?, 'admin', 0, ?, ?, '#388bfd', 1, 0, ?)`)
    .run(uid, orgId, email, email.split('@')[0], salt, hash, now());
  await addMembership(uid, orgId, 'admin');
  return email;
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

async function call(sess, method, p, body) {
  const headers = { cookie: sess.cookie };
  if (method !== 'GET') { headers['X-OpsCat-CSRF'] = sess.csrf; headers['Content-Type'] = 'application/json'; }
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}

const left = async (org) => (await q.prepare('SELECT COUNT(*) c FROM logs WHERE org_id = ?').get(org)).c;

// ── seat-cap + ingest-cap helpers ───────────────────────────────────────────
const setPlan = async (org, plan) =>
  q.prepare('UPDATE organizations SET plan = ? WHERE id = ?').run(plan, org);

// An org's plan is read fresh from `organizations` on every request
// (security.js resolves req.org per call), so moving a tier takes effect on the
// next one — which is what lets the same request be run either side of a
// change and be the only variable.
const addUser = (sess, email) =>
  call(sess, 'POST', '/api/admin/users', { email, name: email.split('@')[0], role: 'analyst' });
const attachUser = (sess, email) =>
  call(sess, 'POST', '/api/admin/users', { email, role: 'analyst' });
const isMember = async (org, email) => (await q.prepare(`SELECT COUNT(*) c FROM memberships m
  JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND u.email = ?`).get(org, email)).c > 0;

const HOUR = 3600000;
const hourBucket = (t) => Math.floor(t / HOUR) * HOUR;
// Set an org's counter for one hour bucket outright. Seeding the COUNTER rather
// than ingesting 50k real lines is the only affordable way to stand at the
// boundary of the free tier, and it is the same row the engine bumps.
const setUsedLines = (org, n, at = now()) => q.prepare(
  `INSERT INTO ingest_stats (org_id, bucket, lines, bytes, events) VALUES (?, ?, ?, 0, 0)
   ON CONFLICT(org_id, bucket) DO UPDATE SET lines = excluded.lines`).run(org, hourBucket(at), n);

const INGEST_KEY = `ock_${crypto.randomBytes(16).toString('hex')}`;
async function ingest(n) {
  const logs = Array.from({ length: n }, (_, i) => ({ device: 'cap-dev', line: `cap line ${i}` }));
  const r = await fetch(`${BASE}/v1/ingest/logs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': INGEST_KEY },
    body: JSON.stringify({ logs }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const ingested = async (org) => (await q.prepare(
  "SELECT COUNT(*) c FROM logs WHERE org_id = ? AND source = 'e2e-ingest'").get(org)).c;

async function main() {
  chk('server boots and answers /api/health', await waitForServer(BASE));
  plans.setEnforce(true);
  await mkOrg(FREE, 'Free Co', 'free', 'free-co');
  await mkOrg(PRO, 'Pro Co', 'pro', 'pro-co');
  await mkOrg(BIZ, 'Biz Co', 'business', 'biz-co');
  await mkOrg(ENT, 'Ent Co', 'enterprise', 'ent-co');

  // one line per day, 100 days back, for our own org and three tenants
  const ins = q.prepare('INSERT INTO logs (org_id, ts, device, line, sev, source) VALUES (?,?,?,?,6,?)');
  const t = now();
  for (const org of [DEFAULT_ORG_ID, FREE, PRO, BIZ]) {
    // eslint-disable-next-line no-await-in-loop
    for (let d = 0; d < 100; d++) await ins.run(org, t - d * DAY, 'dev', `line age ${d}d`, 'seed');
  }
  // `.every()` over an async predicate would keep every element regardless of
  // the answer — a Promise is truthy. Resolve first, then compare.
  const seeded = await Promise.all([DEFAULT_ORG_ID, FREE, PRO, BIZ].map((o) => left(o)));
  chk('seeded 100 days for four orgs', seeded.every((c) => c === 100), JSON.stringify(seeded));

  // Rows sit at ages 0…99 days and prune() runs a few ms later, so the row exactly
  // `days` old is already past the cutoff: N days of retention keeps N rows, not
  // N+1. Spelled out because an off-by-one in the EXPECTATION reads exactly like
  // an off-by-one in the code.
  await setOrgSetting(DEFAULT_ORG_ID, 'retention_logs_days', '7'); // the old global source
  await retention.pruneLogs(now());
  { const nFREE7 = await left(FREE);
    chk('free tenant is cut at its plan (7d)', nFREE7 === 7, `${nFREE7} rows`); }
  { const nPRO30 = await left(PRO);
    chk('pro tenant keeps 30 days', nPRO30 === 30, `${nPRO30} rows`); }
  { const nBIZ90 = await left(BIZ);
    chk('business tenant keeps 90 days', nBIZ90 === 90, `${nBIZ90} rows`); }
  { const nDEFAULT_ORG_ID7 = await left(DEFAULT_ORG_ID);
    chk('the default org governs only itself', nDEFAULT_ORG_ID7 === 7, `${nDEFAULT_ORG_ID7} rows`); }

  await setOrgSetting(PRO, 'retention_logs_days', '3');
  await retention.pruneLogs(now());
  { const nPRO3 = await left(PRO);
    chk('an org may shorten its own retention', nPRO3 === 3, `${nPRO3} rows`); }
  { const nBIZ90 = await left(BIZ);
    chk('shortening one org does not touch another', nBIZ90 === 90, `${nBIZ90} rows`); }

  await setOrgSetting(FREE, 'retention_logs_days', '365');
  chk('a setting past the plan is capped', await plans.retentionDaysFor(FREE) === 7, `${await plans.retentionDaysFor(FREE)}d`);
  await retention.pruneLogs(now());
  { const nFREE7 = await left(FREE);
    chk('and the cleanup still cuts at the plan', nFREE7 === 7, `${nFREE7} rows`); }

  await setOrgSetting(BIZ, 'retention_logs_days', 'abc');
  chk('a garbage setting falls back to the ceiling', await plans.retentionDaysFor(BIZ) === 90,
    `${await plans.retentionDaysFor(BIZ)}d`);
  await retention.pruneLogs(now());
  { const nBIZ90 = await left(BIZ);
    chk('the cleanup is not switched off by garbage', nBIZ90 === 90, `${nBIZ90} rows`); }

  chk('enterprise ceiling is 365', await plans.retentionCapFor(ENT) === 365, `${await plans.retentionCapFor(ENT)}`);

  // ── the settings endpoint ──────────────────────────────────────────────────
  const email = await mkAdmin('free-admin@e2e.test', FREE);
  const sess = await login(email);
  chk('tenant admin can log in', !!sess.csrf);

  const get = await call(sess, 'GET', '/api/admin/settings');
  chk('settings report the plan ceiling', get.body.retention_logs_days_max === '7',
    JSON.stringify(get.body.retention_logs_days_max));
  chk('settings report the effective retention', get.body.retention_logs_days_effective === '7',
    JSON.stringify(get.body.retention_logs_days_effective));

  const tooLong = await call(sess, 'PATCH', '/api/admin/settings', { retention_logs_days: '90' });
  chk('a value past the plan is refused, not clamped', tooLong.status === 400,
    `${tooLong.status} ${JSON.stringify(tooLong.body)}`);
  chk('the refusal names the ceiling', /7 days/.test(tooLong.body?.error || ''), tooLong.body?.error);

  const junk = await call(sess, 'PATCH', '/api/admin/settings', { retention_logs_days: 'abc' });
  chk('a non-numeric value is refused', junk.status === 400, `${junk.status}`);
  const zero = await call(sess, 'PATCH', '/api/admin/settings', { retention_logs_days: '0' });
  chk('zero days is refused', zero.status === 400, `${zero.status}`);
  const shorter = await call(sess, 'PATCH', '/api/admin/settings', { retention_logs_days: '3' });
  chk('a shorter value is accepted', shorter.status === 200, `${shorter.status}`);
  chk('and takes effect immediately', await plans.retentionDaysFor(FREE) === 3, `${await plans.retentionDaysFor(FREE)}d`);

  // ── the SEAT cap ───────────────────────────────────────────────────────────
  // Enforced in routes/admin.js by `withinPlan(req, res, 'users')`, at BOTH
  // places a person joins an org: attaching an account that already exists, and
  // creating a brand-new one. Nothing in the suite exercised either — measured,
  // dropping the await on that guard left all 23 harnesses green.
  chk('the free org starts on one of its three seats', await plans.usedFor(FREE, 'users') === 1,
    `${await plans.usedFor(FREE, 'users')}`);

  const seat2 = await addUser(sess, 'seat-2@e2e.test');
  chk('a seat below the cap is granted', seat2.status === 200, `${seat2.status} ${JSON.stringify(seat2.body)}`);
  const seat3 = await addUser(sess, 'seat-3@e2e.test');
  chk('the last seat of the tier is granted', seat3.status === 200, `${seat3.status}`);
  chk('the counter follows the memberships', await plans.usedFor(FREE, 'users') === 3,
    `${await plans.usedFor(FREE, 'users')}`);

  // AT the cap, not past it: `ok: used < limit`, so the third seat being taken
  // is what refuses the fourth.
  const seat4 = await addUser(sess, 'seat-4@e2e.test');
  chk('a seat past the cap is refused with 402', seat4.status === 402,
    `${seat4.status} ${JSON.stringify(seat4.body)}`);
  chk('the refusal quotes used/limit, which the dialog prints',
    /plan limit reached \(3\/3 users\)/.test(seat4.body?.error || ''), seat4.body?.error);
  // These two, not the status code, are what catch the lost await — measured.
  // Without it the guard still RESOLVES and still writes its 402, a tick later,
  // onto a response the handler has already answered; the client sees 402 either
  // way. What differs is that the seat was taken. A refusal is only a refusal if
  // nothing happened.
  chk('a refused seat creates no user row',
    (await q.prepare('SELECT COUNT(*) c FROM users WHERE email = ?').get('seat-4@e2e.test')).c === 0);
  chk('and the seat count did not move', await plans.usedFor(FREE, 'users') === 3);

  // The other call site: an account that already exists elsewhere. Same cap, and
  // it is a separate `if (!(await withinPlan(...)))` — a lost await on one of the
  // two leaves the other one working, which is what makes checking both worth it.
  const foreign = await mkAdmin('pro-admin@e2e.test', PRO);
  const attach = await attachUser(sess, foreign);
  chk('attaching an EXISTING account is capped too', attach.status === 402,
    `${attach.status} ${JSON.stringify(attach.body)}`);
  chk('and the account stayed out of the org', !(await isMember(FREE, foreign)));

  // The number is the org's PLAN ceiling, not a constant: same request, same
  // usage, one tier up.
  await setPlan(FREE, 'pro');
  chk('the ceiling is the plan\'s', (await plans.checkLimit(FREE, 'pro', 'users')).limit === 10,
    `${(await plans.checkLimit(FREE, 'pro', 'users')).limit}`);
  const attach2 = await attachUser(sess, foreign);
  chk('so one tier up, the refused request goes through',
    attach2.status === 200 && attach2.body?.added === true, `${attach2.status} ${JSON.stringify(attach2.body)}`);

  // Downgrading is the mirror of the retention rule above: intent survives,
  // behaviour stops. Nobody is evicted — the org is simply over its allowance
  // and may not add another.
  await setPlan(FREE, 'free');
  { const lim = await plans.checkLimit(FREE, 'free', 'users');
    chk('a downgrade leaves the org OVER its allowance rather than evicting anyone',
      lim.used === 4 && lim.limit === 3 && !lim.ok, JSON.stringify(lim)); }
  const seat5 = await addUser(sess, 'seat-5@e2e.test');
  chk('and refuses the next seat, quoting the overage',
    seat5.status === 402 && /\(4\/3 users\)/.test(seat5.body?.error || ''),
    `${seat5.status} ${seat5.body?.error}`);
  chk('the four members are all still there', await plans.usedFor(FREE, 'users') === 4);

  // USAGE.users counts memberships JOINed to ACTIVE users, which is what makes
  // "deactivate instead of remove" a usable answer to a full org — the account
  // and its history stay, the seat comes back.
  await call(sess, 'PATCH', `/api/admin/users/${seat2.body.id}`, { active: false });
  chk('a deactivated member stops consuming a seat', await plans.usedFor(FREE, 'users') === 3,
    `${await plans.usedFor(FREE, 'users')}`);
  await call(sess, 'PATCH', `/api/admin/users/${seat3.body.id}`, { active: false });
  const seat6 = await addUser(sess, 'seat-6@e2e.test');
  chk('and the freed seat is usable again', seat6.status === 200, `${seat6.status}`);

  await setPlan(FREE, 'enterprise');
  chk('an unlimited tier reports no seat ceiling',
    (await plans.checkLimit(FREE, 'enterprise', 'users')).limit === -1);
  const seat7 = await addUser(sess, 'seat-7@e2e.test');
  chk('and grants a seat past every other tier', seat7.status === 200, `${seat7.status}`);
  await setPlan(FREE, 'free');

  // ── the DAILY INGEST VOLUME cap ────────────────────────────────────────────
  // Enforced in routes/ingest.js by `withinIngestPlan(orgId, res)` on the three
  // API-key entry points. Free is 50 000 lines per UTC day, counted out of the
  // hourly `ingest_stats` rows the pipeline bumps.
  await q.prepare(`INSERT INTO api_keys (org_id, name, prefix, key_hash, scopes, active, created_at)
    VALUES (?, 'e2e-ingest', ?, ?, 'ingest', 1, ?)`)
    .run(FREE, INGEST_KEY.slice(0, 12), sha256(INGEST_KEY), now());

  // The window is a UTC DAY, so yesterday's spent allowance is yesterday's
  // problem. Seeded first, while today's counter is still empty — the other way
  // round the check cannot tell a working window from a missing one.
  await setUsedLines(FREE, 999999, now() - 25 * HOUR);
  { const v = await plans.checkIngestVolume(FREE);
    chk('a spent allowance from yesterday does not count against today', v.ok && v.used === 0,
      JSON.stringify(v)); }

  await setUsedLines(FREE, 49999);
  const under = await ingest(1);
  chk('a batch one line below the cap is accepted',
    under.status === 200 && under.body?.accepted === 1, `${under.status} ${JSON.stringify(under.body)}`);
  chk('and it consumed the last line of the allowance', await plans.ingestLinesToday(FREE) === 50000,
    `${await plans.ingestLinesToday(FREE)}`);

  const over = await ingest(1);
  chk('the batch that starts past the cap is refused with 429', over.status === 429,
    `${over.status} ${JSON.stringify(over.body)}`);
  chk('the refusal quotes used/limit, which the SDK surfaces',
    /daily log ingest limit reached \(50000\/50000 lines today\)/.test(over.body?.error || ''),
    over.body?.error);
  // Same shape as the seat cap: with the await lost, the 429 is still written
  // (late, onto an answered response) and the batch is ingested anyway. The row
  // count is the only witness.
  chk('a refused batch writes no log line', await ingested(FREE) === 1, `${await ingested(FREE)}`);

  // Same plan-ceiling rule as the seats, on the hot path.
  await setPlan(FREE, 'pro');
  { const v = await plans.checkIngestVolume(FREE);
    chk('the ingest ceiling is the plan\'s too — pro carries a million a day',
      v.limit === 1000000 && v.ok, JSON.stringify(v)); }
  const upgraded = await ingest(1);
  chk('so one tier up, the refused batch lands', upgraded.status === 200, `${upgraded.status}`);

  await setPlan(FREE, 'free');
  const downgraded = await ingest(1);
  chk('and back down, the org is over its allowance again',
    downgraded.status === 429 && /\(50001\/50000 lines today\)/.test(downgraded.body?.error || ''),
    `${downgraded.status} ${downgraded.body?.error}`);

  await setPlan(FREE, 'enterprise');
  { const v = await plans.checkIngestVolume(FREE);
    chk('an unlimited tier reports no ingest ceiling', v.limit === -1 && v.ok, JSON.stringify(v)); }
  const unlimited = await ingest(1);
  chk('and ingests past every other tier', unlimited.status === 200, `${unlimited.status}`);
  await setPlan(FREE, 'free');

  // ── community edition: the self-hosted promise ─────────────────────────────
  plans.setEnforce(false);
  await setOrgSetting(FREE, 'retention_logs_days', '3650');
  chk('community edition has no ceiling', await plans.retentionDaysFor(FREE) === 3650, `${await plans.retentionDaysFor(FREE)}d`);
  chk('community reports the ceiling as unlimited', await plans.retentionCapFor(FREE) === -1);

  // The converse of every cap above, and the check that proves the gate is
  // plan-driven rather than a constant somebody could not see: the same org, the
  // same free plan, the same spent allowance — and no cap at all.
  chk('community edition reports no seat ceiling',
    (await plans.checkLimit(FREE, 'free', 'users')).limit === -1);
  const ceSeat = await addUser(sess, 'seat-ce@e2e.test');
  chk('so a seat past the free tier is granted', ceSeat.status === 200, `${ceSeat.status}`);
  { const v = await plans.checkIngestVolume(FREE);
    chk('community edition reports no ingest ceiling', v.limit === -1 && v.ok, JSON.stringify(v)); }
  const ceIngest = await ingest(1);
  chk('and a spent free allowance ingests anyway', ceIngest.status === 200, `${ceIngest.status}`);

  report();
}

main().catch(die);
