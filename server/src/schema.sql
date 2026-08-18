-- OpsCat schema — PostgreSQL DDL, and the ONLY description of the shape.
--
-- Applied idempotently at boot by db.js (`CREATE ... IF NOT EXISTS` throughout),
-- so a fresh install needs no separate provisioning step and an existing
-- database is left alone. A change to an EXISTING database is a numbered file in
-- src/migrations/ — see the header of db.js for the rule; editing a CREATE TABLE
-- here changes new installs only and is how the two shapes drift apart.
--
-- This file used to be SQLite DDL translated at build time by
-- scripts/pg-schema.js. The translator retired with the second engine (D6): one
-- dialect, written directly, is the thing it existed to approximate.
--
-- Every tenant table carries org_id; child tables inherit their org through
-- their parent FK.

-- Which migrations this database has seen. Written by db.js, never by hand: a
-- FRESH database is stamped at the latest migration number and runs none of
-- them (schema.sql already IS that shape), while an existing one runs only the
-- files numbered above the version it carries.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS organizations (
  -- Minted by the APP (util.newId), not by the database: the id is needed before
  -- the row is written (it goes into the membership and the four org settings in
  -- the same transaction), and a server-side DEFAULT would mean reading it back.
  -- So no DEFAULT here — every insert names its own id. NOT NULL is redundant
  -- under a PRIMARY KEY on this engine and stays because it is documentation.
  id            UUID PRIMARY KEY NOT NULL,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  plan          TEXT NOT NULL DEFAULT 'free',   -- free|pro|business|enterprise
  status        TEXT NOT NULL DEFAULT 'active'  -- active|suspended
                CHECK (status IN ('active','suspended')),
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  subscription_status    TEXT,                  -- trialing|active|past_due|canceled...
  current_period_end     BIGINT,
  trial_ends_at          BIGINT,
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_stripe_cust ON organizations(stripe_customer_id);

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY NOT NULL,   -- see organizations.id on the NOT NULL
  org_id        UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES organizations(id) ON DELETE CASCADE,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'analyst' CHECK (role IN ('admin','cto','lead','analyst')),
  is_super_admin BIGINT NOT NULL DEFAULT 0,   -- platform operator (cross-org)
  auth_provider TEXT NOT NULL DEFAULT 'password', -- password|google|magic
  pass_salt     TEXT NOT NULL DEFAULT '',
  pass_hash     TEXT NOT NULL DEFAULT '',
  color         TEXT NOT NULL DEFAULT '#bc8cff',
  active        BIGINT NOT NULL DEFAULT 1,
  must_change_password BIGINT NOT NULL DEFAULT 0,
  last_seen_at  BIGINT,
  -- IANA zone, for RENDERING an on-call calendar in the reader's own time.
  -- Scheduling logic uses the SCHEDULE's timezone, never this one.
  timezone      TEXT,
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id);

-- org membership: a user may belong to MANY organizations, with a distinct role
-- per org. users.org_id stays the user's "home" org (default active org on login);
-- memberships is the authority for "who is in org X" and "what can they do there".
CREATE TABLE IF NOT EXISTS memberships (
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'analyst' CHECK (role IN ('admin','cto','lead','analyst')),
  created_at    BIGINT NOT NULL,
  PRIMARY KEY (user_id, org_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_org ON memberships(org_id);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,            -- random 64 hex
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  active_org_id UUID,                     -- org the session is currently acting in
  csrf          TEXT NOT NULL,
  created_at    BIGINT NOT NULL,
  last_used_at  BIGINT NOT NULL,
  ip            TEXT,
  user_agent    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- single-use magic-link login tokens (sent via Resend)
CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash    TEXT PRIMARY KEY,            -- sha256(token)
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    BIGINT NOT NULL,
  expires_at    BIGINT NOT NULL,
  used_at       BIGINT,
  -- 'login'  = magic-link sign-in, 15 min, requested by the account owner
  -- 'invite' = account activation / admin password reset, 7 days, issued to an
  --            address that has not proven ownership yet. Same table because the
  --            security property is identical (single use, hashed, expiring); the
  --            purpose keeps the two TTLs and the two cleanup rules apart.
  purpose       TEXT NOT NULL DEFAULT 'login'
);

-- pending OAuth state (CSRF for the Google login roundtrip)
CREATE TABLE IF NOT EXISTS oauth_states (
  state         TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,
  redirect      TEXT,
  created_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id        UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES organizations(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  prefix        TEXT NOT NULL,               -- first 12 chars for display
  key_hash      TEXT NOT NULL UNIQUE,        -- sha256(full key)
  scopes        TEXT NOT NULL DEFAULT 'ingest',  -- csv: ingest,agent,probe,api
  role          TEXT NOT NULL DEFAULT 'analyst', -- role an `api`-scoped key acts with
  active        BIGINT NOT NULL DEFAULT 1,
  created_by    UUID REFERENCES users(id),
  created_at    BIGINT NOT NULL,
  last_used_at  BIGINT
);
CREATE INDEX IF NOT EXISTS idx_apikeys_org ON api_keys(org_id);

CREATE TABLE IF NOT EXISTS logs (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id        UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001',
  ts            BIGINT NOT NULL,            -- unix ms
  device        TEXT NOT NULL,
  line          TEXT NOT NULL,
  sev           BIGINT NOT NULL DEFAULT 6,  -- syslog 0..7
  source        TEXT,                        -- api key name / 'agent' / 'snmp' / 'synthetics'
  meta          TEXT                         -- JSON
);
CREATE INDEX IF NOT EXISTS idx_logs_org_ts ON logs(org_id, ts);
CREATE INDEX IF NOT EXISTS idx_logs_org_device_ts ON logs(org_id, device, ts);

CREATE TABLE IF NOT EXISTS events (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id        UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001',
  dedupe_key    TEXT NOT NULL,
  name          TEXT NOT NULL,
  device        TEXT NOT NULL,
  ip            TEXT,
  target        TEXT,                        -- e.g. attacked hostname, OID, URL
  description   TEXT,
  severity      BIGINT NOT NULL,            -- 0..100
  hits          BIGINT NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','finished','downgraded')),
  assigned_user_id UUID REFERENCES users(id),
  first_seen    BIGINT NOT NULL,
  last_seen     BIGINT NOT NULL,
  finished_at   BIGINT,
  finished_by   UUID REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_events_org_status_sev ON events(org_id, status, severity DESC);
-- THE event-deduplication invariant: at most one active event per
-- (org, dedupe_key). It lived only in db.js for 20 migrations, so a schema
-- generated from this file alone silently duplicated every active event.
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedupe_active ON events(org_id, dedupe_key) WHERE status = 'active';
-- dedupe is per-org: same event name on different orgs must not collide
CREATE INDEX IF NOT EXISTS idx_events_last_seen ON events(last_seen);

-- per-minute hit buckets for sparklines
CREATE TABLE IF NOT EXISTS event_buckets (
  event_id      BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  bucket        BIGINT NOT NULL,            -- unix minute
  count         BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, bucket)
);

CREATE TABLE IF NOT EXISTS cases (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,   -- displayed as C-<1000+id>
  org_id        UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001',
  event_id      BIGINT REFERENCES events(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  device        TEXT NOT NULL,
  severity      BIGINT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','assigned','closed')),
  assigned_user_id UUID REFERENCES users(id),
  root_cause    TEXT,
  note          TEXT,
  opened_at     BIGINT NOT NULL,
  closed_at     BIGINT,
  -- Set ONLY by an acknowledgement — an alert ack, or the explicit Acknowledge
  -- button. Assign does not set it and close does not need it: acknowledging is
  -- "I have seen it, stop ringing", owning the case is a separate statement
  -- (docs/ONCALL-V1.md §3.6, §13.4). MTTA is AVG(acked_at - opened_at).
  acked_at      BIGINT,
  acked_by      UUID REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_cases_org_status ON cases(org_id, status);

-- Who did what to an event, append-only. `cases.note` is a single column that every
-- "Add Note" overwrote, so the previous note was gone and nothing recorded who wrote
-- it; the audit log had the action but keyed the event by a free-text detail string,
-- which cannot be queried back. This is the record the NOC reads during a handover.
-- user_id NULL = the platform did it (detection, automation), not a person.
CREATE TABLE IF NOT EXISTS event_timeline (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id        UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001',
  event_id      BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  ts            BIGINT NOT NULL,
  user_id       UUID REFERENCES users(id),
  action        TEXT NOT NULL,          -- assign | downgrade | finish | note | reopen
  detail        TEXT                    -- the note body, or "90 → 65"
);
CREATE INDEX IF NOT EXISTS idx_event_timeline ON event_timeline(event_id, ts);

CREATE TABLE IF NOT EXISTS agents (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id        UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001',
  name          TEXT NOT NULL UNIQUE,
  grp           TEXT NOT NULL DEFAULT 'default',   -- workspace/group label
  hostname      TEXT,
  token_hash    TEXT NOT NULL UNIQUE,
  platform      TEXT,
  version       TEXT,
  active        BIGINT NOT NULL DEFAULT 1,
  auto_update   BIGINT NOT NULL DEFAULT 1,  -- self-update to the server-bundled agent
  last_seen_at  BIGINT,
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_org ON agents(org_id);

CREATE TABLE IF NOT EXISTS agent_metrics (
  agent_id      BIGINT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  ts            BIGINT NOT NULL,
  cpu_pct       DOUBLE PRECISION, load1 DOUBLE PRECISION,
  mem_used      BIGINT, mem_total BIGINT,
  disk_used     BIGINT, disk_total BIGINT,
  net_rx        BIGINT, net_tx BIGINT,
  PRIMARY KEY (agent_id, ts)
);

-- Logical sensor-agent location. kind: 'local' = the built-in probe on this
-- host, 'customer' = self-hosted or BYO-cloud agent owned by one org
-- (org_id NOT NULL), 'managed' = OpsCat fleet shared across tenants
-- (org_id NULL, orgs subscribe via org_location_access). Location and physical
-- node (sensor_nodes) are separate so a VPS swap keeps history + probe key.
CREATE TABLE IF NOT EXISTS synthetic_locations (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id        UUID,                     -- NULL for managed locations
  city          TEXT NOT NULL,
  cc            TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'customer' CHECK (kind IN ('local','customer','managed')),
  region        TEXT,                        -- UI cluster: 'Europe', 'North America', …
  is_premium    BIGINT NOT NULL DEFAULT 0,  -- managed: Enterprise-plan-only location
  visible       BIGINT NOT NULL DEFAULT 1,  -- managed: shown in tenant picker (pre-provisioning)
  capabilities  TEXT,                        -- JSON, e.g. {"browser":true}
  node_id       BIGINT,                     -- FK sensor_nodes for managed/BYO; NULL for self-hosted
  provider      TEXT,                        -- aws|gcp|hetzner|vultr for auto-provisioned sensors
  provider_ref  TEXT,                        -- provider instance id (teardown)
  probe_key_hash TEXT UNIQUE,               -- null for local
  active        BIGINT NOT NULL DEFAULT 1,
  last_seen_at  BIGINT,
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_synthloc_org ON synthetic_locations(org_id);

-- Physical inventory of auto-provisioned boxes (managed fleet + BYO-cloud).
CREATE TABLE IF NOT EXISTS sensor_nodes (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  provider      TEXT NOT NULL,               -- 'aws'|'gcp'|'hetzner'|'vultr'
  provider_instance_id TEXT,
  provider_region TEXT,
  cloud_credential_id BIGINT,               -- NULL only while provisioning fails early
  instance_class TEXT NOT NULL DEFAULT 'standard',  -- 'standard'|'browser'
  agent_version TEXT,
  status        TEXT NOT NULL DEFAULT 'provisioning'
                CHECK (status IN ('provisioning','online','draining','dead')),
  created_at    BIGINT NOT NULL
);

-- What happened to a managed sensor location, append-only.
--
-- Deliberately NO foreign key and NO cascade: teardown DELETEs the
-- synthetic_locations row (that is what revokes the probe key), and a history that
-- disappears with its subject is worthless exactly when it is needed — "what did we
-- do to the location we tore down last week?" is the question you ask AFTER it is
-- gone. `label` is denormalised for the same reason: once the location row is gone
-- there is nothing left to join a city name out of.
-- user_id NULL = the platform acted (a probe checked in, reconcile ran), not a person.
CREATE TABLE IF NOT EXISTS node_timeline (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  location_id   BIGINT NOT NULL,       -- no FK on purpose, see above
  label         TEXT,                   -- "Frankfurt DE" as it was at the time
  ts            BIGINT NOT NULL,
  user_id       UUID REFERENCES users(id),
  action        TEXT NOT NULL,          -- provisioned | instance_created | online |
                                        -- visibility | premium | teardown | teardown_failed
  detail        TEXT
);
CREATE INDEX IF NOT EXISTS idx_node_timeline ON node_timeline(location_id, ts);

-- Encrypted cloud credentials: org-owned for BYO, org_id NULL = OpsCat
-- platform credential (managed fleet, superadmin only). Secrets are AES-256-GCM
-- encrypted with the app secret and are never returned by the API.
CREATE TABLE IF NOT EXISTS cloud_credentials (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id        UUID,                     -- NULL = platform credential
  provider      TEXT NOT NULL,               -- 'aws'|'gcp'
  label         TEXT NOT NULL,
  key_enc       TEXT NOT NULL,               -- encrypted JSON payload (per provider)
  key_hint      TEXT,                        -- e.g. last 4 chars of the key id
  created_by    TEXT,
  created_at    BIGINT NOT NULL,
  last_used_at  BIGINT
);

-- Which org subscribed which managed location (plan quota or add-on).
CREATE TABLE IF NOT EXISTS org_location_access (
  org_id        UUID NOT NULL,
  location_id   BIGINT NOT NULL REFERENCES synthetic_locations(id) ON DELETE CASCADE,
  source        TEXT NOT NULL DEFAULT 'plan' CHECK (source IN ('plan','addon')),
  created_at    BIGINT NOT NULL,
  PRIMARY KEY (org_id, location_id)
);

CREATE TABLE IF NOT EXISTS synthetic_checks (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id        UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001',
  type          TEXT NOT NULL CHECK (type IN ('http','icmp','dns','tcp','traceroute','reputation')),
  target        TEXT NOT NULL,
  interval_s    BIGINT NOT NULL DEFAULT 60,
  timeout_ms    BIGINT NOT NULL DEFAULT 5000,
  enabled       BIGINT NOT NULL DEFAULT 1,
  assertions    TEXT,                        -- JSON {status?, keyword?, jsonPath?, jsonValue?} (http only)
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_synthchk_org ON synthetic_checks(org_id);

CREATE TABLE IF NOT EXISTS synthetic_results (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  check_id      BIGINT NOT NULL REFERENCES synthetic_checks(id) ON DELETE CASCADE,
  location_id   BIGINT NOT NULL REFERENCES synthetic_locations(id) ON DELETE CASCADE,
  ts            BIGINT NOT NULL,
  ok            BIGINT NOT NULL,
  latency_ms    DOUBLE PRECISION,
  meta          TEXT                         -- JSON: {status, jitter, loss, hops:[...]}
);
CREATE INDEX IF NOT EXISTS idx_synth_results ON synthetic_results(check_id, location_id, ts);

-- ---- reputation (blocklist monitoring) --------------------------------------
-- Its own model on purpose. A blocklist listing is a STATE WITH A LIFECYCLE
-- ("on Spamhaus since the 3rd, delisted on the 14th"), not a measurement — the
-- first question after a listing is "since when?", and a table of samples cannot
-- answer it. So: `reputation_runs` is the time series and gets the short
-- retention every sample table gets; `reputation_listings` is the record and is
-- kept, because it is the evidence a delisting request or a postmaster
-- escalation is argued with.
CREATE TABLE IF NOT EXISTS reputation_assets (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id        UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001',
  target        TEXT NOT NULL,               -- IP or domain, stored normalised
  kind          TEXT NOT NULL CHECK (kind IN ('ip','domain')),
  rdns          TEXT,                        -- last known PTR — names the asset in operator terms
  interval_s    BIGINT NOT NULL DEFAULT 21600,
  enabled       BIGINT NOT NULL DEFAULT 1,
  created_at    BIGINT NOT NULL
);
-- targets are stored canonicalised, so uniqueness is enforceable here
CREATE UNIQUE INDEX IF NOT EXISTS idx_rep_assets_target ON reputation_assets(org_id, target);

CREATE TABLE IF NOT EXISTS reputation_runs (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  asset_id      BIGINT NOT NULL REFERENCES reputation_assets(id) ON DELETE CASCADE,
  ts            BIGINT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('listed','informational','clean','unknown')),
  zones_queried BIGINT NOT NULL DEFAULT 0,   -- zones that actually answered
  zones_total   BIGINT NOT NULL DEFAULT 0,   -- zones we tried for this kind
  worst_tier    TEXT,
  duration_ms   DOUBLE PRECISION,
  unavailable   TEXT,                         -- JSON [{name,zone,tier}] — refused, NOT clean
  errored       TEXT,                         -- JSON [{name,zone,tier,error}]
  policy        TEXT,                         -- JSON [{name,zone,codes}] — PBL-style, no accusation
  error         TEXT,
  -- JSON [{host,ip,listed,covered}] for a domain asset: the mail servers its MX
  -- records point at and what each one's own lookup found. Null for IP assets.
  mx_hosts      TEXT
);
CREATE INDEX IF NOT EXISTS idx_rep_runs ON reputation_runs(asset_id, ts);

CREATE TABLE IF NOT EXISTS reputation_listings (
  id           BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  asset_id     BIGINT NOT NULL REFERENCES reputation_assets(id) ON DELETE CASCADE,
  zone         TEXT NOT NULL,
  name         TEXT NOT NULL,                 -- display name, e.g. "Spamhaus ZEN"
  tier         TEXT NOT NULL,                 -- critical | standard | informational
  codes        TEXT,                          -- JSON [string] — the 127.0.0.x answers
  url          TEXT,                          -- delisting page, carried into the case
  -- WHAT is listed. '' = the asset itself. For a domain asset we also check the
  -- hosts its MX records point at, and those are a different thing being listed:
  -- "link11.com is on DBL" and "its mail server 1.2.3.4 is on ZEN" are separate
  -- facts with separate lifecycles. NOT NULL with a '' default on purpose —
  -- NULLs are DISTINCT in a unique index, so a nullable column here
  -- would silently permit several open episodes for the asset itself.
  subject      TEXT NOT NULL DEFAULT '',
  first_seen   BIGINT NOT NULL,
  last_seen    BIGINT NOT NULL,
  resolved_at  BIGINT                        -- NULL = still listed
);
-- At most one OPEN listing per (asset, subject, zone); a re-listing after a
-- delisting is a new row, so the history reads as distinct episodes rather than
-- one smear.
CREATE UNIQUE INDEX IF NOT EXISTS idx_rep_listing_open
  ON reputation_listings(asset_id, subject, zone) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_rep_listing_zone ON reputation_listings(zone, resolved_at);

CREATE TABLE IF NOT EXISTS snmp_targets (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id        UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001',
  name          TEXT NOT NULL,
  host          TEXT NOT NULL,
  port          BIGINT NOT NULL DEFAULT 161,
  version       TEXT NOT NULL DEFAULT '2c', -- '2c' | '3'
  community_enc TEXT NOT NULL,               -- AES-256-GCM(community)
  oids          TEXT NOT NULL DEFAULT '[]',  -- JSON [{oid,label}]
  interval_s    BIGINT NOT NULL DEFAULT 60,
  enabled       BIGINT NOT NULL DEFAULT 1,
  last_status   TEXT,                        -- 'ok' | 'unreachable' | error msg
  last_seen_at  BIGINT,
  -- SNMPv3 (used when version = '3'; keys AES-256-GCM encrypted like community)
  v3_user           TEXT,
  v3_level          TEXT,                    -- noAuthNoPriv | authNoPriv | authPriv
  v3_auth_protocol  TEXT,                    -- md5 | sha
  v3_auth_key_enc   TEXT,
  v3_priv_protocol  TEXT,                    -- des | aes
  v3_priv_key_enc   TEXT,
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snmp_org ON snmp_targets(org_id);

-- planned-work windows: while a window is active, alert dispatch for the org is
-- suppressed (events still record; the notification log shows "suppressed").
CREATE TABLE IF NOT EXISTS maintenance_windows (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id        UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001',
  name          TEXT NOT NULL,
  starts_at     BIGINT NOT NULL,
  ends_at       BIGINT NOT NULL,
  created_at    BIGINT NOT NULL
);

-- per-minute container snapshots reported by host agents (docker ps + stats)
CREATE TABLE IF NOT EXISTS agent_containers (
  agent_id      BIGINT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  ts            BIGINT NOT NULL,            -- minute bucket
  name          TEXT NOT NULL,
  image         TEXT,
  state         TEXT,                        -- running | exited | restarting | …
  cpu_pct       DOUBLE PRECISION,
  mem_used      BIGINT,
  mem_limit     BIGINT,
  PRIMARY KEY (agent_id, ts, name)
);

-- dead-man's-switch monitors: a cron job / backup pings its URL; silence longer
-- than interval+grace raises a heartbeat_missed event.
CREATE TABLE IF NOT EXISTS heartbeats (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id        UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001',
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  interval_s    BIGINT NOT NULL DEFAULT 3600,
  grace_s       BIGINT NOT NULL DEFAULT 300,
  enabled       BIGINT NOT NULL DEFAULT 1,
  last_ping_at  BIGINT,
  alerted_at    BIGINT,                     -- set when the current miss was reported
  created_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS snmp_results (
  target_id     BIGINT NOT NULL REFERENCES snmp_targets(id) ON DELETE CASCADE,
  ts            BIGINT NOT NULL,
  oid           TEXT NOT NULL,
  value         TEXT,
  PRIMARY KEY (target_id, oid, ts)
);

-- hourly ingest counters per org (pipeline throughput: lines/bytes/events)
CREATE TABLE IF NOT EXISTS ingest_stats (
  org_id        UUID NOT NULL,
  bucket        BIGINT NOT NULL,            -- hour start (ms since epoch)
  lines         BIGINT NOT NULL DEFAULT 0,
  bytes         BIGINT NOT NULL DEFAULT 0,
  events        BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, bucket)
);

-- per-MINUTE ingest counters, kept for 48h only (retention.js). The hourly table
-- above cannot answer "what burst must the ingest survive": a 30-second spike of
-- 5k lines/s disappears almost completely into an hour's average, and that average
-- is exactly the number nobody should size a pipeline on.
CREATE TABLE IF NOT EXISTS ingest_minutes (
  org_id        UUID NOT NULL,
  bucket        BIGINT NOT NULL,            -- minute start (ms since epoch)
  lines         BIGINT NOT NULL DEFAULT 0,
  bytes         BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, bucket)
);

CREATE TABLE IF NOT EXISTS rule_fires (
  rule_id       BIGINT NOT NULL,
  dedupe_key    TEXT NOT NULL,
  fired_at      BIGINT NOT NULL,
  PRIMARY KEY (rule_id, dedupe_key)
);

CREATE TABLE IF NOT EXISTS incidents (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,  -- displayed as INC-<2000+id>
  org_id        UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001',
  title         TEXT NOT NULL,
  severity      BIGINT NOT NULL DEFAULT 50,
  status        TEXT NOT NULL DEFAULT 'investigating'
                CHECK (status IN ('investigating','identified','monitoring','resolved')),
  published     BIGINT NOT NULL DEFAULT 0,
  started_at    BIGINT NOT NULL,
  resolved_at   BIGINT,
  rca_summary   TEXT DEFAULT '', rca_impact TEXT DEFAULT '', rca_root_cause TEXT DEFAULT '',
  rca_resolution TEXT DEFAULT '', rca_actions TEXT DEFAULT '',
  created_by    UUID REFERENCES users(id),
  assignee_id   UUID REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_incidents_org ON incidents(org_id);

-- provenance: the events/cases this incident grew out of. Polymorphic on
-- purpose (no FK on ref_id); rows disappear with the incident, not the target.
CREATE TABLE IF NOT EXISTS incident_links (
  incident_id BIGINT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('case','event')),
  ref_id      BIGINT NOT NULL,
  created_at  BIGINT NOT NULL,
  PRIMARY KEY (incident_id, kind, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_inc_links_ref ON incident_links(kind, ref_id);
-- idx_status_subs_page is created by migration v18, NOT here. This file runs
-- before the migrations, and on a pre-v18 database the CREATE TABLE above is a
-- no-op — so an index naming `page_id` would fail on the very databases the
-- migration exists to bring forward.

-- A status PAGE is a first-class row (schema v18). An org has one default page
-- (slug = the org's slug, so /status and /status/:slug keep working) and, on the
-- Enterprise plan, additional ones — an audience-specific page shows a subset of
-- the components and can be private. Branding lives in COLUMNS rather than a KV
-- table: the set is fixed and small. `domain` is the page's own hostname, only
-- ever served once `domain_verified_at` is set (see lib/status-domains.js).
CREATE TABLE IF NOT EXISTS status_pages (
  id                 BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug               TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  is_default         BIGINT NOT NULL DEFAULT 0,
  published          BIGINT NOT NULL DEFAULT 1,
  visibility         TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  access_token       TEXT,             -- private pages: the secret in the link
  domain             TEXT,
  domain_token       TEXT,             -- DNS TXT challenge value
  domain_verified_at BIGINT,
  accent             TEXT NOT NULL DEFAULT '',
  theme              TEXT NOT NULL DEFAULT 'dark',
  description        TEXT NOT NULL DEFAULT '',
  support_url        TEXT NOT NULL DEFAULT '',
  legal_url          TEXT NOT NULL DEFAULT '',
  hide_powered       BIGINT NOT NULL DEFAULT 0,
  custom_css         TEXT NOT NULL DEFAULT '',
  created_at         BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_status_pages_org ON status_pages(org_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_status_pages_domain
  ON status_pages(domain) WHERE domain IS NOT NULL AND domain <> '';

-- status-page branding assets: the customer's own logo and favicon. Stored as
-- blobs because the database is the only persisted store in the Docker
-- deployment, and because a same-origin `/status/logo` needs no CSP img-src
-- entry. Raster only (PNG/JPEG/WebP/ICO) — see lib/status-branding.js for why
-- SVG is refused.
CREATE TABLE IF NOT EXISTS status_assets (
  page_id    BIGINT NOT NULL REFERENCES status_pages(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('logo','favicon')),
  mime       TEXT NOT NULL,
  bytes      BYTEA NOT NULL,
  updated_at BIGINT NOT NULL,         -- drives the ETag
  PRIMARY KEY (page_id, kind)
);

CREATE TABLE IF NOT EXISTS incident_updates (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  incident_id   BIGINT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  ts            BIGINT NOT NULL,
  status        TEXT NOT NULL,
  message       TEXT NOT NULL,
  user_id       UUID REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_inc_updates ON incident_updates(incident_id, ts);

CREATE TABLE IF NOT EXISTS components (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id        UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001',
  name          TEXT NOT NULL,
  grp           TEXT NOT NULL DEFAULT 'Core',
  status        TEXT NOT NULL DEFAULT 'operational'
                CHECK (status IN ('operational','degraded','partial','major','maintenance')),
  sort          BIGINT NOT NULL DEFAULT 0,
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_components_org ON components(org_id);

-- one row per component per day; worst state seen + seconds not operational
CREATE TABLE IF NOT EXISTS component_days (
  component_id  BIGINT NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  day           TEXT NOT NULL,               -- YYYY-MM-DD (UTC)
  worst         TEXT NOT NULL DEFAULT 'operational',
  down_seconds  BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (component_id, day)
);

-- third-party vendor status monitoring (supply chain): each row subscribes an
-- org to one vendor's official status feed (statuspage/instatus/... JSON, RSS).
CREATE TABLE IF NOT EXISTS vendors (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id        UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES organizations(id) ON DELETE CASCADE,
  slug          TEXT NOT NULL,               -- catalog slug or custom-<name>
  name          TEXT NOT NULL,
  feed_type     TEXT NOT NULL CHECK (feed_type IN ('statuspage','instatus','slack','gcp','aws','heroku','statusio','rss')),
  feed_url      TEXT NOT NULL,
  page_url      TEXT,                        -- human status page link
  interval_s    BIGINT NOT NULL DEFAULT 120,
  enabled       BIGINT NOT NULL DEFAULT 1,
  component_id  BIGINT REFERENCES components(id) ON DELETE SET NULL, -- mirror onto own status page
  status        TEXT NOT NULL DEFAULT 'unknown'
                CHECK (status IN ('unknown','operational','degraded','partial','major','maintenance')),
  last_checked_at BIGINT,
  last_error    TEXT,
  created_at    BIGINT NOT NULL,
  UNIQUE (org_id, slug)
);

-- latest component snapshot as reported by the vendor's feed
CREATE TABLE IF NOT EXISTS vendor_components (
  vendor_id     BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'operational',
  updated_at    BIGINT NOT NULL,
  PRIMARY KEY (vendor_id, name)
);

-- vendor incident history; resolved_at is set when an incident leaves the feed
CREATE TABLE IF NOT EXISTS vendor_incidents (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  vendor_id     BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  remote_id     TEXT NOT NULL,
  title         TEXT NOT NULL,
  status        TEXT,
  impact        TEXT,                        -- minor|degraded|partial|major|critical|maintenance|unknown
  url           TEXT,
  started_at    BIGINT,
  resolved_at   BIGINT,
  updated_at    BIGINT,
  UNIQUE (vendor_id, remote_id)
);
CREATE INDEX IF NOT EXISTS idx_vendor_incidents ON vendor_incidents(vendor_id, updated_at);

-- Downdetector-style user reports submitted from the public status page;
-- engine/reports.js raises a user_reports_spike event when a 15-minute window
-- reaches the org's threshold (org setting status_reports_threshold).
CREATE TABLE IF NOT EXISTS status_reports (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id        UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001' REFERENCES organizations(id) ON DELETE CASCADE,
  ts            BIGINT NOT NULL,
  component_id  BIGINT REFERENCES components(id) ON DELETE SET NULL,
  message       TEXT,
  ip_hash       TEXT NOT NULL                -- sha256(orgId|ip): dedupe, never the raw address
);
CREATE INDEX IF NOT EXISTS idx_status_reports ON status_reports(org_id, ts);

-- one row per vendor per day: worst state seen + seconds not operational
-- (rolled up every minute; drives the Radar heatbars/uptime)
CREATE TABLE IF NOT EXISTS vendor_days (
  vendor_id     BIGINT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  day           TEXT NOT NULL,               -- YYYY-MM-DD (UTC)
  worst         TEXT NOT NULL DEFAULT 'operational',
  down_seconds  BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (vendor_id, day)
);

-- community "it's down for me too" reports from the PUBLIC vendor grid
-- (platform-level, not org data — slug references the vendor catalog)
CREATE TABLE IF NOT EXISTS vendor_reports (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  slug          TEXT NOT NULL,
  ts            BIGINT NOT NULL,
  ip_hash       TEXT NOT NULL                -- sha256(grid|ip): dedupe, never the raw address
);
CREATE INDEX IF NOT EXISTS idx_vendor_reports ON vendor_reports(slug, ts);

-- global platform settings (super-admin)
CREATE TABLE IF NOT EXISTS settings (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL
);

-- per-organization settings (org_name, backend_label, status_published, ...)
CREATE TABLE IF NOT EXISTS org_settings (
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  value         TEXT NOT NULL,
  PRIMARY KEY (org_id, key)
);

-- Scout: templates mined from unclassified log lines (masking + grouping).
-- pending -> (AI suggestion stored on the row) -> approved (became a
-- classifier rule) or dismissed (kept so it is never suggested again).
CREATE TABLE IF NOT EXISTS scout_templates (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id        UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001',
  template      TEXT NOT NULL,               -- masked line, variable parts as <TAG>/<*>
  count         BIGINT NOT NULL DEFAULT 1,
  sample        TEXT,                        -- one raw example line
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','dismissed')),
  suggestion    TEXT,                        -- JSON from the LLM: {name, severity, skip, reason}
  first_seen    BIGINT NOT NULL,
  last_seen     BIGINT NOT NULL,
  UNIQUE (org_id, template)
);
CREATE INDEX IF NOT EXISTS idx_scout_org_status ON scout_templates(org_id, status, count DESC);

-- Automation: trigger (matched against pipeline events) -> actions. First
-- action family: lifecycle auto-close (a clear event finishes its raise
-- event), case auto-assign, outbound webhook. Every run is written to
-- audit_log (action 'automation_run', user_id NULL = system actor).
CREATE TABLE IF NOT EXISTS automations (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id        UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001',
  name          TEXT NOT NULL,
  enabled       BIGINT NOT NULL DEFAULT 1,
  trigger_json  TEXT NOT NULL,               -- {"event":"...", "severityMin":0}
  actions_json  TEXT NOT NULL,               -- [{"type":"close_event"|"assign_case"|"webhook", ...}]
  cooldown_m    BIGINT NOT NULL DEFAULT 15,
  created_by    UUID REFERENCES users(id),
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_automations_org ON automations(org_id);

-- cooldown memory per automation + event dedupe key (mirrors rule_fires)
CREATE TABLE IF NOT EXISTS automation_fires (
  automation_id BIGINT NOT NULL,
  dedupe_key    TEXT NOT NULL,
  fired_at      BIGINT NOT NULL,
  PRIMARY KEY (automation_id, dedupe_key)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id        UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001',
  ts            BIGINT NOT NULL,
  user_id       UUID,
  action        TEXT NOT NULL,
  detail        TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_org_ts ON audit_log(org_id, ts);

-- ── MCP / OAuth 2.1 authorization server ──────────────────────────────────
-- Clients register dynamically (RFC 7591), are public (no secret) and must use
-- PKCE S256. A token is bound to ONE organization, picked by the user on the
-- consent screen — deliberately NOT to a role: the role is read from
-- memberships at request time, so a role change or a revoked membership takes
-- effect immediately instead of living on in an old token.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,               -- json array
  scopes        TEXT NOT NULL,               -- csv, the most this client may ever request
  created_at    BIGINT NOT NULL
);

-- Authorization codes: single-use, short-lived, PKCE-bound. Stored hashed so a
-- database read cannot replay one.
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash      TEXT PRIMARY KEY,           -- sha256(code)
  client_id      TEXT NOT NULL,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id         UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,              -- S256 only
  scopes         TEXT NOT NULL,
  resource       TEXT,                       -- RFC 8707 audience
  expires_at     BIGINT NOT NULL,
  created_at     BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,        -- sha256(token)
  kind          TEXT NOT NULL CHECK (kind IN ('access','refresh')),
  client_id     TEXT NOT NULL,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scopes        TEXT NOT NULL,
  resource      TEXT,                        -- RFC 8707 audience this token may drive
  expires_at    BIGINT NOT NULL,
  created_at    BIGINT NOT NULL,
  last_used_at  BIGINT
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON oauth_tokens(user_id, org_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_client ON oauth_tokens(client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_exp ON oauth_tokens(expires_at);

-- ── OpsCat Bridge ────────────────────────────────────────────────────────────
-- Incident war room / situation room on the LiveKit API (docs/BRIDGE.md). ONE
-- LiveKit room per bridge; a breakout is a server-side subscription group,
-- never a separate media room. This file runs on every boot (IF NOT EXISTS),
-- so pure new tables need no migration entry.
CREATE TABLE IF NOT EXISTS bridges (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id        UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001',
  incident_id   BIGINT NOT NULL UNIQUE REFERENCES incidents(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  -- default ON (docs §7.2); org opts out via org setting bridge_transcription='0',
  -- the incident commander per room. Always visibly indicated in the UI.
  transcription BIGINT NOT NULL DEFAULT 1,
  -- highest bridge_feed.id the insight analyzer has read (phase 3)
  analyzed_feed_id BIGINT NOT NULL DEFAULT 0,
  created_by    UUID REFERENCES users(id),
  created_at    BIGINT NOT NULL,
  closed_at     BIGINT
);

CREATE TABLE IF NOT EXISTS bridge_groups (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  room_id       BIGINT NOT NULL REFERENCES bridges(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  color         TEXT NOT NULL DEFAULT '',
  sort          BIGINT NOT NULL DEFAULT 0,
  created_by    UUID REFERENCES users(id),
  created_at    BIGINT NOT NULL,
  closed_at     BIGINT
);
CREATE INDEX IF NOT EXISTS idx_bridge_groups ON bridge_groups(room_id, closed_at);

-- presence mirror; source of truth is the LiveKit webhook stream.
-- group_id NULL = the lobby.
CREATE TABLE IF NOT EXISTS bridge_participants (
  room_id       BIGINT NOT NULL REFERENCES bridges(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id      BIGINT REFERENCES bridge_groups(id) ON DELETE SET NULL,
  connected     BIGINT NOT NULL DEFAULT 0,
  joined_at     BIGINT NOT NULL,
  last_seen     BIGINT NOT NULL,
  left_at       BIGINT,
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS bridge_feed (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  room_id       BIGINT NOT NULL REFERENCES bridges(id) ON DELETE CASCADE,
  group_id      BIGINT REFERENCES bridge_groups(id) ON DELETE SET NULL,
  user_id       UUID REFERENCES users(id),    -- speaker/actor; NULL = AI or system
  kind          TEXT NOT NULL CHECK (kind IN ('system','transcript','insight')),
  severity      TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','notable','critical')),
  body          TEXT NOT NULL,
  meta          TEXT NOT NULL DEFAULT '{}',      -- JSON: refs, stt confidence, …
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bridge_feed ON bridge_feed(room_id, id);

-- ---------------------------------------------------------------------------
-- On-Call (docs/ONCALL-V1.md slice 1): who has the duty, computable for any
-- instant. Escalation policies and alerts arrive in slice 2 — this half answers
-- "who is on call right now" and nothing else.
-- ---------------------------------------------------------------------------

-- A team is a NAME and a MEMBER LIST. Deliberately flat: no roles, no nesting,
-- no permissions — RBAC stays on the membership. Teams exist to be ADDRESSED
-- (a schedule's owner, later an alert target), not to carry authorisation.
-- Not to be confused with the `msteams` alert channel; see ONCALL-V1 §2.
CREATE TABLE IF NOT EXISTS teams (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id        UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'
                REFERENCES organizations(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  created_at    BIGINT NOT NULL,
  UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id       BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS schedules (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id        UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'
                REFERENCES organizations(id) ON DELETE CASCADE,
  team_id       BIGINT REFERENCES teams(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  timezone      TEXT NOT NULL DEFAULT 'UTC',   -- IANA name; the handoff is a LOCAL time
  gap_alerted_at BIGINT,                      -- set when oncall_gap was raised, cleared on cover
  created_at    BIGINT NOT NULL,
  UNIQUE (org_id, name)
);

-- One or more layers; the HIGHEST position that yields somebody wins. A layer
-- restricted to business hours over a 24/7 base layer is the ordinary shape,
-- and it only works if a restricted layer yields NOBODY outside its window
-- rather than its participant anyway.
CREATE TABLE IF NOT EXISTS schedule_layers (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  schedule_id   BIGINT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  position      BIGINT NOT NULL,              -- 0 = base layer
  rotation      TEXT NOT NULL DEFAULT 'weekly'
                CHECK (rotation IN ('daily','weekly','custom')),
  interval_d    BIGINT NOT NULL DEFAULT 1,    -- 'custom': shift length in days
  handoff_at    BIGINT NOT NULL,              -- anchor instant; its LOCAL time-of-day is the handoff
  restrict_json TEXT,                          -- {"days":[1..7],"from":"08:00","to":"18:00"}
  UNIQUE (schedule_id, position)
);

CREATE TABLE IF NOT EXISTS schedule_participants (
  layer_id      BIGINT NOT NULL REFERENCES schedule_layers(id) ON DELETE CASCADE,
  position      BIGINT NOT NULL,              -- rotation order
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (layer_id, position)
);

-- "I'll take Friday" — beats every layer for its window. Overrides are how a
-- human corrects the machine, so nothing may outrank them.
CREATE TABLE IF NOT EXISTS schedule_overrides (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  schedule_id   BIGINT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  starts_at     BIGINT NOT NULL,
  ends_at       BIGINT NOT NULL,
  created_by    UUID REFERENCES users(id),
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sched_ovr ON schedule_overrides(schedule_id, starts_at, ends_at);

-- ============================================================================
-- On-Call slice 2 — the alert chain (docs/ONCALL-V1.md §3.3–3.6)
-- ============================================================================

-- A policy is a LADDER, not a graph: an ordered list of steps with a timeout
-- each and an optional repeat. No branches, no conditions, no join — the flow
-- engine owns that shape, and modelling an escalation as a DAG would offer
-- authors freedom the problem does not have (§3.3).
CREATE TABLE IF NOT EXISTS escalation_policies (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id        UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'
                REFERENCES organizations(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  repeat_n      BIGINT NOT NULL DEFAULT 0,    -- extra full passes after the last step (0..5)
  high_min      BIGINT NOT NULL DEFAULT 80,   -- severity at/above which an alert is HIGH urgency
  hours_json    TEXT,                          -- support hours; NULL = around the clock
  created_at    BIGINT NOT NULL,
  UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS escalation_steps (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  policy_id     BIGINT NOT NULL REFERENCES escalation_policies(id) ON DELETE CASCADE,
  position      BIGINT NOT NULL,              -- 0 fires immediately
  timeout_m     BIGINT NOT NULL DEFAULT 5,    -- wait this long for an ack, then the next step
  UNIQUE (policy_id, position)
);

-- ref_id is TEXT and not UUID or BIGINT: a 'user' target is a uuid while
-- 'schedule' and 'team' are integer keys. One column holding both has to be the
-- wider type — storing a uuid in a numeric column is exactly the silent-NaN failure
-- CLAUDE.md § Identity keys exists to prevent.
CREATE TABLE IF NOT EXISTS escalation_targets (
  step_id       BIGINT NOT NULL REFERENCES escalation_steps(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('user','schedule','team')),
  ref_id        TEXT NOT NULL,
  PRIMARY KEY (step_id, kind, ref_id)
);

-- Belongs to the PERSON, not the org: the same human in two orgs has one phone.
-- Visible only to their owner — an admin sees that a method exists, its kind and
-- its verification state, never the address (§7 Personal data).
CREATE TABLE IF NOT EXISTS contact_methods (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN
                  ('email','sms','voice','push','pushover','ntfy','telegram')),
  -- CIPHERTEXT when `encrypted` is 1 — a phone number is personal data and a
  -- push subscription is a bearer capability, so both are AES-256-GCM at rest
  -- with OPSCAT_SECRET, the same pattern SNMP community strings use. The flag
  -- is a column rather than "guess from the kind" because the answer has to
  -- survive a kind that changes its mind (docs/ONCALL-V1.md §7).
  address       TEXT NOT NULL,
  encrypted     BIGINT NOT NULL DEFAULT 0,
  label         TEXT NOT NULL DEFAULT '',
  -- An UNVERIFIED sms/voice method is never used: a wrong number costs money on
  -- every escalation and rings a stranger at 03:00. The code is hashed, expires,
  -- and the try counter is what stops six digits being brute-forced.
  verified_at   BIGINT,
  verify_hash   TEXT,
  verify_expires_at BIGINT,
  verify_tries  BIGINT NOT NULL DEFAULT 0,
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contact_methods_user ON contact_methods(user_id);

-- "push now, SMS after 5 minutes" — the recipient moves off the rule and onto
-- the person, so a colleague leaving means editing one place instead of every
-- alert rule that named their number.
CREATE TABLE IF NOT EXISTS notification_rules (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  urgency       TEXT NOT NULL CHECK (urgency IN ('high','low')),
  delay_m       BIGINT NOT NULL DEFAULT 0,    -- minutes after the alert reaches this person
  method_id     BIGINT NOT NULL REFERENCES contact_methods(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_notif_rules_user ON notification_rules(user_id, urgency, delay_m);

CREATE TABLE IF NOT EXISTS alerts (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id        UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'
                REFERENCES organizations(id) ON DELETE CASCADE,
  subject_kind  TEXT NOT NULL CHECK (subject_kind IN ('case','incident')),
  subject_id    BIGINT NOT NULL,
  policy_id     BIGINT REFERENCES escalation_policies(id) ON DELETE SET NULL,
  urgency       TEXT NOT NULL CHECK (urgency IN ('high','low')),
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','acked','resolved','exhausted','canceled')),
  step_position BIGINT NOT NULL DEFAULT 0,
  round         BIGINT NOT NULL DEFAULT 0,    -- repeat pass
  source        TEXT NOT NULL,                 -- 'rule:<id>' | 'flow:<id>' | 'user:<id>'
  message       TEXT,                          -- optional extra line from the raiser
  created_at    BIGINT NOT NULL,
  acked_at      BIGINT,
  acked_by      UUID REFERENCES users(id),
  ended_at      BIGINT,
  end_reason    TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_subject ON alerts(subject_kind, subject_id);
CREATE INDEX IF NOT EXISTS idx_alerts_active ON alerts(org_id, status);

-- One row per person the alert actually reached on a step. Individual DELIVERY
-- attempts do not get a table — they go into `notifications` (which gains
-- alert_id), so "why did nothing arrive" keeps ONE screen with one answer.
CREATE TABLE IF NOT EXISTS alert_attempts (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  alert_id      BIGINT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  step_position BIGINT NOT NULL,
  round         BIGINT NOT NULL,
  via           TEXT NOT NULL,                 -- 'schedule:<id>' | 'team:<id>' | 'user'
  notified_at   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alert_attempts ON alert_attempts(alert_id);

-- Single-use acknowledgement tokens, hashed at rest exactly like login_tokens.
CREATE TABLE IF NOT EXISTS alert_tokens (
  token_hash    TEXT PRIMARY KEY,              -- sha256(token)
  alert_id      BIGINT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose       TEXT NOT NULL CHECK (purpose IN ('ack','resolve')),
  expires_at    BIGINT NOT NULL,
  used_at       BIGINT
);

-- Durable timers for the escalation clock (lib/timers.js). A separate table per
-- owner rather than one polymorphic one: no foreign key can point at two
-- parents, and ON DELETE CASCADE from the owning alert is what
-- keeps an orphaned timer from firing into nothing (§9.3).
CREATE TABLE IF NOT EXISTS alert_timers (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  alert_id      BIGINT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,                 -- 'step' | 'notify'
  ref           TEXT,                          -- notify: '<userId>|<methodId>'
  step_position BIGINT NOT NULL DEFAULT 0,    -- the step this timer belongs to
  round         BIGINT NOT NULL DEFAULT 0,
  resume_at     BIGINT NOT NULL,
  claimed_at    BIGINT,                       -- lease; a stale lease is re-claimable
  canceled_at   BIGINT,
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alert_timers_due ON alert_timers(resume_at, canceled_at);

-- Which check runs from which location. NO rows for a check = "all agents,
-- including future ones" (the default).
CREATE TABLE IF NOT EXISTS check_locations (
  check_id      BIGINT NOT NULL REFERENCES synthetic_checks(id) ON DELETE CASCADE,
  location_id   BIGINT NOT NULL REFERENCES synthetic_locations(id) ON DELETE CASCADE,
  PRIMARY KEY (check_id, location_id)
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id        UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001',
  name          TEXT NOT NULL,
  enabled       BIGINT NOT NULL DEFAULT 1,
  -- 'msteams' is Microsoft Teams. It is spelled out because On-Call introduces
  -- a Team object of our own (docs/ONCALL-V1.md §2) and `channel = 'teams'`
  -- next to `kind = 'team'` would differ by one letter in the one subsystem
  -- where confusing them pages a webhook instead of a person.
  channel       TEXT NOT NULL CHECK (channel IN
                  ('email','msteams','webhook','slack','telegram','discord','ntfy','pushover')),
  trigger_name  TEXT,                        -- null = any event name
  severity_min  BIGINT NOT NULL DEFAULT 60,
  cooldown_m    BIGINT NOT NULL DEFAULT 15,
  recipients    TEXT NOT NULL DEFAULT '[]',  -- JSON: emails[] or [url]
  -- A rule either dispatches into a CHANNEL exactly as it always has, or raises
  -- an ALERT against an escalation policy. This one column is what makes on-call
  -- work with zero flows (docs/ONCALL-V1.md §8) — and every existing row keeps
  -- its meaning, because 'channel' is the default.
  target_type   TEXT NOT NULL DEFAULT 'channel',   -- 'channel' | 'policy'
  policy_id     BIGINT REFERENCES escalation_policies(id) ON DELETE SET NULL,
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rules_org ON alert_rules(org_id);

CREATE TABLE IF NOT EXISTS notifications (
  id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id        UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001',
  ts            BIGINT NOT NULL,
  rule_id       BIGINT REFERENCES alert_rules(id) ON DELETE SET NULL,
  rule_name     TEXT,
  event_id      BIGINT,
  case_label    TEXT,
  channel       TEXT NOT NULL,
  ok            BIGINT NOT NULL,
  error         TEXT,
  -- An alert delivery is a notification like any other. One log means the
  -- "why did nothing arrive" screen keeps one answer, and the maintenance
  -- suppression line gets a sibling instead of a competitor (ONCALL-V1 §3.5).
  alert_id      BIGINT,
  -- What this message COST, in millionths of the account currency. Only the
  -- metered channels (sms, voice) ever set it. It exists because those are the
  -- two channels where an escalation loop is an invoice, and "how much did last
  -- night cost" must be answerable from the same log that says who was reached.
  cost_micros   BIGINT
);
CREATE INDEX IF NOT EXISTS idx_notifications_org_ts ON notifications(org_id, ts);

-- which status-page components an incident affects, and how badly. `impact`
-- uses the app-wide status scale (lib/status-scale.js) — the component status
-- is DERIVED as the worst impact across open incidents, identity, no mapping.
CREATE TABLE IF NOT EXISTS incident_components (
  incident_id  BIGINT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  component_id BIGINT NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  impact       TEXT NOT NULL DEFAULT 'degraded'
               CHECK (impact IN ('degraded','partial','major')),
  PRIMARY KEY (incident_id, component_id)
);
CREATE INDEX IF NOT EXISTS idx_inc_comp_component ON incident_components(component_id);

-- who owns a component: read by auto-assign ("by_component"). Maps to a USER —
-- there is no team object; see docs/INCIDENTS-V2.md §2.
CREATE TABLE IF NOT EXISTS component_owners (
  component_id BIGINT PRIMARY KEY REFERENCES components(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id)
);

-- public status-page subscribers (docs/INCIDENTS-V2.md slice 2): double-opt-in
-- by mail. The token (hashed at rest, mailed in links only) is the subscriber's
-- one credential — it confirms while pending and unsubscribes once confirmed.
-- Uniqueness is per PAGE, not per org (schema v18): an audience-specific page
-- has its own audience, and the same person may legitimately want the public
-- page AND the partner page. `org_id` is kept alongside `page_id` because every
-- quota, admin list and rate limit is still an org-level question.
CREATE TABLE IF NOT EXISTS status_subscribers (
  id           BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id       UUID NOT NULL,
  page_id      BIGINT NOT NULL REFERENCES status_pages(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  confirmed_at BIGINT,              -- NULL = pending double-opt-in
  created_at   BIGINT NOT NULL,
  last_sent_at BIGINT,              -- confirm-mail resend throttle
  UNIQUE (page_id, email)
);
CREATE INDEX IF NOT EXISTS idx_status_subs_org ON status_subscribers(org_id, confirmed_at);
CREATE INDEX IF NOT EXISTS idx_status_subs_page ON status_subscribers(page_id, confirmed_at);

-- which components a page shows. NO rows = every component of the org, which is
-- what the default page wants and saves backfilling it on every new component.
CREATE TABLE IF NOT EXISTS status_page_components (
  page_id      BIGINT NOT NULL REFERENCES status_pages(id) ON DELETE CASCADE,
  component_id BIGINT NOT NULL REFERENCES components(id) ON DELETE CASCADE,
  PRIMARY KEY (page_id, component_id)
);
