'use strict';
/* Exactly-once gates, fired at in parallel.
 *
 * ── Why this exists BEFORE it can fail ───────────────────────────────────────
 *
 * Roughly forty invariants in this codebase used to be enforced by nothing but
 * "better-sqlite3 is synchronous and Node is single-threaded". Each is a
 * read-check-write: read a row, decide in JS, then write. Once an `await`
 * appears between the read and the write — which is the entire point of the
 * Postgres port — two callers both pass the check and the action happens TWICE.
 *
 * Almost every one of them fails by DOING SOMETHING TWICE rather than by
 * throwing. Two sessions from one magic link. Two token pairs from one OAuth
 * code, which costs the single-use guarantee RFC 6749 §4.1.2 requires — not
 * PKCE itself, whose check is a pure function of the verifier the caller
 * presents, so racing without it gains an attacker nothing. A second page to
 * Slack at 3am. Every confirmed status-page subscriber mailed twice,
 * unrecallably.
 *
 * **It was written to pass trivially, and it no longer does.** Every check here
 * was authored against the synchronous driver, where these races were
 * unreachable, so that the assertion existed and stayed green through the
 * conversion rather than being written afterwards by whoever hit the bug. It
 * now runs on a pooled Postgres, where the races are real — so what used to be
 * a tripwire for a future change is a live measurement of the present one. The
 * plan-cap block below is the case where that transition was visible: it went
 * red on Postgres and stayed red until `q.lockOrg` existed.
 *
 * Nothing else in the suite exercises concurrency at all.
 *
 * ── What "parallel" means here ───────────────────────────────────────────────
 *
 * Node is single-threaded, so these requests interleave at await points rather
 * than running simultaneously. That is exactly the concurrency the port
 * introduces — the hazard was never OS threads, it was a second request being
 * served while the first is suspended mid-transaction. `Promise.all` over
 * `fetch` reproduces it faithfully.
 *
 * ── How each gate is asserted ────────────────────────────────────────────────
 *
 * Three rules, and every check here obeys all three:
 *
 *  1. **By SHAPE, never by which caller won.** Which of five parallel requests
 *     gets the row is arbitrary and always will be. "Exactly one 200" is the
 *     invariant; "the first one wins" is a coincidence.
 *  2. **A gate closes one door, not the corridor.** Every exactly-once check is
 *     followed by the next legitimate operation, asserted to still work. A gate
 *     that refuses everything forever also passes an exactly-once test.
 *  3. **Fire-and-forget work is condition-waited and scoped.** Alert dispatch
 *     and mail sending outlive the request that caused them and interleave
 *     across mutations, so counting a global stub list races (the lesson
 *     e2e-incidents.js paid for). Every such assertion here is scoped to its own
 *     recipient address, waits for the FIRST effect to arrive, then settles
 *     before asserting there is only one — waiting for "=== 1" would pass on the
 *     way to 2.
 *
 * Hermetic: throwaway database, own port, no network. The two outbound calls the
 * product really makes — Resend for mail, the EC2 API for a provisioned sensor —
 * are intercepted at the HTTP boundary (the e2e-subscribers.js pattern), so the
 * mail and the provisioning path run FOR REAL right up to the socket.
 *   cd server && node e2e-concurrency.js
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { chk, until, report, onExit, die } = require('./e2e-lib').harness();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opscat-conc-'));
process.env.OPSCAT_DATA_DIR = tmp;
onExit(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.OPSCAT_SECRET = 'e2e-conc-secret';
process.env.PORT = '3155';
process.env.OPSCAT_EDITION = 'cloud';
process.env.OPSCAT_BASE_URL = 'http://127.0.0.1:3155'; // OAuth `resource` is checked against it
process.env.OPSCAT_ADMIN_EMAIL = 'admin@e2e.test';
process.env.OPSCAT_ADMIN_PASSWORD = 'seed-admin-password-1';
process.env.RESEND_API_KEY = 're_e2e_stub';
process.env.MAIL_TRANSPORT = 'resend';
// The BYO-cloud node cap, lowered so "at the cap" is one seeded row rather than
// twenty. It is what the provision gate is written against.
process.env.OPSCAT_MAX_BYO_NODES = '1';

// ── the two outbound calls, intercepted at the socket ───────────────────────
// Everything above the `fetch` runs for real: the mailer builds the message and
// the AWS provider signs a genuine SigV4 request. Only the wire is stubbed.
const realFetch = global.fetch;
const MAILS = [];
const ec2Xml = (body) => (String(body).includes('Action=DescribeImages')
  ? '<DescribeImagesResponse><imagesSet><item><imageId>ami-000000000000000e2</imageId>'
    + '<creationDate>2026-01-01T00:00:00.000Z</creationDate></item></imagesSet></DescribeImagesResponse>'
  : '<RunInstancesResponse><instancesSet><item><instanceId>i-00000000000000e2e</instanceId>'
    + '<ipAddress>203.0.113.7</ipAddress></item></instancesSet></RunInstancesResponse>');
global.fetch = (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://api.resend.com/')) {
    MAILS.push(JSON.parse(opts.body));
    return Promise.resolve(new Response('{"id":"stub"}', { status: 200 }));
  }
  if (/^https:\/\/ec2\.[a-z0-9-]+\.amazonaws\.com\//.test(u)) {
    return Promise.resolve(new Response(ec2Xml(opts.body), { status: 200 }));
  }
  return realFetch(url, opts);
};

require('./src/index.js'); // boots the app on :3155

// Fixtures and read-back go through the SHIM, so they land in the database
// `run-e2e.js` handed this process in DATABASE_URL — the same one the code under
// test reads. A connection the harness opened for itself would be a different
// session, and a fixture written there surfaces as a foreign-key violation
// several calls later, pointing at the wrong thing entirely.
const q = require('./src/db/shim');
const { now, DEFAULT_ORG_ID } = require('./src/util');
const pipeline = require('./src/engine/pipeline');
const plans = require('./src/plans');
const statusPages = require('./src/lib/status-pages');
const subscribers = require('./src/lib/subscribers');
const automations = require('./src/engine/automations');

const BASE = 'http://127.0.0.1:3155';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
// Mail assertions are scoped to ONE address, never to MAILS.length: the seeded
// "Critical → E-Mail" rule and every other mutation in this file are pushing
// into the same list at the same time.
const mailsTo = (addr) => MAILS.filter((m) => (Array.isArray(m.to) ? m.to : [m.to]).includes(addr));

/* `until` (e2e-lib.js) THROWS on a thenable, deliberately: a Promise is truthy,
 * so `while (!fn())` would be satisfied on the first poll and the wait would be
 * no wait at all. That guard also means it cannot take an async predicate — and
 * once the fixtures go through the shim, one of the effects waited for here is a
 * database COUNT rather than an in-memory array.
 *
 * So the DB-backed waits use this variant, which AWAITS its predicate. The hole
 * `until` guards cannot exist here by construction: the query is resolved before
 * it is tested, never mistaken for `true`. Everything the mail stub answers stays
 * on `until` — MAILS is an ordinary array and reads synchronously.
 */
const untilAsync = async (fn, ms = 4000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 >= ms) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
};

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function login(email = 'admin@e2e.test', password = 'seed-admin-password-1') {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await r.json().catch(() => ({}));
  return {
    cookie: (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; '),
    csrf: body.csrf,
  };
}

// Fire N identical requests at once and report how each one answered. The
// assertion is always on the SHAPE of the outcome — exactly one winner — never
// on which one won, because that is genuinely arbitrary.
async function race(n, makeRequest) {
  const rs = await Promise.all(Array.from({ length: n }, (_, i) => makeRequest(i)));
  const out = [];
  for (const r of rs) out.push({ status: r.status, body: await r.json().catch(() => ({})) });
  return out;
}
// Same thing for the endpoints that answer in HTML rather than JSON — the
// confirm/unsubscribe mini pages both answer 200 and say which happened in the
// body, so `countOf` on the status would count nothing.
async function raceText(n, makeRequest) {
  const rs = await Promise.all(Array.from({ length: n }, (_, i) => makeRequest(i)));
  const out = [];
  for (const r of rs) out.push({ status: r.status, text: await r.text().catch(() => '') });
  return out;
}
const countOf = (rs, status) => rs.filter((r) => r.status === status).length;
const countSaying = (rs, needle) => rs.filter((r) => r.text.includes(needle)).length;

async function main() {
  chk('server boots and answers /api/health', await waitForServer());
  const s = await login();
  chk('the seeded admin can log in', !!s.cookie);

  // The seed creates four synthetic checks pointed at opscat.io, and
  // engine/synthetics.js ticks every five seconds. Switched off here, ~5s before
  // the first tick, for two reasons: a harness that says "no network" must not
  // probe a live host, and a result row landing for a check this file later
  // deletes is a FOREIGN KEY failure inside a fire-and-forget promise — under
  // `npm test` (NODE_ENV=test) an unhandled rejection exits the process
  // non-zero, so it would be a harness that fails one run in five for a reason
  // nothing in the output explains.
  await q.prepare('UPDATE synthetic_checks SET enabled = 0').run();

  // ── 1. a magic link is single-use ─────────────────────────────────────────
  // routes/auth.js reads login_tokens, checks used_at in JS, then writes it.
  // Async, five callers all read used_at = NULL and five sessions are minted
  // from one emailed link.
  const user = await q.prepare('SELECT id FROM users ORDER BY created_at LIMIT 1').get();
  const mkToken = async () => {
    const raw = crypto.randomBytes(24).toString('hex');
    await q.prepare(`INSERT INTO login_tokens (token_hash, user_id, purpose, expires_at, created_at)
      VALUES (?, ?, 'magic', ?, ?)`).run(sha256(raw), user.id, now() + 900000, now());
    return raw;
  };

  const magic = await mkToken();
  const magicRs = await race(5, () => fetch(`${BASE}/api/auth/magic-login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: magic }),
  }));
  chk('five parallel redemptions of ONE magic link produce exactly one session',
    countOf(magicRs, 200) === 1, magicRs.map((r) => r.status).join(','));
  chk('…and the other four are refused, not silently accepted',
    countOf(magicRs, 401) === 4, magicRs.map((r) => r.status).join(','));
  const used = await q.prepare('SELECT used_at FROM login_tokens WHERE token_hash = ?').get(sha256(magic));
  chk('…and the token is marked used exactly once', used && used.used_at != null);

  // a fresh token still works — the gate must close the door, not brick it
  const second = await mkToken();
  const okAgain = await fetch(`${BASE}/api/auth/magic-login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: second }),
  });
  chk('a DIFFERENT token still works (the gate closes one door, not the corridor)',
    okAgain.status === 200, String(okAgain.status));

  // ── 2. the 409 guards CLAUDE.md mandates ──────────────────────────────────
  // "An action that cannot change anything is disabled AND refused." Two
  // parallel finishes of one event must produce one 200 and one 409 — not two
  // 200s, and not two timeline entries for a single state change.
  await pipeline.ingestEvent({ name: 'conc_probe', device: 'host-1', severity: 90, description: 'x' },
    'e2e', false, DEFAULT_ORG_ID);
  const ev = await q.prepare("SELECT * FROM events WHERE dedupe_key = 'conc_probe|host-1|'").get();
  chk('an event exists to act on', !!ev);

  const act = (action) => fetch(`${BASE}/api/events/${ev.id}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: s.cookie, 'X-OpsCat-CSRF': s.csrf },
    body: JSON.stringify({ action }),
  });

  const finishRs = await race(4, () => act('finish'));
  chk('four parallel "finish" clicks close the event exactly once',
    countOf(finishRs, 200) === 1, finishRs.map((r) => r.status).join(','));
  chk('…and the rest answer 409 rather than pretending to work',
    countOf(finishRs, 409) === 3, finishRs.map((r) => r.status).join(','));

  const timeline = (await q.prepare(
    "SELECT COUNT(*) c FROM event_timeline WHERE event_id = ? AND action = 'finish'").get(ev.id)).c;
  chk('…and the history records ONE finish, not four',
    timeline === 1, `${timeline} entries`);

  // ── 3. assignment is idempotent per target ────────────────────────────────
  await pipeline.ingestEvent({ name: 'conc_assign', device: 'host-2', severity: 90, description: 'y' },
    'e2e', false, DEFAULT_ORG_ID);
  const ev2 = await q.prepare("SELECT * FROM events WHERE dedupe_key = 'conc_assign|host-2|'").get();
  const assignRs = await race(4, () => fetch(`${BASE}/api/events/${ev2.id}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: s.cookie, 'X-OpsCat-CSRF': s.csrf },
    body: JSON.stringify({ action: 'assign', userId: user.id }),
  }));
  chk('four parallel "assign to me" clicks assign exactly once',
    countOf(assignRs, 200) === 1, assignRs.map((r) => r.status).join(','));
  const assignEntries = (await q.prepare(
    "SELECT COUNT(*) c FROM event_timeline WHERE event_id = ? AND action = 'assign'").get(ev2.id)).c;
  chk('…and leave ONE history entry, not four',
    assignEntries === 1, `${assignEntries} entries`);

  // ── 4. the ingest dedupe key holds under parallel arrival ─────────────────
  // The partial unique index idx_events_dedupe_active is the invariant; this
  // asserts the behaviour it exists for, from the outside.
  const KEY = { name: 'conc_dedupe', device: 'host-3' };
  await Promise.all(Array.from({ length: 8 }, () => Promise.resolve()
    .then(() => pipeline.ingestEvent({ ...KEY, severity: 50, description: 'z' },
      'e2e', false, DEFAULT_ORG_ID))));
  const rows = (await q.prepare(
    "SELECT COUNT(*) c FROM events WHERE dedupe_key = 'conc_dedupe|host-3|' AND status = 'active'").get()).c;
  chk('eight parallel ingests of one dedupe key produce ONE active event',
    rows === 1, `${rows} rows`);
  const hits = (await q.prepare(
    "SELECT hits FROM events WHERE dedupe_key = 'conc_dedupe|host-3|'").get()).hits;
  chk('…and every one of them is counted (nothing silently dropped)',
    hits === 8, `hits ${hits}`);

  // A session-authenticated request, since everything below drives the app the
  // way the browser does.
  const api = (method, p, body, sess = s) => fetch(BASE + p, {
    method,
    headers: {
      'content-type': 'application/json',
      cookie: sess.cookie,
      'X-OpsCat-CSRF': sess.csrf,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // ── 5. an OAuth authorization code is redeemable once ─────────────────────
  // lib/oauth.js `consumeCode` DELETEs first and treats `changes !== 1` as
  // invalid_grant. Without that gate two redemptions of one code both read the
  // row, both fall through to issueTokens, and one authorization mints TWO
  // independently-revocable token pairs.
  //
  // Not "PKCE is defeated" — the S256 check is a pure function of the verifier
  // the caller presents, so racing without it gains an attacker nothing. What
  // goes is the single-use guarantee of RFC 6749 §4.1.2, and with it the only
  // evidence that a code was redeemed twice: when the code and the verifier
  // both leak, today's second exchange fails loudly and surfaces the theft,
  // while under the race both succeed silently.
  const reg = await (await fetch(`${BASE}/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'conc', redirect_uris: ['http://127.0.0.1:9999/cb'], scope: 'read write',
    }),
  })).json();
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const orgRow = await q.prepare('SELECT id FROM organizations WHERE id = ?').get(DEFAULT_ORG_ID);

  async function freshCode() {
    const u = new URL(`${BASE}/oauth/authorize`);
    for (const [k, v] of Object.entries({
      response_type: 'code', client_id: reg.client_id, redirect_uri: 'http://127.0.0.1:9999/cb',
      code_challenge: challenge, code_challenge_method: 'S256', scope: 'read write',
      resource: `${BASE}/mcp`,
    })) u.searchParams.set(k, v);
    // `redirect: 'manual'` is not optional here. Every way /oauth/authorize can
    // refuse is a 302 to the CLIENT's redirect_uri, and this one is
    // 127.0.0.1:9999 — a port with nothing on it. Followed, the refusal becomes
    // `TypeError: fetch failed … ECONNREFUSED` from inside a helper, which says
    // nothing about what was refused. Caught here it is a named check.
    const authz = await fetch(u, { headers: { cookie: s.cookie }, redirect: 'manual' });
    const html = authz.status === 200 ? await authz.text() : '';
    if (!html) throw new Error(`/oauth/authorize refused: ${authz.status} ${authz.headers.get('location')}`);
    const ticket = /name="ticket" value="([^"]+)"/.exec(html)?.[1];
    const consent = await fetch(`${BASE}/oauth/authorize/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: s.cookie },
      body: new URLSearchParams({ ticket, org_id: String(orgRow.id), decision: 'allow' }),
      redirect: 'manual',
    });
    return new URL(consent.headers.get('location')).searchParams.get('code');
  }
  const tokenReq = (body) => fetch(`${BASE}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  const code = await freshCode();
  chk('an authorization code was issued to race', !!code, String(code));
  const codeRs = await race(5, () => tokenReq({
    grant_type: 'authorization_code', client_id: reg.client_id, code,
    redirect_uri: 'http://127.0.0.1:9999/cb', code_verifier: verifier,
  }));
  chk('five parallel redemptions of ONE authorization code mint exactly one token pair',
    countOf(codeRs, 200) === 1, codeRs.map((r) => r.status).join(','));
  chk('…and the other four are told invalid_grant, not handed a second pair',
    codeRs.filter((r) => r.body.error === 'invalid_grant').length === 4,
    codeRs.map((r) => r.body.error || r.status).join(','));
  const issuedPairs = codeRs.filter((r) => r.body.access_token).length;
  chk('…so exactly one access token exists for that code', issuedPairs === 1, `${issuedPairs} pairs`);
  const codeGone = (await q.prepare('SELECT COUNT(*) c FROM oauth_codes WHERE code_hash = ?').get(sha256(code))).c;
  chk('…and the code row is gone, not merely flagged', codeGone === 0, `${codeGone} rows`);

  // the corridor: a DIFFERENT code still exchanges
  const code2 = await freshCode();
  const tok2 = await tokenReq({
    grant_type: 'authorization_code', client_id: reg.client_id, code: code2,
    redirect_uri: 'http://127.0.0.1:9999/cb', code_verifier: verifier,
  });
  const pair = await tok2.json();
  chk('a DIFFERENT authorization code still exchanges (one door, not the corridor)',
    tok2.status === 200 && !!pair.access_token, `${tok2.status} ${JSON.stringify(pair).slice(0, 120)}`);

  // ── 6. refresh-token rotation survives parallel reuse ─────────────────────
  // Same DELETE-is-the-gate shape. Two holders of one refresh token — the
  // legitimate client and whoever copied it — would otherwise BOTH be handed a
  // fresh pair, so the stolen copy keeps working forever and its use is never
  // observed. Rotation without the gate is rotation in name only.
  const refreshRs = await race(4, () => tokenReq({
    grant_type: 'refresh_token', client_id: reg.client_id, refresh_token: pair.refresh_token,
  }));
  chk('four parallel uses of ONE refresh token rotate exactly once',
    countOf(refreshRs, 200) === 1, refreshRs.map((r) => r.status).join(','));
  chk('…and the losers get invalid_grant rather than a second live grant',
    refreshRs.filter((r) => r.body.error === 'invalid_grant').length === 3,
    refreshRs.map((r) => r.body.error || r.status).join(','));
  const spent = (await q.prepare("SELECT COUNT(*) c FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'")
    .get(sha256(pair.refresh_token))).c;
  chk('…and the presented refresh token is consumed', spent === 0, `${spent} rows`);
  const rotated = refreshRs.find((r) => r.status === 200).body;
  const again = await tokenReq({
    grant_type: 'refresh_token', client_id: reg.client_id, refresh_token: rotated.refresh_token,
  });
  const rotated2 = await again.json();
  chk('the NEW refresh token still rotates (one door, not the corridor)',
    again.status === 200 && !!rotated2.access_token, `${again.status}`);
  const AT = rotated2.access_token;

  // ── 7. a status-page subscription is claimed once ─────────────────────────
  // lib/subscribers.js `ins` is ON CONFLICT DO NOTHING and `.changes` says who
  // owns the row. Two sign-ups of one address arriving together would otherwise
  // both insert-or-overwrite, and the second mail's token replaces the first's —
  // so the link in the mail that already left is dead before it is read.
  //
  // Driven through the library rather than POST /api/status/subscribe on
  // purpose: that route sits behind a 3/minute rate limiter that answers
  // { ok: true } for everything it drops, so a race of five over HTTP would be
  // three real attempts and two silent no-ops — a broken gate would look fine.
  // The HTTP door is asserted separately, below.
  const page = await statusPages.defaultPage(DEFAULT_ORG_ID);
  chk('the org has a published default status page', !!page && page.published === 1);
  await Promise.all(Array.from({ length: 5 }, () => subscribers.subscribe(page, 'race@e2e.test')));
  const subRows = (await q.prepare('SELECT COUNT(*) c FROM status_subscribers WHERE email = ?').get('race@e2e.test')).c;
  chk('five parallel sign-ups of one address produce ONE subscriber row',
    subRows === 1, `${subRows} rows`);
  // Wait for the FIRST mail, then settle before counting: `until(… === 1)`
  // returns the instant the count touches 1 and would pass on its way to 5.
  await until(() => mailsTo('race@e2e.test').length >= 1);
  await settle();
  chk('…and exactly one confirmation mail leaves',
    mailsTo('race@e2e.test').length === 1, `${mailsTo('race@e2e.test').length} mails`);

  const otherSub = await fetch(`${BASE}/api/status/subscribe`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'second@e2e.test' }),
  });
  const secondRow = await q.prepare('SELECT 1 AS one FROM status_subscribers WHERE email = ?').get('second@e2e.test');
  chk('a DIFFERENT address still subscribes through the public form',
    otherSub.status === 200 && !!secondRow,
    String(otherSub.status));

  // ── 8. a confirm link counts ONCE against the plan allowance ──────────────
  // `confirm` claims the row with `AND confirmed_at IS NULL`, and `.changes` —
  // not the `row.confirmed_at` read a statement earlier — decides. A confirm
  // link is clicked twice as a matter of routine: the corporate mail scanner
  // fetches it, then the human does. Both clicks pass the JS check, both are
  // told "confirmed", and everything that hangs off a confirmation runs twice.
  // The allowance is the number the org is BILLED on, so it is asserted here
  // too — it must move by exactly one, in either direction.
  const confirmMail = mailsTo('race@e2e.test')[0];
  const confirmToken = (confirmMail.html.match(/\/status\/confirm\?token=([^"< ]+)/) || [])[1];
  chk('the confirmation mail carries a confirm token', !!confirmToken);
  const before = await plans.usedFor(DEFAULT_ORG_ID, 'statusSubscribers');
  const confirmRs = await raceText(4, () =>
    fetch(`${BASE}/status/confirm?token=${confirmToken}`));
  chk('four clicks of ONE confirm link confirm exactly once',
    countSaying(confirmRs, 'Subscription confirmed') === 1,
    confirmRs.map((r) => (r.text.includes('Subscription confirmed') ? 'ok' : 'refused')).join(','));
  chk('…and the other three say the link is spent, not "confirmed" again',
    countSaying(confirmRs, 'Link invalid or expired') === 3,
    `${countSaying(confirmRs, 'Link invalid or expired')} refusals`);
  const usedAfter = await plans.usedFor(DEFAULT_ORG_ID, 'statusSubscribers');
  chk('…and the plan allowance moved by exactly one',
    usedAfter === before + 1, `${before} → ${usedAfter}`);

  // the corridor: a second address's own link still confirms
  const secondMail = await until(() => mailsTo('second@e2e.test')[0]);
  const secondToken = (secondMail.html.match(/\/status\/confirm\?token=([^"< ]+)/) || [])[1];
  const secondConfirm = await (await fetch(`${BASE}/status/confirm?token=${secondToken}`)).text();
  chk('a DIFFERENT subscriber can still confirm (one door, not the corridor)',
    secondConfirm.includes('Subscription confirmed'), secondConfirm.slice(0, 120));

  // ── 9. publishing an incident mails its subscribers ONCE ──────────────────
  // The worst one in the product. lib/incidents.js `setPublished` claims the
  // transition with `AND published != ?` and only the caller that MOVED the row
  // fans out. Two parallel publishes without it both read published = 0, both
  // pass a JS check, and every confirmed subscriber of every page the incident
  // touches is mailed twice. A mail cannot be recalled — which is why the claim
  // happens BEFORE the send, and why the assertion below is on the MAIL COUNT
  // and not on the row. The row was never the bug.
  const incA = await (await api('POST', '/api/incidents',
    { title: 'conc publish', severity: 70, message: 'opened' })).json();
  chk('an incident exists to publish', !!incA.id, JSON.stringify(incA).slice(0, 120));
  const pubRs = await race(2, () => api('PATCH', `/api/incidents/${incA.id}`, { published: true }));
  chk('two parallel publishes of one incident both answer 200 (idempotent, not an error)',
    countOf(pubRs, 200) === 2, pubRs.map((r) => r.status).join(','));
  chk('…and the incident is published', !!(await q.prepare('SELECT published FROM incidents WHERE id = ?')
    .get(incA.id)).published);
  await until(() => mailsTo('race@e2e.test').length >= 2);
  await settle();
  chk('…and the confirmed subscriber is mailed exactly ONCE about it',
    mailsTo('race@e2e.test').filter((m) => m.subject.includes(`INC-${2000 + incA.id}`)).length === 1,
    `${mailsTo('race@e2e.test').filter((m) => m.subject.includes(`INC-${2000 + incA.id}`)).length} mails`);

  // the corridor: unpublish and publish again — the transition still fans out
  await api('PATCH', `/api/incidents/${incA.id}`, { published: false });
  await settle(100);
  const afterUnpublish = mailsTo('race@e2e.test').length;
  await api('PATCH', `/api/incidents/${incA.id}`, { published: true });
  await until(() => mailsTo('race@e2e.test').length > afterUnpublish);
  await settle();
  chk('re-publishing after an unpublish mails again, once (one door, not the corridor)',
    mailsTo('race@e2e.test').length === afterUnpublish + 1,
    `${afterUnpublish} → ${mailsTo('race@e2e.test').length}`);

  // ── 10. resolving an incident emits `incident_resolved` once ──────────────
  // `q.resolve` carries `AND status != 'resolved'` and `.changes` — not the row
  // read a statement earlier — decides whether THIS caller performed the
  // transition. Two resolves past that gate emit the synthetic lifecycle event
  // twice, so every matching alert rule pages the on-call twice for one
  // incident closing, at whatever hour it closed.
  //
  // Observed through a REAL alert rule on the REAL dispatch path, scoped to its
  // own recipient so the seeded "Critical → E-Mail" rule cannot be miscounted.
  await q.prepare(`INSERT INTO alert_rules (org_id, name, enabled, channel, trigger_name, severity_min,
      cooldown_m, recipients, created_at)
    VALUES (?, 'conc-resolved', 1, 'email', 'incident_resolved', 0, 0, ?, ?)`)
    .run(DEFAULT_ORG_ID, JSON.stringify(['resolved@e2e.test']), now());
  const incB = await (await api('POST', '/api/incidents',
    { title: 'conc resolve', severity: 70, message: 'opened' })).json();
  const resolveRs = await race(2, () =>
    api('POST', `/api/incidents/${incB.id}/status`, { status: 'resolved', message: 'done' }));
  chk('two parallel resolves of one incident both answer 200',
    countOf(resolveRs, 200) === 2, resolveRs.map((r) => r.status).join(','));
  chk('…and the incident carries ONE resolved_at',
    !!(await q.prepare('SELECT resolved_at FROM incidents WHERE id = ?').get(incB.id)).resolved_at);
  await until(() => mailsTo('resolved@e2e.test').length >= 1);
  await settle();
  chk('…and `incident_resolved` reached the alert rule exactly once, not twice',
    mailsTo('resolved@e2e.test').length === 1, `${mailsTo('resolved@e2e.test').length} pages`);

  const incC = await (await api('POST', '/api/incidents',
    { title: 'conc resolve 2', severity: 70, message: 'opened' })).json();
  await api('POST', `/api/incidents/${incC.id}/status`, { status: 'resolved', message: 'done' });
  await until(() => mailsTo('resolved@e2e.test').length >= 2);
  await settle();
  chk('a SECOND incident resolving still pages (one door, not the corridor)',
    mailsTo('resolved@e2e.test').length === 2, `${mailsTo('resolved@e2e.test').length} pages`);

  // ── 11. downgrade is a compare-and-swap on the severity it read ───────────
  // routes/ops.js downgrades with `AND severity = ?`. A blind `SET severity = ?`
  // lets two overlapping clicks on a 90 both write 65 and both record "90 → 65",
  // so the history claims two 25-point drops for one. A derived entry may only
  // state the transition the database actually performed.
  //
  // **Read this before adding a "one winner" assertion here — it would be
  // wrong.** Unlike `finish` and `assign`, downgrade is REPEATABLE: 90 → 65 →
  // 40 is three legitimate operations, not one operation attempted three times.
  // And its 409 branch is unreachable from outside today, because the route
  // reads `e.severity` and runs the CAS in ONE synchronous stretch — nothing can
  // move the row between them, so three parallel clicks serialise and each reads
  // a fresh value. Measured: all three answer 200 (they should).
  //
  // What the CAS actually guarantees is a property of the RECORD, and that one
  // is assertable from outside on either driver: **as many timeline entries as
  // there were successful downgrades, each naming a distinct transition, and a
  // final severity that agrees with the chain.** Async without the CAS, two
  // handlers both read 90, both write 65, both answer 200 and both record
  // "90 → 65" — two successes, two entries claiming one drop, and a severity
  // 25 points above what the answers add up to. That is what goes red.
  await pipeline.ingestEvent({ name: 'conc_down', device: 'host-5', severity: 90, description: 'd' },
    'e2e', false, DEFAULT_ORG_ID);
  const ev3 = await q.prepare("SELECT * FROM events WHERE dedupe_key = 'conc_down|host-5|'").get();
  const downRs = await race(3, () => api('POST', `/api/events/${ev3.id}/action`, { action: 'downgrade' }));
  const downOk = countOf(downRs, 200);
  const sevNow = async () => (await q.prepare('SELECT severity FROM events WHERE id = ?').get(ev3.id)).severity;
  chk('three overlapping downgrades neither error nor half-apply',
    downOk + countOf(downRs, 409) === 3, downRs.map((r) => r.status).join(','));
  chk('the severity agrees with the number of downgrades that said they worked',
    await sevNow() === Math.max(10, 90 - 25 * downOk), `${downOk} ok → severity ${await sevNow()}`);
  const downEntries = (await q.prepare(`SELECT detail FROM event_timeline
    WHERE event_id = ? AND action = 'downgrade' ORDER BY ts, id`).all(ev3.id)).map((r) => r.detail);
  chk('…and the history carries exactly one entry per successful downgrade',
    downEntries.length === downOk, `${downEntries.length} entries for ${downOk} successes`);
  chk('…each naming a DISTINCT transition — no two claim the same 25-point drop',
    new Set(downEntries).size === downEntries.length, downEntries.join(' | ') || 'none');
  chk('…and they chain, so every entry names the pair the database performed',
    downEntries.every((d, i) => {
      const [from, to] = d.split(' → ').map(Number);
      return to === Math.max(10, from - 25) && (i === 0 ? from === 90 : from === Number(downEntries[i - 1].split(' → ')[1]));
    }), downEntries.join(' | ') || 'none');

  // the corridor: the next downgrade still works, and the floor still refuses —
  // "an action that cannot change anything is disabled AND refused"
  //
  // Where these two START depends on how many of the three racing clicks won,
  // and that is arbitrary BY DESIGN (rule 1 at the top of this file). Written
  // against the synchronous driver it never looked arbitrary: all three always
  // won, the chain always reached 15, and "=== 10" was the floor one step later.
  // **On Postgres the 409 branch this block describes as unreachable becomes
  // reachable** — the route reads `e.severity` and then AWAITS the
  // compare-and-swap, so two clicks read the same 90 and one is refused, exactly
  // as the CAS exists to ensure. Measured: two winners, severity 40. So the
  // corridor asserts the STEP and then walks to the floor, instead of assuming
  // which step it is standing on.
  const beforeAgain = await sevNow();
  const downAgain = await api('POST', `/api/events/${ev3.id}/action`, { action: 'downgrade' });
  chk('the next downgrade still works (one door, not the corridor)',
    downAgain.status === 200 && await sevNow() === Math.max(10, beforeAgain - 25),
    `${downAgain.status} severity ${beforeAgain} → ${await sevNow()}`);
  // 90 is four steps above the floor, so this is bounded whatever the race did.
  for (let i = 0; i < 8 && await sevNow() > 10; i++) {
    await api('POST', `/api/events/${ev3.id}/action`, { action: 'downgrade' });
  }
  const atFloor = await api('POST', `/api/events/${ev3.id}/action`, { action: 'downgrade' });
  chk('…and at the floor it is refused rather than pretending to work',
    atFloor.status === 409, `${atFloor.status} at severity ${await sevNow()}`);

  // ── 12. two notes on one case BOTH survive ───────────────────────────────
  // The opposite assertion from every other gate here: `cases.note` is
  // human-authored text, and the concatenation has to BE the write. Read the
  // column, join in JS and write it back and the second author silently deletes
  // the first author's sentence — no error, no trace, and the two people
  // involved cannot tell it happened.
  //
  // Both writers are exercised: POST /events/:id/action from the panel and
  // opscat_event_action over the real MCP transport. They share ONE
  // implementation (routes/ops.js `appendCaseNote`) precisely so an agent's note
  // cannot delete an operator's, and that claim needs both callers to prove it.
  await pipeline.ingestEvent({ name: 'conc_note', device: 'host-6', severity: 90, description: 'n' },
    'e2e', false, DEFAULT_ORG_ID);
  const ev4 = await q.prepare("SELECT * FROM events WHERE dedupe_key = 'conc_note|host-6|'").get();
  chk('the event opened a case to write notes on',
    !!await q.prepare("SELECT id FROM cases WHERE event_id = ? AND status != 'closed'").get(ev4.id));

  const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const init = await fetch(`${BASE}/mcp`, {
    method: 'POST', headers: { ...H, authorization: `Bearer ${AT}` },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'initialize', id: 1,
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'conc', version: '1' } },
    }),
  });
  const mcpSid = init.headers.get('mcp-session-id');
  chk('an MCP session is open for the agent half of the note race', !!mcpSid, String(init.status));
  const mcpCall = (params, id) => fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { ...H, authorization: `Bearer ${AT}`, 'mcp-session-id': mcpSid },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', id, params }),
  });

  const [opsNote, mcpNote] = await Promise.all([
    api('POST', `/api/events/${ev4.id}/action`, { action: 'note', note: 'OPERATOR-SAW-IT' }),
    mcpCall({ name: 'opscat_event_action', arguments: { id: ev4.id, action: 'note', note: 'AGENT-SAW-IT' } }, 2),
  ]);
  chk('the operator note and the agent note both answered',
    opsNote.status === 200 && mcpNote.status === 200, `${opsNote.status}/${mcpNote.status}`);
  const noteOf = async () => (await q.prepare(
    "SELECT note FROM cases WHERE event_id = ? AND status != 'closed'").get(ev4.id)).note;
  /* Waits, for exactly the reason the timeline check below already waits — and
   * the reason this block did NOT is that the note is written by the handler
   * while the timeline entry was known to lag. That distinction did not hold:
   * these three checks went red in CI (PR #192, a syslog change that touches
   * neither cases.js nor the MCP note path), with the operator's note present
   * and the agent's absent.
   *
   * A lost update is excluded by the SQL: the append is ONE statement
   * (`SET note = COALESCE(NULLIF(note,'') || ?, '') || ?`), and Postgres blocks
   * the second writer on the row lock and re-evaluates it against the version
   * the first one committed. What is left is that the MCP response can return
   * before its write is visible here — so the read waits, and the assertions
   * are unchanged.
   *
   * If this goes red again AFTER the wait, the wait is not the answer and the
   * note itself is being lost. The detail therefore reports the note verbatim,
   * so the next occurrence starts with evidence rather than with this comment. */
  await untilAsync(async () => {
    const n = String(await noteOf());
    return n.includes('OPERATOR-SAW-IT') && n.includes('AGENT-SAW-IT');
  });
  await settle();
  const noteText = await noteOf();
  chk('the operator note survived the agent writing at the same moment',
    String(noteText).includes('OPERATOR-SAW-IT'), JSON.stringify(noteText));
  chk('…and the agent note survived the operator (BOTH are there, appended)',
    String(noteText).includes('AGENT-SAW-IT'), JSON.stringify(noteText));
  chk('…on separate lines, so neither replaced the other',
    String(noteText).split('\n').filter((l) => l.trim()).length === 2, JSON.stringify(noteText));
  /* Reported with the ROWS, not just the count — this check has failed once in
   * CI (PR #170, a docs-only change, so the race predates it) and has not been
   * reproduced since in ~50 local runs. A count alone says "1 entries" and
   * leaves the next person exactly where this one started: knowing something
   * was lost and not which writer lost it.
   *
   * Both writers await their `recordEvent` before answering — the panel at
   * routes/ops.js and the MCP tool via `opsBus()` — and `event_timeline` has no
   * unique constraint that could collapse two INSERTs, so the obvious
   * explanations are already excluded. Whatever this is, the surviving row's
   * author and detail identify it in one occurrence.
   *
   * Waits for both before judging: `audit()`-style fire-and-forget writes taught
   * us that reading immediately after a response reports "not yet" as "never".
   * The wait settles and then asserts EXACTLY two — waiting for ">= 2" alone
   * would pass on the way to three.
   */
  const noteRows = async () => q.prepare(
    "SELECT user_id, detail FROM event_timeline WHERE event_id = ? AND action = 'note' ORDER BY id")
    .all(ev4.id);
  await untilAsync(async () => (await noteRows()).length >= 2);
  await settle();
  const entries = await noteRows();
  chk('…and the history carries one entry per author, with the agent named',
    entries.length === 2 && entries.some((e) => String(e.detail).includes('[via ')),
    `${entries.length} entries: ${JSON.stringify(entries.map((e) => ({ u: e.user_id, d: String(e.detail).slice(0, 40) })))}`);

  const thirdNote = await api('POST', `/api/events/${ev4.id}/action`, { action: 'note', note: 'THIRD' });
  chk('a third note still appends (this gate must never refuse — it exists to LOSE nothing)',
    thirdNote.status === 200
    && (await noteOf()).includes('OPERATOR-SAW-IT'),
    String(thirdNote.status));

  // ── 13. the plan allowance is enforced BY the insert ─────────────────────
  // plans.js `insertWithinLimit` folds the usage count into the INSERT's own
  // WHERE, so `changes` is the decision. As a COUNT, a JS comparison and then an
  // INSERT, N+4 requests arriving at the cap together all read "under the limit"
  // and all write — a quota bypass, and at routes/synthetics.js the same shape
  // provisions cloud VMs past the cap on the customer's bill.
  //
  // This is a CLOUD-EDITION behaviour: `edition.js` turns enforcement off for
  // the community edition, so a community run cannot tell a working cap from a
  // missing one. The harness runs OPSCAT_EDITION=cloud (top of file), which sets
  // `plans.setEnforce(true)` — no toggling needed here. The seeded org is on the
  // `enterprise` plan, where `checks` is unlimited, so it is put on `free`
  // (cap 3) for this block and restored immediately after.
  //
  // ── THIS BLOCK ONCE FAILED ON POSTGRES, AND IT WAS RIGHT TO ────────────────
  //
  // Measured on PostgreSQL 16 before `q.lockOrg` existed: FOUR rows against a
  // cap of three, four 200s and three 402s, in roughly half of ten runs. The
  // gate was not broken code — it was a claim that only held on the old driver.
  // `plans.insertWithinLimit` argued "the count and the INSERT in ONE statement,
  // so there is no instant between them for a second request to occupy", and on
  // better-sqlite3 that was true: one writer, statements serialised, the
  // subquery always saw every committed row. Under Postgres's default READ
  // COMMITTED a statement's subquery reads a snapshot that does NOT include rows
  // other in-flight transactions have inserted and not yet committed — so N
  // requests can each count 2, each see 2 < 3, and each write. One statement is
  // not one isolation unit.
  //
  // Reproduced outside the app on a bare table, same statement shape, 7 parallel
  // inserts with a cap of 3: five rows written.
  //
  // It was left failing rather than relaxed until the fix landed — a per-org row
  // lock inside the transaction — because this is the quota bypass the block was
  // written to catch, and the identical shape in routes/synthetics.js
  // (`INSERT … SELECT … WHERE (SELECT COUNT(*) …) < cap`) spends the customer's
  // money. Note the provisioning block further down does NOT contradict this —
  // its cap is already occupied by a COMMITTED seed row, so every racer counts 1
  // and all three are refused; that fixture cannot reach the hazard.
  const freeChecks = await plans.checkLimit(DEFAULT_ORG_ID, 'free', 'checks');
  chk('the cloud edition enforces plan limits (the premise of this block)',
    freeChecks.limit === 3, JSON.stringify(freeChecks));
  const planBefore = (await q.prepare('SELECT plan FROM organizations WHERE id = ?').get(DEFAULT_ORG_ID)).plan;
  await q.prepare('DELETE FROM synthetic_checks WHERE org_id = ?').run(DEFAULT_ORG_ID);
  await q.prepare("UPDATE organizations SET plan = 'free' WHERE id = ?").run(DEFAULT_ORG_ID);
  const CAP = 3;
  const quotaRs = await race(CAP + 4, (i) => api('POST', '/api/synthetics/checks',
    { type: 'http', target: `https://e2e.test/${i}`, intervalS: 60, timeoutMs: 5000 }));
  const checksOfOrg = async () => (await q.prepare(
    'SELECT COUNT(*) c FROM synthetic_checks WHERE org_id = ?').get(DEFAULT_ORG_ID)).c;
  const made = await checksOfOrg();
  chk('seven parallel creations against a cap of three write exactly three rows',
    made === CAP, `${made} rows`);
  chk('…and exactly three requests were told they succeeded',
    countOf(quotaRs, 200) === CAP, quotaRs.map((r) => r.status).join(','));
  chk('…and the other four got 402, not a row',
    countOf(quotaRs, 402) === 4, quotaRs.map((r) => r.status).join(','));

  // The cap is the PLAN's, so the corridor is a bigger plan rather than a
  // deleted row — nothing here removes a check the ticker may be running.
  await q.prepare('UPDATE synthetic_checks SET enabled = 0 WHERE org_id = ?').run(DEFAULT_ORG_ID);
  await q.prepare("UPDATE organizations SET plan = 'pro' WHERE id = ?").run(DEFAULT_ORG_ID);
  const roomAgain = await api('POST', '/api/synthetics/checks',
    { type: 'http', target: 'https://e2e.test/after', intervalS: 60, timeoutMs: 5000 });
  chk('a bigger plan lets the next creation through (one door, not the corridor)',
    roomAgain.status === 200 && await checksOfOrg() === CAP + 1, String(roomAgain.status));
  await q.prepare('UPDATE synthetic_checks SET enabled = 0 WHERE org_id = ?').run(DEFAULT_ORG_ID);
  await q.prepare('UPDATE organizations SET plan = ? WHERE id = ?').run(planBefore, DEFAULT_ORG_ID);

  // ── 14. a refused provision leaves NO orphan sensor node ─────────────────
  // routes/synthetics.js writes the `sensor_nodes` row FIRST so the location can
  // carry `node_id`, which is what lets the cap and the write that consumes it
  // be one statement. The price is that a refusal must clean up after itself: a
  // node row is only ever reachable THROUGH its location, so an unlinked one is
  // invisible to teardown AND to the reconcile sweeper — a cloud VM on the
  // customer's bill that nothing in the product can ever find again.
  const cred = await (await api('POST', '/api/synthetics/cloud-credentials', {
    // Hyphenated on purpose, like e2e-vendors' fixtures: a bare `AKIA` + 16
    // uppercase-alnum is the real AWS access-key SHAPE, and the community
    // publish scanner refuses to sync a tree containing one — correctly, since
    // it cannot tell a fixture from a leak. SigV4 signs whatever string it is
    // given, so nothing here needs the realistic form. This exact literal
    // blocked `Publish community core` for four merges.
    provider: 'aws', label: 'e2e', secret: { accessKeyId: 'AKIA-e2e-conc', secretAccessKey: 'x'.repeat(40) },
  })).json();
  chk('a cloud credential exists to provision with', !!cred.id, JSON.stringify(cred).slice(0, 120));

  // occupy the cap of 1 with an existing node+location pair
  // `.insert()`, not lastInsertRowid: the shim refuses that one (node-postgres
  // has no such field, and `undefined` in a foreign key is a NULL nobody notices
  // until a join comes back empty) — and the id IS a foreign key here.
  const seedNodeId = await q.prepare(`INSERT INTO sensor_nodes (provider, provider_region, cloud_credential_id,
      instance_class, status, created_at) VALUES ('aws','eu-west-1',?, 'standard','online',?)`)
    .insert(cred.id, now());
  await q.prepare(`INSERT INTO synthetic_locations (org_id, city, cc, kind, region, provider,
      probe_key_hash, node_id, active, created_at)
    VALUES (?, 'Ireland', 'IE', 'customer', 'Europe', 'aws', ?, ?, 1, ?)`)
    .run(DEFAULT_ORG_ID, sha256('seed-probe-key'), seedNodeId, now());
  const nodeCount = async () => (await q.prepare('SELECT COUNT(*) c FROM sensor_nodes').get()).c;
  const orphanCount = async () => (await q.prepare(`SELECT COUNT(*) c FROM sensor_nodes n
    WHERE NOT EXISTS (SELECT 1 FROM synthetic_locations l WHERE l.node_id = n.id)`).get()).c;
  const nodesBefore = await nodeCount();

  const provRs = await race(3, () => api('POST', '/api/synthetics/locations/provision',
    { provider: 'aws', region: 'eu-central-1', credentialId: cred.id, instanceClass: 'standard' }));
  chk('three parallel provisions at the node cap are all refused',
    countOf(provRs, 429) === 3, provRs.map((r) => r.status).join(','));
  const nodesAfter = await nodeCount();
  chk('…and leave NO orphan sensor_nodes row behind (an unbilled VM nobody can find)',
    nodesAfter === nodesBefore, `${nodesBefore} → ${nodesAfter}`);
  const orphans = await orphanCount();
  chk('…and every node row is still reachable through a location', orphans === 0, `${orphans} orphans`);

  // the corridor: free the slot and a provision goes all the way through
  await q.prepare('DELETE FROM synthetic_locations WHERE node_id = ?').run(seedNodeId);
  await q.prepare('DELETE FROM sensor_nodes WHERE id = ?').run(seedNodeId);
  const provOk = await api('POST', '/api/synthetics/locations/provision',
    { provider: 'aws', region: 'eu-central-1', credentialId: cred.id, instanceClass: 'standard' });
  const provBody = await provOk.json();
  chk('under the cap a provision still completes (one door, not the corridor)',
    provOk.status === 200 && provBody.status === 'provisioning', `${provOk.status} ${JSON.stringify(provBody)}`);
  chk('…and its node is linked to its location, as the cap statement requires',
    await orphanCount() === 0);

  // ── 15. an alert-rule cooldown is claimed, not compared ──────────────────
  // engine/alerts.js claims the fire in ONE statement — insert it, or move
  // `fired_at` forward only if the previous one is already older than the
  // cooldown — and `changes` decides. Read the row, compare in JS and write, and
  // two dispatchers of the same event both see the same `fired_at`, both pass,
  // and the rule pages twice: two Slack messages, two POSTs to a customer's
  // webhook, two phones at 3am. The claim happens BEFORE the send on purpose —
  // a burned cooldown is recoverable, a second page is not.
  await q.prepare(`INSERT INTO alert_rules (org_id, name, enabled, channel, trigger_name, severity_min,
      cooldown_m, recipients, created_at)
    VALUES (?, 'conc-cooldown', 1, 'email', 'conc_cooldown', 0, 60, ?, ?)`)
    .run(DEFAULT_ORG_ID, JSON.stringify(['cooldown@e2e.test']), now());
  await Promise.all(Array.from({ length: 4 }, () => Promise.resolve().then(() =>
    pipeline.ingestEvent({ name: 'conc_cooldown', device: 'host-7', severity: 70, description: 'c' },
      'e2e', false, DEFAULT_ORG_ID))));
  await until(() => mailsTo('cooldown@e2e.test').length >= 1);
  await settle();
  chk('four dispatches of one rule inside its cooldown send ONE notification',
    mailsTo('cooldown@e2e.test').length === 1, `${mailsTo('cooldown@e2e.test').length} pages`);
  const fires = (await q.prepare(`SELECT COUNT(*) c FROM rule_fires
    WHERE dedupe_key = 'conc_cooldown|host-7|'`).get()).c;
  chk('…and the claim left exactly one rule_fires row', fires === 1, `${fires} rows`);

  // the corridor: a DIFFERENT dedupe key is a different claim and still pages
  await pipeline.ingestEvent({ name: 'conc_cooldown', device: 'host-8', severity: 70, description: 'c' },
    'e2e', false, DEFAULT_ORG_ID);
  await until(() => mailsTo('cooldown@e2e.test').length >= 2);
  await settle();
  chk('a different event still pages the same rule (one door, not the corridor)',
    mailsTo('cooldown@e2e.test').length === 2, `${mailsTo('cooldown@e2e.test').length} pages`);

  // ── 16. an automation cooldown is claimed the same way ───────────────────
  // Same statement, higher stakes than a duplicate message: the actions are not
  // reads. A second runner POSTs the lead's webhook again and closes cases a
  // second time, appending an auto-close note to work somebody may already have
  // reopened. Observed through audit_log, which is where every executed action
  // lands (`automation_run`, system actor).
  await q.prepare(`INSERT INTO automations (org_id, name, enabled, trigger_json, actions_json,
      cooldown_m, created_at) VALUES (?, 'conc-auto', 1, ?, ?, 60, ?)`)
    .run(DEFAULT_ORG_ID, JSON.stringify({ event: 'conc_auto', severityMin: 0 }),
      JSON.stringify([{ type: 'assign_case', userId: user.id }]), now());
  automations.invalidate(DEFAULT_ORG_ID);
  const autoRuns = async () => (await q.prepare(`SELECT COUNT(*) c FROM audit_log
    WHERE action = 'automation_run' AND detail LIKE '[conc-auto]%'`).get()).c;
  await Promise.all(Array.from({ length: 4 }, () => Promise.resolve().then(() =>
    pipeline.ingestEvent({ name: 'conc_auto', device: 'host-9', severity: 70, description: 'a' },
      'e2e', false, DEFAULT_ORG_ID))));
  await untilAsync(async () => await autoRuns() >= 1);
  await settle();
  chk('four dispatches of one automation inside its cooldown run the actions ONCE',
    await autoRuns() === 1, `${await autoRuns()} runs`);
  const autoFires = (await q.prepare(`SELECT COUNT(*) c FROM automation_fires
    WHERE dedupe_key = 'conc_auto|host-9|'`).get()).c;
  chk('…and the claim left exactly one automation_fires row', autoFires === 1, `${autoFires} rows`);

  await pipeline.ingestEvent({ name: 'conc_auto', device: 'host-10', severity: 70, description: 'a' },
    'e2e', false, DEFAULT_ORG_ID);
  await untilAsync(async () => await autoRuns() >= 2);
  await settle();
  chk('a different event still runs the automation (one door, not the corridor)',
    await autoRuns() === 2, `${await autoRuns()} runs`);

  /* ── ingest deadlock: two senders, one device, opposing orders ─────────────
   *
   * `ingestLogs` takes a row lock per classified line and holds it to the end of
   * its transaction. In ARRIVAL order that sequence is data-dependent, so two
   * batches mentioning the same two dedupe keys in opposite orders form a lock
   * cycle; PostgreSQL kills one, the batch rolls back, and the sender gets a 500
   * for a request that was entirely valid.
   *
   * This is not hypothetical and it is not rare in shape: ONE shared device with
   * two event types is enough. Measured before the fix — 153 lines/s with 79% of
   * batches refused, against 16,700 lines/s for disjoint devices; and directly,
   * 35 of 60 batches failing with `deadlock detected`.
   *
   * The batches below are DELIBERATELY opposed — a and c lead with BGP, b and d
   * with the panic. Identical input cannot deadlock (same rows, same order), so
   * a version of this check built from one shared fixture passes on the broken
   * code and proves nothing. It was written that way first, and it did.
   *
   * The shipped `scripts/loadtest-ingest.js` cannot see this either: it gives
   * every worker its own device. That is why its throughput figure describes
   * disjoint senders only.
   */
  const BGP_LINE = 'BGP neighbor 10.0.0.1 down';
  const PANIC_LINE = 'kernel panic - not syncing';
  const dlBatch = (first, second) => [
    ...Array.from({ length: 25 }, () => ({ device: 'dl-shared-01', line: first })),
    ...Array.from({ length: 25 }, () => ({ device: 'dl-shared-01', line: second })),
  ];
  const dlResults = [];
  for (let round = 0; round < 3; round++) {
    dlResults.push(...await Promise.allSettled([
      pipeline.ingestLogs(dlBatch(BGP_LINE, PANIC_LINE), 'dl-a', DEFAULT_ORG_ID),
      pipeline.ingestLogs(dlBatch(PANIC_LINE, BGP_LINE), 'dl-b', DEFAULT_ORG_ID),
      pipeline.ingestLogs(dlBatch(BGP_LINE, PANIC_LINE), 'dl-c', DEFAULT_ORG_ID),
      pipeline.ingestLogs(dlBatch(PANIC_LINE, BGP_LINE), 'dl-d', DEFAULT_ORG_ID),
    ]));
  }
  const dlFailed = dlResults.filter((r) => r.status === 'rejected');
  chk('concurrent batches about ONE device in opposing orders do not deadlock',
    dlFailed.length === 0,
    `${dlFailed.length}/${dlResults.length} rejected: ${dlFailed.slice(0, 2).map((r) => String(r.reason && r.reason.message).slice(0, 60)).join(' | ')}`);
  chk('…and every line of every batch landed, none rolled back',
    dlResults.filter((r) => r.status === 'fulfilled').every((r) => r.value.accepted === 50),
    JSON.stringify(dlResults.map((r) => (r.status === 'fulfilled' ? r.value.accepted : 'REJECTED')).slice(0, 6)));

  report();
}

main().catch(die);
