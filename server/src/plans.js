'use strict';
// OpsCat plan tiers, per-organization limits and feature flags. Used by the
// cloud edition (billing/limit enforcement). The self-hosted Community edition
// unlocks everything (see edition.js).
const { db } = require('./db');

// -1 means unlimited.
const PLANS = {
  free: {
    key: 'free', name: 'Free', priceMonthly: 0, priceYearly: 0,
    limits: { users: 3, retentionDays: 7, checks: 3, sensors: 1, snmpTargets: 2, agents: 2, apiKeys: 2 },
    features: ['status_page', 'email_alerts'],
  },
  pro: {
    key: 'pro', name: 'Pro', priceMonthly: 29, priceYearly: 290,
    limits: { users: 10, retentionDays: 30, checks: 25, sensors: 5, snmpTargets: 20, agents: 25, apiKeys: 10 },
    features: ['status_page', 'email_alerts', 'teams_alerts', 'webhook_alerts', 'google_sso', 'otlp', 'sentry'],
  },
  business: {
    key: 'business', name: 'Business', priceMonthly: 99, priceYearly: 990,
    limits: { users: 30, retentionDays: 90, checks: 100, sensors: -1, snmpTargets: -1, agents: -1, apiKeys: 50 },
    features: ['status_page', 'email_alerts', 'teams_alerts', 'webhook_alerts', 'google_sso', 'otlp',
      'sentry', 'priority_support', 'sensor_autoprovision'],
  },
  enterprise: {
    key: 'enterprise', name: 'Enterprise', priceMonthly: null, priceYearly: null,
    limits: { users: -1, retentionDays: 365, checks: -1, sensors: -1, snmpTargets: -1, agents: -1, apiKeys: -1 },
    features: ['status_page', 'email_alerts', 'teams_alerts', 'webhook_alerts', 'google_sso', 'saml_sso',
      'scim', 'otlp', 'sentry', 'priority_support', 'sensor_autoprovision', 'sla'],
  },
};

function planFor(planKey) { return PLANS[planKey] || PLANS.free; }

// Count current usage of a limited resource for an org.
const COUNTERS = {
  users: (orgId) => db.prepare('SELECT COUNT(*) c FROM users WHERE org_id = ? AND active = 1').get(orgId).c,
  checks: (orgId) => db.prepare('SELECT COUNT(*) c FROM synthetic_checks WHERE org_id = ?').get(orgId).c,
  sensors: (orgId) => db.prepare("SELECT COUNT(*) c FROM synthetic_locations WHERE org_id = ? AND kind = 'remote'").get(orgId).c,
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

function publicPlans() {
  return Object.values(PLANS).map((p) => ({
    key: p.key, name: p.name, priceMonthly: p.priceMonthly, priceYearly: p.priceYearly,
    limits: p.limits, features: p.features,
  }));
}

module.exports = { PLANS, planFor, hasFeature, checkLimit, limitFor, setEnforce, publicPlans };
