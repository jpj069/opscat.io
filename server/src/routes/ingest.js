'use strict';
// Open /v1 surface: API-key-authenticated ingest for logs, events, webhooks
// (incl. Sentry), agent heartbeat/metrics, remote probe reports.
const express = require('express');
const q = require('../db/shim');
const { now, sha256, clampInt, isStr, httpError } = require('../util');
const sec = require('../security');
const pipeline = require('../engine/pipeline');
const synthEngine = require('../engine/synthetics');
const plans = require('../plans');

const router = express.Router();

/* Daily log line allowance (plan limit; no-op on the community edition).
 * Returns true if allowed; otherwise sends a 429 and returns false.
 *
 * All three call sites read the answer into a boolean, so the await is
 * PARENTHESISED — `!(await withinIngestPlan(...))`. Without it `!Promise` is
 * `false`: the guard never fires, the handler ingests the batch anyway, and the
 * 429 is then written onto a response that has already been sent. The type gate
 * cannot see this shape (nothing reads a property off the Promise) and neither
 * can the strict thenable. */
async function withinIngestPlan(orgId, res) {
  const vol = await plans.checkIngestVolume(orgId);
  if (!vol.ok) {
    httpError(res, 429,
      `daily log ingest limit reached (${vol.used}/${vol.limit} lines today) — upgrade your plan for more`);
    return false;
  }
  return true;
}

// ---- logs: the "drop your logs here" endpoint ----
// Accepts {logs:[{ts?,device,line,sev?,meta?}]} or a bare array, max 500/batch.
router.post('/ingest/logs', sec.requireApiKey('ingest'), async (req, res) => {
  const body = req.body;
  const entries = Array.isArray(body) ? body : Array.isArray(body?.logs) ? body.logs : null;
  if (!entries) return httpError(res, 400, 'expected {logs:[...]} or [...]');
  if (entries.length === 0) return res.json({ accepted: 0, events: 0 });
  if (entries.length > 500) return httpError(res, 413, 'max 500 log entries per batch');
  if (!(await withinIngestPlan(req.orgId, res))) return;
  const result = await pipeline.ingestLogs(entries, req.apiKey.name, req.orgId);
  res.json(result);
});

// ---- direct event ingest ----
router.post('/ingest/events', sec.requireApiKey('ingest'), async (req, res) => {
  const { name, device, target, description, severity, ip, ts } = req.body || {};
  if (!isStr(name, 100) || !isStr(device, 100)) return httpError(res, 400, 'name and device required');
  const result = await pipeline.ingestEvent({
    name: name.replace(/[^\w.:/-]/g, '_'), device, target, description,
    severity: clampInt(severity, 0, 100, 50), ip, ts,
  }, req.apiKey.name, false, req.orgId);
  res.json(result);
});

// ---- generic webhook (e.g. alertmanager, custom) ----
router.post('/ingest/webhook', sec.requireApiKey('ingest'), async (req, res) => {
  const b = req.body || {};
  const device = isStr(b.device, 100) ? b.device : (isStr(b.host, 100) ? b.host : 'webhook');
  const name = isStr(b.name, 100) ? b.name : (isStr(b.alertname, 100) ? b.alertname : 'webhook_event');
  const description = isStr(b.message, 300) ? b.message : (isStr(b.description, 300) ? b.description : name);
  await pipeline.ingestEvent({
    name: name.replace(/[^\w.:/-]/g, '_'), device, target: isStr(b.target, 200) ? b.target : null,
    description, severity: clampInt(b.severity, 0, 100, 50),
  }, `webhook:${req.apiKey.name}`, false, req.orgId);
  res.json({ ok: true });
});

// ---- Sentry integration: point a Sentry webhook/alert action here ----
const SENTRY_LEVEL_SEV = { fatal: 92, error: 75, warning: 45, info: 20, debug: 10 };
// Accepts three Sentry shapes:
//  1. Legacy webhook plugin:  {project_name, message, level, culprit, event, url}
//  2. Internal-integration issue:  {action, data:{issue:{title, level, project:{slug}, culprit, metadata}}}
//  3. Internal-integration error:  {action, data:{error:{title, level, project, ...}}}
router.post('/integrations/sentry', sec.requireApiKey('ingest'), async (req, res) => {
  const b = req.body || {};
  const issue = b.data?.issue;
  const errorEv = b.data?.error;
  const ev = b.event || errorEv || {};
  const level = String(b.level || ev.level || issue?.level || 'error').toLowerCase();
  const projectRaw = b.project_name || b.project || ev.project ||
    issue?.project?.slug || errorEv?.project || issue?.project_name || 'sentry';
  const project = String(typeof projectRaw === 'object' ? (projectRaw.slug || 'sentry') : projectRaw).slice(0, 100);
  const title = String(b.message || ev.title || issue?.title || issue?.metadata?.value ||
    errorEv?.title || 'sentry event').slice(0, 300);
  const culprit = String(b.culprit || ev.culprit || issue?.culprit || errorEv?.culprit || '').slice(0, 200);
  const url = b.url || issue?.web_url || issue?.url || errorEv?.web_url || null;
  await pipeline.ingestEvent({
    name: 'sentry_' + (SENTRY_LEVEL_SEV[level] >= 75 ? 'error' : level),
    device: project,
    target: culprit || null,
    description: (url ? `${title} — ${url}` : title).slice(0, 300),
    severity: SENTRY_LEVEL_SEV[level] ?? 50,
  }, 'sentry', false, req.orgId);
  res.json({ ok: true });
});

// ---- OpenTelemetry (OTLP/HTTP, JSON encoding) ----
// Logs:   POST /v1/otlp/v1/logs   — fully ingested into the pipeline
// Traces: POST /v1/otlp/v1/traces — spans with error status become events
const OTLP_SEVERITY_TO_SYSLOG = (n) => {
  // OTel SeverityNumber: 1-4 TRACE, 5-8 DEBUG, 9-12 INFO, 13-16 WARN, 17-20 ERROR, 21-24 FATAL
  if (n >= 21) return 1; if (n >= 17) return 3; if (n >= 13) return 4;
  if (n >= 9) return 6; return 7;
};
function otlpAttr(attrs, key) {
  if (!Array.isArray(attrs)) return null;
  const a = attrs.find((x) => x && x.key === key);
  const v = a && a.value;
  return v ? (v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue ?? null) : null;
}
function otlpAnyValue(v) {
  if (v == null) return '';
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return String(v.intValue);
  if (v.doubleValue !== undefined) return String(v.doubleValue);
  if (v.boolValue !== undefined) return String(v.boolValue);
  if (v.kvlistValue || v.arrayValue) return JSON.stringify(v).slice(0, 2000);
  return '';
}

router.post('/otlp/v1/logs', sec.requireApiKey('ingest'), async (req, res) => {
  const resourceLogs = req.body?.resourceLogs;
  if (!Array.isArray(resourceLogs)) return httpError(res, 400, 'expected OTLP JSON {resourceLogs:[...]}');
  const entries = [];
  for (const rl of resourceLogs) {
    const service = otlpAttr(rl.resource?.attributes, 'service.name') ||
      otlpAttr(rl.resource?.attributes, 'host.name') || 'otel';
    for (const sl of rl.scopeLogs || []) {
      for (const lr of sl.logRecords || []) {
        if (entries.length >= 500) break;
        const tsNano = Number(lr.timeUnixNano || lr.observedTimeUnixNano || 0);
        entries.push({
          ts: tsNano ? Math.floor(tsNano / 1e6) : undefined,
          device: String(service).slice(0, 100),
          line: (otlpAnyValue(lr.body) || '(empty)').slice(0, 8192),
          sev: OTLP_SEVERITY_TO_SYSLOG(Number(lr.severityNumber || 9)),
          meta: lr.traceId ? { traceId: lr.traceId } : undefined,
        });
      }
    }
  }
  if (!(await withinIngestPlan(req.orgId, res))) return;
  res.json(await pipeline.ingestLogs(entries, `otlp:${req.apiKey.name}`, req.orgId));
});

router.post('/otlp/v1/traces', sec.requireApiKey('ingest'), async (req, res) => {
  const resourceSpans = req.body?.resourceSpans;
  if (!Array.isArray(resourceSpans)) return httpError(res, 400, 'expected OTLP JSON {resourceSpans:[...]}');
  let spans = 0, errors = 0;
  for (const rs of resourceSpans) {
    const service = otlpAttr(rs.resource?.attributes, 'service.name') || 'otel';
    for (const ss of rs.scopeSpans || []) {
      for (const span of ss.spans || []) {
        spans++;
        // STATUS_CODE_ERROR = 2
        if (span.status && Number(span.status.code) === 2 && errors < 100) {
          errors++;
          await pipeline.ingestEvent({
            name: 'otel_span_error',
            device: String(service).slice(0, 100),
            target: String(span.name || '').slice(0, 200),
            description: `otel_span_error ${span.name || ''} ${span.status.message || ''}`.trim().slice(0, 300),
            severity: 65,
          }, `otlp:${req.apiKey.name}`, false, req.orgId);
        }
      }
    }
  }
  res.json({ accepted: spans, errorEvents: errors });
});

router.post('/otlp/v1/metrics', sec.requireApiKey('ingest'), (req, res) => {
  // Accepted but not stored yet (documented); OTLP partialSuccess signals this.
  res.json({ partialSuccess: { rejectedDataPoints: 0, errorMessage: 'metrics accepted but not stored in this version' } });
});

// ---- agents ----
// Async since the shim, and the `await` is the authentication: unawaited, the
// pending query is a truthy object, `!agent` is false and every bearer token is
// accepted — with `req.agent` then a Promise that throws on first property read.
async function requireAgentToken(req, res, next) {
  const auth = req.headers.authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!token) return httpError(res, 401, 'missing agent token');
  const agent = await q.prepare('SELECT * FROM agents WHERE token_hash = ? AND active = 1').get(sha256(token));
  if (!agent) return httpError(res, 401, 'invalid agent token');
  req.agent = agent;
  next();
}

// The server image bundles the agent script so agents can self-update; read
// once at boot. Absent in exotic setups — updates are then simply disabled.
const AGENT_FILE = require('path').join(__dirname, '..', '..', '..', 'agent', 'opscat-agent.js');
let bundledAgent = null;
let bundledAgentVersion = null;
try {
  bundledAgent = require('fs').readFileSync(AGENT_FILE, 'utf8');
  bundledAgentVersion = (/const VERSION = '([^']+)'/.exec(bundledAgent) || [])[1] || null;
} catch { /* no bundled agent in this build */ }

router.post('/agents/heartbeat', requireAgentToken, async (req, res) => {
  const b = req.body || {};
  await q.prepare(`UPDATE agents SET last_seen_at = ?, hostname = COALESCE(?, hostname),
      platform = COALESCE(?, platform), version = COALESCE(?, version) WHERE id = ?`)
    .run(now(), isStr(b.hostname, 200) ? b.hostname : null,
      isStr(b.platform, 100) ? b.platform : null,
      isStr(b.version, 50) ? b.version : null, req.agent.id);
  const updateAvailable = !!(bundledAgentVersion && req.agent.auto_update
    && isStr(b.version, 50) && b.version !== bundledAgentVersion);
  res.json({ ok: true, intervalS: 60, latestVersion: bundledAgentVersion, updateAvailable });
});

// Self-update download: the agent fetches this when its heartbeat says
// updateAvailable, atomically replaces its own script and lets systemd restart it.
router.get('/agents/update', requireAgentToken, (req, res) => {
  if (!bundledAgent) return httpError(res, 404, 'no bundled agent in this build');
  res.setHeader('X-Agent-Version', bundledAgentVersion || '');
  res.type('application/javascript').send(bundledAgent);
});

// Container snapshot from the host agent (docker ps + stats). Raises a
// container_down event when a container that was running in the previous
// snapshot is now missing or in a non-running state.
router.post('/agents/containers', requireAgentToken, async (req, res) => {
  const list = Array.isArray(req.body && req.body.containers) ? req.body.containers.slice(0, 200) : [];
  const minute = Math.floor(now() / 60000) * 60000;
  const ins = q.prepare(`INSERT INTO agent_containers (agent_id, ts, name, image, state, cpu_pct, mem_used, mem_limit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id, ts, name) DO UPDATE SET image = excluded.image, state = excluded.state,
      cpu_pct = excluded.cpu_pct, mem_used = excluded.mem_used, mem_limit = excluded.mem_limit`);
  const num = (v) => (Number.isFinite(v) ? v : null);
  const nowRunning = new Set();
  let gone = [];

  // What has to be atomic here is "read the snapshot mine follows, then write
  // mine" — one unit per agent, so this agent's snapshots form an unbroken chain
  // and each is diffed against exactly its predecessor. The moment two of its
  // posts can interleave (which is what an `await` in a handler means — no
  // second process required), both read the SAME predecessor and the snapshot
  // between them is never diffed at all: a container that came up and went down
  // inside that window raises no `container_down`. No error, no counter, no log
  // line. The transaction covers two posts landing in the same minute; posts a
  // minute apart additionally need a per-agent lock, which only the Postgres
  // adapter can give us (SQLite has nothing to take one on).
  //
  // `q.withTx`, NOT `db.transaction`: better-sqlite3 COMMITs when the callback
  // RETURNS, so an async callback returns a pending promise and COMMIT fires
  // before the first awaited write — every statement below would land outside
  // the transaction, with no error and a rollback that covers nothing.
  await q.withTx(async () => {
    const prevTs = (await q.prepare('SELECT MAX(ts) ts FROM agent_containers WHERE agent_id = ? AND ts < ?')
      .get(req.agent.id, minute)).ts;
    const prevRunning = prevTs
      ? (await q.prepare("SELECT name FROM agent_containers WHERE agent_id = ? AND ts = ? AND state = 'running'")
        .all(req.agent.id, prevTs)).map((r) => r.name)
      : [];
    for (const c of list) {
      if (!isStr(c.name, 200)) continue;
      const state = isStr(c.state, 40) ? c.state : 'unknown';
      if (state === 'running') nowRunning.add(c.name);
      await ins.run(req.agent.id, minute, c.name, isStr(c.image, 300) ? c.image : null, state,
        num(c.cpuPct), num(c.memUsed), num(c.memLimit));
    }
    gone = prevRunning.filter((name) => !nowRunning.has(name));
  });

  // Deliberately OUTSIDE that unit: ingestEvent opens its own transaction and
  // fans out to the alert engine, which talks to Slack/Teams/webhooks. Holding a
  // write transaction across a network round trip pins a pooled connection for
  // the length of somebody else's HTTP timeout.
  for (const name of gone) {
    const cur = list.find((c) => c && c.name === name);
    await pipeline.ingestEvent({
      name: 'container_down', device: req.agent.name, target: name, severity: 65,
      description: `container_down ${name} on ${req.agent.name} (${cur ? cur.state : 'gone'})`,
    }, 'agents', false, req.agent.org_id);
  }
  res.json({ ok: true, stored: list.length });
});

router.post('/agents/metrics', requireAgentToken, async (req, res) => {
  const m = req.body || {};
  const num = (v) => (Number.isFinite(v) ? v : null);
  const minute = Math.floor(now() / 60000) * 60000;
  await q.prepare(`INSERT INTO agent_metrics (agent_id, ts, cpu_pct, load1, mem_used, mem_total,
      disk_used, disk_total, net_rx, net_tx) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id, ts) DO UPDATE SET cpu_pct = excluded.cpu_pct, load1 = excluded.load1,
      mem_used = excluded.mem_used, mem_total = excluded.mem_total, disk_used = excluded.disk_used,
      disk_total = excluded.disk_total, net_rx = excluded.net_rx, net_tx = excluded.net_tx`)
    .run(req.agent.id, minute, num(m.cpuPct), num(m.load1), num(m.memUsed), num(m.memTotal),
      num(m.diskUsed), num(m.diskTotal), num(m.netRx), num(m.netTx));
  await q.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?').run(now(), req.agent.id);

  // threshold events from agent metrics
  const name = req.agent.name;
  const org = req.agent.org_id;
  if (Number.isFinite(m.cpuPct) && m.cpuPct >= 95) {
    await pipeline.ingestEvent({ name: 'host_cpu_high', device: name, severity: 62,
      description: `host_cpu_high ${m.cpuPct.toFixed(0)}% on ${name}` }, 'agents', false, org);
  }
  if (Number.isFinite(m.memUsed) && Number.isFinite(m.memTotal) && m.memTotal > 0 &&
      m.memUsed / m.memTotal >= 0.95) {
    await pipeline.ingestEvent({ name: 'host_mem_high', device: name, severity: 70,
      description: `host_mem_high ${Math.round((m.memUsed / m.memTotal) * 100)}% on ${name}` }, 'agents', false, org);
  }
  if (Number.isFinite(m.diskUsed) && Number.isFinite(m.diskTotal) && m.diskTotal > 0 &&
      m.diskUsed / m.diskTotal >= 0.9) {
    await pipeline.ingestEvent({ name: 'host_disk_high', device: name, severity: 75,
      description: `host_disk_high ${Math.round((m.diskUsed / m.diskTotal) * 100)}% on ${name}` }, 'agents', false, org);
  }
  res.json({ ok: true });
});

// Agents can also ship logs with their token (no separate API key needed).
router.post('/agents/logs', requireAgentToken, async (req, res) => {
  const entries = Array.isArray(req.body?.logs) ? req.body.logs : null;
  if (!entries) return httpError(res, 400, 'expected {logs:[...]}');
  if (entries.length > 500) return httpError(res, 413, 'max 500 log entries per batch');
  if (!(await withinIngestPlan(req.agent.org_id, res))) return;
  res.json(await pipeline.ingestLogs(entries, `agent:${req.agent.name}`, req.agent.org_id));
});

// ---- remote probe reports ----
// Same rule as requireAgentToken: `!loc` on an unawaited query is always false,
// so the missing await would authenticate every probe key.
async function requireProbeKey(req, res, next) {
  const auth = req.headers.authorization;
  const key = auth && auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!key) return httpError(res, 401, 'missing probe key');
  const loc = await q.prepare('SELECT * FROM synthetic_locations WHERE probe_key_hash = ? AND active = 1')
    .get(sha256(key));
  if (!loc) return httpError(res, 401, 'invalid probe key');
  req.probeLocation = loc;
  next();
}

// Is a check allowed to run on / report from this probe location? Customer
// locations serve their own org; managed locations serve every org that
// booked them. In both cases an explicit check→location assignment
// (check_locations rows) narrows the set; no rows = all agents.
//
// Both reads below decide a BOOLEAN, which is the one class the type gate cannot
// see: `!booked` on a pending query is false and `assigned.some(...)` on one
// throws — so the awaits here are the cross-org guard on the report path, the
// counterpart to the work-list filter's hoisted query.
async function checkAllowedOnLocation(check, loc) {
  if (loc.kind === 'managed') {
    const booked = await q.prepare('SELECT 1 FROM org_location_access WHERE org_id = ? AND location_id = ?')
      .get(check.org_id, loc.id);
    if (!booked) return false;
  } else if (check.org_id !== loc.org_id) {
    return false;
  }
  const assigned = await q.prepare('SELECT location_id FROM check_locations WHERE check_id = ?').all(check.id);
  return assigned.length === 0 || assigned.some((a) => a.location_id === loc.id);
}

// Probe pulls its work list: own-org checks for customer locations, the union
// of all booking orgs' checks for managed locations — filtered by assignment.
router.get('/synthetics/checks', requireProbeKey, async (req, res) => {
  const loc = req.probeLocation;
  await q.prepare('UPDATE synthetic_locations SET last_seen_at = ? WHERE id = ?').run(now(), loc.id);
  if (loc.node_id) {
    const r = await q.prepare("UPDATE sensor_nodes SET status = 'online' WHERE id = ? AND status = 'provisioning'")
      .run(loc.node_id);
    // The provisioning -> online transition happens exactly once, when the VM's probe
    // first calls home. It is the moment a managed location actually starts working,
    // so it belongs in the history — with no user, because nobody clicked it.
    if (r.changes) {
      await q.prepare(`INSERT INTO node_timeline (location_id, label, ts, user_id, action, detail)
        VALUES (?, ?, ?, NULL, 'online', ?)`)
        .run(loc.id, `${loc.city} ${loc.cc}`, now(), 'first probe check-in');
    }
  }
  const rows = loc.kind === 'managed'
    ? await q.prepare(`SELECT c.* FROM synthetic_checks c
        JOIN org_location_access a ON a.org_id = c.org_id AND a.location_id = ?
        WHERE c.enabled = 1`).all(loc.id)
    : await q.prepare('SELECT * FROM synthetic_checks WHERE org_id = ? AND enabled = 1').all(loc.org_id);
  // The location filter is IN THE QUERY, not in a JS predicate, and that is a
  // tenant-isolation property rather than a tidy-up.
  //
  // It used to be `.filter(c => { const assigned = db…all(c.id); return … })`.
  // The moment the storage layer becomes async that callback returns a PROMISE,
  // a Promise is truthy, and the predicate keeps EVERY row — so a managed probe
  // location would be handed the check list of every organisation that booked
  // it. 200 OK, no log line, no test failure. See risk #1 in
  // docs/POSTGRES-MIGRATION-PLAN.md.
  //
  // As one statement there is no callback to get wrong, and it also stops being
  // N+1: one query per work-list request instead of one per check.
  const ids = rows.map((c) => c.id);
  const restricted = new Set();   // has at least one location row
  const assigned = new Set();     // …and one of them is THIS location
  if (ids.length) {
    // awaited HERE, before the loop — the two Sets are plain data by the time
    // the filter below runs, which is the whole point of the hoist
    for (const r of await q.prepare(`SELECT check_id, location_id FROM check_locations
      WHERE check_id IN (${ids.map(() => '?').join(',')})`).all(...ids)) {
      restricted.add(r.check_id);
      if (r.location_id === loc.id) assigned.add(r.check_id);
    }
  }
  res.json(rows
    // a check with no location rows runs everywhere; one with rows runs only
    // where it was assigned — the same rule, expressed without a query inside it.
    // The predicate is SYNCHRONOUS and must stay that way: an async one returns
    // a Promise, a Promise is truthy, and every check of every booking org would
    // be handed to this probe.
    .filter((c) => !restricted.has(c.id) || assigned.has(c.id))
    .map((c) => ({ id: c.id, type: c.type, target: c.target,
      intervalS: c.interval_s, timeoutMs: c.timeout_ms })));
});

// …and reports results (only for checks this location is allowed to serve —
// no cross-org injection).
router.post('/synthetics/report', requireProbeKey, async (req, res) => {
  const results = Array.isArray(req.body?.results) ? req.body.results : null;
  if (!results) return httpError(res, 400, 'expected {results:[...]}');
  if (results.length > 200) return httpError(res, 413, 'max 200 results per batch');
  const t = now();
  let accepted = 0;
  for (const r of results) {
    const checkId = clampInt(r.checkId, 1, 1e9, 0);
    if (!checkId) continue;
    const chk = await q.prepare('SELECT id, org_id, type FROM synthetic_checks WHERE id = ?').get(checkId);
    if (!chk || !(await checkAllowedOnLocation(chk, req.probeLocation))) continue;
    await synthEngine.recordResult(checkId, req.probeLocation.id, {
      ok: !!r.ok, latency: Number.isFinite(r.latencyMs) ? r.latencyMs : null,
      meta: r.meta && typeof r.meta === 'object' ? r.meta : null,
    }, Number.isFinite(r.ts) ? r.ts : t);
    accepted++;
  }
  await q.prepare('UPDATE synthetic_locations SET last_seen_at = ? WHERE id = ?')
    .run(t, req.probeLocation.id);
  res.json({ accepted });
});

module.exports = router;
