'use strict';
/* The managed syslog gateway: whose logs are these, and how could that go wrong.
 *
 * Hermetic: throwaway database, own port (3171), no network. The gateway is the
 * REAL binary — `collector/opscat-collector.js` with `OPSCAT_GATEWAY=1`, run as
 * a child process against a self-signed certificate this file mints — and it is
 * driven exactly the way a customer's relay drives it: RFC 5424 frames over a
 * TLS socket. Nothing here stubs the thing under test.
 *
 * ── Why this file exists at all ─────────────────────────────────────────────
 *
 * Every other ingest path in this product answers "whose logs are these?" from
 * a credential that arrived in an HTTP header, checked by one guard in
 * `security.js` that six harnesses already lean on. The managed endpoint is the
 * first path where the answer comes out of the MESSAGE — a token in RFC 5424
 * structured data, the shape Better Stack, Mezmo and Sumo Logic all use — and
 * is decided by a program running outside the server, on a socket open to the
 * internet, before any of that machinery is reached.
 *
 * So the property that has to be proven is not "a line arrives". It is:
 *
 *   **two tenants sharing one TCP connection do not bleed into each other.**
 *
 * That is what section 2 does: one socket, interleaved frames for two different
 * organisations, and each org's lines asserted present in its own store AND
 * absent from the other's. Both halves — a router that sends everything to the
 * first token it saw passes the "present" half perfectly.
 *
 * ── The failures that are silent, which is why they are checks ──────────────
 *
 *   * **A credential in the log store.** The token travels inside every
 *     message, so the ONE thing that must not happen is it being stored as part
 *     of the line — where it is readable by every analyst in the org, exportable
 *     and searchable. It is not, because `toIngestEntry` builds the line out of
 *     APP-NAME and MSG and never reads structured data. That is a property of
 *     code that could be refactored tomorrow, not a law, so section 3 asserts
 *     the absence directly.
 *   * **A cleartext listener.** In gateway mode the key is in the message, so a
 *     UDP or plain-TCP port would hand a write credential for someone's logs to
 *     everyone on the path. Section 6 asserts those ports are not open — an
 *     assertion about something NOT existing, which no functional test would
 *     ever produce as a side effect.
 *   * **A key in the gateway's own environment.** A copied unit file or a
 *     misread doc, and every message that failed to carry its own token gets
 *     silently ingested into whichever org that key belongs to. The process
 *     refuses to start; section 7 pins the exit code.
 *   * **No certificate.** In collector mode a missing cert is a degradation and
 *     the right one — UDP and TCP keep working. In gateway mode TLS is the only
 *     listener, so the same silence is a box that accepts connections from
 *     nobody while looking perfectly healthy. It exits instead.
 *   * **An unbounded tenant map.** The token is attacker-chosen. Without a cap,
 *     a flood of random ones is a queue per token and the process dies of
 *     memory — with no error attributable to anything.
 *
 * ── One thing that is deliberately NOT pinned to its spelling ───────────────
 *
 * The private enterprise number. `[opscat@0 …]` and `[opscat@32473 …]` must both
 * route, because ours is applied for and not yet assigned: the day it changes,
 * every relay already configured has to keep working. Section 4 sends both.
 *
 *   cd server && node run-e2e.js gateway
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const tls = require('tls');
const path = require('path');
const dgram = require('dgram');
const { execFileSync } = require('child_process');
const { spawn } = require('child_process');

const { chk, untilAsync, report, onExit, die } = require('./e2e-lib').harness();

// Environment BEFORE any src/ require — config.js and db.js are singletons.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opscat-gateway-'));
process.env.OPSCAT_DATA_DIR = tmp;
onExit(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.OPSCAT_SECRET = 'e2e-gateway-secret';
process.env.PORT = '3171';
process.env.OPSCAT_EDITION = 'cloud';
process.env.OPSCAT_BASE_URL = 'http://127.0.0.1:3171';
/* The instance under test HAS a managed endpoint — without this the API refuses
 * `mode: 'managed'` outright, which is itself a check further down (section 8
 * re-reads config with it cleared). */
process.env.OPSCAT_SYSLOG_HOST = 'syslog.e2e.test';
process.env.OPSCAT_SYSLOG_PORT = '6514';
process.env.OPSCAT_SYSLOG_PEN = '0';
process.env.OPSCAT_ADMIN_EMAIL = 'seed-admin@e2e.test';
process.env.OPSCAT_ADMIN_PASSWORD = 'seed-admin-password-1';
// Creating a user mails an activation link; no transport may be configured here.
delete process.env.RESEND_API_KEY;
delete process.env.SMTP_HOST;

require('./src/index.js'); // boots the app on :3171

const { addMembership } = require('./src/db');
const q = require('./src/db/shim');
const { hashPassword, now, newId } = require('./src/util');
const logStore = require('./src/db/log-store');

const BASE = 'http://127.0.0.1:3171';
const PASS = 'e2e-user-password-1';
const GW_PORT = 6614;          // the gateway's TLS port for this run
const GW_UDP = 6615;           // ports it must NOT open
const GW_TCP = 6616;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ── fixtures ────────────────────────────────────────────────────────────────
async function mkOrg(name, plan) {
  const id = newId();
  await q.prepare(`INSERT INTO organizations (id, name, slug, plan, status, created_at)
    VALUES (?, ?, ?, ?, 'active', ?)`).run(id, name, name.toLowerCase(), plan, now());
  return id;
}
async function mkUser(email, role, orgId) {
  const { salt, hash } = hashPassword(PASS);
  const uid = newId();
  await q.prepare(`INSERT INTO users (id, org_id, email, name, role, is_super_admin, pass_salt, pass_hash,
      color, active, must_change_password, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, '#388bfd', 1, 0, ?)`)
    .run(uid, orgId, email, email.split('@')[0], role, salt, hash, now());
  await addMembership(uid, orgId, role);
  return email;
}
async function login(email) {
  for (let i = 0; i < 40; i++) {
    let r;
    try {
      r = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: PASS }),
      });
    } catch { await sleep(50); continue; }
    if (r.status === 429) { await sleep(1000); continue; }
    const j = await r.json().catch(() => null);
    return { cookie: (r.headers.get('set-cookie') || '').split(';')[0], csrf: j && j.csrf };
  }
  throw new Error(`login for ${email} stayed rate-limited`);
}
async function call(sess, method, p, body) {
  for (let i = 0; i < 40; i++) {
    const headers = sess ? { cookie: sess.cookie } : {};
    if (method !== 'GET') {
      if (sess) headers['X-OpsCat-CSRF'] = sess.csrf;
      headers['Content-Type'] = 'application/json';
    }
    const r = await fetch(BASE + p, {
      method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => null);
    if (r.status === 429) { await sleep(300); continue; }
    return { status: r.status, j };
  }
  throw new Error(`${method} ${p} stayed rate-limited`);
}
/* Nothing may touch the database before boot has finished. `require` returns
 * while `boot()` is still seeding, and seeding creates the default organisation
 * only when the table is EMPTY — so a fixture org inserted a millisecond too
 * early makes the seed skip it, and the run dies on a foreign key half a second
 * later with an error that names none of this. */
async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch { /* not yet */ }
    await sleep(100);
  }
  return false;
}

const linesWith = async (orgId, term) => (await logStore.search({
  orgId, since: 0, until: now() + 60000, term, limit: 50,
})).length;

// ── the gateway under test ──────────────────────────────────────────────────
/* Two files and nothing else, which is also what `install.sh` copies and what
 * the Dockerfile puts in the image: if this directory is not enough to run the
 * program, the packaging is wrong and every one of those three is wrong with
 * it. `syslog.js` is `server/src/lib/syslog.js` verbatim — the one-parser rule. */
const gwDir = path.join(tmp, 'gw');
fs.mkdirSync(gwDir);
fs.copyFileSync(path.join(__dirname, '..', 'collector', 'opscat-collector.js'),
  path.join(gwDir, 'opscat-collector.js'));
fs.copyFileSync(path.join(__dirname, 'src', 'lib', 'syslog.js'), path.join(gwDir, 'syslog.js'));
const GW_JS = path.join(gwDir, 'opscat-collector.js');

/* A certificate generated per run rather than committed. An embedded fixture
 * has an expiry date, and a harness that goes red on a calendar day is a harness
 * people learn to re-run instead of read. */
let haveOpenssl = true;
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', path.join(tmp, 'gw.key'), '-out', path.join(tmp, 'gw.crt'),
    '-days', '2', '-subj', '/CN=syslog.e2e.test'], { stdio: 'ignore' });
} catch { haveOpenssl = false; }

/** Start the gateway. Resolves once it says it is listening (or exits). */
function startGateway(extraEnv = {}, expectExit = false) {
  const env = Object.assign({}, process.env, {
    OPSCAT_GATEWAY: '1',
    OPSCAT_URL: BASE,
    OPSCAT_TLS_PORT: String(GW_PORT),
    OPSCAT_UDP_PORT: String(GW_UDP),
    OPSCAT_TCP_PORT: String(GW_TCP),
    OPSCAT_TLS_CERT: path.join(tmp, 'gw.crt'),
    OPSCAT_TLS_KEY: path.join(tmp, 'gw.key'),
    // Ship promptly; the harness waits on the store, not on a fixed sleep.
    OPSCAT_POLL_MS: '2000',
    // The counters are asserted on, so they may not be a minute apart here.
    OPSCAT_REPORT_MS: '500',
    /* Every claim below is waited for rather than slept through, so the cadence
     * only decides how long the harness sits still — 2s per barrier is most of
     * a minute across the file. It is the shipper's interval, not a timeout, so
     * turning it down changes latency and nothing else. */
    OPSCAT_FLUSH_MS: '200',
  }, extraEnv);
  delete env.OPSCAT_COLLECTOR_KEY;
  if (extraEnv.OPSCAT_COLLECTOR_KEY) env.OPSCAT_COLLECTOR_KEY = extraEnv.OPSCAT_COLLECTOR_KEY;
  const child = spawn(process.execPath, [GW_JS], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { text: '', code: null };
  child.stdout.on('data', (b) => { out.text += b.toString(); });
  child.stderr.on('data', (b) => { out.text += b.toString(); });
  child.on('exit', (c) => { out.code = c; });
  onExit(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } });
  return new Promise((res) => {
    const t = setInterval(() => {
      if (out.code !== null || /listening tls/.test(out.text)) { clearInterval(t); res({ child, out }); }
    }, 25);
    if (expectExit) setTimeout(() => { clearInterval(t); res({ child, out }); }, 4000).unref?.();
  });
}

/** One RFC 5424 frame, LF-framed, as rsyslog's omfwd sends by default. */
function frame(token, host, msg, pen = '0') {
  const sd = token ? `[opscat@${pen} token="${token}"]` : '-';
  return `<134>1 ${new Date().toISOString()} ${host} e2e - - ${sd} ${msg}\n`;
}

// ── the run ─────────────────────────────────────────────────────────────────
(async () => {
  if (!haveOpenssl) {
    console.log('!! openssl is not on PATH — the gateway itself was NOT exercised. '
      + 'Only the server-side mode checks ran.');
  }

  chk('server boots and answers /api/health', await waitForServer());

  const ACME = await mkOrg('AcmeGw', 'pro');
  const GLOBEX = await mkOrg('GlobexGw', 'pro');
  const acmeLead = await mkUser('lead@acme-gw.test', 'lead', ACME);
  const globexLead = await mkUser('lead@globex-gw.test', 'lead', GLOBEX);
  const acme = await login(acmeLead);
  const globex = await login(globexLead);

  // ── 1. the endpoint records its mode, and refuses one it cannot render ────
  const mk = async (sess, name, mode, extra = {}) =>
    call(sess, 'POST', '/api/syslog/endpoints', Object.assign({ name, mode }, extra));

  const a = await mk(acme, 'Acme FRA', 'managed', { devicePrefix: 'fra-' });
  chk('a managed endpoint is created', a.status === 200 && a.j && a.j.mode === 'managed');
  chk('...and returns its key exactly once', typeof a.j.key === 'string' && a.j.key.startsWith('ocl_'));
  const g = await mk(globex, 'Globex BER', 'managed');
  chk('a second org gets its own endpoint', g.status === 200 && typeof g.j.key === 'string');
  chk('...with a different key', g.j.key !== a.j.key);

  const c = await mk(acme, 'Acme collector site', 'collector');
  chk('a collector endpoint is still the default shape',
    c.status === 200 && c.j.mode === 'collector');
  const bad = await mk(acme, 'Nonsense', 'satellite');
  chk('an unknown mode is refused', bad.status === 400);

  /* The managed snippets are the configuration a customer PASTES, so what is in
   * them is the feature. Three things have to be true at once or the paste does
   * nothing: the key is in the structured data, the transport is TLS, and the
   * host is the one this instance actually runs. */
  const snips = a.j.snippets;
  chk('managed renders rsyslog and syslog-ng', !!snips.rsyslog && !!snips['syslog-ng']);
  chk('...and no collector install blocks', !snips.docker && !snips.systemd);
  const rsy = snips.rsyslog[0].text;
  chk('the rsyslog template carries the key in structured data',
    rsy.includes(`[opscat@0 token=\\"${a.j.key}\\"]`));
  chk('...names this instance\'s gateway', rsy.includes('syslog.e2e.test') && rsy.includes('6514'));
  chk('...verifies the peer rather than only encrypting',
    rsy.includes('StreamDriverAuthMode="x509/name"'));
  chk('...and still queues to disk across an outage',
    rsy.includes('queue.filename="opscat_fwd"') && rsy.includes('action.resumeRetryCount="-1"'));
  /* A `-` from rsyslog's %STRUCTURED-DATA% followed by our element is not valid
   * RFC 5424 and the token would never be seen. The template must SUBSTITUTE. */
  chk('the template substitutes structured data rather than appending to it',
    !rsy.includes('%STRUCTURED-DATA%'));
  chk('the collector endpoint renders the collector flavours instead',
    !!c.j.snippets.docker && !!c.j.snippets.systemd && !c.j.snippets.test);

  // The config endpoint never re-hands the key, in either mode.
  const cfgA = await call(acme, 'GET', `/api/syslog/endpoints/${a.j.id}/config`);
  chk('re-reading a managed configuration renders a placeholder, not the key',
    cfgA.status === 200 && !JSON.stringify(cfgA.j).includes(a.j.key));
  chk('...and is still the managed flavour set', !!cfgA.j.rsyslog && !cfgA.j.docker);

  // Switching mode keeps the key: the same credential authenticates both paths.
  const sw = await call(acme, 'PATCH', `/api/syslog/endpoints/${c.j.id}`, { mode: 'managed' });
  chk('an endpoint can be switched to managed', sw.status === 200 && sw.j.mode === 'managed');
  const swBack = await call(acme, 'PATCH', `/api/syslog/endpoints/${c.j.id}`, { mode: 'collector' });
  chk('...and back', swBack.status === 200 && swBack.j.mode === 'collector');
  /* COALESCE: a PATCH that names only `enabled` must not reset the mode to its
   * default. This is the same partial-update trap the device prefix has. */
  await call(acme, 'PATCH', `/api/syslog/endpoints/${a.j.id}`, { enabled: false });
  const still = await call(acme, 'GET', '/api/syslog/endpoints');
  chk('a PATCH that names only `enabled` leaves the mode alone',
    still.j.find((e) => e.id === a.j.id).mode === 'managed');
  await call(acme, 'PATCH', `/api/syslog/endpoints/${a.j.id}`, { enabled: true });

  if (!haveOpenssl) { report(); return; }

  // ── 2. two tenants, one connection ───────────────────────────────────────
  const { child: gw, out } = await startGateway();
  chk('the gateway starts and listens on TLS', /listening tls/.test(out.text));
  chk('...and says nothing about udp or plain tcp', !/listening udp|listening tcp/.test(out.text));

  const sock = tls.connect({ host: '127.0.0.1', port: GW_PORT, rejectUnauthorized: false });
  await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
  onExit(() => sock.destroy());

  /* Interleaved on ONE socket. A gateway that keyed its routing off the
   * connection instead of the message would put all four lines in one org and
   * pass every "the line arrived" check ever written. */
  sock.write(frame(a.j.key, 'core-sw-01', 'acme alpha marker'));
  sock.write(frame(g.j.key, 'core-sw-02', 'globex bravo marker'));
  sock.write(frame(a.j.key, 'core-sw-01', 'acme charlie marker'));
  sock.write(frame(g.j.key, 'core-sw-02', 'globex delta marker'));

  await untilAsync(async () => (await linesWith(ACME, 'acme charlie marker')) > 0
    && (await linesWith(GLOBEX, 'globex delta marker')) > 0, 20000);
  chk('acme\'s lines reach acme', (await linesWith(ACME, 'acme alpha marker')) === 1);
  chk('globex\'s lines reach globex', (await linesWith(GLOBEX, 'globex bravo marker')) === 1);
  // The half that a broken router still passes is above; this is the half it fails.
  chk('globex sees NONE of acme\'s lines', (await linesWith(GLOBEX, 'acme alpha marker')) === 0);
  chk('acme sees NONE of globex\'s lines', (await linesWith(ACME, 'globex bravo marker')) === 0);

  /* The device prefix is the endpoint's, applied to the tenant it belongs to —
   * and applied at SHIP time rather than at parse time, so a tenant's very
   * first messages (which arrive before its configuration has been fetched)
   * are named the same as every line after them. */
  const acmeRows = await logStore.search({
    orgId: ACME, since: 0, until: now() + 60000, term: 'acme alpha marker', limit: 5,
  });
  chk('the endpoint\'s device prefix is applied', acmeRows[0].device === 'fra-core-sw-01');
  const globexRows = await logStore.search({
    orgId: GLOBEX, since: 0, until: now() + 60000, term: 'globex bravo marker', limit: 5,
  });
  chk('...and only to the endpoint that has one', globexRows[0].device === 'core-sw-02');
  chk('the sending device\'s own hostname survives, not the relay\'s',
    globexRows[0].device === 'core-sw-02');

  // ── 3. the credential must not become a log line ─────────────────────────
  /* The token is inside every message. If any of it reached the stored line it
   * would be readable by every analyst in the org, exportable, and searchable —
   * a write credential for the org's logs, sitting in the org's logs. */
  chk('no stored line contains the token', (await linesWith(ACME, a.j.key)) === 0);
  chk('...not even its prefix beyond what a key list already shows',
    !acmeRows.some((r) => String(r.line).includes(a.j.key.slice(0, 20))));
  chk('the structured data is not stored at all',
    !acmeRows.some((r) => String(r.line).includes('opscat@')));
  chk('the line is exactly what the device sent', acmeRows[0].line === 'e2e: acme alpha marker');

  // ── 4. the enterprise number is not the identifier ───────────────────────
  sock.write(frame(a.j.key, 'core-sw-03', 'pen thirtytwo marker', '32473'));
  sock.write(frame(a.j.key, 'core-sw-03', 'pen assigned marker', '59321'));
  await untilAsync(async () => (await linesWith(ACME, 'pen assigned marker')) > 0, 20000);
  chk('a message with a different PEN routes identically',
    (await linesWith(ACME, 'pen thirtytwo marker')) === 1);
  chk('...and so does one with the number we may be assigned',
    (await linesWith(ACME, 'pen assigned marker')) === 1);

  // ── 5. messages nobody can be billed for ─────────────────────────────────
  const before = { a: await linesWith(ACME, 'marker'), g: await linesWith(GLOBEX, 'marker') };
  sock.write(frame(null, 'stranger-01', 'no token marker'));
  sock.write(frame('ocl_' + 'f'.repeat(48), 'stranger-02', 'wrong token marker'));
  sock.write(frame('not-a-token-at-all', 'stranger-03', 'malformed token marker'));
  /* A SENTINEL rather than a sleep. It is written last on the same socket, so
   * its arrival proves the three above were read, parsed and decided on — where
   * a fixed wait proves only that a number of milliseconds passed, and answers
   * "was it long enough?" differently on a loaded CI runner than here. */
  sock.write(frame(a.j.key, 'core-sw-01', 'sentinel after strangers marker'));
  await untilAsync(async () => (await linesWith(ACME, 'sentinel after strangers marker')) > 0, 20000);
  chk('a message with no token is written nowhere',
    (await linesWith(ACME, 'no token marker')) === 0
    && (await linesWith(GLOBEX, 'no token marker')) === 0);
  chk('a well-formed but unknown token is written nowhere',
    (await linesWith(ACME, 'wrong token marker')) === 0
    && (await linesWith(GLOBEX, 'wrong token marker')) === 0);
  chk('a malformed token is written nowhere',
    (await linesWith(ACME, 'malformed token marker')) === 0);
  chk('...and no tenant gained a line beyond the sentinel',
    (await linesWith(ACME, 'marker')) === before.a + 1
    && (await linesWith(GLOBEX, 'marker')) === before.g);
  /* A refused key is REMEMBERED. Without the negative cache every message from
   * a relay whose key was rotated is a fresh HTTPS round trip, forever — which
   * is a self-inflicted flood, from a sender who thinks they are configured. */
  await untilAsync(async () => /refused — ignoring it/.test(out.text), 15000);
  chk('the gateway says once that it is ignoring the refused key',
    (out.text.match(/refused — ignoring it/g) || []).length === 1);
  chk('...and stays alive, unlike a collector whose own key was revoked',
    gw.exitCode === null);

  // The working tenants are unaffected by all of that.
  sock.write(frame(a.j.key, 'core-sw-01', 'still working marker'));
  await untilAsync(async () => (await linesWith(ACME, 'still working marker')) > 0, 20000);
  chk('a known tenant still ships after a stranger has been refused', true);

  // ── 6. no cleartext listener ─────────────────────────────────────────────
  /* An assertion about a port that must NOT be open. Nothing a functional test
   * does would ever produce it as a side effect, and the thing it guards — a
   * write credential travelling in clear — has no symptom on our side at all. */
  const closed = await new Promise((res) => {
    const s = net.connect({ host: '127.0.0.1', port: GW_TCP });
    s.on('connect', () => { s.destroy(); res(false); });
    s.on('error', () => res(true));
  });
  chk('gateway mode opens no plain TCP listener', closed);
  const udpQuiet = await new Promise((res) => {
    const s = dgram.createSocket('udp4');
    s.send(Buffer.from(frame(a.j.key, 'udp-01', 'udp marker')), GW_UDP, '127.0.0.1', () => {
      setTimeout(() => { s.close(); res(true); }, 200);
    });
  });
  chk('a UDP datagram to the gateway is sent into nothing', udpQuiet);
  sock.write(frame(a.j.key, 'core-sw-01', 'sentinel post datagram marker'));
  await untilAsync(async () => (await linesWith(ACME, 'sentinel post datagram marker')) > 0, 20000);
  chk('...and lands in no org', (await linesWith(ACME, 'udp marker')) === 0);

  gw.kill('SIGKILL');

  // ── 7. the two ways it must refuse to start ──────────────────────────────
  const withKey = await startGateway({ OPSCAT_COLLECTOR_KEY: a.j.key }, true);
  chk('a gateway with a key of its own refuses to start', withKey.out.code === 2);
  chk('...and says why', /must NOT be set in gateway mode/.test(withKey.out.text));

  const noCert = await startGateway({ OPSCAT_TLS_CERT: path.join(tmp, 'nope.crt') }, true);
  chk('a gateway with no readable certificate refuses to start', noCert.out.code === 4);
  chk('...loudly, rather than listening on nothing',
    /FATAL: gateway mode needs a readable certificate/.test(noCert.out.text));

  // ── 8. the tenant map is bounded ─────────────────────────────────────────
  /* The token is chosen by whoever opened the socket. One queue per token with
   * no cap is a memory exhaustion that costs an attacker one packet each. */
  const capped = await startGateway({ OPSCAT_MAX_TENANTS: '1' });
  chk('the capped gateway starts', /listening tls/.test(capped.out.text));
  const s2 = tls.connect({ host: '127.0.0.1', port: GW_PORT, rejectUnauthorized: false });
  await new Promise((res, rej) => { s2.once('secureConnect', res); s2.once('error', rej); });
  s2.write(frame(a.j.key, 'core-sw-01', 'capped first marker'));
  await untilAsync(async () => (await linesWith(ACME, 'capped first marker')) > 0, 20000);
  s2.write(frame(g.j.key, 'core-sw-02', 'capped second marker'));
  s2.write(frame(a.j.key, 'core-sw-01', 'capped sentinel marker'));   // same barrier
  await untilAsync(async () => (await linesWith(ACME, 'capped sentinel marker')) > 0, 20000);
  chk('the first tenant through the cap works', (await linesWith(ACME, 'capped first marker')) === 1);
  chk('the one past it is dropped rather than queued',
    (await linesWith(GLOBEX, 'capped second marker')) === 0);
  await untilAsync(async () => /tokens past the cap/.test(capped.out.text), 5000);
  chk('...and counted out loud, never silently discarded',
    /tokens past the cap/.test(capped.out.text));
  s2.destroy();
  capped.child.kill('SIGKILL');

  report();
})().catch(die);
