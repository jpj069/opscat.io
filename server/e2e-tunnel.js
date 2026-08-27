'use strict';
/* The syslog tunnel: the address IS the identity, and everything that follows.
 *
 * Hermetic: throwaway database, own port (3173), no network, no kernel. The
 * gateway is the REAL binary — `collector/opscat-collector.js` with
 * `OPSCAT_TUNNEL=1` — driven the way a relay drives it, over UDP and TCP.
 *
 * ── The trick that makes this testable at all ───────────────────────────────
 *
 * A WireGuard interface needs a kernel module, a key pair and root. None of
 * that is available here and none of it is what goes wrong. What goes wrong is
 * the ATTRIBUTION: a packet arrives from an inner address and something decides
 * whose logs it becomes. So the pool is `127.0.0.0/8` for this run, the gateway
 * binds `127.0.0.1`, and the harness sends from `127.0.0.2` and `127.0.0.3` by
 * binding its own sockets to those addresses — which Linux allows for the whole
 * loopback range. The packets then have genuinely different source addresses,
 * travelling through the real listener into the real attribution path.
 *
 * What that does NOT cover is stated rather than implied: the WireGuard data
 * plane itself — that the kernel really does drop a packet whose source is not
 * in the sending peer's AllowedIPs. That is the property the whole mode rests
 * on, it belongs to WireGuard rather than to us, and no harness of ours can
 * assert it. What we can assert is that we never trust an address we were not
 * supposed to, which is section 2.
 *
 * ── Why the binding refusal is the first section ────────────────────────────
 *
 * Attribution by source address is only sound because something upstream
 * verified the address. Bound to `0.0.0.0` the identical code would apply that
 * trust to packets from the internet, and anyone could pick an inner address
 * and write into that tenant's logs by spoofing a UDP source. It is one line of
 * configuration between "correct" and "open relay into any customer's logs",
 * with no symptom in between — so the process refuses to start rather than
 * defaulting, and that refusal is checked before anything else.
 *
 *   cd server && node run-e2e.js tunnel
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const dgram = require('dgram');
const { spawn } = require('child_process');

const { chk, untilAsync, report, onExit, die } = require('./e2e-lib').harness();

// Environment BEFORE any src/ require — config.js and db.js are singletons.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opscat-tunnel-'));
process.env.OPSCAT_DATA_DIR = tmp;
onExit(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.OPSCAT_SECRET = 'e2e-tunnel-secret';
process.env.PORT = '3173';
process.env.OPSCAT_EDITION = 'cloud';
process.env.OPSCAT_BASE_URL = 'http://127.0.0.1:3173';
/* Loopback as the inner network — see the header. `wg.serverIp` makes 127.0.0.1
 * ours and allocation starts at 127.0.0.2, which are addresses this machine
 * genuinely owns and can send from. */
process.env.OPSCAT_TUNNEL_NET = '127.0.0.0/8';
process.env.OPSCAT_TUNNEL_ENDPOINT = 'wg.e2e.test:51820';
process.env.OPSCAT_TUNNEL_PUBKEY = 'oVxLPq9K3sZ8YbN1mT4uJhR7cW2dF6gA0iE5nQpXsUk=';
process.env.OPSCAT_TUNNEL_GATEWAY_KEY = 'oct_e2e_tunnel_gateway_key_0123456789abcdef';
process.env.OPSCAT_ADMIN_EMAIL = 'seed-admin@e2e.test';
process.env.OPSCAT_ADMIN_PASSWORD = 'seed-admin-password-1';
delete process.env.RESEND_API_KEY;
delete process.env.SMTP_HOST;

require('./src/index.js'); // boots the app on :3173

const { addMembership } = require('./src/db');
const q = require('./src/db/shim');
const { hashPassword, now, newId } = require('./src/util');
const logStore = require('./src/db/log-store');
const wgLib = require('./src/lib/wireguard');

const BASE = 'http://127.0.0.1:3173';
const GW_KEY = process.env.OPSCAT_TUNNEL_GATEWAY_KEY;
const PASS = 'e2e-user-password-1';
const UDP_PORT = 6714;
const TCP_PORT = 6715;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
/** A real 32-byte WireGuard-shaped key, generated rather than pasted. */
const peerKey = () => require('crypto').randomBytes(32).toString('base64');

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
/** As the tunnel gateway would call it. */
async function asGateway(method, p, body, key = GW_KEY) {
  const r = await fetch(BASE + p, {
    method,
    headers: Object.assign({ 'content-type': 'application/json' },
      key === null ? {} : { authorization: `Bearer ${key}` }),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, j: await r.json().catch(() => null) };
}
const linesWith = async (orgId, term) => (await logStore.search({
  orgId, since: 0, until: now() + 60000, term, limit: 50,
})).length;

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch { /* not yet */ }
    await sleep(100);
  }
  return false;
}

// ── the gateway under test ──────────────────────────────────────────────────
const gwDir = path.join(tmp, 'gw');
fs.mkdirSync(gwDir);
fs.copyFileSync(path.join(__dirname, '..', 'collector', 'opscat-collector.js'),
  path.join(gwDir, 'opscat-collector.js'));
fs.copyFileSync(path.join(__dirname, 'src', 'lib', 'syslog.js'), path.join(gwDir, 'syslog.js'));
const GW_JS = path.join(gwDir, 'opscat-collector.js');

/* A stub `wg`, so the reconcile drives a REAL argv rather than a mock. It
 * records every invocation and answers `show <if> peers` from a file the
 * harness controls — which is what lets section 5 assert that a peer the
 * server no longer lists is actually removed, on a machine with no WireGuard. */
const WG_LOG = path.join(tmp, 'wg.log');
const WG_PEERS = path.join(tmp, 'wg.peers');
const WG_STUB = path.join(tmp, 'wg-stub.sh');
fs.writeFileSync(WG_PEERS, '');
fs.writeFileSync(WG_STUB, `#!/bin/sh\necho "$@" >> ${WG_LOG}\n`
  + `if [ "$1" = "show" ] && [ "$3" = "peers" ]; then cat ${WG_PEERS}; fi\nexit 0\n`);
fs.chmodSync(WG_STUB, 0o755);
const wgRan = () => (fs.existsSync(WG_LOG) ? fs.readFileSync(WG_LOG, 'utf8').split('\n').filter(Boolean) : []);

function startTunnel(extraEnv = {}, expectExit = false) {
  const env = Object.assign({}, process.env, {
    OPSCAT_TUNNEL: '1',
    OPSCAT_URL: BASE,
    OPSCAT_BIND: '127.0.0.1',
    OPSCAT_UDP_PORT: String(UDP_PORT),
    OPSCAT_TCP_PORT: String(TCP_PORT),
    OPSCAT_WG_BIN: WG_STUB,
    OPSCAT_TUNNEL_IF: 'opscat',
    OPSCAT_FLUSH_MS: '200',
    OPSCAT_POLL_MS: '2000',
    OPSCAT_REPORT_MS: '500',
  }, extraEnv);
  delete env.OPSCAT_COLLECTOR_KEY;
  delete env.OPSCAT_GATEWAY;
  for (const [k, v] of Object.entries(extraEnv)) if (v === null) delete env[k]; else env[k] = v;
  const child = spawn(process.execPath, [GW_JS], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { text: '', code: null };
  child.stdout.on('data', (b) => { out.text += b.toString(); });
  child.stderr.on('data', (b) => { out.text += b.toString(); });
  child.on('exit', (c) => { out.code = c; });
  onExit(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } });
  return new Promise((res) => {
    const t = setInterval(() => {
      if (out.code !== null || /listening tcp/.test(out.text)) { clearInterval(t); res({ child, out }); }
    }, 25);
    if (expectExit) setTimeout(() => { clearInterval(t); res({ child, out }); }, 4000).unref?.();
  });
}

const frame = (host, msg) =>
  `<134>1 ${new Date().toISOString()} ${host} e2e - - - ${msg}\n`;

/** One UDP datagram FROM a chosen inner address. */
function sendUdp(from, host, msg) {
  return new Promise((res, rej) => {
    const s = dgram.createSocket('udp4');
    s.bind(0, from, () => {
      s.send(Buffer.from(frame(host, msg)), UDP_PORT, '127.0.0.1', (e) => {
        s.close(); if (e) rej(e); else res();
      });
    });
    s.on('error', rej);
  });
}

// ── the run ─────────────────────────────────────────────────────────────────
(async () => {
  chk('server boots and answers /api/health', await waitForServer());

  const ACME = await mkOrg('AcmeTun', 'pro');
  const GLOBEX = await mkOrg('GlobexTun', 'pro');
  const acme = await login(await mkUser('lead@acme-tun.test', 'lead', ACME));
  const globex = await login(await mkUser('lead@globex-tun.test', 'lead', GLOBEX));

  // ── 1. the peer key, validated as strictly as an SSH key ─────────────────
  const mk = (sess, name, extra) =>
    call(sess, 'POST', '/api/syslog/endpoints', Object.assign({ name, mode: 'tunnel' }, extra));

  chk('a tunnel endpoint without a peer key is refused',
    (await mk(acme, 'no key', {})).status === 400);
  chk('...and a key that is not base64', (await mk(acme, 'junk', { peerPublicKey: 'not-a-key' })).status === 400);
  chk('...and one of the wrong length',
    (await mk(acme, 'short', { peerPublicKey: require('crypto').randomBytes(31).toString('base64') })).status === 400);
  /* The cloud-init lesson: this string is interpolated into two config files, so
   * a "key" carrying a newline writes a directive of its own. */
  const k = peerKey();
  chk('...and one with a newline in it',
    (await mk(acme, 'nl', { peerPublicKey: `${k.slice(0, 43)}\n` })).status === 400);
  chk('...and one with a space', (await mk(acme, 'sp', { peerPublicKey: `${k.slice(0, 43)} ` })).status === 400);
  chk('a real 32-byte key is a real key', wgLib.isPeerKey(k));

  // ── 2. allocation is the tenant boundary ─────────────────────────────────
  const aKey = peerKey();
  const a = await mk(acme, 'Acme HQ', { peerPublicKey: aKey, devicePrefix: 'hq-' });
  chk('a tunnel endpoint is created', a.status === 200 && a.j.mode === 'tunnel');
  chk('...and is given an inner address', a.j.tunnelIp === '127.0.0.2', a.j.tunnelIp);
  chk('...which the response reports back', typeof a.j.tunnelIp === 'string');
  chk('...along with the peer key, which is not a secret', a.j.peerPublicKey === aKey);

  const gKey = peerKey();
  const g = await mk(globex, 'Globex BER', { peerPublicKey: gKey });
  chk('a second org gets the NEXT address', g.j.tunnelIp === '127.0.0.3', g.j.tunnelIp);
  /* The addresses are unique ACROSS organisations, not within one. That is the
   * whole tenant boundary of this path: an address resolves to one endpoint,
   * and the database index rather than any JS is what guarantees it. */
  chk('...so no two endpoints share an address', a.j.tunnelIp !== g.j.tunnelIp);

  /* The gap has to be in the MIDDLE, and getting that wrong is how this check
   * spent its first version testing nothing: delete the HIGHEST address and
   * "lowest free" and "highest plus one" give the same answer, so both
   * implementations pass. Measured — the mutation survived. So: allocate two
   * more, delete the LOWER of them, and demand that hole back. */
  const third = await mk(acme, 'Acme DR', { peerPublicKey: peerKey() });
  const fourth = await mk(acme, 'Acme DR2', { peerPublicKey: peerKey() });
  chk('a third takes 127.0.0.4', third.j.tunnelIp === '127.0.0.4', third.j.tunnelIp);
  chk('a fourth takes 127.0.0.5', fourth.j.tunnelIp === '127.0.0.5', fourth.j.tunnelIp);
  await call(acme, 'DELETE', `/api/syslog/endpoints/${third.j.id}`);
  const fifth = await mk(acme, 'Acme DR again', { peerPublicKey: peerKey() });
  chk('a released address is REUSED rather than the pool marching upwards',
    fifth.j.tunnelIp === '127.0.0.4', fifth.j.tunnelIp);
  await call(acme, 'DELETE', `/api/syslog/endpoints/${fourth.j.id}`);
  await call(acme, 'DELETE', `/api/syslog/endpoints/${fifth.j.id}`);

  // A rename must not move the address: the customer's config file pins it.
  await call(acme, 'PATCH', `/api/syslog/endpoints/${a.j.id}`, { name: 'Acme HQ renamed' });
  const afterRename = (await call(acme, 'GET', '/api/syslog/endpoints')).j.find((x) => x.id === a.j.id);
  chk('a rename leaves the inner address alone', afterRename.tunnelIp === '127.0.0.2');
  chk('...and the peer key', afterRename.peerPublicKey === aKey);

  // ── 3. the snippets carry no credential of ours ──────────────────────────
  const s = a.j.snippets;
  chk('the tunnel renders wireguard, rsyslog and a verify block',
    !!s.wireguard && !!s.rsyslog && !!s.verify);
  const conf = s.wireguard[1].text;
  chk('the interface takes the allocated address', conf.includes('Address = 127.0.0.2/32'));
  chk('...our public key as the peer', conf.includes(`PublicKey = ${process.env.OPSCAT_TUNNEL_PUBKEY}`));
  /* AllowedIPs is where a tunnel quietly becomes a default route. `0.0.0.0/0`
   * would send the relay's ENTIRE traffic through us — not what was asked for,
   * not what we offer, and a thing nobody notices until their egress IP moves. */
  const allowed = conf.split('\n').filter((l) => l.trim().startsWith('AllowedIPs'));
  chk('...and routes ONLY our inner address into the tunnel',
    allowed.length === 1 && allowed[0].trim() === 'AllowedIPs = 127.0.0.1/32', allowed.join('|'));
  chk('...with a keepalive, because the relay is behind NAT',
    conf.includes('PersistentKeepalive = 25'));
  chk('the private key stays a placeholder — we never see it',
    conf.includes('PrivateKey = <the key from step 1'));
  /* There is no token in this mode, so there must be no token in the config.
   * If one appeared it would mean the mode had quietly become the managed one. */
  chk('no collector key appears anywhere in the tunnel configuration',
    !JSON.stringify(s).includes('ocl_'));
  chk('...and neither does the gateway key', !JSON.stringify(s).includes(GW_KEY));
  chk('the relay snippet uses UDP, which is the point of the mode',
    s.rsyslog[0].text.includes('protocol="udp"'));

  // ── 4. the gateway path, and who may use it ──────────────────────────────
  const peers = await asGateway('GET', '/v1/tunnel/peers');
  chk('the gateway can read the peer list', peers.status === 200);
  chk('...which names both orgs\' peers', peers.j.peers.length === 2);
  chk('...as public keys and addresses', peers.j.peers.every((p) => p.ip && p.publicKey));
  /* The design decision this file exists to protect: the gateway is trusted
   * infrastructure, but a stolen gateway credential must not yield every
   * tenant's write key. So the peer list contains nothing secret at all. */
  chk('...and NOTHING secret', !JSON.stringify(peers.j).includes('ocl_'));
  chk('the peer list reports the network too', peers.j.net === '127.0.0.0/8');

  chk('a wrong gateway key is refused',
    (await asGateway('GET', '/v1/tunnel/peers', undefined, 'oct_wrong')).status === 401);
  chk('...and no key at all',
    (await asGateway('GET', '/v1/tunnel/peers', undefined, null)).status === 401);
  /* Length is checked before timingSafeEqual, which THROWS on a mismatch — a
   * 500 here would be a perfectly good oracle for "your guess was the wrong
   * length", which is the one thing a constant-time compare exists to deny. */
  chk('a key of the wrong LENGTH is a 401, not a 500',
    (await asGateway('GET', '/v1/tunnel/peers', undefined, 'x')).status === 401);
  chk('a session cookie is not a gateway credential',
    (await call(acme, 'GET', '/v1/tunnel/peers')).status === 401);

  // ── 5. the interface is reconciled, including removals ───────────────────
  /* A peer left behind after its endpoint was deleted is a tunnel someone can
   * still send through — and its address may later be reallocated to a
   * different organisation. */
  fs.writeFileSync(WG_PEERS, 'STALEPEERKEYTHATNOLONGEREXISTS=\n');
  fs.writeFileSync(WG_LOG, '');
  const tun = await startTunnel();
  chk('the tunnel gateway starts', /listening tcp/.test(tun.out.text), tun.out.text.slice(-400));
  chk('...and says nothing about tls, which has nothing to add inside a tunnel',
    !/listening tls/.test(tun.out.text));
  await untilAsync(async () => wgRan().some((l) => l.includes('remove')), 10000);
  const ran = wgRan();
  chk('it read the interface\'s current peers', ran.some((l) => l === 'show opscat peers'));
  chk('a peer the server no longer lists is REMOVED',
    ran.some((l) => l === 'set opscat peer STALEPEERKEYTHATNOLONGEREXISTS= remove'));
  chk('acme\'s peer is applied with its own address',
    ran.some((l) => l === `set opscat peer ${aKey} allowed-ips 127.0.0.2/32`));
  chk('globex\'s too', ran.some((l) => l === `set opscat peer ${gKey} allowed-ips 127.0.0.3/32`));

  // ── 6. two tenants, told apart by nothing but the address ────────────────
  await sendUdp('127.0.0.2', 'core-sw-01', 'acme tunnel alpha marker');
  await sendUdp('127.0.0.3', 'core-sw-02', 'globex tunnel bravo marker');
  await sendUdp('127.0.0.2', 'core-sw-01', 'acme tunnel charlie marker');
  await untilAsync(async () => (await linesWith(ACME, 'acme tunnel charlie marker')) > 0
    && (await linesWith(GLOBEX, 'globex tunnel bravo marker')) > 0, 20000);
  chk('acme\'s datagram reaches acme', (await linesWith(ACME, 'acme tunnel alpha marker')) === 1);
  chk('globex\'s reaches globex', (await linesWith(GLOBEX, 'globex tunnel bravo marker')) === 1);
  chk('globex sees NONE of acme\'s', (await linesWith(GLOBEX, 'acme tunnel alpha marker')) === 0);
  chk('acme sees NONE of globex\'s', (await linesWith(ACME, 'globex tunnel bravo marker')) === 0);

  const rows = await logStore.search({
    orgId: ACME, since: 0, until: now() + 60000, term: 'acme tunnel alpha marker', limit: 5,
  });
  /* Applied by the SERVER here, unlike every other syslog path — the gateway
   * does not know which endpoint an address belongs to, and telling it would
   * mean shipping it the mapping this design keeps server-side. */
  chk('the device prefix is applied', !!rows[0] && rows[0].device === 'hq-core-sw-01');
  chk('...and the line is what the device sent',
    !!rows[0] && rows[0].line === 'e2e: acme tunnel alpha marker',
    JSON.stringify(rows[0]));

  // TCP through the same attribution path.
  await new Promise((res, rej) => {
    const c = net.connect({ port: TCP_PORT, host: '127.0.0.1', localAddress: '127.0.0.3' }, () => {
      c.write(frame('core-sw-02', 'globex tunnel tcp marker'), () => { c.end(); res(); });
    });
    c.on('error', rej);
  });
  await untilAsync(async () => (await linesWith(GLOBEX, 'globex tunnel tcp marker')) > 0, 20000);
  chk('TCP inside the tunnel is attributed the same way',
    (await linesWith(GLOBEX, 'globex tunnel tcp marker')) === 1);
  chk('...and still does not leak', (await linesWith(ACME, 'globex tunnel tcp marker')) === 0);

  // ── 7. addresses that are not a tenant ───────────────────────────────────
  /* Two different refusals on purpose. Outside the pool means the packet did
   * not come through the tunnel at all — the gateway is bound wrong or
   * something is forging — and that is not the same event as an address inside
   * the pool that simply belongs to nobody. */
  chk('an address outside the pool is refused as a bad request',
    (await asGateway('POST', '/v1/tunnel/logs',
      { sourceIp: '10.99.0.5', logs: [{ device: 'x', line: 'outside pool marker', sev: 5 }] })).status === 400);
  chk('...and the OUR-side address is outside it too',
    (await asGateway('POST', '/v1/tunnel/logs',
      { sourceIp: '127.0.0.1', logs: [{ device: 'x', line: 'server ip marker', sev: 5 }] })).status === 400);
  chk('an unallocated address inside the pool is a 404, a different answer',
    (await asGateway('POST', '/v1/tunnel/logs',
      { sourceIp: '127.9.9.9', logs: [{ device: 'x', line: 'unallocated marker', sev: 5 }] })).status === 404);
  chk('and none of the three wrote a line anywhere',
    (await linesWith(ACME, 'outside pool marker')) === 0
    && (await linesWith(ACME, 'server ip marker')) === 0
    && (await linesWith(GLOBEX, 'unallocated marker')) === 0);

  // ── 8. the disabled switch, and that it is a switch ──────────────────────
  await call(globex, 'PATCH', `/api/syslog/endpoints/${g.j.id}`, { enabled: false });
  const off = await asGateway('POST', '/v1/tunnel/logs',
    { sourceIp: '127.0.0.3', logs: [{ device: 'core-sw-02', line: 'while disabled marker', sev: 5 }] });
  chk('a disabled endpoint refuses its own address', off.status === 403);
  chk('...and nothing was written', (await linesWith(GLOBEX, 'while disabled marker')) === 0);
  await call(globex, 'PATCH', `/api/syslog/endpoints/${g.j.id}`, { enabled: true });
  const on = await asGateway('POST', '/v1/tunnel/logs',
    { sourceIp: '127.0.0.3', logs: [{ device: 'core-sw-02', line: 'after re-enable marker', sev: 5 }] });
  chk('re-enabling takes effect on the next batch, with no restart anywhere',
    on.status === 200);
  await untilAsync(async () => (await linesWith(GLOBEX, 'after re-enable marker')) > 0, 10000);
  chk('...and the line lands', (await linesWith(GLOBEX, 'after re-enable marker')) === 1);

  tun.child.kill('SIGKILL');

  // ── 9. the four ways it must refuse to start ─────────────────────────────
  /* The first is THE one. Attribution by source address is sound only because
   * WireGuard verified the address; bound to every interface the same code
   * would trust a spoofed UDP source from the internet. There is no safe
   * default, so the default is a refusal. */
  const wide = await startTunnel({ OPSCAT_BIND: '0.0.0.0' }, true);
  chk('binding every interface refuses to start', wide.out.code === 2);
  chk('...and says exactly why',
    /must name the tunnel address/.test(wide.out.text));
  const unbound = await startTunnel({ OPSCAT_BIND: null }, true);
  chk('so does no bind address at all — there is no safe default', unbound.out.code === 2);

  const withKey = await startTunnel({ OPSCAT_COLLECTOR_KEY: 'ocl_' + 'a'.repeat(48) }, true);
  chk('a tenant key in a tunnel gateway refuses to start', withKey.out.code === 2);
  const bothModes = await startTunnel({ OPSCAT_GATEWAY: '1' }, true);
  chk('being both gateways at once refuses to start', bothModes.out.code === 2);
  const noKey = await startTunnel({ OPSCAT_TUNNEL_GATEWAY_KEY: null }, true);
  chk('and no gateway key at all', noKey.out.code === 2);

  // ── 10. an instance with no tunnel does not have this door ───────────────
  /* 404 rather than 401: an instance running no gateway should look like one
   * that has never heard of the feature, rather than advertise a locked door. */
  const cfg = require('./src/config');
  const saved = cfg.tunnelGatewayKey;
  cfg.tunnelGatewayKey = '';
  chk('with no gateway key configured, the peer list is a 404',
    (await asGateway('GET', '/v1/tunnel/peers')).status === 404);
  chk('...and so is the ingest endpoint',
    (await asGateway('POST', '/v1/tunnel/logs', { sourceIp: '127.0.0.2', logs: [] })).status === 404);
  cfg.tunnelGatewayKey = saved;

  const savedNet = cfg.tunnelNet;
  cfg.tunnelNet = '';
  chk('an instance with no tunnel network refuses the mode outright',
    (await mk(acme, 'nope', { peerPublicKey: peerKey() })).status === 400);
  cfg.tunnelNet = savedNet;

  // ── 11. org scoping, unchanged by any of this ────────────────────────────
  chk('another org cannot read this endpoint',
    (await call(globex, 'GET', `/api/syslog/endpoints/${a.j.id}/config`)).status === 404);
  chk('...nor patch it',
    (await call(globex, 'PATCH', `/api/syslog/endpoints/${a.j.id}`, { name: 'theirs' })).status === 404);
  chk('...nor delete it',
    (await call(globex, 'DELETE', `/api/syslog/endpoints/${a.j.id}`)).status === 404);

  report();
})().catch(die);
