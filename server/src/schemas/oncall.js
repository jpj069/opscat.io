'use strict';
/* Shapes for the On-Call API (routes/oncall.js).
 *
 * Same rule as schemas/ops.js: **the schema describes, the handler keeps
 * deciding.** A field the handler already validates is `z.unknown()` with a
 * `.meta()` that documents it; the runtime accepts exactly what it accepted
 * before. See docs/API-CONTRACT.md.
 *
 * Two things are specific to this module.
 *
 * **Sets, not patches.** Layers, escalation steps and a person's notification
 * rules are all replaced whole. They are ORDERED and interdependent — position
 * decides who is woken and when — so patching one at a time would let a client
 * leave a ladder the server never validated. The schemas say `array`, and the
 * handler's own per-entry validation stays where it is.
 *
 * **Contact addresses never appear in a response.** `contacts.displayAddress()`
 * masks them, and the schemas below describe the masked form. A phone number is
 * visible only to its owner, and only in the form they typed it — this is the
 * shape half of that promise (docs/ONCALL-V1.md §7).
 */

const { z } = require('zod');

// ── Documented-but-lenient helpers (same contract as schemas/ops.js) ─────────

/** A field the handler validates or clamps. Documented, accepts anything. @param {any} meta */
const handled = (meta) => z.unknown().optional().meta(meta);
/** Same, but the handler REQUIRES it — so the spec says required too. @param {any} meta */
const handledRequired = (meta) => z.unknown().meta(meta);
const clamped = (min, max, def, description) => handled({
  type: 'integer', minimum: min, maximum: max, default: def,
  description: `${description} Out-of-range values are clamped; anything unparseable falls back to ${def}.`,
});

const ErrorResponse = z.object({ error: z.string() });
const OkResponse = z.object({ ok: z.literal(true) });
const IdParam = z.object({ id: handledRequired({ type: 'string', description: 'Resource id.' }) });

// ── People ───────────────────────────────────────────────────────────────────

const PersonSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().optional(),
  color: z.string().nullable().optional(),
});

// ── Teams ────────────────────────────────────────────────────────────────────

const TeamSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  createdAt: z.number(),
  members: z.array(PersonSchema),
}).describe('A team is a name and a member list — there is nothing else to it.');

const TeamWriteBody = z.object({
  name: handled({ type: 'string', maxLength: 80 }),
  members: handled({
    type: 'array', items: { type: 'string' },
    description: 'User ids. REPLACES the current member list; ids that are not members of this org are dropped.',
  }),
});

// ── Schedules ────────────────────────────────────────────────────────────────

const RestrictSchema = z.object({
  days: z.array(z.number().int()).describe('ISO weekdays, 1 = Monday.'),
  from: z.string().nullable().describe('HH:MM local to the schedule.'),
  to: z.string().nullable(),
}).nullable().describe('When this layer is on duty at all. Same shape as a policy\'s support hours.');

const LayerSchema = z.object({
  id: z.number().int(),
  position: z.number().int().describe('Higher position wins.'),
  rotation: z.string().describe('daily | weekly | custom'),
  intervalD: z.number().int(),
  handoffAt: z.number().describe('Epoch ms of one handoff; the rotation is derived from it.'),
  restrict: RestrictSchema,
  participants: z.array(PersonSchema),
});

const OverrideSchema = z.object({
  id: z.number().int(),
  startsAt: z.number(),
  endsAt: z.number(),
  user: PersonSchema,
});

const ScheduleSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  timezone: z.string(),
  teamId: z.number().int().nullable(),
  createdAt: z.number(),
  onCall: PersonSchema.nullable().describe('Who is on call right now, or null if nobody is.'),
  via: z.string().nullable().describe('override | layer:<n> — how that answer was reached.'),
  gapSince: z.number().nullable().describe('When this schedule was last found with nobody on call.'),
  layers: z.array(LayerSchema),
  overrides: z.array(OverrideSchema).describe('Future and current overrides only.'),
});

const ScheduleWriteBody = z.object({
  name: handled({ type: 'string', maxLength: 80 }),
  timezone: handled({ type: 'string', default: 'UTC', description: 'IANA zone. Validated on write, so a bad zone can never reach the resolver.' }),
  teamId: handled({ type: 'integer', description: 'null detaches the schedule from its team.' }),
});

const LayersBody = z.object({
  layers: handledRequired({
    type: 'array', maxItems: 5,
    description: 'The WHOLE ladder. Entries: {rotation, intervalD, handoffAt, restrict?, participants[]}. '
      + 'An unknown participant is refused rather than dropped — a rotation silently short by one is worse.',
  }),
});

const OverrideBody = z.object({
  userId: handledRequired({ type: 'string', description: 'Must be an active member of this org.' }),
  startsAt: handledRequired({ type: 'integer', description: 'Epoch ms.' }),
  endsAt: handledRequired({ type: 'integer', description: 'Epoch ms, after startsAt.' }),
});

const OverrideCreated = ScheduleSchema.extend({
  id: z.number().int().describe('The new override id — the rest of the object is the updated schedule.'),
});

const TimelineShift = z.object({
  startsAt: z.number(),
  endsAt: z.number(),
  userId: z.string().nullable(),
  user: PersonSchema.nullable(),
  via: z.string().nullable(),
});

const TimelineResponse = z.object({
  scheduleId: z.number().int(),
  timezone: z.string(),
  from: z.number(),
  days: z.number().int(),
  shifts: z.array(TimelineShift),
});

const TimelineQuery = z.object({
  days: clamped(1, 60, 14, 'How far ahead to project.'),
  from: handled({ type: 'integer', description: 'Epoch ms; defaults to now.' }),
});

const NowResponse = z.object({
  at: z.number(),
  schedules: z.array(z.object({
    scheduleId: z.number().int(),
    name: z.string(),
    timezone: z.string(),
    teamId: z.number().int().nullable(),
    user: PersonSchema.nullable(),
    via: z.string().nullable(),
    configured: z.boolean().describe('False when the schedule has neither participants nor overrides — the gap that matters.'),
  })),
}).describe('The question the module exists to answer.');

// ── Escalation policies ──────────────────────────────────────────────────────

const PolicySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  repeatN: z.number().int().describe('Extra passes through the ladder after the first.'),
  highMin: z.number().int().describe('Severity at or above this is high urgency.'),
  hours: z.object({
    days: z.array(z.number().int()),
    from: z.string().nullable(),
    to: z.string().nullable(),
    tz: z.string(),
  }).nullable().describe('Support hours. Same shape and same evaluator as a layer restriction.'),
  createdAt: z.number(),
  steps: z.array(z.object({
    position: z.number().int(),
    timeoutM: z.number().int(),
    targets: z.array(z.object({
      kind: z.string().describe('user | team | schedule'),
      refId: z.string(),
      label: z.string().describe('Resolved name, so the editor never renders a bare id.'),
    })),
  })),
  worstCaseMinutes: z.number().int().describe(
    'How long this policy can ring for. Computed here so the editor cannot show a second answer.'),
});

const PolicyWriteBody = z.object({
  name: handled({ type: 'string', maxLength: 80 }),
  repeatN: clamped(0, 5, 0, 'Extra passes through the ladder.'),
  highMin: clamped(0, 100, 80, 'Severity threshold for high urgency.'),
  hours: handled({ type: 'object', description: '{days[], from, to, tz} — null clears it.' }),
  steps: handled({
    type: 'array', maxItems: 10,
    description: 'The WHOLE ladder: [{timeoutM, targets:[{kind, refId}]}]. Every reference is checked '
      + 'against THIS org — a policy naming another tenant\'s schedule would be a cross-org read with a phone call attached.',
  }),
});

// ── Alerts ───────────────────────────────────────────────────────────────────

const AttemptSchema = z.object({
  user: z.object({ id: z.string(), name: z.string(), color: z.string().nullable() }),
  step: z.number().int(),
  round: z.number().int(),
  via: z.string().nullable(),
  notifiedAt: z.number(),
});

const AlertSchema = z.object({
  id: z.number().int(),
  status: z.string().describe('active | acked | resolved | exhausted | canceled'),
  urgency: z.string().nullable(),
  subjectKind: z.string().describe('case | incident'),
  subjectId: z.number().int(),
  subjectLabel: z.string().nullable(),
  subjectTitle: z.string().nullable(),
  severity: z.number().int().nullable(),
  policyId: z.number().int().nullable(),
  policyName: z.string().nullable(),
  step: z.number().int().nullable(),
  round: z.number().int().nullable(),
  source: z.string().nullable(),
  message: z.string().nullable(),
  createdAt: z.number(),
  ackedAt: z.number().nullable(),
  ackedBy: z.object({ id: z.string(), name: z.string(), color: z.string().nullable() }).nullable(),
  ackMinutes: z.number().nullable(),
  endedAt: z.number().nullable(),
  endReason: z.string().nullable(),
  nextAt: z.number().nullable().describe('When the next rung fires, while active.'),
  attempts: z.array(AttemptSchema).optional().describe('Present on the single-alert read.'),
});

const AlertsQuery = z.object({
  status: handled({
    type: 'string', enum: ['all', 'live', 'active', 'acked', 'resolved', 'exhausted', 'canceled'],
    default: 'live', description: 'live = active or acked. Anything else falls back to live.',
  }),
  limit: clamped(1, 500, 100, 'Alerts to return.'),
});

const RaiseAlertBody = z.object({
  subjectKind: handledRequired({ type: 'string', enum: ['case', 'incident'] }),
  subjectId: handledRequired({ type: 'integer' }),
  policyId: handledRequired({ type: 'integer' }),
  urgency: handled({ type: 'string', enum: ['high', 'low'], description: 'Defaults from the policy\'s highMin against the subject severity.' }),
  message: handled({ type: 'string', maxLength: 500 }),
});

const AlertSuppressed = z.object({
  suppressed: z.string().describe('Why nobody was woken — a maintenance window, or the policy\'s support hours.'),
});

// ── My on-call ───────────────────────────────────────────────────────────────

const ContactMethodSchema = z.object({
  id: z.number().int(),
  kind: z.string().describe('email | sms | voice | push | ntfy | …'),
  address: z.string().describe('MASKED. The full address is never returned, to anyone.'),
  label: z.string().nullable(),
  verifiedAt: z.number().nullable(),
  createdAt: z.number(),
  needsVerification: z.boolean(),
  blockedReason: z.string().nullable().describe(
    'Why this method will not be used, in the words the notification log would use. '
    + 'A method that is quietly skipped is the failure mode.'),
});

const MeResponse = z.object({
  methods: z.array(ContactMethodSchema),
  telephonyConfigured: z.boolean().describe(
    'Whether the org can use the metered channels at all — said BEFORE somebody types a number '
    + 'and waits for a call that never comes.'),
  rules: z.array(z.object({
    id: z.number().int(),
    urgency: z.string(),
    delayM: z.number().int(),
    methodId: z.number().int(),
  })),
  fallbackEmail: z.string().describe(
    'The implicit fallback, stated rather than hidden: a person with no rules is still reachable.'),
  shifts: z.array(z.object({
    scheduleId: z.number().int(),
    schedule: z.string(),
    startsAt: z.number(),
    endsAt: z.number(),
    via: z.string().nullable(),
  })).describe('My next 14 days, at most 20 entries.'),
});

const MethodCreateBody = z.object({
  kind: handledRequired({ type: 'string', description: 'A kind a person can TYPE. `push` is absent on purpose — a subscription is handed over by the browser.' }),
  address: handledRequired({ type: 'string', maxLength: 300, description: 'Phone numbers must be strict E.164 (+4915112345678); a guessed country code is how a German mobile becomes a US landline.' }),
  label: handled({ type: 'string', maxLength: 40 }),
});

const MethodCreated = z.object({
  id: z.number().int(),
  needsVerification: z.boolean(),
});

const VerifySentResponse = z.object({
  ok: z.literal(true),
  expiresAt: z.number().describe('The code is spent after 5 wrong attempts, whichever comes first.'),
});

const VerifyConfirmBody = z.object({
  code: handledRequired({ type: 'string', description: 'The six digits that were sent by SMS.' }),
});

const PushKeyResponse = z.object({
  key: z.string().nullable().describe('The public VAPID key. Public by definition — the browser needs it to ask for permission.'),
});

const PushSubscribeBody = z.object({
  subscription: handledRequired({ type: 'object', description: 'The browser\'s PushSubscription: {endpoint, keys:{p256dh, auth}}.' }),
  label: handled({ type: 'string', maxLength: 40, default: 'this browser' }),
});

const PushSubscribed = z.object({
  id: z.number().int(),
  already: z.literal(true).optional().describe('Set when this browser was already subscribed — one row per endpoint, or every rung rings it twice.'),
});

const MethodTestResponse = z.object({
  ok: z.literal(true),
  latencyMs: z.number().int(),
});

const RulesBody = z.object({
  rules: handledRequired({
    type: 'array', maxItems: 20,
    description: 'The WHOLE set: [{urgency, delayM, methodId}]. An ordered escalation of channels for one person.',
  }),
});

const RulesWritten = z.object({
  ok: z.literal(true),
  count: z.number().int(),
});

// ── Analytics ────────────────────────────────────────────────────────────────

const OncallAnalyticsQuery = z.object({
  range: handled({ type: 'string', enum: ['7d', '30d', '90d'], default: '30d' }),
});

const OncallAnalyticsResponse = z.object({
  range: z.string(),
  since: z.number(),
  at: z.number(),
  mtta: z.object({
    avgMs: z.number().describe('Mean time to ACKNOWLEDGE — the number on-call is actually about.'),
    acked: z.number().int(),
    unacked: z.number().int().describe('Counted separately: averaging them in as zero would make a team that answers nothing look fast.'),
    daily: z.array(z.object({ d: z.string(), v: z.number().nullable() })),
  }),
  escalation: z.object({
    raised: z.number().int(),
    escalated: z.number().int().describe('Alerts that ever left rung one.'),
    acked: z.number().int(),
    exhausted: z.number().int(),
    canceled: z.number().int(),
    resolved: z.number().int(),
    rate: z.number().int().describe('Percent. Near zero means the ladder is decoration; near 100 means rung one points at the wrong person.'),
    exhaustedRate: z.number().int(),
  }),
  perPerson: z.array(z.object({
    user: z.object({ id: z.string(), name: z.string(), color: z.string().nullable() }),
    total: z.number().int(),
    outOfHours: z.number().int(),
    nights: z.number().int().describe('22:00–06:00 local. Nights are what wear people out.'),
    timezone: z.string().nullable(),
    tzSource: z.string().nullable().describe('user | schedule | utc-fallback — so a suspicious number can be explained rather than argued about.'),
  })).describe('Out-of-hours load per person: the number that changes behaviour.'),
  perSchedule: z.array(z.object({
    scheduleId: z.number().int(),
    name: z.string(),
    alerts: z.number().int(),
    perWeek: z.number(),
  })),
  cost: z.object({
    micros: z.number().describe('Metered spend — only sms/voice ever set it.'),
    messages: z.number().int(),
  }),
  truncated: z.boolean().describe(
    'True once the per-person fold is a SAMPLE rather than a total. Said rather than hidden.'),
});

// ── List responses ───────────────────────────────────────────────────────────

const TeamListResponse = z.array(TeamSchema);
const ScheduleListResponse = z.array(ScheduleSchema);
const PolicyListResponse = z.array(PolicySchema);
const AlertListResponse = z.array(AlertSchema);

module.exports = {
  ErrorResponse, OkResponse, IdParam, PersonSchema,
  TeamSchema, TeamWriteBody, TeamListResponse,
  ScheduleSchema, ScheduleWriteBody, ScheduleListResponse, LayersBody,
  OverrideBody, OverrideCreated,
  TimelineResponse, TimelineQuery, NowResponse,
  PolicySchema, PolicyWriteBody, PolicyListResponse,
  AlertSchema, AlertListResponse, AlertsQuery, RaiseAlertBody, AlertSuppressed,
  MeResponse, MethodCreateBody, MethodCreated, VerifySentResponse, VerifyConfirmBody,
  PushKeyResponse, PushSubscribeBody, PushSubscribed, MethodTestResponse,
  RulesBody, RulesWritten,
  OncallAnalyticsQuery, OncallAnalyticsResponse,
};
