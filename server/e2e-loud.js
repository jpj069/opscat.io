'use strict';
/* End-to-end check for On-Call slice 3 — the loud channels (docs/ONCALL-V1.md).
 *
 * Hermetic: throwaway DB, no provider, no push service. The telephony `webhook`
 * implementation points at a local stub, which is the honest thing to exercise
 * here — it is the bring-your-own path a self-hoster actually uses, and it is
 * the only one whose whole request can be inspected. Twilio and Vonage are
 * checked where they can be without an account: the CALL FLOW documents they
 * fetch from us, which is where the acknowledgement lives.
 *
 * Two environment choices, both deliberate:
 *
 *  - **Community edition + `OPSCAT_ALLOW_PRIVATE_TARGETS=1`**, because the
 *    telephony webhook goes through the real SSRF guard and the stub is on
 *    loopback. A failure reading "target resolves to a private address" is the
 *    guard working and the flag missing.
 *  - The PLAN GATE is therefore tested by turning enforcement on explicitly
 *    (`plans.setEnforce`) around those checks rather than by running the whole
 *    app in the cloud edition. That is a narrower claim and it is stated where
 *    it is made: it proves the gate's logic, and separately that the community
 *    edition does not apply it.
 *
 * What it guards:
 *   - a phone number is CIPHERTEXT at rest and round-trips through the helper;
 *   - an UNVERIFIED number is never rung, and says why;
 *   - verification: a code by SMS, hashed, expiring, five tries and no more;
 *   - the plan gate on `sms`/`voice`, and that the CE has none;
 *   - the adapter: what a `webhook` gateway receives, and the cost it reports
 *     landing in the notification log;
 *   - the voice round trip — **fetching the call flow must not acknowledge**
 *     (the provider fetches it before anyone has heard anything), only the
 *     digit `1` does, and a wrong digit does not;
 *   - Web Push: the VAPID key, one row per browser, a malformed subscription
 *     refused, and the subscription stored encrypted.
 *
 *   cd server && node e2e-loud.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

/* The shared helpers, not a private copy of `chk`.
 *
 * The one-liner this replaces records a PASS for anything truthy — and a
 * Promise is truthy. With the fixtures on the async shim every assertion below
 * reads a row, so a single missed `await` would have turned its check
 * permanently green. `e2e-lib`'s chk throws on a thenable instead.
 */
const { chk, report, die } = require('./e2e-lib').harness();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opscat-loud-'));
process.env.OPSCAT_DATA_DIR = tmp;
process.env.OPSCAT_SECRET = 'e2e-loud-secret';
process.env.PORT = '3151';
process.env.OPSCAT_EDITION = 'community';
process.env.OPSCAT_BASE_URL = 'http://127.0.0.1:3151';
process.env.OPSCAT_ADMIN_EMAIL = 'seed-admin@e2e.test';
process.env.OPSCAT_ADMIN_PASSWORD = 'seed-admin-password-1';
process.env.OPSCAT_ALLOW_PRIVATE_TARGETS = '1';
delete process.env.RESEND_API_KEY;
delete process.env.SMTP_HOST;

require('./src/index.js');

const { addMembership, setOrgSetting, schemaVersion } = require('./src/db');
// Fixtures and read-back go through the SHIM, so they land in the database
// `run-e2e.js` handed this process in DATABASE_URL — the same one the code under
// test reads. A connection the harness opened for itself would be a different
// session, and a fixture written there surfaces as a foreign-key violation
// several calls later, pointing at the wrong thing entirely.
const q = require('./src/db/shim');
const { hashPassword, now, newId, DEFAULT_ORG_ID, sha256 } = require('./src/util');
const contacts = require('./src/lib/contacts');
const telephony = require('./src/lib/telephony');
const plans = require('./src/plans');
const chain = require('./src/engine/alert-chain');

const BASE = 'http://127.0.0.1:3151';
const STUB = 'http://127.0.0.1:3152';
const PASS = 'e2e-user-password-1';

// ---- the gateway stub -------------------------------------------------------
const gateway = [];
let gatewayFails = false;
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch { /* not ours */ }
    gateway.push(parsed);
    if (gatewayFails) return res.writeHead(500).end('nope');
    res.writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ id: `stub-${gateway.length}`, price: '0.0075' }));
  });
});

// ---- fixtures ---------------------------------------------------------------
async function mkOrg(name, plan = 'enterprise') {
  const id = newId();
  await q.prepare(`INSERT INTO organizations (id, name, slug, plan, status, created_at)
    VALUES (?, ?, ?, ?, 'active', ?)`).run(id, name, name.toLowerCase(), plan, now());
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
// `insert()` (RETURNING id), never lastInsertRowid — the shim refuses it, and
// node-postgres has no such field at all.
async function mkCase(severity = 90, orgId = DEFAULT_ORG_ID) {
  return Number(await q.prepare(`INSERT INTO cases (org_id, event_id, name, device, severity, status, opened_at)
    VALUES (?, NULL, 'disk_full', 'core-01', ?, 'open', ?)`).insert(orgId, severity, now()));
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
const tick = () => new Promise((res) => setTimeout(res, 80));
const methodRow = (id) => q.prepare('SELECT * FROM contact_methods WHERE id = ?').get(id);
const alertRow = (id) => q.prepare('SELECT * FROM alerts WHERE id = ?').get(id);
const notifsFor = (id) => q.prepare('SELECT * FROM notifications WHERE alert_id = ? ORDER BY id').all(id);

/* "does this column exist" without PRAGMA — see the same helper in e2e-oncall.
 * A statement that NAMES the column parses on both engines when it is there and
 * raises when it is not, which is what the migration check is asserting. */
async function columnExists(t, c) {
  try { await q.prepare(`SELECT ${c} FROM ${t} LIMIT 1`).all(); return true; } catch { return false; }
}

async function main() {
  await new Promise((res) => stub.listen(3152, '127.0.0.1', res));
  chk('server boots and answers /api/health', await waitForServer());

  // ---- migration ---------------------------------------------------------
  chk('migration reached version 25', await schemaVersion() >= 25);
  for (const c of ['encrypted', 'verify_hash', 'verify_expires_at', 'verify_tries']) {
    // eslint-disable-next-line no-await-in-loop
    chk(`contact_methods gained ${c}`, await columnExists('contact_methods', c));
  }
  chk('notifications gained cost_micros', await columnExists('notifications', 'cost_micros'));

  const anna = await mkUser('anna@e2e.test', 'admin');
  const ben = await mkUser('ben@e2e.test', 'analyst');
  const admin = await login(anna.email);
  const junior = await login(ben.email);
  chk('admin can sign in', admin.status === 200, `status ${admin.status}`);

  // ---- the provider config ------------------------------------------------
  const noAccess = await call(junior, 'GET', '/api/admin/telephony');
  chk('a non-admin cannot read the provider config', noAccess.status === 403, `status ${noAccess.status}`);

  const before = await call(admin, 'GET', '/api/admin/telephony');
  chk('telephony starts unconfigured', before.j.configured === false, JSON.stringify(before.j));
  const badProv = await call(admin, 'PUT', '/api/admin/telephony', { provider: 'nonsense' });
  chk('an unknown provider is refused', badProv.status === 400);

  await call(admin, 'PUT', '/api/admin/telephony', {
    provider: 'webhook', webhookUrl: `${STUB}/send`, secret: 'super-secret-token',
    priceSmsMicros: 4000, priceVoiceMicros: 20000,
  });
  const after = await call(admin, 'GET', '/api/admin/telephony');
  chk('the provider is configured', after.j.configured === true, JSON.stringify(after.j));
  chk('the secret is NEVER returned — only that one is set',
    after.j.hasSecret === true && after.j.secret === undefined, JSON.stringify(after.j));
  const storedSecret = await q.prepare("SELECT value FROM org_settings WHERE key = 'telephony_secret'").get();
  chk('...and it is encrypted at rest, not sitting in org_settings in the clear',
    !!storedSecret && !storedSecret.value.includes('super-secret-token'), storedSecret && storedSecret.value);

  // ---- a number is personal data ------------------------------------------
  const badNum = await call(admin, 'POST', '/api/oncall/me/methods', { kind: 'sms', address: '0151 12345678' });
  chk('a national-format number is refused rather than guessed at', badNum.status === 400,
    `status ${badNum.status}`);
  const smsResp = await call(admin, 'POST', '/api/oncall/me/methods',
    { kind: 'sms', address: '+49 151 12345678' });
  chk('an international number is accepted', smsResp.status === 201, JSON.stringify(smsResp.j));
  chk('...and the API says it still needs verifying', smsResp.j.needsVerification === true);
  const smsId = smsResp.j.id;
  const row = await methodRow(smsId);
  chk('the number is CIPHERTEXT in the database', row.encrypted === 1 && !row.address.includes('15112345678'),
    row.address);
  chk('...and decodes back to the normalised number',
    contacts.decodeAddress(row) === '+4915112345678', contacts.decodeAddress(row));
  chk('an e-mail method is NOT encrypted — it is read back constantly and gains nothing',
    (() => {
      const e = contacts.encodeAddress('email', 'x@y.tld');
      return e.encrypted === 0 && e.address === 'x@y.tld';
    })());

  // ---- unverified means unreachable ---------------------------------------
  const gate = await contacts.usable(await methodRow(smsId), DEFAULT_ORG_ID);
  chk('an unverified number may not be rung', gate.ok === false, JSON.stringify(gate));
  chk('...and the reason is one a human can act on',
    /not verified/.test(gate.reason || ''), gate.reason);
  const mineBefore = (await call(admin, 'GET', '/api/oncall/me')).j;
  chk('the screen shows the same reason the delivery log would',
    /not verified/.test(mineBefore.methods.find((m) => m.id === smsId).blockedReason || ''));
  chk('the screen knows the org has a provider at all', mineBefore.telephonyConfigured === true);

  // ---- verification --------------------------------------------------------
  gateway.length = 0;
  const sent = await call(admin, 'POST', `/api/oncall/me/methods/${smsId}/verify`, {});
  chk('a verification code can be requested', sent.status === 200, JSON.stringify(sent.j));
  chk('...and it went out over the channel being verified',
    gateway.length === 1 && gateway[0].kind === 'sms' && gateway[0].to === '+4915112345678',
    JSON.stringify(gateway));
  const code = (String(gateway[0].text).match(/(\d{6})/) || [])[1];
  chk('the message carries a six-digit code', !!code, gateway[0] && gateway[0].text);
  const hashed = await methodRow(smsId);
  chk('the code is HASHED at rest, like every other credential',
    hashed.verify_hash === sha256(code) && !hashed.verify_hash.includes(code));

  const wrong = await call(admin, 'POST', `/api/oncall/me/methods/${smsId}/verify/confirm`, { code: '000000' });
  chk('a wrong code is refused', wrong.status === 400);
  const tried = await methodRow(smsId);
  chk('...and counted — six digits is only safe with a try limit',
    tried.verify_tries === 1, String(tried.verify_tries));
  for (let i = 0; i < 4; i++) {
    await call(admin, 'POST', `/api/oncall/me/methods/${smsId}/verify/confirm`, { code: '000001' });
  }
  const spent = await call(admin, 'POST', `/api/oncall/me/methods/${smsId}/verify/confirm`, { code });
  chk('five wrong tries spend the code — even the right one is then refused',
    spent.status === 429, `status ${spent.status}`);

  gateway.length = 0;
  await call(admin, 'POST', `/api/oncall/me/methods/${smsId}/verify`, {});
  const code2 = (String(gateway[0].text).match(/(\d{6})/) || [])[1];
  chk('a fresh code resets the try counter', (await methodRow(smsId)).verify_tries === 0);
  const good = await call(admin, 'POST', `/api/oncall/me/methods/${smsId}/verify/confirm`, { code: code2 });
  chk('the right code verifies the number', good.status === 200 && !!(await methodRow(smsId)).verified_at);
  chk('...and the code is destroyed once used', (await methodRow(smsId)).verify_hash === null);
  chk('a verified number may now be rung',
    (await contacts.usable(await methodRow(smsId), DEFAULT_ORG_ID)).ok === true);

  // An expired code is refused even when it is the right one.
  await q.prepare('UPDATE contact_methods SET verified_at = NULL, verify_hash = ?, verify_expires_at = ? WHERE id = ?')
    .run(sha256('123456'), now() - 1000, smsId);
  const expired = await call(admin, 'POST', `/api/oncall/me/methods/${smsId}/verify/confirm`, { code: '123456' });
  chk('an expired code is refused', expired.status === 400, `status ${expired.status}`);
  await q.prepare('UPDATE contact_methods SET verified_at = ?, verify_hash = NULL WHERE id = ?').run(now(), smsId);

  // ---- the plan gate -------------------------------------------------------
  // Turned on explicitly: this proves the GATE, and the check after it proves
  // the community edition does not apply one. Running the whole app in the cloud
  // edition would have made the loopback stub unreachable through the SSRF guard.
  const freeOrg = await mkOrg('Frugal', 'free');
  const proOrg = await mkOrg('Paying', 'pro');
  chk('community edition gates nothing — the CE promise',
    (await contacts.usable(await methodRow(smsId), freeOrg)).ok === true);
  plans.setEnforce(true);
  try {
    const onFree = await contacts.usable(await methodRow(smsId), freeOrg);
    chk('with enforcement on, a free org may not send SMS', onFree.ok === false, JSON.stringify(onFree));
    chk('...and the reason names the plan, not the number',
      /plan/.test(onFree.reason || ''), onFree.reason);
    chk('a pro org may', (await contacts.usable(await methodRow(smsId), proOrg)).ok === true);
    chk('voice follows the same line', plans.hasFeature('pro', 'voice') && !plans.hasFeature('free', 'voice'));
    chk('everything else in On-Call stays ungated — a chain that stops at a licence is not a guarantee',
      plans.hasFeature('free', 'email_alerts'));
  } finally { plans.setEnforce(false); }

  // ---- the adapter, end to end --------------------------------------------
  const sched = (await call(admin, 'POST', '/api/oncall/schedules', { name: 'Primary', timezone: 'UTC' })).j;
  await call(admin, 'PUT', `/api/oncall/schedules/${sched.id}/layers`, {
    layers: [{ rotation: 'weekly', handoffAt: now() - 86400000, participants: [anna.id] }],
  });
  const pol = (await call(admin, 'POST', '/api/oncall/policies', {
    name: 'Loud', steps: [{ timeoutM: 5, targets: [{ kind: 'schedule', refId: String(sched.id) }] }],
  })).j;

  // Only the SMS method, so the chain has to use it.
  await call(admin, 'PUT', '/api/oncall/me/rules',
    { rules: [{ urgency: 'high', delayM: 0, methodId: smsId }] });

  gateway.length = 0;
  const caseA = await mkCase(90);
  const A = (await call(admin, 'POST', '/api/oncall/alerts',
    { subjectKind: 'case', subjectId: caseA, policyId: pol.id })).j;
  await tick(); await tick();
  chk('an alert reaches the gateway as an SMS', gateway.some((g) => g.kind === 'sms'),
    JSON.stringify(gateway));
  const smsOut = gateway.find((g) => g.kind === 'sms');
  chk('...addressed to the decrypted number', smsOut && smsOut.to === '+4915112345678');
  chk('...carrying the acknowledgement link, because inbound replies are out of scope',
    smsOut && /\/a\/[0-9a-f]{64}/.test(smsOut.text), smsOut && smsOut.text);
  const smsNotif = (await notifsFor(A.id)).find((n) => n.channel === 'sms');
  chk('the delivery is logged', !!smsNotif && smsNotif.ok === 1);
  chk('...with what it cost — the provider reported 0.0075',
    smsNotif && smsNotif.cost_micros === 7500, smsNotif && String(smsNotif.cost_micros));

  // A gateway that refuses is a failed delivery with the reason, not silence.
  gatewayFails = true;
  const caseB = await mkCase(90);
  const B = (await call(admin, 'POST', '/api/oncall/alerts',
    { subjectKind: 'case', subjectId: caseB, policyId: pol.id })).j;
  await tick(); await tick();
  const failed = (await notifsFor(B.id)).find((n) => n.channel === 'sms');
  chk('a gateway that refuses is recorded as a failed delivery',
    !!failed && failed.ok === 0 && /500/.test(failed.error || ''), JSON.stringify(failed));
  gatewayFails = false;

  // ---- the voice round trip ------------------------------------------------
  gateway.length = 0;   // otherwise the token found below belongs to an EARLIER alert
  const caseC = await mkCase(90);
  const C = (await call(admin, 'POST', '/api/oncall/alerts',
    { subjectKind: 'case', subjectId: caseC, policyId: pol.id })).j;
  await tick();
  const token = (String((gateway.find((g) => g.text && /\/a\//.test(g.text)) || {}).text || '')
    .match(/\/a\/([0-9a-f]{64})/) || [])[1] || await mintTokenFor(C.id, anna.id);

  const flow = await fetch(`${BASE}/v/${token}/twiml`);
  const xml = await flow.text();
  chk('the call flow is TwiML', flow.status === 200 && /<Response>/.test(xml));
  chk('it SPEAKS the alert', /<Say[^>]*>OpsCat alert/.test(xml), xml.slice(0, 200));
  chk('...and then LISTENS — a call that cannot be answered is a robocall',
    /<Gather[^>]+numDigits="1"/.test(xml), xml.slice(0, 300));
  // The exact reason the flow document and the digit callback are separate: the
  // provider fetches this URL to find out what to say, before anyone has heard
  // anything. It is a mail scanner with a phone line.
  chk('fetching the call flow does NOT acknowledge', (await alertRow(C.id)).status === 'active');

  const wrongDigit = await fetch(`${BASE}/v/${token}/digits`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ Digits: '9' }).toString(),
  });
  chk('a wrong key does not acknowledge either',
    wrongDigit.status === 200 && (await alertRow(C.id)).status === 'active');

  const pressOne = await fetch(`${BASE}/v/${token}/digits`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ Digits: '1' }).toString(),
  });
  const ackXml = await pressOne.text();
  chk('pressing 1 acknowledges', (await alertRow(C.id)).status === 'acked', (await alertRow(C.id)).status);
  chk('...and the caller is told so', /Acknowledged/.test(ackXml), ackXml.slice(0, 200));

  const spentFlow = await fetch(`${BASE}/v/${token}/twiml`);
  chk('the flow for a handled alert says so instead of ringing on',
    /already been handled/.test(await spentFlow.text()));

  // Vonage speaks a different document for the same conversation.
  const caseD = await mkCase(90);
  const D = (await call(admin, 'POST', '/api/oncall/alerts',
    { subjectKind: 'case', subjectId: caseD, policyId: pol.id })).j;
  const token2 = await mintTokenFor(D.id, anna.id);
  const ncco = await (await fetch(`${BASE}/v/${token2}/ncco`)).json();
  chk('the Vonage flow is an NCCO with a talk step', Array.isArray(ncco) && ncco[0].action === 'talk');
  chk('...and a DTMF input step', ncco.some((a) => a.action === 'input' && a.dtmf));
  const nccoDigits = await fetch(`${BASE}/v/${token2}/digits-json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dtmf: { digits: '1' } }),
  });
  chk('a Vonage keypress acknowledges the same way',
    nccoDigits.status === 200 && (await alertRow(D.id)).status === 'acked');

  // ---- Web Push ------------------------------------------------------------
  const keyResp = await call(admin, 'GET', '/api/oncall/me/push-key');
  chk('a VAPID public key is served', keyResp.status === 200 && typeof keyResp.j.key === 'string'
    && keyResp.j.key.length > 40, JSON.stringify(keyResp.j).slice(0, 120));
  const stored = await q.prepare("SELECT value FROM settings WHERE key = 'vapid_public'").get();
  chk('...and it is STORED — regenerating it would silently kill every subscription',
    !!stored && stored.value === keyResp.j.key);
  const again = await call(admin, 'GET', '/api/oncall/me/push-key');
  chk('...so asking twice gives the same key', again.j.key === keyResp.j.key);

  const badSub = await call(admin, 'POST', '/api/oncall/me/push', { subscription: { endpoint: 'nope' } });
  chk('a malformed subscription is refused', badSub.status === 400);
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123def456', keys: { p256dh: 'BPk', auth: 'xyz' } };
  const pushResp = await call(admin, 'POST', '/api/oncall/me/push', { subscription: sub, label: 'Firefox on Linux' });
  chk('a browser can subscribe', pushResp.status === 201, JSON.stringify(pushResp.j));
  const pushRow = await methodRow(pushResp.j.id);
  chk('the subscription is encrypted at rest — it is a bearer capability',
    pushRow.encrypted === 1 && !pushRow.address.includes('fcm.googleapis.com'));
  const dupe = await call(admin, 'POST', '/api/oncall/me/push', { subscription: sub });
  chk('re-subscribing the same browser does not create a second row — it would ring twice',
    dupe.j.already === true && dupe.j.id === pushResp.j.id, JSON.stringify(dupe.j));
  chk('a push method needs no verification', !!pushRow.verified_at);
  const displayed = (await call(admin, 'GET', '/api/oncall/me')).j.methods
    .find((m) => m.id === pushResp.j.id);
  chk('the screen names the browser rather than printing a 200-character endpoint',
    displayed.address === 'Firefox on Linux', displayed.address);

  // ---- what another person may see ----------------------------------------
  const benView = (await call(junior, 'GET', '/api/oncall/me')).j;
  chk('another person sees none of these — a number is visible only to its owner',
    benView.methods.length === 0, JSON.stringify(benView.methods));

  // ---- report --------------------------------------------------------------
  stub.close();
  report();
}

// A token minted the way the chain mints one, for the paths where no delivery
// carried it (a Vonage call, or a gateway that swallowed the text).
async function mintTokenFor(alertId, userId) {
  const { randHex } = require('./src/util');
  const t = randHex(32);
  await q.prepare(`INSERT INTO alert_tokens (token_hash, alert_id, user_id, purpose, expires_at)
    VALUES (?, ?, ?, 'ack', ?)`).run(sha256(t), alertId, userId, now() + 3600000);
  return t;
}

main().catch(die);
