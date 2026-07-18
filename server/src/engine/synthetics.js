'use strict';
// Synthetic monitoring: scheduler runs enabled checks from the LOCAL probe
// (this host). Remote probes run the agent in --probe mode and POST results
// to /v1/synthetics/report; both paths land in recordResult().
const { execFile } = require('child_process');
const dns = require('dns');
const net = require('net');
const { db } = require('../db');
const config = require('../config');
const { now } = require('../util');
const pipeline = require('./pipeline');

const insResult = db.prepare(`INSERT INTO synthetic_results
  (check_id, location_id, ts, ok, latency_ms, meta) VALUES (?, ?, ?, ?, ?, ?)`);
const getChecks = db.prepare('SELECT * FROM synthetic_checks WHERE enabled = 1');
const getCheck = db.prepare('SELECT * FROM synthetic_checks WHERE id = ?');
const lastFails = db.prepare(`SELECT ok FROM synthetic_results
  WHERE check_id = ? AND location_id = ? ORDER BY ts DESC LIMIT 3`);

// One local probe location per org — results always link to a location the
// owning org can actually see (tenant isolation).
const localLocByOrg = new Map();
function ensureLocalLocation(orgId = 1) {
  let id = localLocByOrg.get(orgId);
  if (!id) {
    const row = db.prepare("SELECT id FROM synthetic_locations WHERE kind = 'local' AND org_id = ?").get(orgId);
    if (row) { id = row.id; }
    else {
      const info = db.prepare(`INSERT INTO synthetic_locations (org_id, city, cc, kind, active, created_at)
        VALUES (?, ?, ?, 'local', 1, ?)`).run(orgId, config.localProbe.city, config.localProbe.cc, now());
      id = info.lastInsertRowid;
    }
    localLocByOrg.set(orgId, id);
  }
  db.prepare('UPDATE synthetic_locations SET last_seen_at = ? WHERE id = ?').run(now(), id);
  return id;
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

// SSRF guard: refuse checks aimed at private / loopback / link-local space so a
// probe can't be pointed at the cloud metadata endpoint (169.254.169.254),
// localhost, or neighbouring compose services. Applied to http/tcp targets.
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10) return true;
    if (p[0] === 127) return true;
    if (p[0] === 0) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 169 && p[1] === 254) return true; // link-local incl. metadata
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    return false;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (l.startsWith('fe80') || l.startsWith('fc') || l.startsWith('fd')) return true;
    if (l.startsWith('::ffff:')) return isPrivateAddress(l.slice(7)); // IPv4-mapped
    return false;
  }
  return false;
}

async function assertPublicHost(host) {
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('target resolves to a private address');
    return;
  }
  const { address } = await dns.promises.lookup(host);
  if (isPrivateAddress(address)) throw new Error('target resolves to a private address');
}

async function checkHttp(check) {
  const url = /^https?:\/\//.test(check.target) ? check.target : `https://${check.target}`;
  const started = process.hrtime.bigint();
  try {
    let host;
    try { host = new URL(url).hostname.replace(/^\[|\]$/g, ''); }
    catch { return { ok: false, latency: null, meta: { error: 'invalid url' } }; }
    await assertPublicHost(host);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), check.timeout_ms);
    // redirect:'manual' so a 3xx into internal space is NOT followed; a redirect
    // still counts as reachable (status < 400) which is the right health signal.
    const resp = await fetch(url, {
      signal: ctrl.signal, redirect: 'manual',
      headers: { 'User-Agent': 'OpsCat-Synthetics/1.0' },
    });
    await resp.arrayBuffer().catch(() => {}); // drain
    clearTimeout(timer);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    return { ok: resp.status < 400, latency: ms, meta: { status: resp.status } };
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

function recordResult(checkId, locationId, { ok, latency, meta }, ts = now()) {
  insResult.run(checkId, locationId, ts, ok ? 1 : 0, latency, meta ? JSON.stringify(meta).slice(0, 4000) : null);
  if (!ok) {
    // only raise an event after 2 consecutive failures to avoid flapping
    const recent = lastFails.all(checkId, locationId);
    const consecutiveFails = recent.length >= 2 && recent[0].ok === 0 && recent[1].ok === 0;
    if (consecutiveFails) {
      const check = getCheck.get(checkId);
      const loc = db.prepare('SELECT city FROM synthetic_locations WHERE id = ?').get(locationId);
      if (check) {
        pipeline.ingestEvent({
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
    for (const check of getChecks.all()) {
      const last = lastRun.get(check.id) || 0;
      if (t - last < check.interval_s * 1000) continue;
      lastRun.set(check.id, t);
      const runner = RUNNERS[check.type];
      if (!runner) continue;
      const locId = ensureLocalLocation(check.org_id);
      runner(check)
        .then((res) => recordResult(check.id, locId, res))
        .catch((e) => recordResult(check.id, locId, { ok: false, latency: null, meta: { error: String(e.message).slice(0, 100) } }));
    }
  } finally { running = false; }
}

// Run every enabled check for one org now (or all orgs if orgId omitted).
async function runAllNow(orgId = null) {
  const results = [];
  const checks = getChecks.all().filter((c) => orgId == null || c.org_id === orgId);
  for (const check of checks) {
    lastRun.set(check.id, now());
    const runner = RUNNERS[check.type];
    if (!runner) continue;
    const locId = ensureLocalLocation(check.org_id);
    try {
      const res = await runner(check);
      recordResult(check.id, locId, res);
      results.push({ check_id: check.id, ...res });
    } catch (e) {
      recordResult(check.id, locId, { ok: false, latency: null, meta: { error: e.message } });
      results.push({ check_id: check.id, ok: false });
    }
  }
  return results;
}

function start() {
  ensureLocalLocation(1);
  const iv = setInterval(tick, 5000);
  iv.unref();
}

module.exports = { start, runAllNow, recordResult, RUNNERS };
