'use strict';
/* End-to-end check for the account-activation flow (docs/API.md § Users).
 *
 * Deliberately hermetic: throwaway database, and no mail ever leaves the process
 * — the Resend transport is exercised for real up to the HTTP call, which a stub
 * intercepts and records. So this runs in CI without network and without a mail
 * provider, and still proves the mail was BUILT correctly (subject, link, TTL).
 *
 * The flow it guards has two halves that must not be confused:
 *
 *   mail configured  -> the account is created with NO password and gets a
 *                       single-use activation link. Nothing is ever handed over,
 *                       so there is nothing to force a change of.
 *   no mail (or the
 *   send failed)     -> fallback to the one-time password an admin relays, and
 *                       THEN must_change_password applies and the forced dialog
 *                       stays hard.
 *
 * Getting that split wrong is silent in both directions: a broken link path
 * leaves a colleague locked out of an account that looks fine in the user list,
 * and a broken fallback path leaves an admin with no credential to hand over.
 *
 *   cd server && node e2e-invite.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const R = [];
const chk = (name, pass, detail = '') => R.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : ` — ${detail}`}`);

// Environment BEFORE any src/ require — db.js and config.js are singletons.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opscat-invite-'));
process.env.OPSCAT_DATA_DIR = tmp;
process.env.OPSCAT_SECRET = 'e2e-invite-secret';
process.env.PORT = '3119';
process.env.OPSCAT_EDITION = 'community';
process.env.OPSCAT_BASE_URL = 'https://ops.e2e.test';
process.env.OPSCAT_ADMIN_EMAIL = 'seed-admin@e2e.test';
process.env.OPSCAT_ADMIN_PASSWORD = 'seed-admin-password-1';
process.env.RESEND_API_KEY = 're_e2e_stub';
process.env.MAIL_TRANSPORT = 'resend';

// --- mail stub: intercept ONLY the provider call, leave every other fetch alone.
// The mailer's own code path (transport selection, headers, body) still runs.
const realFetch = global.fetch;
const MAILS = [];
let mailFails = false;
global.fetch = (url, opts) => {
  if (String(url).startsWith('https://api.resend.com/')) {
    if (mailFails) return Promise.resolve(new Response('upstream down', { status: 500 }));
    MAILS.push(JSON.parse(opts.body));
    return Promise.resolve(new Response('{"id":"stub"}', { status: 200 }));
  }
  return realFetch(url, opts);
};

require('./src/index.js'); // boots the app on :3119

const { db, addMembership } = require('./src/db');
const { hashPassword, now, sha256, newId, DEFAULT_ORG_ID } = require('./src/util');
const config = require('./src/config');

const BASE = 'http://127.0.0.1:3119';
const PASS = 'e2e-user-password-1';
const lastMail = () => MAILS[MAILS.length - 1];
const tokenIn = (mail) => (mail.html.match(/\/app\/login\?token=([A-Za-z0-9_-]+)/) || [])[1];
const userRow = (email) => db.prepare('SELECT * FROM users WHERE email = ?').get(email);
const tokensFor = (id) => db.prepare('SELECT * FROM login_tokens WHERE user_id = ?').all(id);

function mkUser(email, role, orgId) {
  const { salt, hash } = hashPassword(PASS);
  const uid = newId();
  db.prepare(`INSERT INTO users (id, org_id, email, name, role, is_super_admin, pass_salt, pass_hash,
      color, active, must_change_password, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, '#388bfd', 1, 0, ?)`)
    .run(uid, orgId, email, email.split('@')[0], role, salt, hash, now());
  addMembership(uid, orgId, role);
  return { id: uid, email };
}

// The auth limiter is real (10/min per IP) and this harness signs in more often than
// that. Waiting for the bucket keeps the limiter in the test instead of loosening it —
// and a 429 must NEVER be returned as a session, because the next call then fails with
// 401 and the check reads as "a non-admin cannot invite" when nobody was even signed in.
// That exact misreading cost a debugging round.
async function login(email, password = PASS) {
  for (let i = 0; i < 40; i++) {
    const r = await realFetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (r.status === 429) { await new Promise((res) => setTimeout(res, 1000)); continue; }
    let j = null;
    try { j = await r.json(); } catch { /* non-JSON */ }
    return { cookie: (r.headers.get('set-cookie') || '').split(';')[0], csrf: j && j.csrf,
      user: j && j.user, status: r.status };
  }
  throw new Error(`login for ${email} stayed rate-limited — the harness cannot continue`);
}

async function call(sess, method, p, body) {
  const headers = { cookie: sess.cookie };
  if (method !== 'GET') { headers['X-OpsCat-CSRF'] = sess.csrf; headers['Content-Type'] = 'application/json'; }
  const r = await realFetch(BASE + p, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let j = null;
  try { j = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, j, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}

async function anon(method, p, body) {
  const r = await realFetch(BASE + p, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined });
  let j = null;
  try { j = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, j, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { if ((await realFetch(`${BASE}/api/health`)).ok) return true; } catch { /* not yet */ }
    await new Promise((res) => setTimeout(res, 100));
  }
  return false;
}

async function main() {
  chk('server boots and answers /api/health', await waitForServer());

  // ── migration ─────────────────────────────────────────────────────────────
  const cols = db.pragma('table_info(login_tokens)').map((c) => c.name);
  chk('login_tokens carries a purpose column', cols.includes('purpose'), cols.join(','));
  chk('user_version is at least 13', db.pragma('user_version', { simple: true }) >= 13);

  const admin = await login('seed-admin@e2e.test', 'seed-admin-password-1');
  chk('seeded admin can sign in', admin.status === 200 && admin.user.role === 'admin', String(admin.status));
  chk('a password account reports hasPassword', admin.user.hasPassword === true);

  // ── 1. invitation by link (mail configured) ───────────────────────────────
  const inv = await call(admin, 'POST', '/api/admin/users',
    { email: 'newbie@e2e.test', name: 'New Bie', role: 'analyst' });
  chk('invite answers 200', inv.status === 200, JSON.stringify(inv.j));
  chk('invite reports invited, not a password',
    inv.j.invited === true && inv.j.initialPassword === undefined, JSON.stringify(inv.j));

  const nb = userRow('newbie@e2e.test');
  chk('invited account has NO password', nb.pass_hash === '' && nb.pass_salt === '');
  chk('invited account is not forced to change one', nb.must_change_password === 0);
  chk('invited account is active', nb.active === 1);

  const toks = tokensFor(nb.id);
  chk('exactly one activation token exists', toks.length === 1, String(toks.length));
  chk('the token has purpose invite', toks[0] && toks[0].purpose === 'invite');
  const ttlDays = toks[0] ? (toks[0].expires_at - toks[0].created_at) / 86400000 : 0;
  chk('the token lives 7 days', Math.abs(ttlDays - 7) < 0.01, `${ttlDays}d`);

  const mail = lastMail();
  chk('an invitation mail was built', !!mail && mail.to[0] === 'newbie@e2e.test');
  chk('the subject names the invitation', /invited/i.test(mail.subject), mail.subject);
  chk('the body carries an activation link on the configured base URL',
    mail.html.includes(`${config.baseUrl}/app/login?token=`), config.baseUrl);
  chk('the body says the link is single-use and expires', /once/i.test(mail.html) && /7 days/.test(mail.html));
  const token = tokenIn(mail);
  chk('the mailed token matches the stored hash',
    !!token && sha256(token) === toks[0].token_hash);

  // an account with no password must be unreachable by password, whatever is sent
  const guess = await login('newbie@e2e.test', 'anything-at-all-1234');
  chk('password login is refused for a passwordless account', guess.status === 401, String(guess.status));
  const empty = await login('newbie@e2e.test', '');
  chk('an empty password is refused too', empty.status !== 200, String(empty.status));

  // ── 2. accepting the invitation ───────────────────────────────────────────
  const acc = await anon('POST', '/api/auth/magic-login', { token });
  chk('the activation link signs the user in', acc.status === 200, JSON.stringify(acc.j));
  chk('the response flags it as an activation', acc.j.invited === true);
  chk('the activated user still has no password', acc.j.user.hasPassword === false);
  chk('the activated user is not force-prompted', acc.j.user.mustChangePassword === false);
  const NB = { cookie: acc.cookie, csrf: acc.j.csrf };

  const replay = await anon('POST', '/api/auth/magic-login', { token });
  chk('the activation link is single-use', replay.status === 401, String(replay.status));

  chk('the acceptance is audited',
    !!db.prepare("SELECT 1 FROM audit_log WHERE action = 'invite_accepted' AND user_id = ?").get(nb.id));
  chk('the invitation itself is audited',
    !!db.prepare("SELECT 1 FROM audit_log WHERE action = 'user_invited'").get());

  // ── 3. setting the first password needs no current one ────────────────────
  const NEW = 'chosen-by-the-user-1';
  const setPw = await call(NB, 'POST', '/api/auth/change-password', { newPassword: NEW });
  chk('a first password is set without proving an old one', setPw.status === 200, JSON.stringify(setPw.j));
  const me = await call(NB, 'GET', '/api/auth/me');
  chk('/me now reports hasPassword', me.j.user.hasPassword === true);
  const after = await login('newbie@e2e.test', NEW);
  chk('the chosen password works', after.status === 200, String(after.status));
  const tooShort = await call(NB, 'POST', '/api/auth/change-password', { newPassword: 'short' });
  chk('the 12-character minimum still applies', tooShort.status === 400, String(tooShort.status));

  // a user WITH a password must still prove it
  const noProof = await call(after, 'POST', '/api/auth/change-password', { newPassword: 'another-password-1' });
  chk('a voluntary change still requires the current password', noProof.status === 400, String(noProof.status));
  const wrongProof = await call(after, 'POST', '/api/auth/change-password',
    { currentPassword: 'nope-nope-nope', newPassword: 'another-password-1' });
  chk('a wrong current password is refused', wrongProof.status === 401, String(wrongProof.status));

  // ── 4. a magic link must not void a pending invitation ────────────────────
  const inv2 = await call(admin, 'POST', '/api/admin/users',
    { email: 'pending@e2e.test', name: 'Pen Ding', role: 'analyst' });
  chk('second invitation sent', inv2.j.invited === true);
  const pend = userRow('pending@e2e.test');
  const inviteHash = tokensFor(pend.id)[0].token_hash;
  await anon('POST', '/api/auth/magic-link', { email: 'pending@e2e.test' });
  const stillThere = tokensFor(pend.id);
  chk('requesting a magic link keeps the pending invitation',
    stillThere.some((t) => t.token_hash === inviteHash), JSON.stringify(stillThere.map((t) => t.purpose)));
  chk('and adds a login token beside it',
    stillThere.some((t) => t.purpose === 'login'), JSON.stringify(stillThere.map((t) => t.purpose)));

  // ── 5. the send fails -> fall back to a password, never a dead account ─────
  mailFails = true;
  const broke = await call(admin, 'POST', '/api/admin/users',
    { email: 'nomail@e2e.test', name: 'No Mail', role: 'analyst' });
  mailFails = false;
  chk('a failed send still answers 200', broke.status === 200, String(broke.status));
  chk('a failed send returns a one-time password', typeof broke.j.initialPassword === 'string');
  chk('a failed send says so', broke.j.mailFailed === true);
  const nm = userRow('nomail@e2e.test');
  chk('the fallback account must change its password', nm.must_change_password === 1);
  const nmLogin = await login('nomail@e2e.test', broke.j.initialPassword);
  chk('the fallback password works', nmLogin.status === 200, String(nmLogin.status));
  chk('and the browser is told to force a change', nmLogin.user.mustChangePassword === true);

  // ── 6. no mail transport at all -> the documented fallback ────────────────
  const keepKey = config.resendApiKey;
  config.resendApiKey = '';
  const offline = await call(admin, 'POST', '/api/admin/users',
    { email: 'offline@e2e.test', name: 'Off Line', role: 'analyst' });
  chk('without a transport an invite returns a password',
    typeof offline.j.initialPassword === 'string' && offline.j.invited === undefined,
    JSON.stringify(offline.j));
  const off = userRow('offline@e2e.test');
  chk('that account is forced to change it', off.must_change_password === 1);
  chk('and no activation token was minted', tokensFor(off.id).length === 0);

  // reset without a transport keeps the old behaviour too
  const offReset = await call(admin, 'PATCH', `/api/admin/users/${off.id}`, { resetPassword: true });
  chk('a reset without a transport returns a password',
    typeof offReset.j.initialPassword === 'string' && offReset.j.invited === undefined);
  config.resendApiKey = keepKey;

  // ── 7. reset by link ──────────────────────────────────────────────────────
  const victim = mkUser('victim@e2e.test', 'analyst', DEFAULT_ORG_ID);
  const V = await login('victim@e2e.test');
  chk('the user has a session before the reset', V.status === 200);
  const reset = await call(admin, 'PATCH', `/api/admin/users/${victim.id}`, { resetPassword: true });
  chk('a reset with mail sends a link', reset.j.invited === true, JSON.stringify(reset.j));
  const vr = userRow('victim@e2e.test');
  chk('the reset clears the password', vr.pass_hash === '' && vr.must_change_password === 0);
  const oldPw = await login('victim@e2e.test', PASS);
  chk('the old password stops working', oldPw.status === 401, String(oldPw.status));
  const vSession = await call(V, 'GET', '/api/auth/me');
  chk('the reset signed every session out', vSession.status === 401, String(vSession.status));
  chk('the reset mail is a reset, not an invitation', /new .*password/i.test(lastMail().subject),
    lastMail().subject);
  const vTok = tokensFor(victim.id);
  chk('a 7-day activation token was minted for the reset',
    vTok.length === 1 && vTok[0].purpose === 'invite');
  const vBack = await anon('POST', '/api/auth/magic-login', { token: tokenIn(lastMail()) });
  chk('the reset link signs them back in', vBack.status === 200, String(vBack.status));

  // ── 8. the deliberate escape hatch: manual:true ───────────────────────────
  // A colleague whose mailbox is not reachable yet, a shared NOC account. It must
  // be a CHOICE — never reachable by accident, and never the default.
  const man = await call(admin, 'POST', '/api/admin/users',
    { email: 'manual@e2e.test', name: 'Man Ual', role: 'analyst', manual: true });
  chk('manual:true returns a one-time password even with mail configured',
    typeof man.j.initialPassword === 'string' && man.j.invited === undefined, JSON.stringify(man.j));
  const mu = userRow('manual@e2e.test');
  chk('the manual account is forced to change it', mu.must_change_password === 1);
  chk('no activation token was minted for it', tokensFor(mu.id).length === 0);
  chk('and no mail went out', lastMail().to[0] !== 'manual@e2e.test');
  chk('the manual password works', (await login('manual@e2e.test', man.j.initialPassword)).status === 200);
  // anything other than the literal true keeps the safe path
  const notManual = await call(admin, 'POST', '/api/admin/users',
    { email: 'truthy@e2e.test', name: 'Tru Thy', role: 'analyst', manual: 'yes' });
  chk('a truthy-but-not-true manual keeps the link path', notManual.j.invited === true,
    JSON.stringify(notManual.j));

  // ── 9. the admin can SEE who never activated ──────────────────────────────
  const list = (await call(admin, 'GET', '/api/admin/users')).j;
  const row = (e) => list.find((u) => u.email === e);
  chk('a user who never opened the link is pending', row('pending@e2e.test').pending === true);
  chk('an activated user is not pending', row('newbie@e2e.test').pending === false);
  chk('a one-time-password account is not pending', row('manual@e2e.test').pending === false);
  chk('the admin itself is not pending', row('seed-admin@e2e.test').pending === false);

  // ── 10. the instance advertises whether it can mail at all ────────────────
  const pub = await (await realFetch(`${BASE}/api/plans`)).json();
  chk('/api/plans reports mail configured', pub.auth.mail === true, JSON.stringify(pub.auth));
  const keep2 = config.resendApiKey;
  config.resendApiKey = '';
  const pub2 = await (await realFetch(`${BASE}/api/plans`)).json();
  chk('and reports it false without a transport', pub2.auth.mail === false);
  config.resendApiKey = keep2;

  // ── 11. platform-initiated org creation takes the SAME path ───────────────
  // It used to be the odd one out: a random password, no mail, and — the part that
  // made it the weakest of the three — must_change_password = 0, so the secret the
  // operator read out over the phone stayed valid forever.
  const sa = admin; // the seeded first admin IS the super-admin — no second sign-in
  const org = await call(sa, 'POST', '/api/superadmin/orgs',
    { orgName: 'Acme Inc', email: 'owner@acme.test', name: 'Own Er', plan: 'free' });
  chk('creating an org answers 200', org.status === 200, JSON.stringify(org.j));
  chk('the owner is invited, not handed a password',
    org.j.invited === true && org.j.initialPassword === undefined, JSON.stringify(org.j));
  const owner = userRow('owner@acme.test');
  chk('the owner has no password', owner.pass_hash === '');
  chk('and is not forced to change one', owner.must_change_password === 0);
  const oTok = tokensFor(owner.id);
  chk('an activation token was minted for the owner',
    oTok.length === 1 && oTok[0].purpose === 'invite');
  chk('the mail names the organization', /Acme Inc/.test(lastMail().subject), lastMail().subject);
  chk('the activation link signs the owner in',
    (await anon('POST', '/api/auth/magic-login', { token: tokenIn(lastMail()) })).status === 200);

  const newOrg = db.prepare("SELECT * FROM organizations WHERE slug LIKE 'acme%'").get();
  chk('the new org is on the free plan and active',
    newOrg.plan === 'free' && newOrg.status === 'active');
  // `free` is forever — nothing ever read trial_ends_at to expire anything, and the
  // billing page showed a trial end date on a plan that does not end.
  chk('no trial end date is invented for a forever plan', newOrg.trial_ends_at === null,
    String(newOrg.trial_ends_at));

  // an address that already has an account becomes the owner — multi-org is supported
  const attach = await call(sa, 'POST', '/api/superadmin/orgs',
    { orgName: 'Second Corp', email: 'newbie@e2e.test', name: 'New Bie', plan: 'free' });
  chk('an existing account can own a new org', attach.status === 200 && attach.j.attached === true,
    JSON.stringify(attach.j));
  chk('it is the SAME user, not a second account',
    attach.j.ownerId === userRow('newbie@e2e.test').id);
  chk('their password is left untouched', userRow('newbie@e2e.test').pass_hash !== '');
  chk('and they got no invitation mail', lastMail().to[0] !== 'newbie@e2e.test');
  chk('they hold an admin membership in the new org',
    db.prepare("SELECT role FROM memberships WHERE user_id = ? AND org_id = ?")
      .get(attach.j.ownerId, attach.j.orgId)?.role === 'admin');

  // the manual escape hatch, and the must_change guard that used to be missing
  const orgMan = await call(sa, 'POST', '/api/superadmin/orgs',
    { orgName: 'Manual Ltd', email: 'owner2@acme.test', name: 'Man Ual', plan: 'free', manual: true });
  chk('manual:true hands over a one-time password',
    typeof orgMan.j.initialPassword === 'string' && orgMan.j.invited === undefined);
  chk('and THAT owner must change it', userRow('owner2@acme.test').must_change_password === 1);
  const oIn = await login('owner2@acme.test', orgMan.j.initialPassword);
  chk('the handed-over password works', oIn.status === 200, String(oIn.status));
  chk('and the browser is told to force a change', oIn.user.mustChangePassword === true);

  // ── 12. gating and the multi-org path are untouched ───────────────────────
  const grunt = mkUser('grunt@e2e.test', 'analyst', DEFAULT_ORG_ID);
  const G = await login('grunt@e2e.test');
  const denied = await call(G, 'POST', '/api/admin/users',
    { email: 'sneak@e2e.test', name: 'Sneak', role: 'admin' });
  chk('a non-admin cannot invite', denied.status === 403, String(denied.status));
  chk('and no account was created', !userRow('sneak@e2e.test'));

  // no hard-coded id: earlier sections now create organizations of their own, and a
  // fixture that pins a primary key breaks the moment something is added above it.
  const otherOrgId = newId();
  db.prepare(`INSERT INTO organizations (id, name, slug, plan, status, created_at)
    VALUES (?, 'Other Org', 'other', 'enterprise', 'active', ?)`).run(otherOrgId, now());
  const outsider = mkUser('outsider@e2e.test', 'admin', otherOrgId);
  const addExisting = await call(admin, 'POST', '/api/admin/users',
    { email: 'outsider@e2e.test', name: 'Out Sider', role: 'lead' });
  chk('an existing account is attached to the org, not re-created',
    addExisting.j.added === true && addExisting.j.invited === undefined, JSON.stringify(addExisting.j));
  chk('its password is left alone', userRow('outsider@e2e.test').pass_hash !== '');
  chk('and it got no invitation mail', lastMail().to[0] !== 'outsider@e2e.test');
  chk('adding the same account twice is refused',
    (await call(admin, 'POST', '/api/admin/users',
      { email: 'outsider@e2e.test', name: 'Out Sider', role: 'lead' })).status === 409);
  chk('outsider still belongs to its own org',
    db.prepare('SELECT 1 FROM memberships WHERE user_id = ? AND org_id = ?')
      .get(outsider.id, otherOrgId) !== undefined);

  // ── summary ───────────────────────────────────────────────────────────────
  const fails = R.filter((r) => r.startsWith('FAIL'));
  console.log(`\n${R.join('\n')}`);
  console.log(`\n${R.length - fails.length}/${R.length} checks passed`);
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
