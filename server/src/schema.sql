-- OpsCat schema (multi-tenant). Applied idempotently at boot (CREATE IF NOT
-- EXISTS) plus guarded migrations in db.js that ALTER existing single-tenant
-- databases up to this shape. Every tenant table carries org_id; child tables
-- inherit their org through their parent FK.

CREATE TABLE IF NOT EXISTS organizations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  plan          TEXT NOT NULL DEFAULT 'free',   -- free|pro|business|enterprise
  status        TEXT NOT NULL DEFAULT 'active'  -- active|suspended
                CHECK (status IN ('active','suspended')),
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  subscription_status    TEXT,                  -- trialing|active|past_due|canceled...
  current_period_end     INTEGER,
  trial_ends_at          INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_stripe_cust ON organizations(stripe_customer_id);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id        INTEGER NOT NULL DEFAULT 1 REFERENCES organizations(id) ON DELETE CASCADE,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'analyst' CHECK (role IN ('admin','cto','lead','analyst')),
  is_super_admin INTEGER NOT NULL DEFAULT 0,   -- platform operator (cross-org)
  auth_provider TEXT NOT NULL DEFAULT 'password', -- password|google|magic
  pass_salt     TEXT NOT NULL DEFAULT '',
  pass_hash     TEXT NOT NULL DEFAULT '',
  color         TEXT NOT NULL DEFAULT '#bc8cff',
  active        INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  last_seen_at  INTEGER,
  created_at    INTEGER NOT NULL
);

-- org membership: a user may belong to MANY organizations, with a distinct role
-- per org. users.org_id stays the user's "home" org (default active org on login);
-- memberships is the authority for "who is in org X" and "what can they do there".
CREATE TABLE IF NOT EXISTS memberships (
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id        INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'analyst' CHECK (role IN ('admin','cto','lead','analyst')),
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, org_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_memberships_org ON memberships(org_id);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,            -- random 64 hex
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  active_org_id INTEGER,                     -- org the session is currently acting in
  csrf          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER NOT NULL,
  ip            TEXT,
  user_agent    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- single-use magic-link login tokens (sent via Resend)
CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash    TEXT PRIMARY KEY,            -- sha256(token)
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  used_at       INTEGER
) WITHOUT ROWID;

-- pending OAuth state (CSRF for the Google login roundtrip)
CREATE TABLE IF NOT EXISTS oauth_states (
  state         TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,
  redirect      TEXT,
  created_at    INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS api_keys (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id        INTEGER NOT NULL DEFAULT 1 REFERENCES organizations(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  prefix        TEXT NOT NULL,               -- first 12 chars for display
  key_hash      TEXT NOT NULL UNIQUE,        -- sha256(full key)
  scopes        TEXT NOT NULL DEFAULT 'ingest',  -- csv: ingest,agent,probe
  active        INTEGER NOT NULL DEFAULT 1,
  created_by    INTEGER REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);

CREATE TABLE IF NOT EXISTS logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id        INTEGER NOT NULL DEFAULT 1,
  ts            INTEGER NOT NULL,            -- unix ms
  device        TEXT NOT NULL,
  line          TEXT NOT NULL,
  sev           INTEGER NOT NULL DEFAULT 6,  -- syslog 0..7
  source        TEXT,                        -- api key name / 'agent' / 'snmp' / 'synthetics'
  meta          TEXT                         -- JSON
);

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id        INTEGER NOT NULL DEFAULT 1,
  dedupe_key    TEXT NOT NULL,
  name          TEXT NOT NULL,
  device        TEXT NOT NULL,
  ip            TEXT,
  target        TEXT,                        -- e.g. attacked hostname, OID, URL
  description   TEXT,
  severity      INTEGER NOT NULL,            -- 0..100
  hits          INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','finished','downgraded')),
  assigned_user_id INTEGER REFERENCES users(id),
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  finished_at   INTEGER,
  finished_by   INTEGER REFERENCES users(id)
);
-- dedupe is per-org: same event name on different orgs must not collide
CREATE INDEX IF NOT EXISTS idx_events_last_seen ON events(last_seen);

-- per-minute hit buckets for sparklines
CREATE TABLE IF NOT EXISTS event_buckets (
  event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  bucket        INTEGER NOT NULL,            -- unix minute
  count         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, bucket)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS cases (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,   -- displayed as C-<1000+id>
  org_id        INTEGER NOT NULL DEFAULT 1,
  event_id      INTEGER REFERENCES events(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  device        TEXT NOT NULL,
  severity      INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','assigned','closed')),
  assigned_user_id INTEGER REFERENCES users(id),
  root_cause    TEXT,
  note          TEXT,
  opened_at     INTEGER NOT NULL,
  closed_at     INTEGER
);

CREATE TABLE IF NOT EXISTS agents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id        INTEGER NOT NULL DEFAULT 1,
  name          TEXT NOT NULL UNIQUE,
  grp           TEXT NOT NULL DEFAULT 'default',   -- workspace/group label
  hostname      TEXT,
  token_hash    TEXT NOT NULL UNIQUE,
  platform      TEXT,
  version       TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  last_seen_at  INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_metrics (
  agent_id      INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  ts            INTEGER NOT NULL,
  cpu_pct       REAL, load1 REAL,
  mem_used      INTEGER, mem_total INTEGER,
  disk_used     INTEGER, disk_total INTEGER,
  net_rx        INTEGER, net_tx INTEGER,
  PRIMARY KEY (agent_id, ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS synthetic_locations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id        INTEGER NOT NULL DEFAULT 1,
  city          TEXT NOT NULL,
  cc            TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'remote' CHECK (kind IN ('local','remote')),
  provider      TEXT,                        -- hetzner|vultr|... for auto-provisioned sensors
  provider_ref  TEXT,                        -- provider instance id (teardown)
  probe_key_hash TEXT UNIQUE,               -- null for local
  active        INTEGER NOT NULL DEFAULT 1,
  last_seen_at  INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS synthetic_checks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id        INTEGER NOT NULL DEFAULT 1,
  type          TEXT NOT NULL CHECK (type IN ('http','icmp','dns','tcp','traceroute')),
  target        TEXT NOT NULL,
  interval_s    INTEGER NOT NULL DEFAULT 60,
  timeout_ms    INTEGER NOT NULL DEFAULT 5000,
  enabled       INTEGER NOT NULL DEFAULT 1,
  assertions    TEXT,                        -- JSON {status?, keyword?, jsonPath?, jsonValue?} (http only)
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS synthetic_results (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  check_id      INTEGER NOT NULL REFERENCES synthetic_checks(id) ON DELETE CASCADE,
  location_id   INTEGER NOT NULL REFERENCES synthetic_locations(id) ON DELETE CASCADE,
  ts            INTEGER NOT NULL,
  ok            INTEGER NOT NULL,
  latency_ms    REAL,
  meta          TEXT                         -- JSON: {status, jitter, loss, hops:[...]}
);
CREATE INDEX IF NOT EXISTS idx_synth_results ON synthetic_results(check_id, location_id, ts);

CREATE TABLE IF NOT EXISTS snmp_targets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id        INTEGER NOT NULL DEFAULT 1,
  name          TEXT NOT NULL,
  host          TEXT NOT NULL,
  port          INTEGER NOT NULL DEFAULT 161,
  version       TEXT NOT NULL DEFAULT '2c', -- '2c' | '3'
  community_enc TEXT NOT NULL,               -- AES-256-GCM(community)
  oids          TEXT NOT NULL DEFAULT '[]',  -- JSON [{oid,label}]
  interval_s    INTEGER NOT NULL DEFAULT 60,
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_status   TEXT,                        -- 'ok' | 'unreachable' | error msg
  last_seen_at  INTEGER,
  -- SNMPv3 (used when version = '3'; keys AES-256-GCM encrypted like community)
  v3_user           TEXT,
  v3_level          TEXT,                    -- noAuthNoPriv | authNoPriv | authPriv
  v3_auth_protocol  TEXT,                    -- md5 | sha
  v3_auth_key_enc   TEXT,
  v3_priv_protocol  TEXT,                    -- des | aes
  v3_priv_key_enc   TEXT,
  created_at    INTEGER NOT NULL
);

-- dead-man's-switch monitors: a cron job / backup pings its URL; silence longer
-- than interval+grace raises a heartbeat_missed event.
CREATE TABLE IF NOT EXISTS heartbeats (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id        INTEGER NOT NULL DEFAULT 1,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  interval_s    INTEGER NOT NULL DEFAULT 3600,
  grace_s       INTEGER NOT NULL DEFAULT 300,
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_ping_at  INTEGER,
  alerted_at    INTEGER,                     -- set when the current miss was reported
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS snmp_results (
  target_id     INTEGER NOT NULL REFERENCES snmp_targets(id) ON DELETE CASCADE,
  ts            INTEGER NOT NULL,
  oid           TEXT NOT NULL,
  value         TEXT,
  PRIMARY KEY (target_id, oid, ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS alert_rules (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id        INTEGER NOT NULL DEFAULT 1,
  name          TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  channel       TEXT NOT NULL CHECK (channel IN
                  ('email','teams','webhook','slack','telegram','discord','ntfy','pushover')),
  trigger_name  TEXT,                        -- null = any event name
  severity_min  INTEGER NOT NULL DEFAULT 60,
  cooldown_m    INTEGER NOT NULL DEFAULT 15,
  recipients    TEXT NOT NULL DEFAULT '[]',  -- JSON: emails[] or [url]
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id        INTEGER NOT NULL DEFAULT 1,
  ts            INTEGER NOT NULL,
  rule_id       INTEGER REFERENCES alert_rules(id) ON DELETE SET NULL,
  rule_name     TEXT,
  event_id      INTEGER,
  case_label    TEXT,
  channel       TEXT NOT NULL,
  ok            INTEGER NOT NULL,
  error         TEXT
);

CREATE TABLE IF NOT EXISTS rule_fires (
  rule_id       INTEGER NOT NULL,
  dedupe_key    TEXT NOT NULL,
  fired_at      INTEGER NOT NULL,
  PRIMARY KEY (rule_id, dedupe_key)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS incidents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,  -- displayed as INC-<2000+id>
  org_id        INTEGER NOT NULL DEFAULT 1,
  title         TEXT NOT NULL,
  severity      INTEGER NOT NULL DEFAULT 50,
  status        TEXT NOT NULL DEFAULT 'investigating'
                CHECK (status IN ('investigating','identified','monitoring','resolved')),
  published     INTEGER NOT NULL DEFAULT 0,
  started_at    INTEGER NOT NULL,
  resolved_at   INTEGER,
  rca_summary   TEXT DEFAULT '', rca_impact TEXT DEFAULT '', rca_root_cause TEXT DEFAULT '',
  rca_resolution TEXT DEFAULT '', rca_actions TEXT DEFAULT '',
  created_by    INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS incident_updates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id   INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  ts            INTEGER NOT NULL,
  status        TEXT NOT NULL,
  message       TEXT NOT NULL,
  user_id       INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_inc_updates ON incident_updates(incident_id, ts);

CREATE TABLE IF NOT EXISTS components (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id        INTEGER NOT NULL DEFAULT 1,
  name          TEXT NOT NULL,
  grp           TEXT NOT NULL DEFAULT 'Core',
  status        TEXT NOT NULL DEFAULT 'operational'
                CHECK (status IN ('operational','degraded','partial','major','maintenance')),
  sort          INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

-- one row per component per day; worst state seen + seconds not operational
CREATE TABLE IF NOT EXISTS component_days (
  component_id  INTEGER NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  day           TEXT NOT NULL,               -- YYYY-MM-DD (UTC)
  worst         TEXT NOT NULL DEFAULT 'operational',
  down_seconds  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (component_id, day)
) WITHOUT ROWID;

-- global platform settings (super-admin)
CREATE TABLE IF NOT EXISTS settings (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL
) WITHOUT ROWID;

-- per-organization settings (org_name, backend_label, status_published, ...)
CREATE TABLE IF NOT EXISTS org_settings (
  org_id        INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  value         TEXT NOT NULL,
  PRIMARY KEY (org_id, key)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id        INTEGER NOT NULL DEFAULT 1,
  ts            INTEGER NOT NULL,
  user_id       INTEGER,
  action        TEXT NOT NULL,
  detail        TEXT
);
