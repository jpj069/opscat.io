'use strict';
// OpsCat plan tiers, per-organization limits and feature flags. Used by the
// cloud edition (billing/limit enforcement). The self-hosted Community edition
// unlocks everything (see edition.js).
const { db } = require('./db');

// -1 means unlimited.
//
// Feature flags gate cloud capabilities (checked via `hasFeature`). `multi_org` —
// running more than one organization from a single account (self-service org creation
// + the workspace switcher) — is enabled on EVERY cloud plan on purpose: multi-org is a
// baseline cloud capability, not an Enterprise-only upsell. This features array is the
// single place to change that per plan (drop it from a tier to gate multi-org there).
const PLANS = {
  free: {
    key: 'free', name: 'Free', priceMonthly: 0, priceYearly: 0,
    limits: { users: 3, retentionDays: 7, checks: 3, managedLocations: 5, minIntervalS: 60, snmpTargets: 2,
      agents: 2, apiKeys: 2, ingestLinesPerDay: 50000 },
    features: ['status_page', 'email_alerts', 'multi_org'],
  },
  pro: {
    key: 'pro', name: 'Pro', priceMonthly: 29, priceYearly: 290,
    limits: { users: 10, retentionDays: 30, checks: 25, managedLocations: 10, minIntervalS: 30, snmpTargets: 20,
      agents: 25, apiKeys: 10, ingestLinesPerDay: 1000000 },
    features: ['status_page', 'email_alerts', 'teams_alerts', 'webhook_alerts', 'google_sso', 'otlp',
      'sentry', 'multi_org'],
  },
  business: {
    key: 'business', name: 'Business', priceMonthly: 99, priceYearly: 990,
    limits: { users: 30, retentionDays: 90, checks: 100, managedLocations: 25, minIntervalS: 15, snmpTargets: -1,
      agents: -1, apiKeys: 50, ingestLinesPerDay: 10000000 },
    features: ['status_page', 'email_alerts', 'teams_alerts', 'webhook_alerts', 'google_sso', 'otlp',
      'sentry', 'priority_support', 'sensor_autoprovision', 'multi_org'],
  },
  enterprise: {
    key: 'enterprise', name: 'Enterprise', priceMonthly: null, priceYearly: null,
    limits: { users: -1, retentionDays: 365, checks: -1, managedLocations: -1, minIntervalS: 15, snmpTargets: -1,
      agents: -1, apiKeys: -1, ingestLinesPerDay: -1 },
    features: ['status_page', 'email_alerts', 'teams_alerts', 'webhook_alerts', 'google_sso', 'saml_sso',
      'scim', 'otlp', 'sentry', 'priority_support', 'sensor_autoprovision', 'premium_locations', 'sla', 'multi_org'],
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
  minIntervalFor, checkIngestVolume, ingestLinesToday };
