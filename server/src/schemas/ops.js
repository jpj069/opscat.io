'use strict';
/* Shapes for the operations API (routes/ops.js).
 *
 * ── The rule this file was written under ────────────────────────────────────
 *
 * **The schema describes; the handler keeps deciding.**
 *
 * /api is not a greenfield surface. It is what the UI talks to and what every
 * API token talks to, and its handlers already validate — `clampInt` clamps a
 * limit rather than rejecting it, `isStr(name, 100)` answers 400 'name
 * required', an unknown action answers 400 'unknown action'. Re-expressing
 * those as zod constraints would change the message a client has been parsing,
 * and in the clamp cases it would change the STATUS: `?limit=9999` returns 500
 * rows today and would start returning 400.
 *
 * So a field the handler already validates is declared `z.unknown()` and
 * documented with `.meta()`. The runtime accepts exactly what it accepted
 * before; the spec says what a caller should send. That direction is safe — the
 * server being MORE forgiving than advertised costs nobody anything, while a
 * spec promising something the server rejects is the lie this whole exercise
 * removes. The same asymmetry, mirrored, governs the responses below: a
 * response schema wider than reality under-promises, a narrower one lies, so
 * anything uncertain is `.nullable()`.
 *
 * `z.unknown()` without `.optional()` is worth knowing: it REJECTS undefined and
 * lands in the spec's `required` list while still accepting any type. That is
 * the right declaration for a field the handler requires — it keeps the 400 a
 * 400 and only sharpens the message.
 *
 * Tightening any of this is a separate, per-route decision with its own
 * reasoning. It is not a cleanup.
 *
 * ── Responses are the new guarantee ─────────────────────────────────────────
 *
 * Nothing checked what these routes actually returned. The response schemas
 * below are enforced on every request in dev and test (lib/route-schema.js), so
 * the e2e suite is the proof that they describe the wire — including the view
 * models owned by lib/incidents.js and engine/alert-chain.js, which had no
 * written description anywhere before this.
 */

const { z } = require('zod');
const { EventSchema, AssignedSchema } = require('./domain');

// ── Documented-but-lenient helpers ───────────────────────────────────────────

/** A field the handler validates or clamps. Documented, accepts anything. @param {any} meta */
const handled = (meta) => z.unknown().optional().meta(meta);
/** Same, but the handler REQUIRES it — so the spec says required too. @param {any} meta */
const handledRequired = (meta) => z.unknown().meta(meta);

/** An integer query parameter the handler runs through clampInt(). */
const clamped = (min, max, def, description) => handled({
  type: 'integer', minimum: min, maximum: max, default: def,
  description: `${description} Out-of-range values are clamped; anything unparseable falls back to ${def}.`,
});

const ErrorResponse = z.object({ error: z.string() }).describe('Error envelope: {"error": "message"}.');
const OkResponse = z.object({ ok: z.literal(true) });

const IdParam = z.object({ id: handledRequired({ type: 'string', description: 'Resource id.' }) });

// ── Small view models ────────────────────────────────────────────────────────

const TeamMemberSchema = z.object({
  id: z.string(),
  name: z.string(),
  i: z.string().describe('Initials, for the avatar chip.'),
  color: z.string().nullable(),
  role: z.string().describe('viewer | analyst | lead | admin'),
});

const LogLineSchema = z.object({
  ts: z.number().describe('Epoch ms.'),
  device: z.string().nullable(),
  line: z.string(),
  sev: z.number().int().nullable().describe('Syslog severity 0-7; lower is worse.'),
  source: z.string().nullable().describe('Which ingest path delivered the line — API key name, agent, webhook.'),
}).describe(
  'One log line. Both log stores return this shape: db/log-store.js is the single seam, and e2e-logstore.js '
  + 'asserts the two implementations agree.');

const TimelineEntrySchema = z.object({
  ts: z.number(),
  user: AssignedSchema.describe('Who acted, or null when the platform did.'),
  action: z.string().describe('detected | finish | downgrade | assign | note | acknowledge | case_status | root_cause'),
  detail: z.string().nullable(),
});

const SparkSchema = z.array(z.number()).describe('10 cumulative points over the last 30 minutes.');

const EventListItemSchema = EventSchema.extend({ spark: SparkSchema });

const EventsQuery = z.object({
  status: handled({ type: 'string', enum: ['active', 'finished', 'downgraded', 'all'], default: 'active',
    description: 'Anything else falls back to active.' }),
  limit: clamped(1, 500, 200, 'Events to return.'),
});

const EventDetailSchema = EventSchema.extend({
  spark: SparkSchema,
  recentLogs: z.array(LogLineSchema).describe('Last 20 lines from the same device.'),
  timeline: z.array(TimelineEntrySchema),
  case: z.object({ label: z.string(), id: z.number().int(), status: z.string() })
    .nullable().describe('The most recent case for this event, if any.'),
});

// ── Alerts (engine/alert-chain.js view model) ────────────────────────────────

const AlertViewSchema = z.object({
  id: z.number().int(),
  status: z.string().describe('active | acked | ended'),
  urgency: z.string().nullable(),
  subjectKind: z.string().describe('case | incident'),
  subjectId: z.number().int(),
  subjectLabel: z.string().nullable(),
  subjectTitle: z.string().nullable(),
  severity: z.number().int().nullable(),
  policyId: z.number().int().nullable(),
  policyName: z.string().nullable(),
  step: z.number().int().nullable().describe('Position in the escalation policy.'),
  round: z.number().int().nullable(),
  source: z.string().nullable(),
  message: z.string().nullable(),
  createdAt: z.number(),
  ackedAt: z.number().nullable(),
  ackedBy: z.object({ id: z.string(), name: z.string(), color: z.string().nullable() }).nullable(),
  ackMinutes: z.number().nullable(),
  endedAt: z.number().nullable(),
  endReason: z.string().nullable(),
  nextAt: z.number().nullable().describe('When the next escalation step fires, while active.'),
  attempts: z.array(z.unknown()).optional().describe('Only when the caller asked for them.'),
}).describe('A live escalation, as engine/alert-chain.js renders it.');

// ── Cases ────────────────────────────────────────────────────────────────────

const IncidentRefSchema = z.object({ id: z.number().int(), label: z.string() }).nullable();

const CaseSchema = z.object({
  id: z.number().int(),
  label: z.string().describe('C-1001 style.'),
  eventId: z.number().int().nullable(),
  name: z.string(),
  device: z.string().nullable(),
  severity: z.number().int(),
  status: z.string().describe('open | assigned | closed'),
  assigned: AssignedSchema,
  rootCause: z.string().nullable(),
  note: z.string().nullable(),
  openedAt: z.number(),
  closedAt: z.number().nullable(),
  ackedAt: z.number().nullable(),
  ackedBy: AssignedSchema,
  incident: IncidentRefSchema.describe('Set once the case was promoted.'),
  alert: AlertViewSchema.nullable().describe('Live escalation for this case, if anybody is being paged.'),
  durationMs: z.number(),
});

const CasesQuery = z.object({
  status: handled({ type: 'string', enum: ['open', 'assigned', 'closed', 'all'], default: 'all',
    description: 'Anything else falls back to all.' }),
  limit: clamped(1, 500, 200, 'Cases to return.'),
});

const StatusReportsQuery = z.object({
  hours: clamped(1, 720, 24, 'How far back to look.'),
});

const CaseAckResponse = z.object({
  ok: z.literal(true),
  ackedAlerts: z.number().int().describe('How many live alerts this acknowledgement silenced.'),
});

const CasePatchBody = z.object({
  status: handled({ type: 'string', enum: ['open', 'assigned', 'closed'] }),
  assignedUserId: handled({ type: 'string', description: 'Must be a member of this org.' }),
  rootCause: handled({ type: 'string', maxLength: 200 }),
  note: handled({ type: 'string', maxLength: 2000, description: 'Replaces the note. The slide-over APPENDS instead.' }),
});

const EventActionBody = z.object({
  action: handledRequired({
    type: 'string', enum: ['finish', 'downgrade', 'assign', 'note'],
    description: 'finish closes the event and its case; downgrade drops severity by 25 (floor 10).',
  }),
  userId: handled({ type: 'string', description: 'assign only — defaults to the caller.' }),
  note: handled({ type: 'string', maxLength: 2000, description: 'note only. Appended to the open case, never overwritten.' }),
});

const PromoteBody = z.object({
  title: handled({ type: 'string', maxLength: 200, description: 'Defaults to "<event> on <device>".' }),
  severity: handled({ type: 'integer', minimum: 0, maximum: 100, description: "Defaults to the case's severity." }),
  components: handled({ type: 'array', items: {}, description: 'Affected components, as in POST /incidents.' }),
  assigneeId: handled({ type: 'string' }),
});

// ── Logs, dashboard, analytics ───────────────────────────────────────────────

const LogsQuery = z.object({
  limit: clamped(1, 1000, 300, 'Lines to return.'),
  q: handled({ type: 'string', maxLength: 200, description: 'Substring match on line or device. Regex filtering happens client-side.' }),
  hours: clamped(1, 720, 2, 'Relative window, ignored when from/to are given.'),
  from: handled({ type: 'integer', description: 'Absolute window start, epoch ms. Overrides hours.' }),
  to: handled({ type: 'integer', description: 'Absolute window end, epoch ms.' }),
});

const DashboardSchema = z.object({
  sevCounts: z.object({
    critical: z.number().int(), high: z.number().int(), medium: z.number().int(),
    low: z.number().int(), info: z.number().int(),
  }).describe('Active events per severity band.'),
  openCases: z.number().int(),
  mttrMs: z.number().describe('Mean time to resolve over the last 7 days; 0 when nothing closed.'),
  logs24: z.number().int(),
  events24: z.number().int(),
  casesByAnalyst: z.array(z.object({
    name: z.string(), i: z.string(), color: z.string().nullable(), count: z.number().int(),
  })),
});

const DayPointSchema = z.object({ d: z.string().describe('UTC day label.') });

const AnalyticsSchema = z.object({
  volume: z.array(DayPointSchema.extend({
    c: z.number().int().describe('sev <= 2 (critical).'),
    h: z.number().int().describe('sev == 3.'),
    m: z.number().int().describe('sev == 4.'),
    l: z.number().int().describe('sev >= 5.'),
  })),
  mttrDaily: z.array(DayPointSchema.extend({ v: z.number().nullable() })),
  topTypes: z.array(z.object({ n: z.string(), v: z.number().int() })),
  topServers: z.array(z.object({ n: z.string().nullable(), v: z.number().int() })),
  totals: z.object({
    events: z.number().int(),
    mttrMs: z.number(),
    resolutionRate: z.number().describe('Percent of cases opened in the window that are closed.'),
    notifications: z.number().int(),
    notificationsFailed: z.number().int(),
  }),
});

const AnalyticsQuery = z.object({
  range: handled({ type: 'string', enum: ['24h', '7d', '30d'], default: '7d', description: 'Anything else falls back to 7d.' }),
});

// ── Alert rules + notifications ──────────────────────────────────────────────

const RuleSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  enabled: z.boolean(),
  channel: z.string().describe('email | msteams | webhook | slack | telegram | discord | ntfy | pushover'),
  triggerName: z.string().nullable().describe('Fire only for events with exactly this name.'),
  severityMin: z.number().int(),
  cooldownM: z.number().int(),
  targetType: z.string().describe('channel | policy'),
  policyId: z.number().int().nullable(),
  recipients: z.array(z.string()),
});

const RULE_CHANNEL_META = {
  type: 'string',
  enum: ['email', 'msteams', 'webhook', 'slack', 'telegram', 'discord', 'ntfy', 'pushover'],
};

const RuleCreateBody = z.object({
  name: handledRequired({ type: 'string', maxLength: 100 }),
  channel: handledRequired(RULE_CHANNEL_META),
  triggerName: handled({ type: 'string', maxLength: 100 }),
  severityMin: clamped(0, 100, 60, 'Minimum event severity that fires this rule.'),
  cooldownM: clamped(1, 1440, 15, 'Minutes before the same rule fires again.'),
  recipients: handled({ type: 'array', items: { type: 'string' }, maxItems: 20 }),
  targetType: handled({ type: 'string', enum: ['channel', 'policy'], default: 'channel' }),
  policyId: handled({ type: 'integer', description: 'Required when targetType is policy.' }),
});

const RulePatchBody = z.object({
  name: handled({ type: 'string', maxLength: 100 }),
  enabled: handled({ type: 'boolean' }),
  channel: handled(RULE_CHANNEL_META),
  triggerName: handled({ type: 'string', maxLength: 100, description: 'Send null to clear it.' }),
  severityMin: handled({ type: 'integer', minimum: 0, maximum: 100 }),
  cooldownM: handled({ type: 'integer', minimum: 1, maximum: 1440 }),
  recipients: handled({ type: 'array', items: { type: 'string' }, maxItems: 20 }),
  targetType: handled({ type: 'string', enum: ['channel', 'policy'] }),
  policyId: handled({ type: 'integer' }),
});

const RuleTestResponse = z.object({
  ok: z.literal(true),
  channel: z.string(),
  latencyMs: z.number().int().describe('How long the real dispatch took.'),
});

const NotificationSchema = z.object({
  ts: z.number(),
  rule: z.string().nullable(),
  event: z.string().describe('Case label, E-<id>, or empty.'),
  channel: z.string(),
  ok: z.boolean(),
  error: z.string().nullable(),
});

// ── Heartbeats, maintenance, status reports, assets ──────────────────────────

const HeartbeatSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  intervalS: z.number().int(),
  graceS: z.number().int(),
  enabled: z.boolean(),
  lastPingAt: z.number().nullable(),
  status: z.string().describe('ok | late | missing | waiting | disabled'),
});

const HeartbeatCreateBody = z.object({
  name: handledRequired({ type: 'string', maxLength: 100 }),
  intervalS: clamped(30, 30 * 86400, 3600, 'Expected seconds between pings.'),
  graceS: clamped(0, 86400, 300, 'Extra seconds before a late heartbeat counts as missing.'),
});

const HeartbeatCreateResponse = z.object({
  id: z.number().int(),
  pingUrl: z.string().describe('Returned ONCE — only the token hash is stored.'),
});

const HeartbeatPatchBody = z.object({
  name: handled({ type: 'string', maxLength: 100 }),
  enabled: handled({ type: 'boolean' }),
  intervalS: handled({ type: 'integer', minimum: 30, maximum: 30 * 86400 }),
  graceS: handled({ type: 'integer', minimum: 0, maximum: 86400 }),
});

const MaintenanceSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  startsAt: z.number(),
  endsAt: z.number(),
  active: z.boolean().describe('True while the window contains now — alerts are suppressed.'),
});

const MaintenanceCreateBody = z.object({
  name: handledRequired({ type: 'string', maxLength: 100 }),
  startsAt: handledRequired({ type: 'integer', description: 'Epoch ms.' }),
  endsAt: handledRequired({ type: 'integer', description: 'Epoch ms. Must be after startsAt, and at most 30 days later.' }),
});

const CreatedIdResponse = z.object({ id: z.number().int() });

const StatusReportsResponse = z.object({
  total: z.number().int(),
  reports: z.array(z.object({
    ts: z.number(),
    component: z.string().nullable(),
    message: z.string(),
  })),
});

const AssetSchema = z.object({
  // An ENUM rather than a free string: the set is closed, the UI switches on it,
  // and the spec is the place a consumer learns what may arrive. `log-source` is
  // kebab because the value is also a URL path segment in the app.
  kind: z.enum(['agent', 'snmp', 'check', 'reputation', 'heartbeat', 'container',
    'vendor', 'log-source', 'syslog'])
    .describe('What the row is. `log-source` is derived, not configured: a device name '
      + 'seen in log lines or events that no agent covers.'),
  id: z.number().int().nullable().describe('Null for derived assets — a container has no '
    + 'id of its own and a log source IS its name.'),
  name: z.string(),
  detail: z.string(),
  status: z.string(),
  lastSeen: z.number().nullable(),
}).describe('One monitored counterparty, configured or implicit.');

// ── Incidents ────────────────────────────────────────────────────────────────

const IncidentSchema = z.object({
  id: z.number().int(),
  label: z.string().describe('INC-<n>.'),
  title: z.string(),
  severity: z.number().int(),
  status: z.string().describe('investigating | identified | monitoring | resolved'),
  published: z.boolean().describe('Visible on the public status page.'),
  startedAt: z.number(),
  resolvedAt: z.number().nullable(),
  durationMs: z.number(),
  assigneeId: z.string().nullable(),
  assignee: z.string().nullable().describe('Display name.'),
  components: z.array(z.object({
    id: z.number().int(), impact: z.string(), name: z.string(),
  })),
  links: z.array(z.object({
    kind: z.string().describe('case | event'), refId: z.number().int(), label: z.string(),
  })),
  updates: z.array(z.object({
    ts: z.number(), status: z.string(), message: z.string().nullable(),
  })),
  rca: z.object({
    summary: z.string().nullable(), impact: z.string().nullable(),
    rootCause: z.string().nullable(), resolution: z.string().nullable(),
    actions: z.string().nullable(),
  }),
}).describe('An incident, as lib/incidents.js renders it.');

const IncidentCreateBody = z.object({
  title: handledRequired({ type: 'string', maxLength: 200 }),
  severity: clamped(0, 100, 50, 'Incident severity.'),
  message: handled({ type: 'string', maxLength: 2000, description: 'First status update.' }),
  components: handled({ type: 'array', items: {}, description: 'Component ids, or {id, impact} pairs.' }),
  assigneeId: handled({ type: 'string' }),
});

const IncidentStatusBody = z.object({
  status: handledRequired({ type: 'string', enum: ['investigating', 'identified', 'monitoring', 'resolved'] }),
  message: handled({ type: 'string', maxLength: 2000 }),
});

const IncidentPatchBody = z.object({
  title: handled({ type: 'string', maxLength: 200 }),
  severity: handled({ type: 'integer', minimum: 0, maximum: 100 }),
  components: handled({ type: 'array', items: {} }),
  assigneeId: handled({ type: 'string', description: 'null unassigns; anything malformed is a 400.' }),
  published: handled({ type: 'boolean', description: 'Publishing mails subscribers, so it is applied after the wording.' }),
  rca: handled({
    type: 'object',
    description: 'summary, impact, rootCause, resolution, actions — each up to 10000 chars.',
  }),
});

const PromoteResponse = z.object({
  ok: z.literal(true),
  already: z.boolean().describe('True when an open incident was already linked — nothing new was created.'),
  incident: IncidentSchema,
});

// ── List responses ───────────────────────────────────────────────────────────
// Wrapped here rather than in the route file so the route module never imports
// zod: every shape this API can answer with is described in one place.

const TeamListResponse = z.array(TeamMemberSchema);
const EventListResponse = z.array(EventListItemSchema);
const CaseListResponse = z.array(CaseSchema);
const LogListResponse = z.array(LogLineSchema);
const RuleListResponse = z.array(RuleSchema);
const NotificationListResponse = z.array(NotificationSchema);
const HeartbeatListResponse = z.array(HeartbeatSchema);
const MaintenanceListResponse = z.array(MaintenanceSchema);
const AssetListResponse = z.array(AssetSchema);
const IncidentListResponse = z.array(IncidentSchema);

module.exports = {
  ErrorResponse, OkResponse, IdParam, EventSchema,
  EventsQuery, CasesQuery, StatusReportsQuery,
  TeamMemberSchema, LogLineSchema, TimelineEntrySchema,
  EventListItemSchema, EventDetailSchema, EventActionBody,
  AlertViewSchema, CaseSchema, CaseAckResponse, CasePatchBody, PromoteBody, PromoteResponse,
  LogsQuery, DashboardSchema, AnalyticsSchema, AnalyticsQuery,
  RuleSchema, RuleCreateBody, RulePatchBody, RuleTestResponse, NotificationSchema,
  HeartbeatSchema, HeartbeatCreateBody, HeartbeatCreateResponse, HeartbeatPatchBody,
  MaintenanceSchema, MaintenanceCreateBody, CreatedIdResponse,
  StatusReportsResponse, AssetSchema,
  IncidentSchema, IncidentCreateBody, IncidentStatusBody, IncidentPatchBody,
  TeamListResponse, EventListResponse, CaseListResponse, LogListResponse,
  RuleListResponse, NotificationListResponse, HeartbeatListResponse,
  MaintenanceListResponse, AssetListResponse, IncidentListResponse,
};
