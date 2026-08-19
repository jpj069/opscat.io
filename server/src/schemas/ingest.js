'use strict';
/* Schemas for the open /v1 ingest surface.
 *
 * These are the source of truth for three consumers that currently each
 * declare the shape independently: the route handler, mcp/tools.js, and the
 * hand-written sdk/js client.
 *
 * ── A rule for converting an EXISTING public endpoint ──────────────────────
 *
 * The schema must not change what the route ACCEPTS. Ingest is an open surface
 * with foreign clients — Alertmanager, Sentry, the SDK, whatever a customer
 * wired up two years ago — and a schema that is stricter than the handler was
 * rejects traffic that used to work. That is an outage, not a cleanup.
 *
 * So where the existing code is deliberately lenient, the schema is lenient
 * too. `severity` is the clearest case: `clampInt(severity, 0, 100, 50)` takes
 * anything at all and falls back to 50, so the schema takes anything at all and
 * the clamp stays in the handler. Tightening any of this is a separate,
 * per-route decision with its own reasoning — never a side effect of adding
 * validation.
 *
 * `.describe()` is not decoration: that text is the API documentation and lands
 * verbatim in /openapi.json.
 */

const { z } = require('zod');

/** This repo's error envelope — `httpError()` in util.js. */
const ErrorResponse = z.object({
  error: z.string().describe('Human-readable failure reason.'),
}).describe('Error envelope used by every non-2xx JSON response.');

/* Lenient by intent: the handler clamps with clampInt(v, 0, 100, 50), which
 * accepts a string, a null, or nothing at all. Requiring a number here would
 * 400 traffic that has been ingesting fine for years. */
const severity = z.unknown().optional()
  .describe('0-100; >=80 critical, >=60 major, >=40 minor. Anything unparseable becomes 50.');

const LogEntry = z.object({
  ts: z.unknown().optional().describe('Timestamp; defaults to arrival time.'),
  device: z.string().describe('Host or service the line came from.'),
  line: z.string().describe('The raw log line.'),
  sev: z.unknown().optional().describe('Severity label, free-form.'),
  meta: z.unknown().optional().describe('Arbitrary structured context.'),
}).loose();

/* Two accepted shapes, and that is deliberate — the SDK posts {logs:[…]} while
 * hand-rolled shippers post a bare array. The union documents a polymorphism
 * that was previously only visible by reading the handler. */
const IngestLogsBody = z.union([
  z.object({ logs: z.array(LogEntry) }).loose(),
  z.array(LogEntry),
]).describe('Either {logs:[…]} or a bare array. Max 500 entries per batch.');

const IngestResult = z.object({
  accepted: z.number().int().describe('Log lines stored.'),
  events: z.number().int().describe('Deduplicated events touched by this batch.'),
}).describe('What the pipeline did with the batch.');

const IngestEventBody = z.object({
  name: z.string().max(100).describe('Event name. Characters outside [\\w.:/-] are replaced with "_".'),
  device: z.string().max(100).describe('Host or service the event is about.'),
  target: z.unknown().optional().describe('What was affected (URL, interface, …).'),
  description: z.unknown().optional(),
  severity,
  ip: z.unknown().optional(),
  ts: z.unknown().optional(),
}).loose();

/* Everything optional with a fallback, mirroring the handler: this endpoint
 * exists to swallow whatever an external alerting system posts. */
const IngestWebhookBody = z.object({
  device: z.unknown().optional(), host: z.unknown().optional(),
  name: z.unknown().optional(), alertname: z.unknown().optional(),
  message: z.unknown().optional(), description: z.unknown().optional(),
  target: z.unknown().optional(), severity,
}).loose().describe('Generic webhook payload. Alertmanager-style keys are recognised; anything else is tolerated.');

const OkResponse = z.object({ ok: z.literal(true) });

/* ── OTLP ──────────────────────────────────────────────────────────────────
 *
 * Only the TOP level is described, deliberately. The handlers walk the interior
 * with `rl.scopeLogs || []` and tolerate everything below that, and OTLP
 * exporters differ in what they populate — describing the interior here would
 * reject payloads that ingest fine today. What the handler genuinely requires
 * is the array at the top, so that is what the schema says, and the OpenAPI
 * document says it too. */
const OtlpLogsBody = z.object({
  resourceLogs: z.array(z.unknown()).describe('OTLP resourceLogs. Up to 500 log records are taken per request.'),
}).loose().describe('OTLP/HTTP JSON logs payload.');

const OtlpTracesBody = z.object({
  resourceSpans: z.array(z.unknown()).describe('OTLP resourceSpans. Spans with status.code = 2 become events.'),
}).loose().describe('OTLP/HTTP JSON traces payload.');

const OtlpTracesResult = z.object({
  accepted: z.number().int().describe('Spans seen.'),
  errorEvents: z.number().int().describe('Error spans turned into events (max 100 per request).'),
});

const OtlpMetricsResult = z.object({
  partialSuccess: z.object({
    rejectedDataPoints: z.number().int(),
    errorMessage: z.string(),
  }),
}).describe('Metrics are accepted and discarded in this version; OTLP partialSuccess signals that.');

/* Sentry posts three different shapes depending on which integration is wired
 * up (legacy webhook plugin, issue alert, error alert), and the handler picks
 * fields out of whichever arrived. Anything narrower than "an object" would
 * reject one of the three. */
const SentryBody = z.looseObject({})
  .describe('A Sentry webhook payload — legacy plugin, issue alert or error alert. All three shapes are accepted.');

/* ── Agents ─────────────────────────────────────────────────────────────── */

const AgentHeartbeatBody = z.object({
  hostname: z.unknown().optional().describe('Reported host name; kept if absent.'),
  platform: z.unknown().optional(),
  version: z.unknown().optional().describe('Agent version — drives updateAvailable.'),
}).loose();

const AgentHeartbeatResult = z.object({
  ok: z.literal(true),
  intervalS: z.number().int().describe('Seconds until the agent should beat again.'),
  latestVersion: z.string().nullable().describe('Version bundled with this server, or null.'),
  updateAvailable: z.boolean().describe('True when this agent is older and auto-update is on.'),
});

const AgentContainersBody = z.object({
  containers: z.array(z.unknown()).optional().describe('docker ps + stats snapshot; first 200 are stored.'),
}).loose();

const AgentContainersResult = z.object({ ok: z.literal(true), stored: z.number().int() });

/* Every field optional and untyped: the handler runs each through
 * `Number.isFinite(v) ? v : null`, so a missing or junk value is already a
 * first-class case and must not become a 400. */
const AgentMetricsBody = z.looseObject({})
  .describe('Host metrics snapshot (cpu, load, memory, disk). Unparseable values are stored as null.');

const AgentLogsBody = z.object({
  logs: z.array(LogEntry).describe('Max 500 entries per batch.'),
}).loose();

/* ── Remote probes ──────────────────────────────────────────────────────── */

const SyntheticCheck = z.object({
  id: z.number().int(),
  type: z.string(),
  target: z.string().nullable(),
  intervalS: z.number().int().nullable(),
  timeoutMs: z.number().int().nullable(),
});

const SyntheticChecksResult = z.array(SyntheticCheck)
  .describe('The checks this probe location is allowed to run.');

const SyntheticReportBody = z.object({
  results: z.array(z.unknown()).describe('Max 200 results per batch. Entries without a known checkId are skipped.'),
}).loose();

const SyntheticReportResult = z.object({
  accepted: z.number().int().describe('Results recorded; unknown or not-allowed checks are silently skipped.'),
});

module.exports = {
  ErrorResponse, LogEntry, IngestLogsBody, IngestResult,
  IngestEventBody, IngestWebhookBody, OkResponse,
  OtlpLogsBody, OtlpTracesBody, OtlpTracesResult, OtlpMetricsResult, SentryBody,
  AgentHeartbeatBody, AgentHeartbeatResult, AgentContainersBody, AgentContainersResult,
  AgentMetricsBody, AgentLogsBody,
  SyntheticCheck, SyntheticChecksResult, SyntheticReportBody, SyntheticReportResult,
};
