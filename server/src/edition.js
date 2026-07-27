'use strict';
// OpsCat ships as open core. Two editions share one codebase:
//
//   CE — Community Edition (default) — the Apache-2.0 core. Self-hosted,
//        single organization, ALL monitoring features unlocked, no plan
//        limits, no billing.
//   EE — Enterprise Edition — per-organization plans, limits and Stripe
//        billing are enforced; the commercially-licensed modules under
//        server/src/ee/** are active. Powers the hosted OpsCat Cloud SaaS
//        (Cloud is the deployment of EE, not a third edition).
//
// Selected with OPSCAT_EDITION=community|cloud (default community; the
// internal runtime value for EE stays 'cloud' for compatibility — the values
// 'enterprise' and 'ee' are accepted as aliases).
const plans = require('./plans');

const RAW = (process.env.OPSCAT_EDITION || 'community').toLowerCase();
const EDITION = ['cloud', 'enterprise', 'ee'].includes(RAW) ? 'cloud' : 'community';

// EE enforces per-org plan limits; CE unlocks everything.
plans.setEnforce(EDITION === 'cloud');

const isCloud = () => EDITION === 'cloud';
const isCommunity = () => EDITION === 'community';

module.exports = { EDITION, isCloud, isCommunity };
