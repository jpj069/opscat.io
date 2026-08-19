'use strict';
/* Shapes for the PUBLIC status page API (routes/status.js).
 *
 * This is the surface a customer's monitoring polls and a vendor-status
 * detector parses, so it is the one place in the product where the JSON IS the
 * product. It has also had the least written description: the field names are
 * load-bearing history — `org` keeps its old spelling because the public
 * contract and the vendor detector read it — and nothing anywhere said so.
 *
 * Most of routes/status.js is deliberately NOT registered. It serves the status
 * PAGE (HTML), an RSS feed (XML), logos and favicons (binary), the confirm and
 * unsubscribe mini-pages (HTML), and the Caddy on-demand-TLS check (plain
 * text). The registrar describes one JSON body per request; a schema for any of
 * those would be a fiction, and a spec that guesses is the thing this replaces.
 *
 * Same rule as the other schema modules: the schema describes, the handler
 * keeps deciding.
 *
 * ── Two shapes worth reading twice ──────────────────────────────────────────
 *
 * `uptimePct` is a STRING. It comes from `.toFixed(2)`, and it has been a
 * string on the wire since the endpoint existed — a hand-written doc calling it
 * a number would have been wrong for years without anything noticing.
 *
 * The report and subscribe responses are UNIFORM by design: new, pending,
 * already-confirmed, rate-limited, honeypot-caught and silently-dropped all
 * answer `{ok:true}` identically, so the form cannot be used to probe an
 * address book. The schema is one shape because the endpoint has one answer.
 */

const { z } = require('zod');

/** A field the handler validates. Documented, accepts anything. @param {any} meta */
const handled = (meta) => z.unknown().optional().meta(meta);

const ErrorResponse = z.object({ error: z.string() });
const OkResponse = z.object({ ok: z.literal(true) })
  .describe('Uniform on purpose — every outcome looks identical from outside.');

const SlugParam = z.object({
  slug: z.unknown().meta({ type: 'string', description: 'Status-page slug.' }),
});

const StatusQuery = z.object({
  org: handled({ type: 'string', description: 'Page slug. Omitted, the page is resolved from the request host.' }),
});

const ComponentSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  group: z.string().nullable().describe('A free label, not an entity — the set of groups IS the distinct values in use.'),
  status: z.string().describe('operational | degraded | partial | major | maintenance'),
  uptimePct: z.string().describe('Two decimal places, as a STRING — it is toFixed(2) and always has been.'),
  days: z.array(z.object({
    day: z.string().describe('YYYY-MM-DD.'),
    worst: z.string().describe('The worst status seen that day.'),
  })).describe('Up to 45 days, oldest first.'),
});

const PublicIncidentSchema = z.object({
  id: z.number().int(),
  label: z.string().describe('INC-<n>.'),
  title: z.string(),
  status: z.string(),
  startedAt: z.number(),
  resolvedAt: z.number().nullable(),
  updates: z.array(z.object({
    ts: z.number(),
    status: z.string(),
    message: z.string().nullable(),
  })).describe('Newest first, up to 10.'),
});

const StatusResponse = z.object({
  overall: z.string().describe('The worst component status on this page.'),
  overallLabel: z.string(),
  components: z.array(ComponentSchema),
  incidents: z.array(PublicIncidentSchema).describe(
    'Published incidents touching this page\'s components — plus any that name no component at all, '
    + 'which is how an org-wide announcement is expressed and therefore belongs everywhere.'),
  org: z.string().describe(
    'The page\'s display name. The KEY keeps its old spelling: it is the public contract and the vendor detector reads it.'),
  page: z.object({
    slug: z.string().nullable(),
    name: z.string(),
    isDefault: z.boolean(),
  }),
  ts: z.number(),
  reportsEnabled: z.boolean(),
  reports60m: z.number().int().optional().describe(
    'Visitor reports in the last hour. Present only when the org publishes that number.'),
});

const ReportBody = z.object({
  componentId: handled({ type: 'integer', description: 'Must belong to this page; anything else is ignored.' }),
  message: handled({ type: 'string', maxLength: 500 }),
  website: handled({ type: 'string', description: 'Honeypot. Filled in means the report is dropped — and answered exactly like a real one.' }),
});

const SubscribeBody = z.object({
  email: handled({ type: 'string', format: 'email' }),
  website: handled({ type: 'string', description: 'Honeypot, same posture as the report form.' }),
});

module.exports = {
  ErrorResponse, OkResponse, SlugParam, StatusQuery,
  ComponentSchema, PublicIncidentSchema, StatusResponse,
  ReportBody, SubscribeBody,
};
