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
 *   cd server && node e2e-retention.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { chk, report, onExit, die } = require('./e2e-lib').harness();

// Environment BEFORE any src/ require — db.js and config.js are singletons.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opscat-retention-'));
process.env.OPSCAT_DATA_DIR = tmp;
onExit(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.OPSCAT_SECRET = 'e2e-retention-secret';
process.env.PORT = '3135';
process.env.OPSCAT_EDITION = 'cloud';
process.env.OPSCAT_ADMIN_EMAIL = 'seed-admin@e2e.test';
process.env.OPSCAT_ADMIN_PASSWORD = 'seed-admin-password-1';

require('./src/index.js'); // boots the app on :3135

const { db, setOrgSetting, addMembership } = require('./src/db');
const { hashPassword, now, newId, DEFAULT_ORG_ID } = require('./src/util');
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

function mkOrg(id, name, plan, slug) {
  db.prepare(`INSERT INTO organizations (id, name, slug, plan, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(id, name, slug, plan, now());
}

function mkAdmin(email, orgId) {
  const { salt, hash } = hashPassword(PASS);
  const uid = newId();
  db.prepare(`INSERT INTO users (id, org_id, email, name, role, is_super_admin, pass_salt, pass_hash,
      color, active, must_change_password, created_at)
    VALUES (?, ?, ?, ?, 'admin', 0, ?, ?, '#388bfd', 1, 0, ?)`)
    .run(uid, orgId, email, email.split('@')[0], salt, hash, now());
  addMembership(uid, orgId, 'admin');
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

const left = (org) => db.prepare('SELECT COUNT(*) c FROM logs WHERE org_id = ?').get(org).c;

async function main() {
  plans.setEnforce(true);
  mkOrg(FREE, 'Free Co', 'free', 'free-co');
  mkOrg(PRO, 'Pro Co', 'pro', 'pro-co');
  mkOrg(BIZ, 'Biz Co', 'business', 'biz-co');
  mkOrg(ENT, 'Ent Co', 'enterprise', 'ent-co');

  // one line per day, 100 days back, for our own org and three tenants
  const ins = db.prepare('INSERT INTO logs (org_id, ts, device, line, sev, source) VALUES (?,?,?,?,6,?)');
  const t = now();
  for (const org of [DEFAULT_ORG_ID, FREE, PRO, BIZ]) {
    for (let d = 0; d < 100; d++) ins.run(org, t - d * DAY, 'dev', `line age ${d}d`, 'seed');
  }
  chk('seeded 100 days for four orgs', [DEFAULT_ORG_ID, FREE, PRO, BIZ].every((o) => left(o) === 100));

  // Rows sit at ages 0…99 days and prune() runs a few ms later, so the row exactly
  // `days` old is already past the cutoff: N days of retention keeps N rows, not
  // N+1. Spelled out because an off-by-one in the EXPECTATION reads exactly like
  // an off-by-one in the code.
  setOrgSetting(DEFAULT_ORG_ID, 'retention_logs_days', '7'); // the old global source
  retention.pruneLogs(now());
  chk('free tenant is cut at its plan (7d)', left(FREE) === 7, `${left(FREE)} rows`);
  chk('pro tenant keeps 30 days', left(PRO) === 30, `${left(PRO)} rows`);
  chk('business tenant keeps 90 days', left(BIZ) === 90, `${left(BIZ)} rows`);
  chk('the default org governs only itself', left(DEFAULT_ORG_ID) === 7, `${left(DEFAULT_ORG_ID)} rows`);

  setOrgSetting(PRO, 'retention_logs_days', '3');
  retention.pruneLogs(now());
  chk('an org may shorten its own retention', left(PRO) === 3, `${left(PRO)} rows`);
  chk('shortening one org does not touch another', left(BIZ) === 90, `${left(BIZ)} rows`);

  setOrgSetting(FREE, 'retention_logs_days', '365');
  chk('a setting past the plan is capped', plans.retentionDaysFor(FREE) === 7, `${plans.retentionDaysFor(FREE)}d`);
  retention.pruneLogs(now());
  chk('and the cleanup still cuts at the plan', left(FREE) === 7, `${left(FREE)} rows`);

  setOrgSetting(BIZ, 'retention_logs_days', 'abc');
  chk('a garbage setting falls back to the ceiling', plans.retentionDaysFor(BIZ) === 90,
    `${plans.retentionDaysFor(BIZ)}d`);
  retention.pruneLogs(now());
  chk('the cleanup is not switched off by garbage', left(BIZ) === 90, `${left(BIZ)} rows`);

  chk('enterprise ceiling is 365', plans.retentionCapFor(ENT) === 365, `${plans.retentionCapFor(ENT)}`);

  // ── the settings endpoint ──────────────────────────────────────────────────
  const email = mkAdmin('free-admin@e2e.test', FREE);
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
  chk('and takes effect immediately', plans.retentionDaysFor(FREE) === 3, `${plans.retentionDaysFor(FREE)}d`);

  // ── community edition: the self-hosted promise ─────────────────────────────
  plans.setEnforce(false);
  setOrgSetting(FREE, 'retention_logs_days', '3650');
  chk('community edition has no ceiling', plans.retentionDaysFor(FREE) === 3650, `${plans.retentionDaysFor(FREE)}d`);
  chk('community reports the ceiling as unlimited', plans.retentionCapFor(FREE) === -1);

  report();
}

main().catch(die);
