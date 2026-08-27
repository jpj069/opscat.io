'use strict';
// Open /v1 surface: API-key-authenticated ingest for logs, events, webhooks
// (incl. Sentry), agent heartbeat/metrics, remote probe reports.
const express = require('express');
const q = require('../db/shim');
const { now, sha256, clampInt, isStr, httpError } = require('../util');
const sec = require('../security');
const { resolveUserAgent } = require('../lib/useragent');
const { getOrgSetting } = require('../db');
const pipeline = require('../engine/pipeline');
const synthEngine = require('../engine/synthetics');
const plans = require('../plans');
const { createRouteRegistrar, ApiProblem } = require('../lib/route-schema');
const S = require('../schemas/ingest');
const SY = require('../schemas/syslog');
const crypto = require('crypto');
const config = require('../config');
const wg = require('../lib/wireguard');

const router = express.Router();

/* Schema-first registration for this file's converted routes. The remaining
 * raw `router.post(...)` handlers below are counted by scripts/check-api-schema.js
 * and migrate one at a time; see docs/API-CONTRACT.md. */
const route = createRouteRegistrar(router, '/v1');

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
route({
  method: 'post', path: '/ingest/logs',
  summary: 'Ingest log lines',
  description: 'Accepts {logs:[…]} or a bare array, max 500 entries per batch. '
    + 'Lines are classified and deduplicated into events by the pipeline.',
  tags: ['Ingest'], auth: 'apiKey',
  middleware: [sec.requireApiKey('ingest')],
  body: S.IngestLogsBody,
  responses: { 200: S.IngestResult, 400: S.ErrorResponse, 413: S.ErrorResponse, 429: S.ErrorResponse },
}, async ({ body, req, res }) => {
  const entries = Array.isArray(body) ? body : body.logs;
  if (entries.length === 0) return { accepted: 0, events: 0 };
  if (entries.length > 500) throw new ApiProblem(413, 'max 500 log entries per batch');
  // Sends its own 429; returning undefined hands the already-written response
  // through the registrar's escape hatch untouched.
  if (!(await withinIngestPlan(req.orgId, res))) return undefined;
  return pipeline.ingestLogs(entries, req.apiKey.name, req.orgId);
});

/* ---- the syslog collector ------------------------------------------------
 *
 * Two routes, and both exist rather than reusing `/v1/ingest/logs` for one
 * reason: SCOPE. A collector key lives in an env file on a machine inside a
 * customer's network, and `ingest` would also let it post events and webhooks.
 * `collector` lets it do exactly one thing.
 *
 * Everything else is deliberately shared — `withinIngestPlan` above and
 * `pipeline.ingestLogs` below are the same code the SDK path runs, so syslog
 * lines are classified, deduplicated, folded into `event_buckets` and counted
 * against the same daily allowance. A second write path would have been a
 * second set of answers to all four.
 */
const qEndpointByKey = q.prepare(`SELECT id, name, device_prefix, enabled
  FROM syslog_endpoints WHERE api_key_id = ? AND org_id = ?`);

route({
  method: 'get', path: '/collector/config',
  summary: 'Configuration for a syslog collector',
  description: 'Polled by the collector at boot and periodically, so a device prefix or a '
    + 'disabled endpoint takes effect without anyone editing a file on the customer\'s host.',
  tags: ['Ingest'], auth: 'apiKey',
  middleware: [sec.requireApiKey('collector')],
  responses: { 200: SY.CollectorConfig, 404: S.ErrorResponse },
}, async ({ req }) => {
  const e = await qEndpointByKey.get(req.apiKey.id, req.orgId);
  if (!e) throw new ApiProblem(404, 'this key belongs to no endpoint');
  return {
    endpointId: Number(e.id),
    name: e.name,
    devicePrefix: e.device_prefix || null,
    enabled: !!e.enabled,
    batchMax: 500,      // the cap /v1/ingest/logs enforces; told rather than guessed
    flushMs: 2000,
  };
});

route({
  method: 'post', path: '/collector/logs',
  summary: 'Ingest syslog lines from a collector',
  description: 'Same body and the same 500-line cap as /v1/ingest/logs, authenticated with '
    + 'a collector key. Lines from a disabled endpoint are refused, not silently dropped.',
  tags: ['Ingest'], auth: 'apiKey',
  middleware: [sec.requireApiKey('collector')],
  body: S.IngestLogsBody,
  responses: { 200: S.IngestResult, 400: S.ErrorResponse, 403: S.ErrorResponse,
    404: S.ErrorResponse, 413: S.ErrorResponse, 429: S.ErrorResponse },
}, async ({ body, req, res }) => {
  const entries = Array.isArray(body) ? body : body.logs;
  if (entries.length === 0) return { accepted: 0, events: 0 };
  if (entries.length > 500) throw new ApiProblem(413, 'max 500 log entries per batch');
  const e = await qEndpointByKey.get(req.apiKey.id, req.orgId);
  if (!e) throw new ApiProblem(404, 'this key belongs to no endpoint');
  /* Parenthesised, and the endpoint is re-read on every batch rather than
   * trusted from the key: `enabled` is the switch an operator flips to silence
   * a site that has gone mad, and a cached answer would keep ingesting for as
   * long as the cache lived. */
  if (!e.enabled) throw new ApiProblem(403, 'this endpoint is disabled');
  if (!(await withinIngestPlan(req.orgId, res))) return undefined;
  return pipeline.ingestLogs(entries, req.apiKey.name, req.orgId);
});

/* ---- the syslog tunnel ----------------------------------------------------
 *
 * Stage 3. Inside a WireGuard tunnel there is no credential in the message at
 * all: the kernel refuses to carry a packet whose source is not in the sending
 * peer's AllowedIPs, so the inner address IS the tenant, and an appliance that
 * can only speak plain UDP/514 becomes attributable. That is the whole feature.
 *
 * ── What the gateway is allowed to know, and why it is this little ──────────
 *
 * Something has to terminate the tunnel, and whatever does is trusted — that is
 * inherent, not a weakness of this design. The question worth answering is how
 * much a stolen gateway credential is worth, and the answer was chosen rather
 * than inherited.
 *
 * The obvious shape is to hand the gateway a map of inner address → the
 * endpoint's COLLECTOR KEY, and let it ship through `/v1/collector/logs` like
 * everything else. That would mean one credential whose theft yields every
 * tenant's write key, in plaintext, reusable from anywhere, for as long as
 * nobody rotates them all.
 *
 * So instead the gateway asserts the source address and the SERVER resolves the
 * tenant. `/v1/tunnel/peers` hands out public keys and addresses — nothing
 * secret — and `/v1/tunnel/logs` takes `{sourceIp, logs}`. A stolen gateway key
 * can still write into any tenant, which is unavoidable, but only through this
 * endpoint, only while it is valid, and only in a way that is attributable to
 * the gateway rather than indistinguishable from the customer's own relay.
 *
 * ── The key is infrastructure configuration, not a tenant credential ────────
 *
 * `OPSCAT_TUNNEL_GATEWAY_KEY`, shared by compose with the gateway container the
 * same way `CLICKHOUSE_PASSWORD` is. Unset means the whole path does not exist:
 * an instance with no tunnel gateway must not answer here at all, rather than
 * answer 401 and advertise that it would.
 */
const tunnelPeers = q.prepare(
  `SELECT id, tunnel_ip, peer_pubkey FROM syslog_endpoints
   WHERE mode = 'tunnel' AND tunnel_ip IS NOT NULL AND peer_pubkey IS NOT NULL
   ORDER BY tunnel_ip`);
const tunnelByIp = q.prepare(
  `SELECT id, org_id, name, device_prefix, enabled FROM syslog_endpoints
   WHERE tunnel_ip = ? AND mode = 'tunnel'`);

/**
 * Timing-safe, and length-safe before that: `timingSafeEqual` THROWS on a
 * length mismatch, so comparing a supplied string of the wrong size would turn
 * an authentication failure into a 500 — and a 500 is a perfectly good oracle
 * for "your guess was the wrong length".
 */
function tunnelAuthed(req) {
  const want = config.tunnelGatewayKey;
  if (!want) return false;
  const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireTunnelGateway(req, res, next) {
  // 404, not 403: an instance that runs no tunnel gateway should look like one
  // that has never heard of the feature.
  if (!config.tunnelGatewayKey) return httpError(res, 404, 'not found');
  if (!tunnelAuthed(req)) return httpError(res, 401, 'unauthorized');
  return next();
}

route({
  method: 'get', path: '/tunnel/peers',
  summary: 'The WireGuard peers the tunnel gateway should configure',
  description: 'Public keys and inner addresses only — there is nothing secret in this '
    + 'response. Polled by the gateway, which reconciles its interface against it.',
  tags: ['Ingest'], auth: 'apiKey',
  middleware: [requireTunnelGateway],
  responses: { 200: SY.TunnelPeers, 401: S.ErrorResponse, 404: S.ErrorResponse },
}, async () => ({
  net: config.tunnelNet,
  peers: (await tunnelPeers.all()).map((p) => ({
    endpointId: Number(p.id), ip: p.tunnel_ip, publicKey: p.peer_pubkey,
  })),
}));

route({
  method: 'post', path: '/tunnel/logs',
  summary: 'Ingest syslog lines that arrived through the tunnel',
  description: 'The gateway asserts the inner source address; the tenant is resolved here. '
    + 'Same 500-line cap, same pipeline and the same daily allowance as every other path.',
  tags: ['Ingest'], auth: 'apiKey',
  middleware: [requireTunnelGateway],
  body: SY.TunnelLogsBody,
  responses: { 200: S.IngestResult, 400: S.ErrorResponse, 401: S.ErrorResponse,
    403: S.ErrorResponse, 404: S.ErrorResponse, 413: S.ErrorResponse, 429: S.ErrorResponse },
}, async ({ body, res }) => {
  const entries = Array.isArray(body.logs) ? body.logs : [];
  if (entries.length === 0) return { accepted: 0, events: 0 };
  if (entries.length > 500) throw new ApiProblem(413, 'max 500 log entries per batch');
  /* The address is checked against the POOL before it is looked up. A lookup
   * alone would be safe — an address outside the pool simply matches no row —
   * but this refusal says something different and worth saying: a packet from
   * outside the inner network did not come through the tunnel, so either the
   * gateway is bound to the wrong interface or something is forging. Neither is
   * a "no such endpoint". */
  if (!wg.inPool(config.tunnelNet, body.sourceIp)) {
    throw new ApiProblem(400, 'sourceIp is not inside the tunnel network');
  }
  const e = await tunnelByIp.get(body.sourceIp);
  if (!e) throw new ApiProblem(404, 'no endpoint holds that inner address');
  // Re-read every batch, never cached: `enabled` is what an operator flips to
  // silence a site, and it has to take effect on the next batch.
  if (!e.enabled) throw new ApiProblem(403, 'this endpoint is disabled');
  if (!(await withinIngestPlan(e.org_id, res))) return undefined;
  /* The device prefix is applied HERE rather than at the gateway, unlike every
   * other syslog path — because the gateway does not know which endpoint a
   * packet belongs to, and telling it would mean shipping it the very mapping
   * this design keeps server-side. */
  const pfx = e.device_prefix || '';
  const logs = pfx
    ? entries.map((x) => Object.assign({}, x, { device: pfx + String(x.device || 'unknown') }))
    : entries;
  return pipeline.ingestLogs(logs, e.name, e.org_id);
});

// ---- direct event ingest ----
route({
  method: 'post', path: '/ingest/events',
  summary: 'Ingest a single event',
  description: 'Bypasses log classification — use when the caller already knows this is an event.',
  tags: ['Ingest'], auth: 'apiKey',
  middleware: [sec.requireApiKey('ingest')],
  body: S.IngestEventBody,
  responses: { 200: S.IngestResult, 400: S.ErrorResponse },
}, async ({ body, req }) => {
  const { name, device, target, description, severity, ip, ts } = body;
  // The schema already guarantees both are strings <= 100; clampInt still owns
  // severity because it accepts anything and this surface must stay lenient.
  return pipeline.ingestEvent({
    name: name.replace(/[^\w.:/-]/g, '_'), device, target, description,
    severity: clampInt(severity, 0, 100, 50), ip, ts,
  }, req.apiKey.name, false, req.orgId);
});

// ---- generic webhook (e.g. alertmanager, custom) ----
route({
  method: 'post', path: '/ingest/webhook',
  summary: 'Ingest an event from a generic webhook',
  description: 'Tolerant by design: Alertmanager-style keys are recognised, anything else is accepted and '
    + 'mapped onto sensible defaults.',
  tags: ['Ingest'], auth: 'apiKey',
  middleware: [sec.requireApiKey('ingest')],
  body: S.IngestWebhookBody,
  responses: { 200: S.OkResponse, 400: S.ErrorResponse },
}, async ({ body, req }) => {
  const b = body;
  const device = isStr(b.device, 100) ? b.device : (isStr(b.host, 100) ? b.host : 'webhook');
  const name = isStr(b.name, 100) ? b.name : (isStr(b.alertname, 100) ? b.alertname : 'webhook_event');
  const description = isStr(b.message, 300) ? b.message : (isStr(b.description, 300) ? b.description : name);
  await pipeline.ingestEvent({
    name: name.replace(/[^\w.:/-]/g, '_'), device, target: isStr(b.target, 200) ? b.target : null,
    description, severity: clampInt(b.severity, 0, 100, 50),
  }, `webhook:${req.apiKey.name}`, false, req.orgId);
  return { ok: true };
});

// ---- Sentry integration: point a Sentry webhook/alert action here ----
const SENTRY_LEVEL_SEV = { fatal: 92, error: 75, warning: 45, info: 20, debug: 10 };
// Accepts three Sentry shapes:
//  1. Legacy webhook plugin:  {project_name, message, level, culprit, event, url}
//  2. Internal-integration issue:  {action, data:{issue:{title, level, project:{slug}, culprit, metadata}}}
//  3. Internal-integration error:  {action, data:{error:{title, level, project, ...}}}
route({
  method: 'post', path: '/integrations/sentry',
  summary: 'Ingest a Sentry alert',
  description: 'Point a Sentry webhook or alert action here. Three payload shapes are recognised: the legacy '
    + 'webhook plugin, an internal-integration issue alert, and an error alert.',
  tags: ['Ingest'], auth: 'apiKey',
  middleware: [sec.requireApiKey('ingest')],
  body: S.SentryBody,
  responses: { 200: S.OkResponse, 400: S.ErrorResponse },
}, async ({ req }) => {
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
  return { ok: true };
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

route({
  method: 'post', path: '/otlp/v1/logs',
  summary: 'Ingest OTLP logs',
  description: 'OTLP/HTTP JSON. Up to 500 log records per request are stored; severityNumber is mapped to syslog.',
  tags: ['Ingest'], auth: 'apiKey',
  middleware: [sec.requireApiKey('ingest')],
  body: S.OtlpLogsBody,
  responses: { 200: S.IngestResult, 400: S.ErrorResponse, 429: S.ErrorResponse },
}, async ({ body, req, res }) => {
  const resourceLogs = body.resourceLogs;
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
  if (!(await withinIngestPlan(req.orgId, res))) return undefined;  // 429 already sent
  return pipeline.ingestLogs(entries, `otlp:${req.apiKey.name}`, req.orgId);
});

route({
  method: 'post', path: '/otlp/v1/traces',
  summary: 'Ingest OTLP traces',
  description: 'OTLP/HTTP JSON. Spans with status.code = 2 (ERROR) become events, up to 100 per request.',
  tags: ['Ingest'], auth: 'apiKey',
  middleware: [sec.requireApiKey('ingest')],
  body: S.OtlpTracesBody,
  responses: { 200: S.OtlpTracesResult, 400: S.ErrorResponse },
}, async ({ body, req }) => {
  const resourceSpans = body.resourceSpans;
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
  return { accepted: spans, errorEvents: errors };
});

route({
  method: 'post', path: '/otlp/v1/metrics',
  summary: 'Ingest OTLP metrics (accepted, not stored)',
  description: 'Accepted and discarded in this version. OTLP partialSuccess is how that is signalled, so an '
    + 'exporter pointed here does not retry forever.',
  tags: ['Ingest'], auth: 'apiKey',
  middleware: [sec.requireApiKey('ingest')],
  responses: { 200: S.OtlpMetricsResult },
}, () => ({
  partialSuccess: { rejectedDataPoints: 0, errorMessage: 'metrics accepted but not stored in this version' },
}));

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

route({
  method: 'post', path: '/agents/heartbeat',
  summary: 'Agent heartbeat',
  description: 'Updates last-seen plus the reported hostname/platform/version, and tells the agent whether a '
    + 'newer bundled version is available.',
  tags: ['Agents'], auth: 'agentToken',
  middleware: [requireAgentToken],
  body: S.AgentHeartbeatBody,
  responses: { 200: S.AgentHeartbeatResult },
}, async ({ req }) => {
  const b = req.body || {};
  await q.prepare(`UPDATE agents SET last_seen_at = ?, hostname = COALESCE(?, hostname),
      platform = COALESCE(?, platform), version = COALESCE(?, version) WHERE id = ?`)
    .run(now(), isStr(b.hostname, 200) ? b.hostname : null,
      isStr(b.platform, 100) ? b.platform : null,
      isStr(b.version, 50) ? b.version : null, req.agent.id);
  const updateAvailable = !!(bundledAgentVersion && req.agent.auto_update
    && isStr(b.version, 50) && b.version !== bundledAgentVersion);
  return { ok: true, intervalS: 60, latestVersion: bundledAgentVersion, updateAvailable };
});

/* Self-update download: the agent fetches this when its heartbeat says
 * updateAvailable, atomically replaces its own script and lets systemd restart it.
 *
 * Registered rather than raw, and it took a `contentType` on the spec to do it:
 * the generator hard-coded `application/json`, so declaring this route would
 * have put a lie in the spec — which is worse than being absent from it. The
 * handler answers through `res` and returns undefined, i.e. the registrar's
 * documented escape hatch; what registration buys is that the route is IN
 * `/openapi.json` and the ratchet in `check-api-schema.js` counts it. */
route({
  method: 'get', path: '/agents/update',
  summary: 'Download the agent script this build bundles',
  description: 'The host agent fetches this when its heartbeat answers updateAvailable, replaces its own '
    + 'file atomically and exits for systemd to restart it.',
  tags: ['Agents'], auth: 'agentToken',
  middleware: [requireAgentToken],
  contentType: 'application/javascript',
  responses: { 200: S.AgentScript, 404: S.ErrorResponse },
}, ({ res }) => {
  if (!bundledAgent) return httpError(res, 404, 'no bundled agent in this build');
  res.setHeader('X-Agent-Version', bundledAgentVersion || '');
  res.type('application/javascript').send(bundledAgent);
  return undefined;
});

// Container snapshot from the host agent (docker ps + stats). Raises a
// container_down event when a container that was running in the previous
// snapshot is now missing or in a non-running state.
route({
  method: 'post', path: '/agents/containers',
  summary: 'Container snapshot from the host agent',
  description: 'docker ps + stats. A container that was running in the previous snapshot and is now missing or '
    + 'not running raises a container_down event.',
  tags: ['Agents'], auth: 'agentToken',
  middleware: [requireAgentToken],
  body: S.AgentContainersBody,
  responses: { 200: S.AgentContainersResult },
}, async ({ req }) => {
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
  return { ok: true, stored: list.length };
});

route({
  method: 'post', path: '/agents/metrics',
  summary: 'Host metrics from the agent',
  description: 'cpu, load, memory and disk. Values that are not finite numbers are stored as null; a disk at '
    + '>= 90% raises a host_disk_high event.',
  tags: ['Agents'], auth: 'agentToken',
  middleware: [requireAgentToken],
  body: S.AgentMetricsBody,
  responses: { 200: S.OkResponse },
}, async ({ req }) => {
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
  return { ok: true };
});

// Agents can also ship logs with their token (no separate API key needed).
route({
  method: 'post', path: '/agents/logs',
  summary: 'Ship logs with an agent token',
  description: 'The same pipeline as /v1/ingest/logs, authenticated by the agent token so an installed agent '
    + 'needs no separate API key.',
  tags: ['Agents'], auth: 'agentToken',
  middleware: [requireAgentToken],
  body: S.AgentLogsBody,
  responses: { 200: S.IngestResult, 400: S.ErrorResponse, 413: S.ErrorResponse, 429: S.ErrorResponse },
}, async ({ body, req, res }) => {
  const entries = body.logs;
  if (entries.length > 500) throw new ApiProblem(413, 'max 500 log entries per batch');
  if (!(await withinIngestPlan(req.agent.org_id, res))) return undefined;  // 429 already sent
  return pipeline.ingestLogs(entries, `agent:${req.agent.name}`, req.agent.org_id);
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
route({
  method: 'get', path: '/synthetics/checks',
  summary: 'Checks this probe location should run',
  description: 'Also marks the location as seen, and flips a managed node from provisioning to online on its '
    + 'first call.',
  tags: ['Probes'], auth: 'probeKey',
  middleware: [requireProbeKey],
  responses: { 200: S.SyntheticChecksResult },
}, async ({ req, res }) => {
  const loc = req.probeLocation;
  /* The work-list pull is the ONLY thing a probe-only sensor calls on a
   * schedule, so it is where the version conversation has to happen. A sensor
   * carries a probe key and no agent token, so it never reaches
   * `/v1/agents/heartbeat` — which is why `sensor_nodes.agent_version` was read
   * in four places and written in none, and why every managed node showed a
   * dash for its version forever.
   *
   * Both directions ride on HEADERS rather than the body: the response is a bare
   * JSON array that older agents parse with `Array.isArray(...) ? … : []`, so
   * wrapping it in an object would silently stop every deployed sensor.
   */
  const reported = String(req.headers['x-opscat-agent-version'] || '').slice(0, 50);
  if (reported && loc.node_id && /^[0-9a-zA-Z.\-+]+$/.test(reported)) {
    await q.prepare('UPDATE sensor_nodes SET agent_version = ? WHERE id = ?').run(reported, loc.node_id);
  }
  if (bundledAgentVersion) res.setHeader('X-OpsCat-Agent-Latest', bundledAgentVersion);
  // The source address is recorded here rather than at provisioning time
  // because it is the only place that knows the truth for EVERY kind of probe:
  // a self-hosted agent has no cloud API to ask, and an auto-provisioned node's
  // public IP is ephemeral and can change under it. It is what the UI shows
  // when someone has to allow-list the monitor at a firewall.
  await q.prepare('UPDATE synthetic_locations SET last_seen_at = ?, last_ip = ? WHERE id = ?')
    .run(now(), sec.clientIp(req).slice(0, 45) || null, loc.id);
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
  return (rows
    // a check with no location rows runs everywhere; one with rows runs only
    // where it was assigned — the same rule, expressed without a query inside it.
    // The predicate is SYNCHRONOUS and must stay that way: an async one returns
    // a Promise, a Promise is truthy, and every check of every booking org would
    // be handed to this probe.
    .filter((c) => !restricted.has(c.id) || assigned.has(c.id))
    // The UA is RESOLVED here rather than sent as three fields: the sensor has no
    // access to org settings, and a probe deciding its own identity is how the
    // two paths drift into sending different headers for the same check.
    .map((c) => ({ id: c.id, type: c.type, target: c.target,
      intervalS: c.interval_s, timeoutMs: c.timeout_ms,
      userAgent: resolveUserAgent(c.user_agent, getOrgSetting(c.org_id, 'synthetic_user_agent', '')) })));
});

/* The same bundled script `/v1/agents/update` serves, for callers that have a
 * probe key instead of an agent token. Two routes rather than one relaxed guard:
 * the credentials authorise different things, and a probe key must never become
 * a way to reach the host-agent surface. */
route({
  method: 'get', path: '/synthetics/agent',
  summary: 'Download the agent script, for a caller holding a probe key',
  description: 'Same file as /v1/agents/update. A sensor has no agent token, so without this route a '
    + 'probe-only node kept whatever cloud-init installed on the day it booted.',
  tags: ['Probes'], auth: 'probeKey',
  middleware: [requireProbeKey],
  contentType: 'application/javascript',
  responses: { 200: S.AgentScript, 404: S.ErrorResponse },
}, ({ res }) => {
  if (!bundledAgent) return httpError(res, 404, 'no bundled agent in this build');
  res.setHeader('X-Agent-Version', bundledAgentVersion || '');
  res.type('application/javascript').send(bundledAgent);
  return undefined;
});

// …and reports results (only for checks this location is allowed to serve —
// no cross-org injection).
route({
  method: 'post', path: '/synthetics/report',
  summary: 'Report synthetic check results',
  description: 'Results for checks this location is not allowed to run are skipped silently rather than '
    + 'rejected, so a stale probe config cannot fail a whole batch.',
  tags: ['Probes'], auth: 'probeKey',
  middleware: [requireProbeKey],
  body: S.SyntheticReportBody,
  responses: { 200: S.SyntheticReportResult, 400: S.ErrorResponse, 413: S.ErrorResponse },
}, async ({ body, req }) => {
  const results = body.results;
  if (results.length > 200) throw new ApiProblem(413, 'max 200 results per batch');
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
  return { accepted };
});

module.exports = router;
