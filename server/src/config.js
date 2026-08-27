'use strict';
const path = require('path');
const crypto = require('crypto');

function bool(v, d) { if (v === undefined || v === '') return d; return v === '1' || v === 'true'; }
function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }

// Kept for anything the app writes to disk beside the database (nothing does,
// today). `dbFile` went with SQLite — the database is a connection string now,
// and a stale path constant is how somebody reintroduces a file.
const dataDir = process.env.OPSCAT_DATA_DIR || path.join(__dirname, '..', 'data');

module.exports = {
  port: int(process.env.PORT, 3000),
  dataDir,
  // PostgreSQL connection string. REQUIRED — it is the only engine (decision D6);
  // src/db/shim.js refuses to load without it rather than falling back to
  // anything.
  databaseUrl: process.env.DATABASE_URL || null,
  /* ClickHouse — the LOG LINE store, and only that (src/db/log-store.js).
   *
   * The default in both editions. Unset is still a SUPPORTED configuration
   * rather than a degraded one — log lines stay in PostgreSQL, which is the
   * right answer for a box too small to spare ~600 MB, and it is covered by the
   * same parity harness on every pull request. Everything transactional stays
   * in Postgres either way.
   *
   * Set-but-unreachable is neither: `index.js` exits non-zero rather than
   * falling back, because serving logs from Postgres while writes go to
   * ClickHouse would split one org's lines across two stores with no error
   * anywhere.
   */
  clickhouseUrl: (process.env.CLICKHOUSE_URL || '').trim() || null,
  clickhouseDatabase: process.env.CLICKHOUSE_DB || 'opscat',
  clickhouseUser: process.env.CLICKHOUSE_USER || 'opscat',
  clickhousePassword: process.env.CLICKHOUSE_PASSWORD || '',
  publicDir: process.env.OPSCAT_PUBLIC_DIR || path.join(__dirname, '..', 'public'),
  wwwDir: process.env.OPSCAT_WWW_DIR || path.join(__dirname, '..', 'public-www'),
  // host that serves the public vendor-status grid at / (see routes/public.js);
  // publishing is additionally gated by the vendor_grid_published setting
  gridHost: (process.env.OPSCAT_GRID_HOST || 'radar.opscat.io').toLowerCase(),
  // Optional dedicated host for status pages: `status.<domain>/<slug>`, which is
  // what people expect a status page to look like. Unset = pages stay on the app
  // host under /status/<slug>. Setting it does NOT retire the /status paths —
  // they keep resolving, so a link somebody already shared does not break.
  //
  // Worth being honest about what this does and does not buy: the usual argument
  // for a separate status host is that it survives the app being down, and that
  // only holds when it is separate INFRASTRUCTURE. Here it is the same process,
  // so this is naming, not resilience.
  statusHost: (process.env.OPSCAT_STATUS_HOST || '').trim().toLowerCase(),
  // OPSCAT_SECRET encrypts SNMP communities and signs nothing else; generated+persisted if absent.
  secret: process.env.OPSCAT_SECRET || null,
  resendApiKey: process.env.RESEND_API_KEY || null,
  // MAIL_TRANSPORT forces 'resend' or 'smtp'; unset = Resend when its key is
  // set, otherwise SMTP when SMTP_HOST is set (see mailer.js).
  mailTransport: process.env.MAIL_TRANSPORT || null,
  smtp: {
    host: process.env.SMTP_HOST || null,
    port: int(process.env.SMTP_PORT, 587),
    secure: bool(process.env.SMTP_SECURE, false), // true = implicit TLS (465)
    user: process.env.SMTP_USER || null,
    pass: process.env.SMTP_PASS || null,
  },
  baseUrl: process.env.OPSCAT_BASE_URL || 'https://opscat.io',

  // --- The managed syslog endpoint (stage 2) --------------------------------
  //
  // Where a customer's relay sends when they run NO collector of their own.
  // Empty disables the managed flavour outright: the snippets are then simply
  // not offered, which is the honest answer for a self-hosted instance that has
  // not put a gateway anywhere. Defaulting it to `syslog.<apex>` would print a
  // hostname that resolves to nothing on every community install.
  syslogHost: (process.env.OPSCAT_SYSLOG_HOST || '').trim().toLowerCase(),
  syslogPort: int(process.env.OPSCAT_SYSLOG_PORT, 6514),
  /* The private enterprise number in the structured-data element that carries
   * the tenant's key: `[opscat@<PEN> token="ocl_…"]`. RFC 5424 §7.2 requires a
   * custom SD-ID to be `name@<PEN>`, and ours is applied for but not yet
   * assigned — so the default is **0**, which IANA lists as Reserved and can
   * therefore never be another organisation's. Printing a plausible-looking
   * number we do not own would put somebody else's identifier into customer
   * configuration files.
   *
   * Changing it later is free by construction: the gateway matches the SD
   * element by NAME and ignores the number (`syslog.js` § sdParamAny), so every
   * relay configured before the assignment keeps working untouched. */
  syslogPen: (process.env.OPSCAT_SYSLOG_PEN || '0').trim(),

  /* --- The syslog tunnel (stage 3) -----------------------------------------
   *
   * WireGuard, and the point of it is that plain UDP becomes attributable: the
   * kernel will not carry a packet whose source is not in the sending peer's
   * AllowedIPs, so the inner address IS the tenant and no token has to travel
   * in the message. That is what makes an appliance which can only speak
   * UDP/514 reachable at all.
   *
   * All three are required together and the mode is refused unless all three
   * are set — an inner network with no endpoint to reach it, or an endpoint
   * with no public key to trust, is a configuration that renders a snippet
   * nobody can use. */
  tunnelNet: (process.env.OPSCAT_TUNNEL_NET || '').trim(),
  tunnelEndpoint: (process.env.OPSCAT_TUNNEL_ENDPOINT || '').trim(),
  // OUR public key. The private half never leaves the gateway container, and
  // nothing in the app has any use for it.
  tunnelPubkey: (process.env.OPSCAT_TUNNEL_PUBKEY || '').trim(),
  /* Shared with the gateway container by compose, exactly like
   * CLICKHOUSE_PASSWORD — this is infrastructure configuration, not a tenant
   * credential, and it has no place in a table or a UI. Unset means `/v1/tunnel/*`
   * answers 404: an instance running no gateway should look like one that has
   * never heard of the feature, rather than advertise a door it keeps locked. */
  tunnelGatewayKey: (process.env.OPSCAT_TUNNEL_GATEWAY_KEY || '').trim(),
  // The contact a push service uses if our sends start misbehaving (VAPID
  // `sub`). It must be a real mailbox; lib/webpush.js falls back to
  // ops@<baseUrl host> so a fresh install is not broken by an unset variable.
  pushContact: process.env.OPSCAT_PUSH_CONTACT || null,
  // --- Enterprise edition config (cloud) ---
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || null,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || null,
    pricePro: process.env.STRIPE_PRICE_PRO || null,
    priceProYearly: process.env.STRIPE_PRICE_PRO_YEARLY || null,
    priceBusiness: process.env.STRIPE_PRICE_BUSINESS || null,
    priceBusinessYearly: process.env.STRIPE_PRICE_BUSINESS_YEARLY || null,
  },
  // OpsCat Bridge: LiveKit sidecar — the feature is off (routes 503,
  // UI hidden) until all three are set. apiKey is the key NAME inside the
  // sidecar's LIVEKIT_KEYS; apiSecret signs access tokens and webhooks.
  livekit: {
    url: process.env.OPSCAT_LIVEKIT_URL || null,             // public wss:// for browsers
    internalUrl: process.env.OPSCAT_LIVEKIT_INTERNAL_URL || process.env.OPSCAT_LIVEKIT_URL || null,
    apiKey: process.env.OPSCAT_LIVEKIT_API_KEY || null,
    apiSecret: process.env.OPSCAT_LIVEKIT_API_SECRET || null,
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || null,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || null,
  },
  microsoft: {
    clientId: process.env.MICROSOFT_CLIENT_ID || null,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET || null,
    tenant: process.env.MICROSOFT_TENANT || 'common',
  },
  // --- community feature: GitHub login ---
  github: {
    clientId: process.env.GITHUB_CLIENT_ID || null,
    clientSecret: process.env.GITHUB_CLIENT_SECRET || null,
  },
  signupsOpen: (process.env.OPSCAT_SIGNUPS_OPEN || '1') === '1',
  // BYO-cloud cost guard: max live sensor nodes per org (reconcile is the net).
  sensorNodeCapPerOrg: int(process.env.OPSCAT_MAX_BYO_NODES, 20),
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
