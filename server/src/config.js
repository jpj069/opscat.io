'use strict';
const path = require('path');
const crypto = require('crypto');

function bool(v, d) { if (v === undefined || v === '') return d; return v === '1' || v === 'true'; }
function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }

const dataDir = process.env.OPSCAT_DATA_DIR || path.join(__dirname, '..', 'data');

module.exports = {
  port: int(process.env.PORT, 3000),
  dataDir,
  dbFile: path.join(dataDir, 'opscat.db'),
  publicDir: process.env.OPSCAT_PUBLIC_DIR || path.join(__dirname, '..', 'public'),
  wwwDir: process.env.OPSCAT_WWW_DIR || path.join(__dirname, '..', 'public-www'),
  // OPSCAT_SECRET encrypts SNMP communities and signs nothing else; generated+persisted if absent.
  secret: process.env.OPSCAT_SECRET || null,
  resendApiKey: process.env.RESEND_API_KEY || null,
  baseUrl: process.env.OPSCAT_BASE_URL || 'https://opscat.io',
  // --- Enterprise edition config (cloud) ---
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || null,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || null,
    pricePro: process.env.STRIPE_PRICE_PRO || null,
    priceProYearly: process.env.STRIPE_PRICE_PRO_YEARLY || null,
    priceBusiness: process.env.STRIPE_PRICE_BUSINESS || null,
    priceBusinessYearly: process.env.STRIPE_PRICE_BUSINESS_YEARLY || null,
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || null,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || null,
  },
  signupsOpen: (process.env.OPSCAT_SIGNUPS_OPEN || '1') === '1',
  cookieSecure: bool(process.env.OPSCAT_COOKIE_SECURE, true),
  trustProxy: bool(process.env.OPSCAT_TRUST_PROXY, true),
  sessionIdleMs: int(process.env.OPSCAT_SESSION_IDLE_MIN, 12 * 60) * 60 * 1000,
  sessionMaxMs: int(process.env.OPSCAT_SESSION_MAX_H, 7 * 24) * 3600 * 1000,
  retentionLogsDays: int(process.env.OPSCAT_RETENTION_LOGS_DAYS, 7),
  retentionMetricsDays: int(process.env.OPSCAT_RETENTION_METRICS_DAYS, 30),
  retentionResultsDays: int(process.env.OPSCAT_RETENTION_RESULTS_DAYS, 30),
  localProbe: {
    city: process.env.OPSCAT_PROBE_CITY || 'Nuremberg',
    cc: process.env.OPSCAT_PROBE_CC || 'DE',
  },
  genId: (bytes = 16) => crypto.randomBytes(bytes).toString('hex'),
};
