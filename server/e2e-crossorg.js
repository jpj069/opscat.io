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
 *   cd server && node e2e-crossorg.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const R = [];
const chk = (name, pass, detail = '') => R.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : ` — ${detail}`}`);

// Environment BEFORE any src/ require — db.js and config.js are singletons.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opscat-crossorg-'));
process.env.OPSCAT_DATA_DIR = tmp;
process.env.OPSCAT_SECRET = 'e2e-crossorg-secret';
process.env.PORT = '3125';
process.env.OPSCAT_EDITION = 'cloud';
process.env.OPSCAT_ADMIN_EMAIL = 'operator@e2e.test';
process.env.OPSCAT_ADMIN_PASSWORD = 'seed-admin-password-1';

require('./src/index.js'); // boots the app on :3125

const { db, addMembership } = require('./src/db');
const { hashPassword, now, newId, DEFAULT_ORG_ID } = require('./src/util');

const BASE = 'http://127.0.0.1:3125';
const PASS = 'e2e-user-password-1';

const ACME = newId();
const GLOBEX = newId();

function mkOrg(id, name, slug) {
  db.prepare(`INSERT INTO organizations (id, name, slug, plan, status, created_at)
    VALUES (?, ?, ?, 'business', 'active', ?)`).run(id, name, slug, now());
}

function mkUser(email, orgId, { superAdmin = false } = {}) {
  const { salt, hash } = hashPassword(PASS);
  const uid = newId();
  db.prepare(`INSERT INTO users (id, org_id, email, name, role, is_super_admin, pass_salt, pass_hash,
      color, active, must_change_password, created_at)
    VALUES (?, ?, ?, ?, 'admin', ?, ?, ?, '#388bfd', 1, 0, ?)`)
    .run(uid, orgId, email, email.split('@')[0], superAdmin ? 1 : 0, salt, hash, now());
  addMembership(uid, orgId, 'admin');
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

const rows = (orgId, action = 'superadmin_org_access') => db.prepare(
  'SELECT * FROM audit_log WHERE org_id = ? AND action = ? ORDER BY id').all(orgId, action);

async function main() {
  mkOrg(ACME, 'Acme', 'acme');
  mkOrg(GLOBEX, 'Globex', 'globex');
  // Our own operator rather than the seeded one: that account carries
  // must_change_password, which is a different flow and not what this checks.
  const operator = mkUser('op@e2e.test', DEFAULT_ORG_ID, { superAdmin: true });
  mkUser('tenant@e2e.test', ACME);

  const op = await login('op@e2e.test');
  chk('the operator can log in', !!op.csrf);

  // ── entering a foreign org ────────────────────────────────────────────────
  const ev = await get(op, '/api/events?limit=1', ACME);
  chk('a super-admin may read a foreign org', ev.status === 200, `got ${ev.status}`);

  const first = rows(ACME);
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
  chk('further requests in the same org add nothing', rows(ACME).length === 1,
    `${rows(ACME).length} rows`);

  // ── a second org is its own record ────────────────────────────────────────
  await get(op, '/api/events?limit=1', GLOBEX);
  chk('a different org gets its own row', rows(GLOBEX).length === 1, `${rows(GLOBEX).length} rows`);
  chk('…and the first org still has exactly one', rows(ACME).length === 1);

  // ── the header door ───────────────────────────────────────────────────────
  const viaHeader = await get(op, '/api/events?limit=1', GLOBEX, { viaHeader: true });
  chk('the header door works too', viaHeader.status === 200, `got ${viaHeader.status}`);
  chk('…and is deduplicated with the link door', rows(GLOBEX).length === 1,
    `${rows(GLOBEX).length} rows`);

  // ── the operator's OWN org is not cross-org ───────────────────────────────
  await get(op, '/api/events?limit=1', DEFAULT_ORG_ID);
  chk('acting in an org they belong to writes nothing',
    rows(DEFAULT_ORG_ID).length === 0, `${rows(DEFAULT_ORG_ID).length} rows`);

  // ── a normal admin cannot use the override at all ─────────────────────────
  const tenant = await login('tenant@e2e.test');
  const stolen = await get(tenant, '/api/events?limit=1', GLOBEX);
  chk('a tenant admin naming another org is answered from their OWN org',
    stolen.status === 200, `got ${stolen.status}`);
  chk('…and it leaves no cross-org row', rows(GLOBEX).length === 1, `${rows(GLOBEX).length} rows`);
  const audits = db.prepare('SELECT COUNT(*) c FROM audit_log WHERE user_id = ? AND action = ?')
    .get(db.prepare('SELECT id FROM users WHERE email = ?').get('tenant@e2e.test').id,
      'superadmin_org_access').c;
  chk('…and none anywhere else either', audits === 0, `${audits} rows`);

  const fails = R.filter((l) => l.startsWith('FAIL'));
  console.log(R.join('\n'));
  console.log(`\n${R.length - fails.length}/${R.length} checks passed`);
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
