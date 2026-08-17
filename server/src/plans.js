'use strict';
// OpsCat plan tiers, per-organization limits and feature flags. Used by the
// cloud edition (billing/limit enforcement). The self-hosted Community edition
// unlocks everything (see edition.js).
const { db, getOrgSetting } = require('./db');
const config = require('./config');

// -1 means unlimited.
//
// Feature flags gate cloud capabilities (checked via `hasFeature`). `multi_org` —
// running more than one organization from a single account (self-service org creation
// + the workspace switcher) — is enabled on EVERY cloud plan on purpose: multi-org is a
// baseline cloud capability, not an Enterprise-only upsell. This features array is the
// single place to change that per plan (drop it from a tier to gate multi-org there).
//
// STATUS PAGE: there is deliberately no `status_page` flag. The page itself, and
// its identity — logo, favicon, accent colour, light/dark, description, links —
// are ungated on every plan including Free. A status page is public, so a Free
// one is a shop window: making it wear a generic OpsCat mark advertises us badly
// and pressures nobody into upgrading. What is paid for is DISTANCE from OpsCat
// and the things that cost us to run:
//   status_domain      (pro+)        status.acme.com — cert issuance + host mapping
//   status_whitelabel  (business+)   hide the "Powered by OpsCat" footer
//   status_css         (business+)   arbitrary CSS — unbounded support surface
//   status_pages_multi (enterprise)  several pages / private audience pages
// `statusSubscribers` is a limit rather than a flag: it grows with the customer's
// own success, which is the fairest axis to charge on (and the one Statuspage
// monetises hardest).
//
// ON-CALL: there is deliberately no `oncall` flag either. Schedules, escalation
// policies, alerts and acknowledgement are core on every tier including Free,
// because a chain that stops at a licence boundary is not a guarantee
// (docs/ONCALL-V1.md §13.1, docs/OPEN-CORE.md). The only two flags are `sms` and
// `voice`, from `pro` up — and the line is drawn where the MARGINAL COST is, not
// where the value is: everything else is our own compute, while a message or a
// call is money per unit and would otherwise be an open tap on a free tier. A
// Free org runs the full ladder over e-mail, chat, ntfy, Pushover and Web Push;
// a self-hoster brings their own provider credentials and is unaffected either
// way, which is the entire point of the adapter in lib/telephony.js.
const PLANS = {
  free: {
    key: 'free', name: 'Free', priceMonthly: 0, priceYearly: 0,
    limits: { users: 3, retentionDays: 7, checks: 3, managedLocations: 5, minIntervalS: 60, snmpTargets: 2,
      agents: 2, apiKeys: 2, ingestLinesPerDay: 50000, statusSubscribers: 50 },
    features: ['email_alerts', 'multi_org'],
  },
  pro: {
    key: 'pro', name: 'Pro', priceMonthly: 29, priceYearly: 290,
    limits: { users: 10, retentionDays: 30, checks: 25, managedLocations: 10, minIntervalS: 30, snmpTargets: 20,
      agents: 25, apiKeys: 10, ingestLinesPerDay: 1000000, statusSubscribers: 500 },
    features: ['email_alerts', 'teams_alerts', 'webhook_alerts', 'google_sso', 'otlp',
      'sentry', 'multi_org', 'status_domain', 'sms', 'voice'],
  },
  business: {
    key: 'business', name: 'Business', priceMonthly: 99, priceYearly: 990,
    limits: { users: 30, retentionDays: 90, checks: 100, managedLocations: 25, minIntervalS: 15, snmpTargets: -1,
      agents: -1, apiKeys: 50, ingestLinesPerDay: 10000000, statusSubscribers: 5000 },
    features: ['email_alerts', 'teams_alerts', 'webhook_alerts', 'google_sso', 'otlp',
      'sentry', 'priority_support', 'sensor_autoprovision', 'bridge', 'multi_org',
      'status_domain', 'status_whitelabel', 'status_css', 'sms', 'voice'],
  },
  enterprise: {
    key: 'enterprise', name: 'Enterprise', priceMonthly: null, priceYearly: null,
    limits: { users: -1, retentionDays: 365, checks: -1, managedLocations: -1, minIntervalS: 15, snmpTargets: -1,
      agents: -1, apiKeys: -1, ingestLinesPerDay: -1, statusSubscribers: -1 },
    features: ['email_alerts', 'teams_alerts', 'webhook_alerts', 'google_sso', 'saml_sso',
      'scim', 'otlp', 'sentry', 'priority_support', 'sensor_autoprovision', 'premium_locations', 'sla',
      'bridge', 'multi_org', 'status_domain', 'status_whitelabel', 'status_css', 'status_pages_multi',
      'sms', 'voice'],
  },
};

function planFor(planKey) { return PLANS[planKey] || PLANS.free; }

// Count current usage of a limited resource for an org.
const COUNTERS = {
  users: (orgId) => db.prepare(`SELECT COUNT(*) c FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.org_id = ? AND u.active = 1`).get(orgId).c,
  // Reputation assets have their own table but consume the same budget: both are
  // scheduled outbound probes run on the org's behalf. Counting only
  // synthetic_checks here would make the quota bypassable by adding assets.
  checks: (orgId) => db.prepare('SELECT COUNT(*) c FROM synthetic_checks WHERE org_id = ?').get(orgId).c
    + db.prepare('SELECT COUNT(*) c FROM reputation_assets WHERE org_id = ?').get(orgId).c,
  managedLocations: (orgId) => db.prepare('SELECT COUNT(*) c FROM org_location_access WHERE org_id = ?').get(orgId).c,
  snmpTargets: (orgId) => db.prepare('SELECT COUNT(*) c FROM snmp_targets WHERE org_id = ?').get(orgId).c,
  agents: (orgId) => db.prepare('SELECT COUNT(*) c FROM agents WHERE org_id = ?').get(orgId).c,
  apiKeys: (orgId) => db.prepare('SELECT COUNT(*) c FROM api_keys WHERE org_id = ? AND active = 1').get(orgId).c,
  // Only CONFIRMED subscribers count. A pending double-opt-in may never be
  // completed, and letting unconfirmed rows consume the allowance would let a
  // stranger exhaust someone else's quota by typing addresses into the form.
  statusSubscribers: (orgId) => db.prepare(
    'SELECT COUNT(*) c FROM status_subscribers WHERE org_id = ? AND confirmed_at IS NOT NULL').get(orgId).c,
};

// module-level to allow the cloud edition to force limit enforcement; the
// community edition (edition.js) sets enforce=false so self-hosters are unlimited.
let enforce = false;
function setEnforce(v) { enforce = !!v; }

function limitFor(planKey, resource) {
  const p = planFor(planKey);
  const v = p.limits[resource];
  return v === undefined ? -1 : v;
}

function hasFeature(planKey, feature) {
  if (!enforce) return true; // community edition: everything on
  return planFor(planKey).features.includes(feature);
}

// Returns {ok, limit, used} — ok=false means creating one more would exceed.
function checkLimit(orgId, planKey, resource) {
  if (!enforce) return { ok: true, limit: -1, used: 0 };
  const limit = limitFor(planKey, resource);
  if (limit === -1) return { ok: true, limit: -1, used: 0 };
  const used = COUNTERS[resource] ? COUNTERS[resource](orgId) : 0;
  return { ok: used < limit, limit, used };
}

// Daily ingest allowance from the hourly ingest_stats counters (UTC day).
// Called on the hot ingest path — one indexed SUM over at most 24 rows.
const ingestTodayStmt = db.prepare(
  'SELECT COALESCE(SUM(lines), 0) c FROM ingest_stats WHERE org_id = ? AND bucket >= ?');
const orgPlanStmt = db.prepare('SELECT plan FROM organizations WHERE id = ?');

function ingestLinesToday(orgId) {
  const t = Date.now();
  return ingestTodayStmt.get(orgId, t - (t % 86400000)).c;
}

// Returns {ok, limit, used} — ok=false means today's log line allowance is spent.
function checkIngestVolume(orgId) {
  if (!enforce) return { ok: true, limit: -1, used: 0 };
  const org = orgPlanStmt.get(orgId);
  const limit = limitFor(org ? org.plan : 'free', 'ingestLinesPerDay');
  if (limit === -1) return { ok: true, limit: -1, used: 0 };
  const used = ingestLinesToday(orgId);
  return { ok: used < limit, limit, used };
}

/**
 * How long an org's LOGS are actually kept, in days.
 *
 * Two inputs, and the direction matters: the plan sets the CEILING, the org's own
 * `retention_logs_days` may only shorten it. Shortening is a real request ("keep
 * three days, we do not want more of our customers' log lines lying around");
 * lengthening past the tier is the thing that is sold, so it cannot be a text
 * field. On the community edition there is no ceiling — `enforce` is off and the
 * operator owns the disk.
 *
 * This exists because the number was defined per plan and read by NOBODY: the
 * cleanup used org 1's setting for every tenant, so a Business customer paying for
 * 90 days got whatever our own org had set. `retentionDays` was decoration on the
 * pricing page.
 */
function retentionDaysFor(orgId) {
  const raw = parseInt(getOrgSetting(orgId, 'retention_logs_days', ''), 10);
  const own = Number.isFinite(raw) && raw > 0 ? raw : null;
  if (!enforce) return own ?? config.retentionLogsDays;
  const org = orgPlanStmt.get(orgId);
  const cap = limitFor(org ? org.plan : 'free', 'retentionDays');
  const ceiling = cap === -1 ? Number.MAX_SAFE_INTEGER : cap;
  return Math.min(own ?? ceiling, ceiling);
}

// The ceiling alone — what the UI shows next to the field, and what the settings
// endpoint validates against.
function retentionCapFor(orgId) {
  if (!enforce) return -1;
  const org = orgPlanStmt.get(orgId);
  return limitFor(org ? org.plan : 'free', 'retentionDays');
}

function publicPlans() {
  return Object.values(PLANS).map((p) => ({
    key: p.key, name: p.name, priceMonthly: p.priceMonthly, priceYearly: p.priceYearly,
    limits: p.limits, features: p.features,
  }));
}

// Plan-dependent minimum check interval (cadence). Community edition and
// unlimited plans get the technical floor of 15s.
function minIntervalFor(planKey) {
  if (!enforce) return 15;
  const v = planFor(planKey).limits.minIntervalS;
  return Number.isFinite(v) && v > 0 ? v : 15;
}

module.exports = { PLANS, planFor, hasFeature, checkLimit, limitFor, setEnforce, publicPlans,
  minIntervalFor, checkIngestVolume, ingestLinesToday, retentionDaysFor, retentionCapFor };
