'use strict';
// Open /v1 surface: API-key-authenticated ingest for logs, events, webhooks
// (incl. Sentry), agent heartbeat/metrics, remote probe reports.
const express = require('express');
const { db } = require('../db');
const { now, sha256, clampInt, isStr, httpError } = require('../util');
const sec = require('../security');
const pipeline = require('../engine/pipeline');
const synthEngine = require('../engine/synthetics');

const router = express.Router();

// ---- logs: the "drop your logs here" endpoint ----
// Accepts {logs:[{ts?,device,line,sev?,meta?}]} or a bare array, max 500/batch.
router.post('/ingest/logs', sec.requireApiKey('ingest'), (req, res) => {
  const body = req.body;
  const entries = Array.isArray(body) ? body : Array.isArray(body?.logs) ? body.logs : null;
  if (!entries) return httpError(res, 400, 'expected {logs:[...]} or [...]');
  if (entries.length === 0) return res.json({ accepted: 0, events: 0 });
  if (entries.length > 500) return httpError(res, 413, 'max 500 log entries per batch');
  const result = pipeline.ingestLogs(entries, req.apiKey.name, req.orgId);
  res.json(result);
});

// ---- direct event ingest ----
router.post('/ingest/events', sec.requireApiKey('ingest'), (req, res) => {
  const { name, device, target, description, severity, ip, ts } = req.body || {};
  if (!isStr(name, 100) || !isStr(device, 100)) return httpError(res, 400, 'name and device required');
  const result = pipeline.ingestEvent({
    name: name.replace(/[^\w.:/-]/g, '_'), device, target, description,
    severity: clampInt(severity, 0, 100, 50), ip, ts,
  }, req.apiKey.name, false, req.orgId);
  res.json(result);
});

// ---- generic webhook (e.g. alertmanager, custom) ----
router.post('/ingest/webhook', sec.requireApiKey('ingest'), (req, res) => {
  const b = req.body || {};
  const device = isStr(b.device, 100) ? b.device : (isStr(b.host, 100) ? b.host : 'webhook');
  const name = isStr(b.name, 100) ? b.name : (isStr(b.alertname, 100) ? b.alertname : 'webhook_event');
  const description = isStr(b.message, 300) ? b.message : (isStr(b.description, 300) ? b.description : name);
  pipeline.ingestEvent({
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
router.post('/integrations/sentry', sec.requireApiKey('ingest'), (req, res) => {
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
  pipeline.ingestEvent({
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

router.post('/otlp/v1/logs', sec.requireApiKey('ingest'), (req, res) => {
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
  res.json(pipeline.ingestLogs(entries, `otlp:${req.apiKey.name}`, req.orgId));
});

router.post('/otlp/v1/traces', sec.requireApiKey('ingest'), (req, res) => {
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
          pipeline.ingestEvent({
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
function requireAgentToken(req, res, next) {
  const auth = req.headers.authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!token) return httpError(res, 401, 'missing agent token');
  const agent = db.prepare('SELECT * FROM agents WHERE token_hash = ? AND active = 1').get(sha256(token));
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

router.post('/agents/heartbeat', requireAgentToken, (req, res) => {
  const b = req.body || {};
  db.prepare(`UPDATE agents SET last_seen_at = ?, hostname = COALESCE(?, hostname),
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

router.post('/agents/metrics', requireAgentToken, (req, res) => {
  const m = req.body || {};
  const num = (v) => (Number.isFinite(v) ? v : null);
  const minute = Math.floor(now() / 60000) * 60000;
  db.prepare(`INSERT INTO agent_metrics (agent_id, ts, cpu_pct, load1, mem_used, mem_total,
      disk_used, disk_total, net_rx, net_tx) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id, ts) DO UPDATE SET cpu_pct = excluded.cpu_pct, load1 = excluded.load1,
      mem_used = excluded.mem_used, mem_total = excluded.mem_total, disk_used = excluded.disk_used,
      disk_total = excluded.disk_total, net_rx = excluded.net_rx, net_tx = excluded.net_tx`)
    .run(req.agent.id, minute, num(m.cpuPct), num(m.load1), num(m.memUsed), num(m.memTotal),
      num(m.diskUsed), num(m.diskTotal), num(m.netRx), num(m.netTx));
  db.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?').run(now(), req.agent.id);

  // threshold events from agent metrics
  const name = req.agent.name;
  const org = req.agent.org_id;
  if (Number.isFinite(m.cpuPct) && m.cpuPct >= 95) {
    pipeline.ingestEvent({ name: 'host_cpu_high', device: name, severity: 62,
      description: `host_cpu_high ${m.cpuPct.toFixed(0)}% on ${name}` }, 'agents', false, org);
  }
  if (Number.isFinite(m.memUsed) && Number.isFinite(m.memTotal) && m.memTotal > 0 &&
      m.memUsed / m.memTotal >= 0.95) {
    pipeline.ingestEvent({ name: 'host_mem_high', device: name, severity: 70,
      description: `host_mem_high ${Math.round((m.memUsed / m.memTotal) * 100)}% on ${name}` }, 'agents', false, org);
  }
  if (Number.isFinite(m.diskUsed) && Number.isFinite(m.diskTotal) && m.diskTotal > 0 &&
      m.diskUsed / m.diskTotal >= 0.9) {
    pipeline.ingestEvent({ name: 'host_disk_high', device: name, severity: 75,
      description: `host_disk_high ${Math.round((m.diskUsed / m.diskTotal) * 100)}% on ${name}` }, 'agents', false, org);
  }
  res.json({ ok: true });
});

// Agents can also ship logs with their token (no separate API key needed).
router.post('/agents/logs', requireAgentToken, (req, res) => {
  const entries = Array.isArray(req.body?.logs) ? req.body.logs : null;
  if (!entries) return httpError(res, 400, 'expected {logs:[...]}');
  if (entries.length > 500) return httpError(res, 413, 'max 500 log entries per batch');
  res.json(pipeline.ingestLogs(entries, `agent:${req.agent.name}`, req.agent.org_id));
});

// ---- remote probe reports ----
function requireProbeKey(req, res, next) {
  const auth = req.headers.authorization;
  const key = auth && auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!key) return httpError(res, 401, 'missing probe key');
  const loc = db.prepare('SELECT * FROM synthetic_locations WHERE probe_key_hash = ? AND active = 1')
    .get(sha256(key));
  if (!loc) return httpError(res, 401, 'invalid probe key');
  req.probeLocation = loc;
  next();
}

// Probe pulls its work list… (only its own org's checks)
router.get('/synthetics/checks', requireProbeKey, (req, res) => {
  db.prepare('UPDATE synthetic_locations SET last_seen_at = ? WHERE id = ?')
    .run(now(), req.probeLocation.id);
  res.json(db.prepare('SELECT id, type, target, interval_s, timeout_ms FROM synthetic_checks WHERE org_id = ? AND enabled = 1')
    .all(req.probeLocation.org_id).map((c) => ({ id: c.id, type: c.type, target: c.target,
      intervalS: c.interval_s, timeoutMs: c.timeout_ms })));
});

// …and reports results (only for checks in the probe's org — no cross-org injection).
router.post('/synthetics/report', requireProbeKey, (req, res) => {
  const results = Array.isArray(req.body?.results) ? req.body.results : null;
  if (!results) return httpError(res, 400, 'expected {results:[...]}');
  if (results.length > 200) return httpError(res, 413, 'max 200 results per batch');
  const t = now();
  let accepted = 0;
  for (const r of results) {
    const checkId = clampInt(r.checkId, 1, 1e9, 0);
    if (!checkId) continue;
    const chk = db.prepare('SELECT org_id FROM synthetic_checks WHERE id = ?').get(checkId);
    if (!chk || chk.org_id !== req.probeLocation.org_id) continue;
    synthEngine.recordResult(checkId, req.probeLocation.id, {
      ok: !!r.ok, latency: Number.isFinite(r.latencyMs) ? r.latencyMs : null,
      meta: r.meta && typeof r.meta === 'object' ? r.meta : null,
    }, Number.isFinite(r.ts) ? r.ts : t);
    accepted++;
  }
  db.prepare('UPDATE synthetic_locations SET last_seen_at = ? WHERE id = ?')
    .run(t, req.probeLocation.id);
  res.json({ accepted });
});

module.exports = router;
