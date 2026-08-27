#!/usr/bin/env node
'use strict';
/**
 * OpsCat Syslog Collector — receives syslog and ships it to OpsCat over HTTPS.
 *
 * Dependency-free: `dgram`, `net`, `tls` and the global `fetch`, nothing else.
 * The wire-format work lives in `syslog.js`, which the installer fetches from
 * the OpsCat server — it is the same file `server/src/lib/syslog.js` and the
 * same one `e2e-syslog.js` pins, so the parser running inside a customer's
 * network is byte-for-byte the parser that was tested.
 *
 * ── Two modes, one program ──────────────────────────────────────────────────
 *
 *   **collector** (default) — the customer runs it inside their own network,
 *   next to a relay that cannot be modernised. It is old, it belongs to the
 *   network team, and it speaks plain UDP. This process stands next to it and
 *   becomes the one box that talks outward: it terminates TLS, buffers across
 *   an outage, and turns a 2015 installation into something that can reach a
 *   SaaS without being touched itself. One key, from the environment.
 *
 *   **gateway** (`OPSCAT_GATEWAY=1`) — WE run it, on `syslog.<domain>:6514`, so
 *   a customer with an internet-facing relay needs to install nothing at all.
 *   It is multi-tenant: the key travels in each message's structured data
 *   (`[opscat@<PEN> token="ocl_…"]`, the shape Better Stack, Mezmo and Sumo
 *   Logic all use), and the gateway groups by that token and forwards each
 *   group under the token it arrived with. It holds no credential of its own
 *   and can therefore not reach any tenant a sender did not already name.
 *
 * They are one file rather than two because everything between the socket and
 * the HTTP POST — the framer, the bounded queue, the backoff, the drop
 * accounting, the shutdown drain — is the same code, and this repository's
 * recurring lesson is that the second copy is the one that drifts. The modes
 * differ in exactly three things: where the key comes from, which listeners
 * open, and what a refused key means. Keeping it one file also keeps
 * `install.sh` at two files and the image at one entrypoint.
 *
 * ── The rules it follows ────────────────────────────────────────────────────
 *
 *   * **Never lose a line silently.** UDP is lossy by nature and a buffer is
 *     finite, so drops happen — but every one of them is counted and REPORTED
 *     as a log line of its own. A collector that quietly discards is worse than
 *     one that stops.
 *   * **Never buffer without a bound.** Every limit here exists because the
 *     input is unauthenticated network traffic from devices nobody audits. In
 *     gateway mode the input is unauthenticated traffic from the INTERNET, so
 *     the number of tenants tracked is bounded too: without that, a flood of
 *     random tokens is a queue-per-token memory exhaustion.
 *   * **The server decides what it can.** Device prefix and the enabled switch
 *     are polled, not configured locally, so an operator can silence a site
 *     without an SSH session to the customer's relay.
 *
 * Usage:
 *   OPSCAT_URL=https://opscat.io OPSCAT_COLLECTOR_KEY=ocl_… node opscat-collector.js
 *   OPSCAT_GATEWAY=1 OPSCAT_URL=http://app:3000 OPSCAT_TLS_CERT=… node opscat-collector.js
 */
const dgram = require('dgram');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sl = require('./syslog.js');

const env = process.env;
const GATEWAY = env.OPSCAT_GATEWAY === '1';
const TUNNEL = env.OPSCAT_TUNNEL === '1';
const URL_BASE = (env.OPSCAT_URL || '').replace(/\/+$/, '');
const KEY = env.OPSCAT_COLLECTOR_KEY || '';
const BIND = env.OPSCAT_BIND || '0.0.0.0';
const UDP_PORT = num(env.OPSCAT_UDP_PORT, 514);
const TCP_PORT = num(env.OPSCAT_TCP_PORT, 514);
const TLS_PORT = num(env.OPSCAT_TLS_PORT, 6514);
const TLS_CERT = env.OPSCAT_TLS_CERT || '';
const TLS_KEY = env.OPSCAT_TLS_KEY || '';
const TLS_DOMAIN = env.OPSCAT_TLS_DOMAIN || '';
const MAX_QUEUE = num(env.OPSCAT_MAX_QUEUE, 50000);
const MAX_CONNS = num(env.OPSCAT_MAX_CONNS, 512);
const IDLE_MS = num(env.OPSCAT_IDLE_MS, 300000);
const MAX_TENANTS = num(env.OPSCAT_MAX_TENANTS, 1000);
const BAD_KEY_MS = num(env.OPSCAT_BAD_KEY_MS, 600000);
const POLL_MS = num(env.OPSCAT_POLL_MS, 300000);
/* How often the shipper wakes. In COLLECTOR mode the server's answer wins when
 * it has one — one endpoint, one opinion — and this is the fallback until it
 * has replied. A gateway serves many endpoints and cannot take any one of their
 * opinions, so this is the whole answer there. */
const FLUSH_MS = num(env.OPSCAT_FLUSH_MS, 2000);
const CERT_WATCH_MS = num(env.OPSCAT_CERT_WATCH_MS, 60000);
/* How often drops are turned into a log line and the gateway's own counters
 * into a stderr summary. A minute in production; the harness turns it down so
 * that "and it SAID so" can be asserted without a minute of wall clock. */
const REPORT_MS = num(env.OPSCAT_REPORT_MS, 60000);
/* Tunnel mode (stage 3). We run this one too, on the box that terminates
 * WireGuard. There is no token in the message at all: the kernel refuses to
 * carry a packet whose source is not in the sending peer's AllowedIPs, so the
 * inner source ADDRESS is the tenant — which is the only reason plain UDP can
 * be accepted here and cannot be accepted on the public endpoint. */
const TUNNEL_KEY = env.OPSCAT_TUNNEL_GATEWAY_KEY || '';
const TUNNEL_IF = env.OPSCAT_TUNNEL_IF || 'opscat';
const WG_BIN = env.OPSCAT_WG_BIN || 'wg';

/* The SD element carrying the tenant's key. The NAME is ours; the number after
 * the `@` is a private enterprise number, and which one we print is a fact
 * about a registry application rather than about the message — so the gateway
 * matches on the name and ignores the number (`sl.sdParamAny`). See the note on
 * that function: the day the PEN changes, every already-configured relay has to
 * keep working, and it does. */
const SD_NAME = 'opscat';

/* A SHAPE filter, never an authentication decision — the server owns that, and
 * it owns it by hashing, not by looking at the prefix. What this buys is that a
 * flood of arbitrary strings costs a regex rather than an HTTPS round trip and
 * a queue. It is deliberately loose about the middle letter: a credential kind
 * added later must not be silently refused by a gateway nobody redeployed, for
 * the same reason `lib/tokens.js` forbids a `startsWith` in an auth guard. */
const TOKEN_RE = /^oc[a-z]_[A-Za-z0-9_-]{16,128}$/;

function num(v, d) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; }
function log(...a) { console.log(new Date().toISOString(), ...a); }
const DEFAULT_CFG = { devicePrefix: null, enabled: true, batchMax: 500, flushMs: 2000, name: '?' };

// ── one queue per key ───────────────────────────────────────────────────────
/* In collector mode there is exactly one, created at boot from the configured
 * key; in gateway mode one per token seen. Making single-tenant a special case
 * of multi-tenant rather than the other way round is what keeps the shipping
 * path a single implementation. */
/** @type {Map<string, any>} */
const streams = new Map();
let refusedTenants = 0;   // tokens turned away because MAX_TENANTS was reached
let unattributed = 0;     // messages with no usable token — nobody to bill them to
let badKeyDrops = 0;      // messages for a token the server has refused recently

function newStream(token) {
  return {
    token,
    queue: [],
    dropped: 0, received: 0, shipped: 0,
    cfg: Object.assign({}, DEFAULT_CFG),
    polledAt: 0, flushing: false, retryAt: 0, backoffMs: 0, badUntil: 0,
  };
}

/**
 * The stream a token belongs to, creating it on first sight.
 * @returns {any|null} null when the tenant cap is reached — the caller drops.
 */
function streamFor(token) {
  const have = streams.get(token);
  if (have) return have;
  if (streams.size >= MAX_TENANTS) { refusedTenants += 1; return null; }
  const st = newStream(token);
  streams.set(token, st);
  return st;
}

// ── server-side configuration, polled per key ───────────────────────────────
/**
 * @param {any} st
 * @returns {Promise<boolean>} false when the key was REFUSED (401/403).
 */
async function pollConfig(st) {
  st.polledAt = Date.now();
  try {
    const r = await fetch(`${URL_BASE}/v1/collector/config`, {
      headers: { authorization: `Bearer ${st.token}` },
    });
    if (r.status === 401 || r.status === 403) return false;
    if (!r.ok) return true;
    const c = await r.json();
    const was = st.cfg.enabled;
    st.cfg = Object.assign(st.cfg, c);
    if (was !== st.cfg.enabled) {
      log(`endpoint "${st.cfg.name}" ${st.cfg.enabled ? 'enabled' : 'DISABLED'} by the server`);
    }
  } catch (e) {
    log('config poll failed (keeping the previous one):', e.message);
  }
  return true;
}

/**
 * What a refused key means, and it is the one place the two modes genuinely
 * disagree.
 *
 * In COLLECTOR mode the key is the process's whole reason to exist: it was put
 * in an env file by a person, and a refusal means it was rotated or revoked.
 * Retrying forever would turn that into a silent outage, so the process exits
 * loudly and whatever supervises it says so.
 *
 * In GATEWAY mode the key came off the wire, from a sender we do not control. A
 * refusal is an ordinary event — a customer rotated theirs and has not yet
 * updated the relay, or somebody is guessing. Exiting would let any stranger
 * take down the ingest of every tenant on the box with one bad message, so it
 * is remembered as bad for a while and its queue is dropped.
 */
function keyRefused(st) {
  if (!GATEWAY) {
    log('FATAL: the collector key was refused — has it been rotated or revoked?');
    process.exit(3);
  }
  st.badUntil = Date.now() + BAD_KEY_MS;
  badKeyDrops += st.queue.length;
  st.queue.length = 0;
  log(`key ${st.token.slice(0, 12)}… refused — ignoring it for ${Math.round(BAD_KEY_MS / 1000)}s`);
}

// ── receiving ───────────────────────────────────────────────────────────────
function enqueue(st, entry) {
  st.received += 1;
  if (st.queue.length >= MAX_QUEUE) {
    // Drop the OLDEST: during an outage the newest lines are the ones somebody
    // is about to be paged about.
    st.queue.shift();
    st.dropped += 1;
  }
  st.queue.push(entry);
}

function onMessage(raw, peer) {
  if (!raw) return;
  const p = sl.parse(raw);
  let st;
  if (TUNNEL) {
    /* The address, and nothing but the address. There is no token to look for
     * and no header to trust: the packet reached this process through a
     * WireGuard interface, which means the kernel already checked that the
     * sending peer's key owns this source address. `peer` here is that inner
     * address — which is only true because the listeners bind the tunnel
     * address and nothing else (see main()). Bound to 0.0.0.0 the same line
     * would attribute a spoofed packet from the internet, so those two facts
     * are one decision and not two. */
    if (!peer || peer === 'unknown') { unattributed += 1; return; }
    st = streamFor(peer);
    if (!st) return;                                   // tenant cap — already counted
    if (st.badUntil > Date.now()) { badKeyDrops += 1; return; }
  } else if (GATEWAY) {
    const token = sl.sdParamAny(p, SD_NAME, 'token');
    if (!token || !TOKEN_RE.test(token)) { unattributed += 1; return; }
    st = streamFor(token);
    if (!st) return;                                   // tenant cap — already counted
    if (st.badUntil > Date.now()) { badKeyDrops += 1; return; }
  } else {
    st = streams.get(KEY);
  }
  /* The token is NOT stripped here, and it does not need to be: `toIngestEntry`
   * builds the stored line out of APP-NAME and MSG, and structured data is a
   * separate field it does not read. A credential that travelled in the message
   * therefore never reaches the log store — asserted in `e2e-gateway.js`,
   * because "it happens not to be copied" is one refactor away from false. */
  enqueue(st, sl.toIngestEntry(p, { peer }));
}

// ── shipping ────────────────────────────────────────────────────────────────
async function flush(st) {
  if (st.flushing || !st.queue.length) return;
  if (!st.cfg.enabled) return;                 // the server said stop; keep buffering
  st.flushing = true;
  try {
    const batch = st.queue.splice(0, st.cfg.batchMax || 500);
    /* The device prefix is applied HERE and not where the line was parsed, so
     * that it is always the prefix the server currently says — a batch that sat
     * in the queue through an outage, or through an operator changing it, ships
     * under the new one. In gateway mode it also removes an ordering problem
     * outright: a tenant's first messages arrive before its configuration has
     * been fetched, and prefixing at parse time would have named those devices
     * differently from every line after them.
     *
     * `batch` itself stays unprefixed, because a 429 puts it BACK on the queue
     * and a prefix applied to the stored objects would be applied again on the
     * next attempt. */
    const pfx = st.cfg.devicePrefix || '';
    const logs = pfx ? batch.map((e) => Object.assign({}, e, { device: pfx + e.device })) : batch;
    /* The two paths differ in what the batch SAYS IT IS, and that is the whole
     * of the tunnel's credential design. A collector or a managed tenant proves
     * itself with the endpoint's own key. The tunnel gateway has no tenant key —
     * deliberately, so that stealing it does not yield every customer's write
     * credential — and instead asserts the inner address it saw, which the
     * server resolves. The prefix is applied server-side there for the same
     * reason: we do not know which endpoint this is. */
    const r = await fetch(TUNNEL ? `${URL_BASE}/v1/tunnel/logs` : `${URL_BASE}/v1/collector/logs`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TUNNEL ? TUNNEL_KEY : st.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(TUNNEL ? { sourceIp: st.token, logs } : { logs }),
    });
    if (r.ok) {
      st.shipped += batch.length;
      st.backoffMs = 0;
      st.retryAt = 0;
      return;
    }
    if (r.status === 401 || r.status === 403) {
      /* In TUNNEL mode these two mean different things and only one of them is
       * about this queue. 401 is OUR credential being wrong — the same class of
       * failure as a collector's revoked key, and retrying forever would hide
       * it. 403 is the endpoint being DISABLED, which is an operator silencing
       * a site: back off and keep the lines, exactly as the collector does when
       * the server tells it to stop. */
      if (TUNNEL && r.status === 403) {
        st.queue.unshift(...batch);
        st.backoffMs = Math.min(st.backoffMs ? st.backoffMs * 2 : 5000, 60000);
        st.retryAt = Date.now() + st.backoffMs;
        return;
      }
      if (TUNNEL && r.status === 401) {
        log('FATAL: the tunnel gateway key was refused — check OPSCAT_TUNNEL_GATEWAY_KEY');
        process.exit(3);
      }
      st.dropped += batch.length;
      keyRefused(st);
      return;
    }
    /* An inner address no endpoint holds. The peer was almost certainly deleted
     * and the interface has not been reconciled yet, so the next sweep removes
     * it — until then this stops one stale peer from turning every packet into
     * an HTTPS round trip. */
    if (TUNNEL && r.status === 404) {
      st.dropped += batch.length;
      keyRefused(st);
      return;
    }
    // Any other 4xx means this batch will never be accepted; putting it back
    // would block the queue behind it forever.
    if (r.status === 429 || r.status >= 500) {
      st.queue.unshift(...batch);
      st.backoffMs = Math.min(st.backoffMs ? st.backoffMs * 2 : 1000, 60000);
      st.retryAt = Date.now() + st.backoffMs;
      log(`ship failed (${r.status}) — retrying in ${st.backoffMs}ms, ${st.queue.length} queued`);
    } else {
      st.dropped += batch.length;
      log(`ship refused (${r.status}) — ${batch.length} lines discarded`);
    }
  } catch (e) {
    st.backoffMs = Math.min(st.backoffMs ? st.backoffMs * 2 : 1000, 60000);
    st.retryAt = Date.now() + st.backoffMs;
    log('ship error:', e.message);
  } finally {
    st.flushing = false;
  }
}

/* Losses become a log line of the customer's own, so a drop is visible in the
 * product rather than only in a counter on a box nobody opens. The gateway's
 * own counters — messages nobody can be billed for, tokens past the cap — have
 * no tenant to belong to and can only go to our stderr. */
function reportDrops() {
  const who = TUNNEL ? 'opscat-syslog-tunnel'
    : GATEWAY ? 'opscat-syslog-gateway' : 'opscat-collector';
  for (const st of streams.values()) {
    if (!st.dropped) continue;
    const n = st.dropped;
    st.dropped = 0;
    enqueue(st, {
      device: who,
      line: `${who} dropped ${n} syslog lines (queue full or refused) — `
        + `received=${st.received} shipped=${st.shipped} queued=${st.queue.length}`,
      sev: 3,
      meta: { format: 'collector' },
    });
  }
  if ((GATEWAY || TUNNEL) && (unattributed || refusedTenants || badKeyDrops)) {
    log(`gateway: ${unattributed} messages without a usable ${TUNNEL ? 'source address' : 'token'}, `
      + `${badKeyDrops} for a refused key, ${refusedTenants} tokens past the cap, `
      + `${streams.size} tenants active`);
    unattributed = 0; refusedTenants = 0; badKeyDrops = 0;
  }
}

/* A tenant that has been silent long enough to have nothing queued and nothing
 * in flight is forgotten, or the cap becomes a high-water mark that only ever
 * rises and a gateway that has seen MAX_TENANTS keys once refuses new ones
 * forever. A stream is only dropped when it holds no lines, so this can never
 * be a way to lose one. */
function sweepIdle() {
  const cutoff = Date.now() - Math.max(POLL_MS * 2, 600000);
  for (const [token, st] of streams) {
    if (st.queue.length || st.flushing) continue;
    if (st.polledAt > cutoff || st.badUntil > Date.now()) continue;
    streams.delete(token);
  }
}

// ── the WireGuard interface ─────────────────────────────────────────────────
/**
 * What has to change on the interface to match the server's peer list.
 *
 * A PURE function returning argv arrays, which is the only reason any of this
 * is testable: a harness has no kernel, no `wg` and no interface, but the thing
 * that actually goes wrong here is deciding WHICH peers to add and remove —
 * and that is arithmetic on two lists. Running the commands is four lines
 * below and has nothing left to get wrong.
 *
 * Removal is not an optimisation. A peer left behind after its endpoint was
 * deleted is a tunnel someone can still send through, and its inner address may
 * later be reallocated to a different organisation — so the address would
 * resolve to a tenant the old peer's key was never given.
 *
 * @param {string[]} current public keys the interface has now
 * @param {{ip:string, publicKey:string}[]} desired what the server says
 * @param {string} iface
 * @returns {string[][]} argv arrays for `wg`
 */
function wgCommands(current, desired, iface) {
  const out = [];
  const want = new Map(desired.map((p) => [p.publicKey, p.ip]));
  for (const key of current) {
    if (!want.has(key)) out.push(['set', iface, 'peer', key, 'remove']);
  }
  /* Every desired peer is (re)applied rather than only the new ones. `wg set`
   * is idempotent, the list is small, and the alternative is trusting that
   * nothing outside this process has edited the interface — which is exactly
   * the assumption that makes a drifted allowed-ips invisible. */
  for (const [key, ip] of want) {
    out.push(['set', iface, 'peer', key, 'allowed-ips', `${ip}/32`]);
  }
  return out;
}

async function reconcilePeers() {
  let peers;
  try {
    const r = await fetch(`${URL_BASE}/v1/tunnel/peers`, {
      headers: { authorization: `Bearer ${TUNNEL_KEY}` },
    });
    if (r.status === 401 || r.status === 403) {
      log('FATAL: the tunnel gateway key was refused — check OPSCAT_TUNNEL_GATEWAY_KEY');
      process.exit(3);
    }
    if (!r.ok) return;
    peers = (await r.json()).peers || [];
  } catch (e) {
    // Keeping the interface as it is beats tearing every tunnel down because
    // one poll failed.
    log('peer poll failed (keeping the current peers):', e.message);
    return;
  }
  let current = [];
  try {
    current = execFileSync(WG_BIN, ['show', TUNNEL_IF, 'peers'], { encoding: 'utf8' })
      .split('\n').map((l) => l.trim()).filter(Boolean);
  } catch (e) {
    log(`could not read ${TUNNEL_IF} peers:`, e.message);
    return;
  }
  const cmds = wgCommands(current, peers, TUNNEL_IF);
  let changed = 0;
  for (const argv of cmds) {
    // An `allowed-ips` re-application that changes nothing is the common case,
    // so only the removals and genuine additions are worth a line in the log.
    const isNew = argv[4] === 'remove' || !current.includes(argv[3]);
    try {
      execFileSync(WG_BIN, argv, { stdio: 'ignore' });
      if (isNew) changed += 1;
    } catch (e) {
      log(`wg ${argv.join(' ')} failed:`, e.message);
    }
  }
  if (changed) log(`tunnel peers reconciled: ${peers.length} configured, ${changed} changed`);
}

// ── listeners ───────────────────────────────────────────────────────────────
function startUdp() {
  const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  s.on('message', (buf, rinfo) => onMessage(buf.toString('utf8').replace(/\0+$/, ''), rinfo.address));
  s.on('error', (e) => log('udp error:', e.message));
  s.bind(UDP_PORT, BIND, () => log(`listening udp/${UDP_PORT}`));
  return s;
}

let openConns = 0;
function handleStream(sock, kind) {
  if (openConns >= MAX_CONNS) { sock.destroy(); return; }
  openConns += 1;
  const peer = sock.remoteAddress ? sock.remoteAddress.replace(/^::ffff:/, '') : 'unknown';
  const framer = new sl.Framer();
  sock.setTimeout(IDLE_MS, () => sock.destroy());
  sock.on('data', (buf) => {
    for (const msg of framer.push(buf)) onMessage(msg, peer);
    if (framer.error) { log(`${kind} framing error from ${peer}: ${framer.error}`); sock.destroy(); }
  });
  sock.on('error', () => sock.destroy());
  sock.on('close', () => { openConns -= 1; });
}

function startTcp() {
  const s = net.createServer((c) => handleStream(c, 'tcp'));
  s.on('error', (e) => log('tcp error:', e.message));
  s.listen(TCP_PORT, BIND, () => log(`listening tcp/${TCP_PORT}`));
  return s;
}

/**
 * Where the certificate actually is.
 *
 * A path is used as given when it names a file. When it names a DIRECTORY the
 * tree below it is searched for `<OPSCAT_TLS_DOMAIN>.crt`/`.key`, which exists
 * for one concrete reason: in our own deployment the certificate is the one
 * Caddy already obtains and renews, and it lives at
 * `caddy/certificates/<acme-directory>/<domain>/<domain>.crt`. The middle
 * segment names the CA, so it changes if issuance ever falls back from Let's
 * Encrypt to ZeroSSL — and a hard-coded path would then point at nothing, on a
 * renewal, months later, with the listener the only thing affected.
 *
 * @returns {{cert:string, key:string}|null}
 */
function resolveCertPaths() {
  if (!TLS_CERT || !TLS_KEY) return null;
  const find = (root, want) => {
    /** @type {string[]} */
    const stack = [root];
    for (let guard = 0; stack.length && guard < 4096; guard += 1) {
      const dir = stack.pop();
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.name === want) return full;
      }
    }
    return null;
  };
  const one = (p, ext) => {
    let st;
    try { st = fs.statSync(p); } catch { return null; }
    if (st.isFile()) return p;
    if (!st.isDirectory() || !TLS_DOMAIN) return null;
    return find(p, `${TLS_DOMAIN}${ext}`);
  };
  const cert = one(TLS_CERT, '.crt');
  const key = one(TLS_KEY, '.key');
  return cert && key ? { cert, key } : null;
}

function readCert() {
  const p = resolveCertPaths();
  if (!p) return null;
  try {
    return {
      cert: fs.readFileSync(p.cert),
      key: fs.readFileSync(p.key),
      stamp: `${fs.statSync(p.cert).mtimeMs}:${fs.statSync(p.key).mtimeMs}`,
    };
  } catch (e) {
    log('could not read cert/key:', e.message);
    return null;
  }
}

function startTls() {
  const material = readCert();
  if (!material) {
    /* In collector mode this is a degradation and the right one: UDP and TCP
     * keep working and only the encrypted listener is missing. In gateway mode
     * TLS is the ONLY listener, so the same silence would be a box that accepts
     * connections from nobody while looking perfectly healthy. */
    if (GATEWAY) {
      console.error('FATAL: gateway mode needs a readable certificate '
        + `(OPSCAT_TLS_CERT=${TLS_CERT || '(unset)'} OPSCAT_TLS_DOMAIN=${TLS_DOMAIN || '(unset)'})`);
      process.exit(4);
    }
    log('TLS listener NOT started — no readable cert/key');
    return null;
  }
  let stamp = material.stamp;
  const s = tls.createServer({ cert: material.cert, key: material.key },
    (c) => handleStream(c, 'tls'));
  s.on('error', (e) => log('tls error:', e.message));
  s.listen(TLS_PORT, BIND, () => log(`listening tls/${TLS_PORT}`));
  /* Renewal happens under the process rather than to it: Caddy rewrites the
   * files and nothing restarts us, so a listener that read the certificate once
   * serves an expired one from the day it expires. `setSecureContext` is the
   * whole fix and it costs a stat every minute. */
  setInterval(() => {
    const next = readCert();
    if (!next || next.stamp === stamp) return;
    stamp = next.stamp;
    try {
      s.setSecureContext({ cert: next.cert, key: next.key });
      log('TLS certificate reloaded');
    } catch (e) {
      log('TLS reload failed (keeping the old context):', e.message);
    }
  }, CERT_WATCH_MS).unref();
  return s;
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  /* Inside main(), not at module scope. A guard that exits on require makes the
   * module impossible to load for a check — and the check that matters is CI
   * proving the image can load it at all, which is exactly the mistake this
   * file's own Dockerfile would otherwise hide. */
  /* Only the COLLECTOR needs a key of its own. Both gateways are told who the
   * tenant is by something else — the message, or the address — and demanding a
   * key from them is how tunnel mode refused to start at all the first time
   * this was written. */
  if (!URL_BASE || (!GATEWAY && !TUNNEL && !KEY)) {
    console.error(GATEWAY || TUNNEL
      ? 'OPSCAT_URL is required'
      : 'OPSCAT_URL and OPSCAT_COLLECTOR_KEY are required');
    process.exit(2);
  }
  if (TUNNEL && GATEWAY) {
    console.error('OPSCAT_TUNNEL and OPSCAT_GATEWAY are different machines and different '
      + 'trust models — set exactly one');
    process.exit(2);
  }
  if (TUNNEL && !TUNNEL_KEY) {
    console.error('OPSCAT_TUNNEL_GATEWAY_KEY is required in tunnel mode');
    process.exit(2);
  }
  if (TUNNEL && KEY) {
    /* Same reasoning as the gateway's refusal below: a tenant key here would be
     * a second, contradictory answer to "whose logs are these", and the one it
     * gives is silent. */
    console.error('OPSCAT_COLLECTOR_KEY must NOT be set in tunnel mode — '
      + 'the tenant is the inner source address');
    process.exit(2);
  }
  if (TUNNEL && (!BIND || BIND === '0.0.0.0' || BIND === '::')) {
    /* THE security property of this mode, and it is one line.
     *
     * Attribution is by source address, and a source address is only
     * trustworthy because WireGuard checked it against the sending peer's key.
     * Listening on every interface would apply that same trust to packets that
     * never went through the tunnel — so anyone on the internet could pick an
     * inner address and write into that tenant's logs by spoofing a UDP source.
     *
     * There is no safe default here, which is why the default is a refusal
     * rather than a guess: an operator who has not said which address to bind
     * has not yet made the decision this mode depends on.
     */
    console.error('OPSCAT_BIND must name the tunnel address in tunnel mode — '
      + 'binding every interface would trust a source address nothing verified');
    process.exit(2);
  }
  if (GATEWAY && KEY) {
    /* A key in the environment of a multi-tenant gateway is either a
     * misunderstanding or a copied unit file, and both end the same way: every
     * message that failed to carry its own token would be silently ingested
     * into whichever org that key belongs to. Refusing is the only answer that
     * cannot be got wrong quietly. */
    console.error('OPSCAT_COLLECTOR_KEY must NOT be set in gateway mode — '
      + 'the tenant comes from each message, never from this process');
    process.exit(2);
  }

  if (TUNNEL) {
    log(`opscat-syslog-tunnel → ${URL_BASE} (${TUNNEL_IF}, bound to ${BIND})`);
    await reconcilePeers();
    setInterval(reconcilePeers, POLL_MS).unref();
    /* UDP and TCP, and NO TLS. Inside the tunnel everything is already
     * encrypted and authenticated by WireGuard, so a second handshake would buy
     * nothing and would exclude precisely the senders this mode exists for —
     * the appliance that speaks UDP/514 and nothing else. */
    startUdp();
    startTcp();
  } else if (GATEWAY) {
    log(`opscat-syslog-gateway → ${URL_BASE} (tls/${TLS_PORT}, up to ${MAX_TENANTS} tenants)`);
    /* No UDP and no plain TCP, and this is a security property rather than an
     * omission: in gateway mode the tenant's key is IN the message, so a
     * cleartext listener would hand a write credential for someone's logs to
     * everyone on the path, with no handshake and no rate limit to lean on. A
     * customer who needs UDP runs the collector inside their own network, which
     * is the mode above. */
    startTls();
  } else {
    log(`opscat-collector → ${URL_BASE} (key ${KEY.slice(0, 12)}…)`);
    const st = newStream(KEY);
    streams.set(KEY, st);
    if (!(await pollConfig(st))) keyRefused(st);
    log(`endpoint "${st.cfg.name}" — prefix=${st.cfg.devicePrefix || '(none)'} enabled=${st.cfg.enabled}`);
    startUdp();
    startTcp();
    startTls();
  }

  setInterval(reportDrops, REPORT_MS).unref();
  if (GATEWAY || TUNNEL) setInterval(sweepIdle, 60000).unref();

  const tick = async () => {
    const t = Date.now();
    const due = [];
    /* Nothing to poll per tenant in tunnel mode: the gateway does not know
     * which endpoint an address belongs to, so the device prefix and the
     * enabled switch are the server's business on every batch. */
    if (!TUNNEL) {
      for (const st of streams.values()) {
        if (st.polledAt && t - st.polledAt < POLL_MS) { /* fresh */ } else due.push(st);
      }
    }
    // A tenant seen for the first time has no configuration yet, so its prefix
    // and enabled switch are unknown until this resolves — which is why the
    // poll happens before the flush rather than beside it.
    for (const st of due.slice(0, 16)) {
      if (!(await pollConfig(st))) keyRefused(st);
    }
    const ready = [...streams.values()].filter((st) => st.retryAt <= t && st.badUntil <= t);
    // Bounded outbound concurrency: one tenant's slow POST must not hold up the
    // rest, and a thousand of them must not open a thousand sockets.
    for (let i = 0; i < ready.length; i += 8) {
      await Promise.all(ready.slice(i, i + 8).map(flush));
    }
    const single = GATEWAY ? null : streams.get(KEY);
    setTimeout(tick, (single && single.cfg.flushMs) || FLUSH_MS).unref();
  };
  tick();

  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, async () => {
      const queued = [...streams.values()].reduce((n, st) => n + st.queue.length, 0);
      log(`${sig} — flushing ${queued} queued lines`);
      // Best effort: one last pass rather than an unbounded drain, so a stuck
      // server cannot keep the process alive through a restart.
      await Promise.all([...streams.values()].map(flush));
      process.exit(0);
    });
  }
}

if (require.main === module) main();
module.exports = {
  onMessage, enqueue, streams, streamFor, newStream, flush, pollConfig,
  reportDrops, sweepIdle, resolveCertPaths, wgCommands, TOKEN_RE, SD_NAME,
};
