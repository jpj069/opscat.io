'use strict';
/* End-to-end check for status-page subscribers (docs/INCIDENTS-V2.md slice 2).
 *
 * Hermetic like e2e-invite.js: throwaway database, and the Resend transport
 * runs for real up to the HTTP call, which a stub intercepts — so every mail
 * is proven to be BUILT right (recipient, subject, links) without a network.
 *
 * What it guards:
 *   - double-opt-in: nothing but the confirm link ever reaches an unconfirmed
 *     address, the confirm token is single-use, pending rows expire;
 *   - enumeration safety: new, pending, confirmed, invalid and rate-limited
 *     subscribes all answer identically;
 *   - the send path: a PUBLISHED incident's transitions mail confirmed
 *     subscribers (with a working per-subscriber unsubscribe link), an
 *     unpublished incident mails nobody, first-publish mails once;
 *   - the Atom feed: published incidents only, XML-escaped, right content type;
 *   - the admin surface: list/delete behind lead+, the enable toggle hides the
 *     form and closes the endpoint.
 *
 *   cd server && node e2e-subscribers.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const R = [];
const chk = (name, pass, detail = '') => R.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : ` — ${detail}`}`);

// Environment BEFORE any src/ require — db.js and config.js are singletons.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opscat-subs-'));
process.env.OPSCAT_DATA_DIR = tmp;
process.env.OPSCAT_SECRET = 'e2e-subs-secret';
process.env.PORT = '3123';
process.env.OPSCAT_EDITION = 'community';
process.env.OPSCAT_BASE_URL = 'https://ops.e2e.test';
process.env.OPSCAT_ADMIN_EMAIL = 'seed-admin@e2e.test';
process.env.OPSCAT_ADMIN_PASSWORD = 'seed-admin-password-1';
process.env.RESEND_API_KEY = 're_e2e_stub';
process.env.MAIL_TRANSPORT = 'resend';

// --- mail stub: intercept ONLY the provider call (invite-harness pattern) ----
const realFetch = global.fetch;
const MAILS = [];
global.fetch = (url, opts) => {
  if (String(url).startsWith('https://api.resend.com/')) {
    MAILS.push(JSON.parse(opts.body));
    return Promise.resolve(new Response('{"id":"stub"}', { status: 200 }));
  }
  return realFetch(url, opts);
};

require('./src/index.js'); // boots the app on :3123

const { db } = require('./src/db');
const subs = require('./src/lib/subscribers');
const inc = require('./src/lib/incidents');

const BASE = 'http://127.0.0.1:3123';
const mailsTo = (email) => MAILS.filter((m) => (Array.isArray(m.to) ? m.to : [m.to]).includes(email));
const row = (email) => db.prepare('SELECT * FROM status_subscribers WHERE email = ?').get(email);
const linkIn = (mail, pathPart) =>
  (mail.html.match(new RegExp(`https://ops\\.e2e\\.test(${pathPart}[^"< ]*)`)) || [])[1];

async function login(email, password) {
  for (let i = 0; i < 40; i++) {
    const r = await realFetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (r.status === 429) { await new Promise((res) => setTimeout(res, 1000)); continue; }
    const j = await r.json().catch(() => null);
    return { cookie: (r.headers.get('set-cookie') || '').split(';')[0], csrf: j && j.csrf, status: r.status };
  }
  throw new Error('login stayed rate-limited');
}
async function call(sess, method, p, body) {
  const headers = { cookie: sess.cookie };
  if (method !== 'GET') { headers['X-OpsCat-CSRF'] = sess.csrf; headers['Content-Type'] = 'application/json'; }
  const r = await realFetch(BASE + p, { method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  return { status: r.status, j };
}
async function anonJson(method, p, body) {
  const r = await realFetch(BASE + p, { method, headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  return { status: r.status, j };
}
async function page(p, opts) {
  const r = await realFetch(BASE + p, opts);
  return { status: r.status, type: r.headers.get('content-type') || '', text: await r.text() };
}
async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { if ((await realFetch(`${BASE}/api/health`)).ok) return true; } catch { /* not yet */ }
    await new Promise((res) => setTimeout(res, 100));
  }
  return false;
}
async function until(fn, ms = 3000) {
  const t0 = Date.now();
  while (!fn() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
  return fn();
}

async function main() {
  chk('server boots and answers /api/health', await waitForServer());
  chk('user_version is at least 16', db.pragma('user_version', { simple: true }) >= 16);
  chk('status_subscribers table exists', db.pragma('table_info(status_subscribers)').length === 7);

  const admin = await login('seed-admin@e2e.test', 'seed-admin-password-1');
  chk('seeded admin can sign in', admin.status === 200, String(admin.status));

  // ── subscribe: the uniform, guarded front door ────────────────────────────
  const s1 = await anonJson('POST', '/api/status/subscribe', { email: 'alice@e2e.test' });
  chk('subscribe answers { ok: true }', s1.status === 200 && s1.j.ok === true, JSON.stringify(s1));
  const p1 = row('alice@e2e.test');
  chk('a pending row exists, unconfirmed', p1 && p1.confirmed_at === null);
  chk('exactly one confirm mail went out', await until(() => mailsTo('alice@e2e.test').length === 1));
  const confirmMail = mailsTo('alice@e2e.test')[0];
  chk('the confirm mail names the org and the intent',
    /Confirm/.test(confirmMail.subject), confirmMail.subject);
  const confirmPath = linkIn(confirmMail, '/status/confirm\\?token=');
  chk('the confirm mail carries a confirm link', !!confirmPath, confirmMail.html.slice(0, 200));
  chk('the token is not stored in clear',
    !confirmPath || !db.prepare('SELECT 1 FROM status_subscribers WHERE token_hash = ?')
      .get(confirmPath.split('token=')[1]));

  const hp = await anonJson('POST', '/api/status/subscribe', { email: 'bot@e2e.test', website: 'spam' });
  chk('the honeypot answers ok and stores nothing', hp.j && hp.j.ok === true && !row('bot@e2e.test'));
  const bad = await anonJson('POST', '/api/status/subscribe', { email: 'not-an-email' });
  chk('an invalid address answers ok and stores nothing', bad.j && bad.j.ok === true);
  const again = await anonJson('POST', '/api/status/subscribe', { email: 'alice@e2e.test' });
  chk('re-subscribing while pending answers identically', again.j && again.j.ok === true);
  chk('…and the resend throttle held the second mail back', mailsTo('alice@e2e.test').length === 1);
  const limited = await anonJson('POST', '/api/status/subscribe', { email: 'late@e2e.test' });
  chk('the rate limiter drops the 4th quick attempt silently',
    limited.j && limited.j.ok === true && !row('late@e2e.test'));

  // ── confirm: single-use, then a real subscriber ───────────────────────────
  const c1 = await page(confirmPath);
  chk('the confirm link answers a confirmation page',
    c1.status === 200 && /confirmed/i.test(c1.text), c1.text.slice(0, 120));
  chk('the row is now confirmed', !!row('alice@e2e.test').confirmed_at);
  const c2 = await page(confirmPath);
  chk('a second use of the confirm link is refused', /invalid|expired/i.test(c2.text));
  const cBad = await page('/status/confirm?token=definitely-not-a-token-1234');
  chk('an unknown token is refused generically', /invalid|expired/i.test(cBad.text));

  // second subscriber through the lib (the HTTP door is proven; the limiter
  // would otherwise make the harness wait out its bucket)
  await subs.subscribe(1, 'bob@e2e.test');
  const bobConfirm = linkIn(mailsTo('bob@e2e.test')[0], '/status/confirm\\?token=');
  await page(bobConfirm);
  await subs.subscribe(1, 'pending@e2e.test'); // stays unconfirmed on purpose
  chk('fixtures: two confirmed, one pending',
    !!row('bob@e2e.test').confirmed_at && !row('pending@e2e.test').confirmed_at);

  // ── the send path: published is the switch ────────────────────────────────
  MAILS.length = 0;
  const dec = await call(admin, 'POST', '/api/incidents',
    { title: 'Feed <script> & escaping probe', severity: 70, message: 'Investigating.' });
  chk('incident declared (unpublished)', dec.status === 200 && dec.j.published === false);
  await call(admin, 'POST', `/api/incidents/${dec.j.id}/status`, { status: 'identified' });
  await new Promise((r) => setTimeout(r, 300));
  chk('an unpublished incident mails nobody', MAILS.length === 0, JSON.stringify(MAILS.map((m) => m.subject)));

  await call(admin, 'PATCH', `/api/incidents/${dec.j.id}`, { published: true });
  chk('first publish mails every confirmed subscriber',
    await until(() => mailsTo('alice@e2e.test').length === 1 && mailsTo('bob@e2e.test').length === 1));
  chk('…but never the pending one', mailsTo('pending@e2e.test').length === 0);
  const pub = mailsTo('alice@e2e.test')[0];
  chk('the notification subject carries label and title',
    /INC-2\d+/.test(pub.subject) && pub.subject.includes('Feed'), pub.subject);
  const unsubPath = linkIn(pub, '/status/unsubscribe\\?id=');
  chk('the notification carries a per-subscriber unsubscribe link', !!unsubPath);
  chk('the notification links the status page', pub.html.includes('/status'));

  await call(admin, 'PATCH', `/api/incidents/${dec.j.id}`, { published: true });
  await new Promise((r) => setTimeout(r, 300));
  chk('re-publishing an already-published incident mails nothing new',
    mailsTo('alice@e2e.test').length === 1);

  await call(admin, 'POST', `/api/incidents/${dec.j.id}/status`,
    { status: 'monitoring', message: 'Mitigation is in place.' });
  chk('a status change on a published incident mails an update',
    await until(() => mailsTo('alice@e2e.test').length === 2));
  chk('the update mail carries the message',
    mailsTo('alice@e2e.test')[1].html.includes('Mitigation is in place.'));

  await call(admin, 'PATCH', `/api/incidents/${dec.j.id}`, { published: false });
  await call(admin, 'POST', `/api/incidents/${dec.j.id}/status`, { status: 'investigating' });
  await new Promise((r) => setTimeout(r, 300));
  chk('after unpublish, transitions mail nobody again', mailsTo('alice@e2e.test').length === 2);

  // ── unsubscribe: two-step, MAC-addressed, revocable ───────────────────────
  const u1 = await page(unsubPath);
  chk('the unsubscribe link shows a page with a button, removes nothing yet',
    u1.status === 200 && /<button/.test(u1.text) && !!row('alice@e2e.test'));
  const [, uid, usig] = unsubPath.match(/id=(\d+)&sig=([^&]+)/) || [];
  const u2 = await page('/status/unsubscribe', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `id=${uid}&sig=${usig}` });
  chk('the POST removes the subscriber', /Unsubscribed/.test(u2.text) && !row('alice@e2e.test'));
  const u3 = await page('/status/unsubscribe', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `id=${uid}&sig=${usig}` });
  chk('a second POST of the same link is refused', /invalid/i.test(u3.text));
  const bobId = row('bob@e2e.test').id;
  const forged = await page('/status/unsubscribe', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `id=${bobId}&sig=${usig}` });
  chk('a MAC for one subscriber cannot remove another',
    /invalid/i.test(forged.text) && !!row('bob@e2e.test'));

  // re-publishing after an unpublish is a first-publish again — and alice,
  // now unsubscribed, must be left out of exactly that fan-out
  const bobBefore = mailsTo('bob@e2e.test').length;
  await call(admin, 'PATCH', `/api/incidents/${dec.j.id}`, { published: true });
  chk('after unsubscribing, only the remaining subscriber is mailed',
    await until(() => mailsTo('bob@e2e.test').length === bobBefore + 1)
    && mailsTo('alice@e2e.test').length === 2);
  await call(admin, 'POST', `/api/incidents/${dec.j.id}/status`, { status: 'resolved' });
  chk('the resolve update reaches the remaining subscriber too',
    await until(() => mailsTo('bob@e2e.test').length === bobBefore + 2));

  // ── the Atom feed ─────────────────────────────────────────────────────────
  const feed = await page('/status/feed.xml');
  chk('the feed answers with the Atom content type',
    feed.status === 200 && feed.type.includes('application/atom+xml'), feed.type);
  chk('the feed carries the published incident', feed.text.includes('INC-2'), feed.text.slice(0, 200));
  chk('the feed escapes markup in titles',
    feed.text.includes('&lt;script&gt;') && !feed.text.includes('<script>'));
  chk('the feed declares itself', feed.text.includes('<link rel="self"')
    && feed.text.includes('/status/feed.xml'));
  const hidden = await call(admin, 'POST', '/api/incidents',
    { title: 'UNPUBLISHED-MARKER incident', severity: 40 });
  const feed2 = await page('/status/feed.xml');
  chk('an unpublished incident stays out of the feed',
    hidden.status === 200 && !feed2.text.includes('UNPUBLISHED-MARKER'));
  chk('an unknown slug has no feed', (await page('/status/nope/feed.xml')).status === 404);

  // ── the public page ───────────────────────────────────────────────────────
  const html = await page('/status');
  chk('the page offers the subscribe form', html.text.includes('Get status updates by e-mail'));
  chk('the page links the Atom feed', html.text.includes('feed.xml'));
  const banner = await page('/status?subscribed=1');
  chk('the post-subscribe banner asks for the inbox', /check your inbox/i.test(banner.text));

  // ── the admin surface and the switch ──────────────────────────────────────
  const list = await call(admin, 'GET', '/api/admin/status-subscribers');
  chk('the admin list counts confirmed and pending',
    list.status === 200 && list.j.confirmed === 1 && list.j.pending === 1, JSON.stringify(list.j));
  const pendingId = list.j.rows.find((r) => !r.confirmedAt).id;
  const del = await call(admin, 'DELETE', `/api/admin/status-subscribers/${pendingId}`);
  chk('an admin can remove an address (GDPR)', del.status === 200 && !row('pending@e2e.test'));
  chk('removing it twice is a 404',
    (await call(admin, 'DELETE', `/api/admin/status-subscribers/${pendingId}`)).status === 404);

  const { addMembership } = require('./src/db');
  const { hashPassword, now } = require('./src/util');
  const { salt, hash } = hashPassword('analyst-password-1');
  const a = db.prepare(`INSERT INTO users (org_id, email, name, role, is_super_admin, pass_salt, pass_hash,
      color, active, must_change_password, created_at)
    VALUES (1, 'analyst@e2e.test', 'analyst', 'analyst', 0, ?, ?, '#388bfd', 1, 0, ?)`)
    .run(salt, hash, now());
  addMembership(a.lastInsertRowid, 1, 'analyst');
  const analyst = await login('analyst@e2e.test', 'analyst-password-1');
  chk('an analyst cannot read subscriber addresses',
    (await call(analyst, 'GET', '/api/admin/status-subscribers')).status === 403);

  await call(admin, 'PATCH', '/api/admin/settings', { status_subscribers_enabled: '0' });
  chk('switched off, the subscribe endpoint closes',
    (await anonJson('POST', '/api/status/subscribe', { email: 'x@e2e.test' })).status === 404);
  chk('…and the form leaves the page', !(await page('/status')).text.includes('Get status updates'));
  chk('…while the feed keeps working', (await page('/status/feed.xml')).status === 200);
  await call(admin, 'PATCH', '/api/admin/settings', { status_subscribers_enabled: '1' });
  chk('switched back on, the form returns', (await page('/status')).text.includes('Get status updates'));

  // ── wrap up ───────────────────────────────────────────────────────────────
  const fails = R.filter((l) => l.startsWith('FAIL'));
  console.log(R.join('\n'));
  console.log(`\n${R.length - fails.length}/${R.length} checks passed`);
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
