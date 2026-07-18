'use strict';
// OpsCat ships as open core. Two editions share one codebase:
//
//   community  (default) — the Apache-2.0 core. Self-hosted, single organization,
//              ALL monitoring features unlocked, no plan limits, no billing.
//   cloud                — the hosted multi-tenant SaaS. Per-organization plans,
//              limits and Stripe billing are enforced; the commercially-licensed
//              Enterprise modules under server/src/ee/** are active.
//
// Selected with OPSCAT_EDITION=community|cloud (default community).
const plans = require('./plans');

const EDITION = (process.env.OPSCAT_EDITION || 'community').toLowerCase() === 'cloud'
  ? 'cloud' : 'community';

// Cloud edition enforces per-org plan limits; community unlocks everything.
plans.setEnforce(EDITION === 'cloud');

const isCloud = () => EDITION === 'cloud';
const isCommunity = () => EDITION === 'community';

module.exports = { EDITION, isCloud, isCommunity };
