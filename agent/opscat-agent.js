#!/usr/bin/env node
'use strict';
/**
 * opscat-agent — single-file, dependency-free host agent for OpsCat.
 *
 * Runs on Linux servers. Every interval it ships a heartbeat + host metrics.
 * Optionally tails journald logs (--logs) and runs synthetic checks (--probe).
 *
 * Config via env vars or CLI flags (flags win):
 *   OPSCAT_URL          base URL of the OpsCat server         (--url)
 *   OPSCAT_AGENT_TOKEN  agent token (Bearer)                  (--token)
 *   OPSCAT_PROBE_KEY    synthetics probe key (Bearer)         (--probe-key)
 *
 * Flags:
 *   --logs              ship journald logs to /v1/agents/logs
 *   --probe             run synthetic checks (needs OPSCAT_PROBE_KEY)
 *   --interval <sec>    metrics/heartbeat interval (default 60)
 *   --disk-path <path>  filesystem to report disk usage for (default /)
 *   --dry-run           collect metrics once, print JSON, exit 0
 *   --help              show usage
 *
 * Requires Node >= 18 (global fetch, AbortController).
 */

const os = require('os');
const fs = require('fs');
const net = require('net');
const dns = require('dns');
const { execFile, spawn } = require('child_process');
const readline = require('readline');

const VERSION = '0.3.0';
const HTTP_TIMEOUT_MS = 10000;
const LOG_QUEUE_CAP = 2000;
const LOG_BATCH = 100;
const LOG_FLUSH_MS = 5000;
const PROBE_POLL_MS = 30000;

// --- config ----------------------------------------------------------------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      // boolean flags
      if (['logs', 'probe', 'dry-run', 'help'].includes(key)) { out[key] = true; continue; }
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) { printHelp(); process.exit(0); }

const cfg = {
  url: String(args.url || process.env.OPSCAT_URL || '').replace(/\/+$/, ''),
  token: args.token || process.env.OPSCAT_AGENT_TOKEN || '',
  probeKey: args['probe-key'] || process.env.OPSCAT_PROBE_KEY || '',
  interval: Math.max(5, parseInt(args.interval, 10) || 60),
  diskPath: args['disk-path'] || '/',
  logs: !!args.logs,
  probe: !!args.probe,
  dryRun: !!args['dry-run'],
};

// --- logging (never leak secrets) ------------------------------------------
function sanitize(s) {
  s = String(s == null ? '' : s);
  if (cfg.token) s = s.split(cfg.token).join('***');
  if (cfg.probeKey) s = s.split(cfg.probeKey).join('***');
  return s;
}
function logErr(ctx, msg) {
  process.stderr.write('[opscat-agent] ' + new Date().toISOString() + ' ' + ctx + ' failed: ' + sanitize(msg) + '\n');
}
function logInfo(msg) {
  process.stderr.write('[opscat-agent] ' + new Date().toISOString() + ' ' + sanitize(msg) + '\n');
}

// --- tiny helpers ----------------------------------------------------------
// NOTE: this is a long-running daemon, so timers are intentionally NOT unref'd —
// the metrics interval is what keeps the process alive.
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : n);
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error((label || 'operation') + ' timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// --- HTTP ------------------------------------------------------------------
async function httpJson(method, path, token, body) {
  const url = cfg.url + path;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        token ? { Authorization: 'Bearer ' + token } : {}
      ),
      body: body != null ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON / empty */ }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(to);
  }
}

async function safePost(path, token, body, ctx) {
  try {
    const r = await httpJson('POST', path, token, body);
    if (!r.ok) { logErr(ctx, 'HTTP ' + r.status); return null; }
    return r.data;
  } catch (e) {
    logErr(ctx, e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || String(e));
    return null;
  }
}

// --- metrics collection (Linux) --------------------------------------------
function readCpuSample() {
  const first = fs.readFileSync('/proc/stat', 'utf8').split('\n', 1)[0];
  // "cpu  user nice system idle iowait irq softirq steal guest guest_nice"
  const parts = first.trim().split(/\s+/).slice(1).map(Number);
  const idle = (parts[3] || 0) + (parts[4] || 0); // idle + iowait counted as idle
  const total = parts.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  return { idle, total };
}

async function cpuPercent() {
  try {
    const a = readCpuSample();
    await sleep(1000);
    const b = readCpuSample();
    const idleD = b.idle - a.idle;
    const totalD = b.total - a.total;
    if (totalD <= 0) return 0;
    const pct = 100 * (1 - idleD / totalD);
    return round2(Math.max(0, Math.min(100, pct)));
  } catch (e) {
    return 0;
  }
}

function memInfo() {
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const kb = (key) => {
      const m = txt.match(new RegExp('^' + key + ':\\s+(\\d+)\\s*kB', 'm'));
      return m ? Number(m[1]) * 1024 : null;
    };
    const total = kb('MemTotal');
    const avail = kb('MemAvailable');
    return {
      memTotal: total || 0,
      memUsed: (total != null && avail != null) ? total - avail : 0,
    };
  } catch (e) {
    return { memTotal: 0, memUsed: 0 };
  }
}

function netCounters() {
  let netRx = 0, netTx = 0;
  try {
    const lines = fs.readFileSync('/proc/net/dev', 'utf8').split('\n');
    for (const l of lines) {
      const idx = l.indexOf(':');
      if (idx < 0) continue;
      const iface = l.slice(0, idx).trim();
      if (!iface || iface === 'lo') continue;
      const cols = l.slice(idx + 1).trim().split(/\s+/).map(Number);
      // receive bytes = col 0, transmit bytes = col 8
      netRx += cols[0] || 0;
      netTx += cols[8] || 0;
    }
  } catch (e) { /* ignore */ }
  return { netRx, netTx };
}

function diskInfo(path) {
  return new Promise((resolve) => {
    execFile('df', ['-kP', path], { timeout: 5000 }, (err, stdout) => {
      if (err || !stdout) return resolve({ diskUsed: 0, diskTotal: 0 });
      const lines = stdout.trim().split('\n');
      const cols = lines[lines.length - 1].trim().split(/\s+/);
      // df -kP: Filesystem 1024-blocks Used Available Capacity Mounted-on
      const blocks = Number(cols[1]);
      const used = Number(cols[2]);
      resolve({
        diskTotal: Number.isFinite(blocks) ? blocks * 1024 : 0,
        diskUsed: Number.isFinite(used) ? used * 1024 : 0,
      });
    });
  });
}

async function collectMetrics() {
  const cpuP = cpuPercent();          // takes ~1s
  const diskP = diskInfo(cfg.diskPath);
  const cpuPct = await cpuP;
  const { memUsed, memTotal } = memInfo();
  const { diskUsed, diskTotal } = await diskP;
  const { netRx, netTx } = netCounters();
  return {
    cpuPct,
    load1: round2(os.loadavg()[0]),
    memUsed,
    memTotal,
    diskUsed,
    diskTotal,
    netRx,
    netTx,
  };
}

// --- self-update -------------------------------------------------------------
// The server bundles its matching agent script; when the heartbeat reports
// updateAvailable, download it, replace THIS file atomically and exit — the
// systemd unit (Restart=always) relaunches the new version.
let updating = false;
async function selfUpdate() {
  if (updating) return;
  updating = true;
  try {
    const res = await fetch(cfg.url + '/v1/agents/update', {
      headers: { Authorization: 'Bearer ' + cfg.token },
    });
    if (!res.ok) { logErr('update', 'HTTP ' + res.status); updating = false; return; }
    const script = await res.text();
    const m = /const VERSION = '([^']+)'/.exec(script);
    if (!m || m[1] === VERSION || script.length < 10000) {
      logErr('update', 'refusing update: implausible script payload');
      updating = false;
      return;
    }
    fs.writeFileSync(__filename + '.new', script, { mode: 0o755 });
    fs.renameSync(__filename + '.new', __filename);
    logInfo('self-update ' + VERSION + ' -> ' + m[1] + ' installed; exiting for restart');
    setTimeout(() => process.exit(0), 300);
  } catch (e) {
    logErr('update', (e && e.message) || String(e));
    updating = false;
  }
}

// --- container stats (docker CLI; silently off when docker is absent) -------
let dockerAvailable = null; // null = not probed yet
function execCmd(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve({ err, stdout: String(stdout || '') });
    });
  });
}
function parseSize(s) {
  const m = /^([\d.]+)\s*([KMGT]?i?B)$/i.exec(String(s || '').trim());
  if (!m) return null;
  const mult = { b: 1, kb: 1e3, kib: 1024, mb: 1e6, mib: 1048576, gb: 1e9, gib: 1073741824,
    tb: 1e12, tib: 1099511627776 }[m[2].toLowerCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}
async function collectContainers() {
  if (dockerAvailable === false) return null;
  const ps = await execCmd('docker', ['ps', '-a', '--format', '{{json .}}'], 10000);
  if (ps.err) {
    if (dockerAvailable === null) logInfo('docker not available — container monitoring disabled');
    dockerAvailable = false;
    return null;
  }
  dockerAvailable = true;
  const byName = new Map();
  for (const line of ps.stdout.split('\n').filter(Boolean)) {
    try {
      const c = JSON.parse(line);
      byName.set(c.Names, { name: c.Names, image: c.Image, state: String(c.State || '').toLowerCase() });
    } catch (e) { /* skip malformed line */ }
  }
  const stats = await execCmd('docker', ['stats', '--no-stream', '--format', '{{json .}}'], 15000);
  if (!stats.err) {
    for (const line of stats.stdout.split('\n').filter(Boolean)) {
      try {
        const s = JSON.parse(line);
        const c = byName.get(s.Name);
        if (!c) continue;
        c.cpuPct = parseFloat(String(s.CPUPerc).replace('%', ''));
        const mem = String(s.MemUsage || '').split('/');
        c.memUsed = parseSize(mem[0]);
        c.memLimit = parseSize(mem[1]);
      } catch (e) { /* skip malformed line */ }
    }
  }
  return Array.from(byName.values());
}

// --- heartbeat + metrics tick ----------------------------------------------
async function tick() {
  const hb = await safePost('/v1/agents/heartbeat', cfg.token, {
    hostname: os.hostname(),
    platform: os.platform() + ' ' + os.release(),
    version: VERSION,
  }, 'heartbeat');
  if (hb && hb.updateAvailable) selfUpdate();

  const metrics = await collectMetrics();
  await safePost('/v1/agents/metrics', cfg.token, metrics, 'metrics');

  const containers = await collectContainers();
  if (containers && containers.length) {
    await safePost('/v1/agents/containers', cfg.token, { containers }, 'containers');
  }
}

// --- log shipping (journald) -----------------------------------------------
let logQueue = [];
let journalProc = null;
let logFlushTimer = null;

function enqueueLog(entry) {
  if (logQueue.length >= LOG_QUEUE_CAP) logQueue.shift(); // drop-oldest
  logQueue.push(entry);
  if (logQueue.length >= LOG_BATCH) flushLogs();
}

async function flushLogs() {
  if (!logQueue.length) return;
  const batch = logQueue.splice(0, LOG_BATCH);
  await safePost('/v1/agents/logs', cfg.token, { logs: batch }, 'agent-logs');
}

function handleJournalLine(line) {
  if (!line) return;
  let j;
  try { j = JSON.parse(line); } catch (e) { return; }

  let msg = j.MESSAGE;
  if (Array.isArray(msg)) { try { msg = Buffer.from(msg).toString('utf8'); } catch (e) { msg = ''; } }
  if (typeof msg !== 'string') msg = msg == null ? '' : String(msg);
  if (!msg) return;                          // skip empty MESSAGE
  if (/opscat/i.test(msg)) return;           // avoid feedback loops

  const device = (typeof j._HOSTNAME === 'string' && j._HOSTNAME) ? j._HOSTNAME : os.hostname();
  let sev = parseInt(j.PRIORITY, 10);
  if (!Number.isInteger(sev)) sev = 6;
  sev = Math.min(7, Math.max(0, sev));

  const entry = { device: String(device).slice(0, 100), line: msg.slice(0, 8192), sev };
  const us = Number(j.__REALTIME_TIMESTAMP);
  if (Number.isFinite(us) && us > 0) entry.ts = Math.floor(us / 1000); // µs → ms
  enqueueLog(entry);
}

function spawnJournal() {
  try {
    journalProc = spawn('journalctl', ['-f', '-o', 'json', '-n', '0'], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    logErr('journalctl', (e && e.message) || String(e));
    scheduleJournalRestart();
    return;
  }
  const rl = readline.createInterface({ input: journalProc.stdout });
  rl.on('line', (line) => { try { handleJournalLine(line); } catch (e) { /* ignore */ } });
  journalProc.on('error', (e) => { logErr('journalctl', (e && e.message) || String(e)); });
  journalProc.on('exit', () => {
    if (shuttingDown) return;
    logErr('journalctl', 'exited; restarting in 10s');
    scheduleJournalRestart();
  });
}

function scheduleJournalRestart() {
  if (shuttingDown) return;
  setTimeout(() => { if (!shuttingDown) spawnJournal(); }, 10000);
}

function startLogShipping() {
  logFlushTimer = setInterval(() => { flushLogs().catch(() => {}); }, LOG_FLUSH_MS);
  spawnJournal();
}

// --- synthetic probes ------------------------------------------------------
const probeState = new Map(); // checkId -> last run (ms)
let probeTimer = null;

function startProbe() {
  if (!cfg.probeKey) { logErr('probe', 'OPSCAT_PROBE_KEY not set; probe disabled'); return; }
  const run = () => { probeCycle().catch((e) => logErr('probe', (e && e.message) || String(e))); };
  run();
  probeTimer = setInterval(run, PROBE_POLL_MS);
}

async function probeCycle() {
  let checks;
  try {
    const r = await httpJson('GET', '/v1/synthetics/checks', cfg.probeKey, null);
    if (!r.ok) { logErr('probe-fetch', 'HTTP ' + r.status); return; }
    checks = Array.isArray(r.data) ? r.data : [];
  } catch (e) {
    logErr('probe-fetch', e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || String(e));
    return;
  }

  const nowMs = Date.now();
  const due = checks.filter((c) => {
    const last = probeState.get(c.id) || 0;
    return nowMs - last >= (Number(c.intervalS) || 60) * 1000;
  });

  let results = [];
  for (const c of due) {
    probeState.set(c.id, Date.now());
    let res;
    try {
      res = await runCheck(c);
    } catch (e) {
      res = { ok: false, meta: { error: String((e && e.message) || e).slice(0, 200) } };
    }
    if (res == null) continue; // check skipped (e.g. traceroute binary missing)
    results.push(Object.assign({ checkId: c.id, ts: Date.now() }, res));
    if (results.length >= 200) { await reportResults(results); results = []; }
  }
  if (results.length) await reportResults(results);

  // forget state for checks that no longer exist
  const ids = new Set(checks.map((c) => c.id));
  for (const id of Array.from(probeState.keys())) if (!ids.has(id)) probeState.delete(id);
}

async function reportResults(results) {
  await safePost('/v1/synthetics/report', cfg.probeKey, { results }, 'probe-report');
}

function runCheck(c) {
  const timeoutMs = Math.max(1000, Number(c.timeoutMs) || 5000);
  switch (c.type) {
    case 'http': return checkHttp(c.target, timeoutMs);
    case 'icmp': return checkIcmp(c.target, timeoutMs);
    case 'dns': return checkDns(c.target, timeoutMs);
    case 'tcp': return checkTcp(c.target, timeoutMs);
    case 'traceroute': return checkTraceroute(c.target, timeoutMs);
    default: return Promise.resolve({ ok: false, meta: { error: 'unknown check type: ' + c.type } });
  }
}

async function checkHttp(target, timeoutMs) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = process.hrtime.bigint();
  try {
    const res = await fetch(target, { method: 'GET', redirect: 'follow', signal: ctrl.signal });
    const latencyMs = Number(process.hrtime.bigint() - start) / 1e6;
    // drain body so the socket can be reused/closed
    try { await res.arrayBuffer(); } catch (e) { /* ignore */ }
    return { ok: res.status < 400, latencyMs: round2(latencyMs), meta: { status: res.status } };
  } catch (e) {
    return { ok: false, meta: { error: e && e.name === 'AbortError' ? 'timeout' : String((e && e.message) || e).slice(0, 200) } };
  } finally {
    clearTimeout(to);
  }
}

// Guard execFile args: reject a leading '-' (would be read as a flag) and any
// char outside a conservative hostname/IP set. Mirrors the server-side guard.
function isSafeHost(h) {
  return typeof h === 'string' && h.length > 0 && h.length <= 255 &&
    /^[a-zA-Z0-9._:\[\]-]+$/.test(h) && !h.startsWith('-');
}

function checkIcmp(host, timeoutMs) {
  if (!isSafeHost(host)) return Promise.resolve({ ok: false, meta: { error: 'invalid target' } });
  return new Promise((resolve) => {
    const wsec = Math.max(1, Math.ceil(timeoutMs / 1000));
    execFile('ping', ['-n', '-q', '-c', '5', '-i', '0.2', '-W', String(wsec), String(host)],
      { timeout: timeoutMs + 8000 }, (err, stdout, stderr) => {
        const out = (stdout || '') + (stderr || '');
        const lossM = out.match(/([\d.]+)%\s*packet loss/i);
        const loss = lossM ? parseFloat(lossM[1]) : 100;
        // iputils:  "rtt min/avg/max/mdev = 0.1/0.2/0.3/0.04 ms"
        // busybox:  "round-trip min/avg/max = 0.1/0.2/0.3 ms"
        let avg = null, jitter = null;
        const m = out.match(/(?:rtt|round-trip)[^=]*=\s*([\d.]+)\/([\d.]+)\/([\d.]+)(?:\/([\d.]+))?\s*ms/i);
        if (m) { avg = parseFloat(m[2]); if (m[4] !== undefined) jitter = parseFloat(m[4]); }
        const result = { ok: loss < 100, meta: { loss, jitter } };
        if (avg != null) result.latencyMs = round2(avg);
        resolve(result);
      });
  });
}

async function checkDns(target, timeoutMs) {
  // supports "name @ server"
  let name = String(target).trim();
  let server = null;
  const m = name.match(/^(\S+)\s*@\s*(\S+)$/);
  if (m) { name = m[1]; server = m[2]; }
  const resolver = new dns.promises.Resolver({ timeout: timeoutMs, tries: 1 });
  if (server) { try { resolver.setServers([server]); } catch (e) { return { ok: false, meta: { error: 'bad dns server: ' + server } }; } }
  const start = process.hrtime.bigint();
  try {
    const addrs = await withTimeout(resolver.resolve4(name), timeoutMs, 'dns');
    const latencyMs = Number(process.hrtime.bigint() - start) / 1e6;
    const ok = Array.isArray(addrs) && addrs.length > 0;
    return { ok, latencyMs: round2(latencyMs), meta: { addresses: (addrs || []).slice(0, 10) } };
  } catch (e) {
    return { ok: false, meta: { error: String((e && e.message) || e).slice(0, 200) } };
  }
}

function checkTcp(target, timeoutMs) {
  return new Promise((resolve) => {
    const m = String(target).match(/^\s*(?:\[([^\]]+)\]|([^:]+)):(\d+)\s*$/);
    if (!m) { resolve({ ok: false, meta: { error: 'invalid tcp target (expected host:port)' } }); return; }
    const host = m[1] || m[2];
    const port = Number(m[3]);
    const start = process.hrtime.bigint();
    let done = false;
    const sock = net.connect({ host, port });
    const finish = (ok, meta) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (e) { /* ignore */ }
      const r = { ok, meta };
      if (ok) r.latencyMs = round2(Number(process.hrtime.bigint() - start) / 1e6);
      resolve(r);
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => finish(true, {}));
    sock.on('timeout', () => finish(false, { error: 'timeout' }));
    sock.on('error', (e) => finish(false, { error: String((e && e.message) || e).slice(0, 120) }));
  });
}

function checkTraceroute(host, timeoutMs) {
  if (!isSafeHost(host)) return Promise.resolve({ ok: false, meta: { error: 'invalid target' } });
  return new Promise((resolve) => {
    execFile('traceroute', ['-n', '-q', '1', '-w', '1', '-m', '20', String(host)],
      { timeout: Math.max(timeoutMs, 25000) }, (err, stdout) => {
        if (err && err.code === 'ENOENT') { resolve(null); return; } // skip silently if missing
        const out = stdout || '';
        const hops = [];
        let replied = 0;
        for (const line of out.split('\n')) {
          const hm = line.match(/^\s*(\d+)\s+(.*)$/);
          if (!hm) continue;
          const hop = Number(hm[1]);
          const rest = hm[2];
          const ipM = rest.match(/(\d{1,3}(?:\.\d{1,3}){3}|(?:[0-9a-fA-F]{0,4}:){2,}[0-9a-fA-F]{0,4})/);
          const msM = rest.match(/([\d.]+)\s*ms/);
          const ip = ipM ? ipM[1] : null;
          const ms = msM ? round2(parseFloat(msM[1])) : null;
          if (ip) replied++;
          hops.push({ hop, ip, ms });
        }
        resolve({ ok: replied >= 1, meta: { hops } });
      });
  });
}

// --- lifecycle -------------------------------------------------------------
let shuttingDown = false;
const timers = [];

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logInfo('received ' + signal + '; shutting down');
  for (const t of timers) { try { clearInterval(t); } catch (e) { /* ignore */ } }
  try { if (journalProc) journalProc.kill('SIGTERM'); } catch (e) { /* ignore */ }
  try { await withTimeout(flushLogs(), 5000, 'flush'); } catch (e) { /* ignore */ }
  process.exit(0);
}

function printHelp() {
  process.stdout.write([
    'opscat-agent ' + VERSION,
    '',
    'Usage: opscat-agent [options]',
    '',
    'Env:  OPSCAT_URL, OPSCAT_AGENT_TOKEN, OPSCAT_PROBE_KEY',
    '',
    'Options:',
    '  --url <url>          OpsCat base URL (overrides OPSCAT_URL)',
    '  --token <token>      agent token (overrides OPSCAT_AGENT_TOKEN)',
    '  --probe-key <key>    probe key (overrides OPSCAT_PROBE_KEY)',
    '  --logs               ship journald logs to /v1/agents/logs',
    '  --probe              run synthetic checks (needs a probe key)',
    '  --interval <sec>     metrics/heartbeat interval (default 60)',
    '  --disk-path <path>   filesystem to report disk usage for (default /)',
    '  --dry-run            collect metrics once, print JSON, exit',
    '  --help               show this help',
    '',
  ].join('\n'));
}

async function main() {
  // dry-run: collect metrics once and print them, no network needed
  if (cfg.dryRun) {
    const metrics = await collectMetrics();
    // Print and let the event loop drain naturally — calling process.exit()
    // here can truncate stdout when it is a pipe.
    process.stdout.write(JSON.stringify(metrics, null, 2) + '\n');
    process.exitCode = 0;
    return;
  }

  if (!cfg.url) { logErr('config', 'OPSCAT_URL / --url not set'); process.exit(2); }
  // A host agent needs an agent token; a probe-only sensor needs only a probe
  // key. Require at least one credential for the chosen mode.
  const probeOnly = cfg.probe && !cfg.token;
  if (!cfg.token && !(cfg.probe && cfg.probeKey)) {
    logErr('config', 'need OPSCAT_AGENT_TOKEN (host agent) or --probe with OPSCAT_PROBE_KEY (sensor)');
    process.exit(2);
  }

  // never crash on an unexpected error
  process.on('uncaughtException', (e) => logErr('uncaught', (e && e.message) || String(e)));
  process.on('unhandledRejection', (e) => logErr('unhandledRejection', (e && e.message) || String(e)));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logInfo('starting agent v' + VERSION + ' → ' + cfg.url + (probeOnly ? ' (probe-only sensor)' :
    ' (interval=' + cfg.interval + 's, logs=' + cfg.logs + ', probe=' + cfg.probe + ')'));

  // heartbeat + metrics only when running as a host agent (needs the token)
  if (cfg.token) {
    tick().catch((e) => logErr('tick', (e && e.message) || String(e)));
    const metricsTimer = setInterval(() => { tick().catch((e) => logErr('tick', (e && e.message) || String(e))); }, cfg.interval * 1000);
    timers.push(metricsTimer);
    if (cfg.logs) startLogShipping();
  }
  if (cfg.probe) startProbe();
  if (logFlushTimer) timers.push(logFlushTimer);
  if (probeTimer) timers.push(probeTimer);
}

main().catch((e) => { logErr('main', (e && e.message) || String(e)); process.exit(1); });
