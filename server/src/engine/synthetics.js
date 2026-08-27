'use strict';
// Synthetic monitoring: scheduler runs enabled checks from the LOCAL probe
// (this host). Remote probes run the agent in --probe mode and POST results
// to /v1/synthetics/report; both paths land in recordResult().
const { execFile } = require('child_process');
const dns = require('dns');
const net = require('net');
const tls = require('tls');
const q = require('../db/shim');
const config = require('../config');
const { now, DEFAULT_ORG_ID } = require('../util');
const pipeline = require('./pipeline');
const { assertPublicHost } = require('../lib/ssrf');
const { resolveUserAgent } = require('../lib/useragent');
const { getOrgSetting } = require('../db');

const insResult = q.prepare(`INSERT INTO synthetic_results
  (check_id, location_id, ts, ok, latency_ms, meta) VALUES (?, ?, ?, ?, ?, ?)`);
const getChecks = q.prepare('SELECT * FROM synthetic_checks WHERE enabled = 1');
// check→location assignment: no rows = run everywhere (incl. this local probe)
const assignedLocs = q.prepare('SELECT location_id FROM check_locations WHERE check_id = ?');
// The empty set is a FALLBACK, not the way "all agents" is expressed. Since
// migration 034 every check carries explicit rows and routes/synthetics.js
// writes them on create and on update, so an empty set means something went
// wrong — a location deleted out from under the last assignment, a row written
// by hand. Running everywhere is the right answer to that: a check that runs
// NOWHERE reports nothing, alerts on nothing and looks exactly like a healthy
// one, which is the worse of the two failures by a distance.
async function runsOnLocation(checkId, locationId) {
  const rows = await assignedLocs.all(checkId);
  return rows.length === 0 || rows.some((r) => r.location_id === locationId);
}
const getCheck = q.prepare('SELECT * FROM synthetic_checks WHERE id = ?');
const lastFails = q.prepare(`SELECT ok FROM synthetic_results
  WHERE check_id = ? AND location_id = ? ORDER BY ts DESC LIMIT 3`);

// One local probe location per org — results always link to a location the
// owning org can actually see (tenant isolation).
const findLocalLoc = q.prepare("SELECT id FROM synthetic_locations WHERE kind = 'local' AND org_id = ?");
const insLocalLoc = q.prepare(`INSERT INTO synthetic_locations (org_id, city, cc, kind, active, created_at)
  VALUES (?, ?, ?, 'local', 1, ?)`);
const touchLoc = q.prepare('UPDATE synthetic_locations SET last_seen_at = ? WHERE id = ?');

async function findOrCreateLocalLocation(orgId) {
  const row = await findLocalLoc.get(orgId);
  if (row) return row.id;
  // `.insert()`, not `run().lastInsertRowid` — the shim refuses that one, and
  // `undefined` in `synthetic_results.location_id` is a NULL nobody notices
  // until the uptime chart comes back empty.
  return insLocalLoc.insert(orgId, config.localProbe.city, config.localProbe.cc, now());
}

const localLocByOrg = new Map();   // orgId -> Promise<locationId>
function ensureLocalLocation(orgId = DEFAULT_ORG_ID) {
  let pending = localLocByOrg.get(orgId);
  if (!pending) {
    /* The map holds the PROMISE, not the id, and that is the whole difference
     * the conversion makes here. Synchronously this function could not overlap
     * with itself; awaited it can — `tick()` and `runAllNow()` both call it, and
     * two racing cache misses would each find no row and each INSERT one, giving
     * an org two "local" probe locations and splitting its own history across
     * them. Caching the in-flight promise restores the single-insert property
     * the synchronous version had for free. A FAILURE is not cached, or one
     * transient error would make the probe locationless for the process's life.
     */
    pending = findOrCreateLocalLocation(orgId);
    pending.catch(() => localLocByOrg.delete(orgId));
    localLocByOrg.set(orgId, pending);
  }
  return pending.then(async (id) => { await touchLoc.run(now(), id); return id; });
}

// ---- runners ----------------------------------------------------------------

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

const isSafeTarget = (t) => /^[a-zA-Z0-9._:\/?#\[\]@!$&'()*+,;=%-]+$/.test(t) && !t.startsWith('-');

// SSRF guard: private / loopback / link-local space is refused so a probe cannot
// be pointed at the cloud metadata endpoint (169.254.169.254), localhost, or a
// neighbouring compose service. The implementation moved to lib/ssrf.js when the
// automation and alert webhooks turned out to need the same guard — one copy,
// re-exported here because vendor-feeds.js has imported it from this module
// since it was written.

// Days until the server certificate expires (null when unknown/plain http).
// rejectUnauthorized:false on purpose — an already-invalid chain should still
// report its dates instead of hiding them.
function certDaysLeft(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let sock;
    const finish = (v) => { try { sock.destroy(); } catch { /* noop */ } resolve(v); };
    try {
      sock = tls.connect({ host, port, servername: host, timeout: timeoutMs, rejectUnauthorized: false }, () => {
        const cert = sock.getPeerCertificate();
        if (!cert || !cert.valid_to) return finish(null);
        finish(Math.floor((Date.parse(cert.valid_to) - Date.now()) / 86400000));
      });
      sock.on('error', () => finish(null));
      sock.on('timeout', () => finish(null));
    } catch { resolve(null); }
  });
}

// Simple dot-path lookup ("a.b.0.c") — deliberately no JSONPath dependency.
function jsonPath(obj, path) {
  let cur = obj;
  for (const part of String(path).replace(/^\$\.?/, '').split('.').filter(Boolean)) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

// Evaluate configured assertions against the response; returns a failure
// message or null when everything passes.
function failedAssertion(assertions, status, bodyText) {
  if (assertions.status && status !== assertions.status) {
    return `status ${status} != ${assertions.status}`;
  }
  if (assertions.keyword && !bodyText.includes(assertions.keyword)) {
    return `keyword "${assertions.keyword}" not found`;
  }
  if (assertions.jsonPath) {
    let val;
    try { val = jsonPath(JSON.parse(bodyText), assertions.jsonPath); }
    catch { return 'response is not valid JSON'; }
    if (String(val) !== String(assertions.jsonValue)) {
      return `${assertions.jsonPath} = ${JSON.stringify(val)} != ${JSON.stringify(assertions.jsonValue)}`;
    }
  }
  return null;
}

async function checkHttp(check) {
  const url = /^https?:\/\//.test(check.target) ? check.target : `https://${check.target}`;
  let assertions = null;
  try { assertions = check.assertions ? JSON.parse(check.assertions) : null; } catch { /* noop */ }
  const started = process.hrtime.bigint();
  try {
    let parsed;
    try { parsed = new URL(url); }
    catch { return { ok: false, latency: null, meta: { error: 'invalid url' } }; }
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    await assertPublicHost(host);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), check.timeout_ms);
    // redirect:'manual' so a 3xx into internal space is NOT followed; a redirect
    // still counts as reachable (status < 400) which is the right health signal.
    const resp = await fetch(url, {
      signal: ctrl.signal, redirect: 'manual',
      // check → org → ours (lib/useragent.js). getOrgSetting is SYNCHRONOUS and
      // answers from the boot cache; it must stay that way.
      headers: { 'User-Agent': resolveUserAgent(check.user_agent,
        getOrgSetting(check.org_id, 'synthetic_user_agent', '')) },
    });
    // body only needed when assertions inspect it; otherwise just drain
    const body = assertions && (assertions.keyword || assertions.jsonPath)
      ? (await resp.text().catch(() => '')).slice(0, 262144)
      : (await resp.arrayBuffer().catch(() => {}), '');
    clearTimeout(timer);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const meta = { status: resp.status };
    if (parsed.protocol === 'https:') {
      const days = await certDaysLeft(host, Number(parsed.port) || 443, check.timeout_ms);
      if (days != null) meta.certDaysLeft = days;
    }
    let ok = resp.status < 400;
    if (ok && assertions) {
      const failed = failedAssertion(assertions, resp.status, body);
      if (failed) { ok = false; meta.failed = failed; }
    } else if (!ok && assertions && assertions.status === resp.status) {
      ok = !failedAssertion(assertions, resp.status, body); // explicitly expected non-2xx
    }
    return { ok, latency: ms, meta };
  } catch (e) {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    return { ok: false, latency: ms, meta: { error: String(e.cause?.code || e.message || e.name).slice(0, 100) } };
  }
}

async function checkIcmp(check) {
  const host = check.target.replace(/^https?:\/\//, '').split('/')[0];
  if (!isSafeTarget(host)) return { ok: false, latency: null, meta: { error: 'invalid target' } };
  const count = 5;
  const { stdout } = await run('ping', ['-n', '-q', '-c', String(count), '-i', '0.2',
    '-W', String(Math.ceil(check.timeout_ms / 1000)), host], check.timeout_ms + 4000);
  const lossM = /(\d+(?:\.\d+)?)% packet loss/.exec(stdout);
  const rttM = /rtt [^=]*= ([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)/.exec(stdout);
  const loss = lossM ? parseFloat(lossM[1]) : 100;
  if (!rttM) return { ok: false, latency: null, meta: { loss } };
  return {
    ok: loss < 100, latency: parseFloat(rttM[2]),
    meta: { loss, jitter: parseFloat(rttM[4]), min: parseFloat(rttM[1]), max: parseFloat(rttM[3]) },
  };
}

async function checkDns(check) {
  // target format: "name" or "name @ server"
  const [name, server] = check.target.split('@').map((s) => s.trim());
  const resolver = new dns.promises.Resolver({ timeout: check.timeout_ms, tries: 1 });
  if (server) { try { resolver.setServers([server]); } catch { /* keep defaults */ } }
  const started = process.hrtime.bigint();
  try {
    const addrs = await resolver.resolve4(name);
    return { ok: addrs.length > 0, latency: Number(process.hrtime.bigint() - started) / 1e6,
      meta: { answers: addrs.slice(0, 4) } };
  } catch (e) {
    return { ok: false, latency: Number(process.hrtime.bigint() - started) / 1e6,
      meta: { error: e.code || 'DNS_FAIL' } };
  }
}

async function checkTcp(check) {
  const [host, portStr] = check.target.split(':');
  const port = parseInt(portStr, 10) || 443;
  try { await assertPublicHost(host); }
  catch (e) { return { ok: false, latency: null, meta: { error: e.message.slice(0, 100) } }; }
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const sock = net.connect({ host, port, timeout: check.timeout_ms });
    const done = (ok, meta) => {
      sock.destroy();
      resolve({ ok, latency: Number(process.hrtime.bigint() - started) / 1e6, meta });
    };
    sock.on('connect', () => done(true, { port }));
    sock.on('timeout', () => done(false, { error: 'timeout' }));
    sock.on('error', (e) => done(false, { error: e.code }));
  });
}

async function checkTraceroute(check) {
  const host = check.target.replace(/^https?:\/\//, '').split('/')[0];
  if (!isSafeTarget(host)) return { ok: false, latency: null, meta: { error: 'invalid target' } };
  const { stdout, err } = await run('traceroute', ['-n', '-q', '1', '-w', '1', '-m', '20', host], 30000);
  if (err && !stdout) return { ok: false, latency: null, meta: { error: 'traceroute failed' } };
  const hops = [];
  for (const line of stdout.split('\n').slice(1)) {
    const m = /^\s*(\d+)\s+([\d.a-fA-F:]+|\*)\s*(?:([\d.]+) ms)?/.exec(line);
    if (m) hops.push({ hop: +m[1], ip: m[2], ms: m[3] ? parseFloat(m[3]) : null });
  }
  const last = hops.filter((h) => h.ms != null).pop();
  return { ok: hops.length > 0 && !!last, latency: last ? last.ms : null, meta: { hops: hops.slice(0, 20) } };
}

const RUNNERS = { http: checkHttp, icmp: checkIcmp, dns: checkDns, tcp: checkTcp, traceroute: checkTraceroute };

// ---- recording + failure events --------------------------------------------

const getLocCity = q.prepare('SELECT city FROM synthetic_locations WHERE id = ?');

async function recordResult(checkId, locationId, { ok, latency, meta }, ts = now()) {
  await insResult.run(checkId, locationId, ts, ok ? 1 : 0, latency, meta ? JSON.stringify(meta).slice(0, 4000) : null);
  // certificate expiry is an event of its own — the site may still be up
  if (meta && Number.isFinite(meta.certDaysLeft) && meta.certDaysLeft <= 14) {
    const check = await getCheck.get(checkId);
    if (check) {
      const days = meta.certDaysLeft;
      await pipeline.ingestEvent({
        name: 'tls_cert_expiring', device: check.target.replace(/^https?:\/\//, '').split('/')[0],
        target: check.target, severity: days <= 3 ? 85 : days <= 7 ? 75 : 60,
        description: `tls_cert_expiring ${check.target} — certificate expires in ${days} day(s)`,
      }, 'synthetics', false, check.org_id);
    }
  }
  if (!ok) {
    // only raise an event after 2 consecutive failures to avoid flapping
    const recent = await lastFails.all(checkId, locationId);
    const consecutiveFails = recent.length >= 2 && recent[0].ok === 0 && recent[1].ok === 0;
    if (consecutiveFails) {
      const check = await getCheck.get(checkId);
      const loc = await getLocCity.get(locationId);
      if (check) {
        await pipeline.ingestEvent({
          name: 'synthetic_check_failed', device: `probe-${loc ? loc.city : locationId}`,
          target: check.target, severity: 70,
          description: `synthetic_check_failed ${check.type} ${check.target} from ${loc ? loc.city : 'probe'}`,
        }, 'synthetics', false, check.org_id);
      }
    }
  }
}

// ---- scheduler --------------------------------------------------------------

const lastRun = new Map(); // checkId -> ts
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const t = now();
    for (const check of await getChecks.all()) {
      const last = lastRun.get(check.id) || 0;
      if (t - last < check.interval_s * 1000) continue;
      lastRun.set(check.id, t);
      const runner = RUNNERS[check.type];
      if (!runner) continue;
      const locId = await ensureLocalLocation(check.org_id);
      // Parenthesised on purpose: `!await f()` reads as `!Promise` if the await
      // is ever lost, which is always false — the guard would stop existing and
      // nothing in the type gate can see it.
      if (!(await runsOnLocation(check.id, locId))) continue; // assigned to other agents only
      runner(check)
        .then((res) => recordResult(check.id, locId, res))
        .catch((e) => recordResult(check.id, locId, { ok: false, latency: null, meta: { error: String(e.message).slice(0, 100) } }))
        // recordResult is awaited now, so its own failure would land here as an
        // unhandled rejection (which NODE_ENV=test turns into a non-zero exit).
        .catch((e) => console.error('synthetics record error', e && e.message));
    }
  } finally { running = false; }
}

// Run every enabled check for one org now (or all orgs if orgId omitted).
async function runAllNow(orgId = null) {
  const results = [];
  const checks = (await getChecks.all()).filter((c) => orgId == null || c.org_id === orgId);
  for (const check of checks) {
    lastRun.set(check.id, now());
    const runner = RUNNERS[check.type];
    if (!runner) continue;
    const locId = await ensureLocalLocation(check.org_id);
    if (!(await runsOnLocation(check.id, locId))) continue;
    try {
      const res = await runner(check);
      await recordResult(check.id, locId, res);
      results.push({ check_id: check.id, ...res });
    } catch (e) {
      await recordResult(check.id, locId, { ok: false, latency: null, meta: { error: e.message } });
      results.push({ check_id: check.id, ok: false });
    }
  }
  return results;
}

function start() {
  // Both are promises now, and an unhandled rejection is a non-zero exit under
  // NODE_ENV=test and a silently dead scheduler in production. Same shape as
  // engine/heartbeats.js.
  /* No argument: the default IS `DEFAULT_ORG_ID` (see the signature above). The
   * literal `1` that used to be here is the bug CLAUDE.md § Identity keys
   * describes — since organisations became uuids it matches no row, so this
   * created a `synthetic_locations` row belonging to NO organisation on every
   * boot. Invisible on SQLite, which stores whatever it is given; on Postgres it
   * is a hard `invalid input syntax for type uuid: "1"` and the scheduler never
   * starts. */
  ensureLocalLocation().catch((e) => console.error('synthetics local location', e && e.message));
  const iv = setInterval(() => {
    tick().catch((e) => console.error('synthetics tick error', e && e.message));
  }, 5000);
  iv.unref();
}

module.exports = { start, runAllNow, recordResult, RUNNERS, assertPublicHost };
