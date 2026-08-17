'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

// --- versioned migrations (schema.sql covers a fresh v-latest install; these
// bring older databases forward). Each is idempotent/guarded so it is a no-op
// on a database that already has the target shape. ---
const getVersion = () => db.pragma('user_version', { simple: true });

function hasColumn(table, col) {
  return db.pragma(`table_info(${table})`).some((c) => c.name === col);
}
function addColumn(table, col, ddl) {
  if (!hasColumn(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}

const MIGRATIONS = [
  // idx 0 -> version 1: baseline (schema.sql)
  () => {},
  // idx 1 -> version 2: multi-tenancy. Add org_id to every tenant table, seed
  // the default organization, and promote the first user to super-admin/owner.
  () => {
    // organizations / org_settings / oauth_states are created by schema.sql
    // (CREATE IF NOT EXISTS), so they already exist here. Ensure a default org.
    const orgCount = db.prepare('SELECT COUNT(*) c FROM organizations').get().c;
    if (orgCount === 0) {
      const name = (() => {
        try { const r = db.prepare("SELECT value FROM settings WHERE key='org_name'").get(); return r ? r.value : 'OpsCat'; }
        catch { return 'OpsCat'; }
      })();
      db.prepare(`INSERT INTO organizations (id, name, slug, plan, status, created_at)
        VALUES (1, ?, 'default', 'enterprise', 'active', ?)`).run(name, Date.now());
    }
    // users: org membership + platform flag + oauth
    addColumn('users', 'org_id', 'INTEGER NOT NULL DEFAULT 1');
    addColumn('users', 'is_super_admin', 'INTEGER NOT NULL DEFAULT 0');
    addColumn('users', 'auth_provider', "TEXT NOT NULL DEFAULT 'password'");
    // tenant tables get an org_id defaulting to the legacy single tenant (1)
    for (const t of ['api_keys', 'logs', 'events', 'cases', 'agents', 'synthetic_locations',
      'synthetic_checks', 'snmp_targets', 'alert_rules', 'notifications', 'incidents',
      'components', 'audit_log']) {
      addColumn(t, 'org_id', 'INTEGER NOT NULL DEFAULT 1');
    }
    addColumn('synthetic_locations', 'provider', 'TEXT');
    addColumn('synthetic_locations', 'provider_ref', 'TEXT');
    // org_id indexes live here (not schema.sql) so they are created AFTER the
    // columns exist — works for both fresh installs and migrated legacy DBs.
    db.exec('DROP INDEX IF EXISTS idx_events_dedupe_active');
    for (const idx of [
      'CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id)',
      'CREATE INDEX IF NOT EXISTS idx_apikeys_org ON api_keys(org_id)',
      'CREATE INDEX IF NOT EXISTS idx_logs_org_ts ON logs(org_id, ts)',
      'CREATE INDEX IF NOT EXISTS idx_logs_org_device_ts ON logs(org_id, device, ts)',
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedupe_active ON events(org_id, dedupe_key) WHERE status = 'active'",
      'CREATE INDEX IF NOT EXISTS idx_events_org_status_sev ON events(org_id, status, severity DESC)',
      'CREATE INDEX IF NOT EXISTS idx_cases_org_status ON cases(org_id, status)',
      'CREATE INDEX IF NOT EXISTS idx_agents_org ON agents(org_id)',
      'CREATE INDEX IF NOT EXISTS idx_synthloc_org ON synthetic_locations(org_id)',
      'CREATE INDEX IF NOT EXISTS idx_synthchk_org ON synthetic_checks(org_id)',
      'CREATE INDEX IF NOT EXISTS idx_snmp_org ON snmp_targets(org_id)',
      'CREATE INDEX IF NOT EXISTS idx_rules_org ON alert_rules(org_id)',
      'CREATE INDEX IF NOT EXISTS idx_notifications_org_ts ON notifications(org_id, ts)',
      'CREATE INDEX IF NOT EXISTS idx_incidents_org ON incidents(org_id)',
      'CREATE INDEX IF NOT EXISTS idx_components_org ON components(org_id)',
      'CREATE INDEX IF NOT EXISTS idx_audit_org_ts ON audit_log(org_id, ts)',
    ]) db.exec(idx);
    // migrate legacy global org_* settings into org_settings for org 1
    for (const key of ['org_name', 'backend_label', 'status_published', 'alert_email_from',
      'auth_email_from', 'teams_webhook_url', 'retention_logs_days', 'classifiers']) {
      const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      if (r) {
        db.prepare(`INSERT INTO org_settings (org_id, key, value) VALUES (1, ?, ?)
          ON CONFLICT(org_id, key) DO NOTHING`).run(key, r.value);
      }
    }
    // first user becomes the platform super-admin and owner of the default org
    const first = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
    if (first) {
      db.prepare('UPDATE users SET is_super_admin = 1, role = ?, org_id = 1 WHERE id = ?')
        .run('admin', first.id);
    }
  },
  // idx 2 -> version 3: more alert channels (slack, telegram, discord, ntfy,
  // pushover). The channel CHECK is baked into the table, so rebuild it.
  () => {
    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'alert_rules'").get();
    if (!ddl || ddl.sql.includes("'slack'")) return; // fresh install already has the wide CHECK
    db.exec(`
      CREATE TABLE alert_rules_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id        INTEGER NOT NULL DEFAULT 1,
        name          TEXT NOT NULL,
        enabled       INTEGER NOT NULL DEFAULT 1,
        channel       TEXT NOT NULL CHECK (channel IN
                        ('email','teams','webhook','slack','telegram','discord','ntfy','pushover')),
        trigger_name  TEXT,
        severity_min  INTEGER NOT NULL DEFAULT 60,
        cooldown_m    INTEGER NOT NULL DEFAULT 15,
        recipients    TEXT NOT NULL DEFAULT '[]',
        created_at    INTEGER NOT NULL
      );
      INSERT INTO alert_rules_new (id, org_id, name, enabled, channel, trigger_name,
        severity_min, cooldown_m, recipients, created_at)
        SELECT id, org_id, name, enabled, channel, trigger_name,
          severity_min, cooldown_m, recipients, created_at FROM alert_rules;
      DROP TABLE alert_rules;
      ALTER TABLE alert_rules_new RENAME TO alert_rules;
      CREATE INDEX IF NOT EXISTS idx_rules_org ON alert_rules(org_id);
    `);
  },
  // idx 3 -> version 4: multi-org memberships. Add the per-session active org and
  // backfill exactly one membership per existing user from their (org_id, role) —
  // so a freshly-migrated single-tenant DB keeps everyone in their current org.
  () => {
    // memberships table + sessions.active_org_id are in schema.sql for fresh
    // installs; add the column here for databases that predate it.
    addColumn('sessions', 'active_org_id', 'INTEGER');
    db.prepare(`INSERT INTO memberships (user_id, org_id, role, created_at)
      SELECT id, org_id, role, COALESCE(created_at, ?) FROM users WHERE org_id IS NOT NULL
      ON CONFLICT(user_id, org_id) DO NOTHING`).run(Date.now());
  },
  // idx 4 -> version 5: one-time reset — make every EXISTING org re-run the setup
  // flow (we only have demo tenants at this point). On a fresh install this runs
  // before seed() creates the default org, so it is a no-op there and the seeded
  // platform org keeps its pre-populated state (no onboarding).
  () => {
    // `WHERE true` disambiguates ON CONFLICT from a JOIN's ON in INSERT…SELECT…UPSERT
    db.prepare(`INSERT INTO org_settings (org_id, key, value)
      SELECT id, 'onboarding_done', '0' FROM organizations WHERE true
      ON CONFLICT(org_id, key) DO UPDATE SET value = '0'`).run();
  },
  // idx 5 -> version 6: HTTP assertions on synthetic checks + SNMPv3 target
  // credentials. (The heartbeats table ships via schema.sql CREATE IF NOT EXISTS.)
  () => {
    addColumn('synthetic_checks', 'assertions', 'TEXT');
    addColumn('snmp_targets', 'v3_user', 'TEXT');
    addColumn('snmp_targets', 'v3_level', 'TEXT');
    addColumn('snmp_targets', 'v3_auth_protocol', 'TEXT');
    addColumn('snmp_targets', 'v3_auth_key_enc', 'TEXT');
    addColumn('snmp_targets', 'v3_priv_protocol', 'TEXT');
    addColumn('snmp_targets', 'v3_priv_key_enc', 'TEXT');
  },
  // idx 6 -> version 7: agent self-update opt-out flag (default on).
  () => {
    addColumn('agents', 'auto_update', 'INTEGER NOT NULL DEFAULT 1');
  },
  // idx 7 -> version 8: API keys can drive the full REST API, not just ingest.
  // A key now carries the ROLE it acts with; `analyst` (least privilege) is the
  // default, so every pre-existing ingest key stays read-only even if someone
  // later grants it the `api` scope.
  () => {
    addColumn('api_keys', 'role', "TEXT NOT NULL DEFAULT 'analyst'");
  },
  // idx 8 -> version 9: sensor agents v2 (docs/SENSOR-AGENTS.md). Rebuild
  // synthetic_locations so kind allows 'customer'/'managed' (SQLite cannot
  // alter a CHECK), org_id becomes nullable (managed locations belong to no
  // tenant), and the new columns exist. Existing 'remote' locations become
  // 'customer'. sensor_nodes / cloud_credentials / org_location_access /
  // check_locations are created by schema.sql. No check_locations backfill on
  // purpose: zero rows = "runs on all agents incl. future" = old behavior.
  () => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='synthetic_locations'").get();
    if (row && !/'customer'/.test(row.sql)) {
      db.exec(`
        CREATE TABLE synthetic_locations_v2 (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          org_id        INTEGER,
          city          TEXT NOT NULL,
          cc            TEXT NOT NULL,
          kind          TEXT NOT NULL DEFAULT 'customer' CHECK (kind IN ('local','customer','managed')),
          region        TEXT,
          is_premium    INTEGER NOT NULL DEFAULT 0,
          visible       INTEGER NOT NULL DEFAULT 1,
          capabilities  TEXT,
          node_id       INTEGER,
          provider      TEXT,
          provider_ref  TEXT,
          probe_key_hash TEXT UNIQUE,
          active        INTEGER NOT NULL DEFAULT 1,
          last_seen_at  INTEGER,
          created_at    INTEGER NOT NULL
        );
        INSERT INTO synthetic_locations_v2
          (id, org_id, city, cc, kind, provider, provider_ref, probe_key_hash, active, last_seen_at, created_at)
        SELECT id, org_id, city, cc,
               CASE kind WHEN 'remote' THEN 'customer' ELSE kind END,
               provider, provider_ref, probe_key_hash, active, last_seen_at, created_at
        FROM synthetic_locations;
        DROP TABLE synthetic_locations;
        ALTER TABLE synthetic_locations_v2 RENAME TO synthetic_locations;
        CREATE INDEX IF NOT EXISTS idx_synth_locations_org ON synthetic_locations(org_id);
      `);
    }
  },
  // idx 9 -> version 10: the `reputation` check type (DNSBL/RHSBL blocklist
  // lookups). The type CHECK is baked into the table, so rebuild it — same
  // approach as the alert_rules channel widening above.
  () => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='synthetic_checks'").get();
    if (!row || row.sql.includes("'reputation'")) return; // fresh install already has the wide CHECK
    db.exec(`
      CREATE TABLE synthetic_checks_v2 (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id        INTEGER NOT NULL DEFAULT 1,
        type          TEXT NOT NULL CHECK (type IN ('http','icmp','dns','tcp','traceroute','reputation')),
        target        TEXT NOT NULL,
        interval_s    INTEGER NOT NULL DEFAULT 60,
        timeout_ms    INTEGER NOT NULL DEFAULT 5000,
        enabled       INTEGER NOT NULL DEFAULT 1,
        assertions    TEXT,
        created_at    INTEGER NOT NULL
      );
      INSERT INTO synthetic_checks_v2
        (id, org_id, type, target, interval_s, timeout_ms, enabled, assertions, created_at)
        SELECT id, org_id, type, target, interval_s, timeout_ms, enabled, assertions, created_at
        FROM synthetic_checks;
      DROP TABLE synthetic_checks;
      ALTER TABLE synthetic_checks_v2 RENAME TO synthetic_checks;
    `);
  },
  // idx 10 -> version 11: reputation gets its own tables. v10 stored an asset as
  // a `synthetic_checks` row of type 'reputation' and its verdicts as
  // `synthetic_results.meta`. That reuse bought a scheduler and cost fifteen
  // `type != 'reputation'` guards, a forged-event path (probe-supplied meta
  // decided "this is a listing"), and — the reason this migration exists — a
  // model that cannot answer "since when are we listed?", because a listing is a
  // state with a lifecycle and synthetic_results is a table of samples.
  //
  // The `type` CHECK on synthetic_checks deliberately KEEPS 'reputation' as a
  // legal value. Narrowing it means rebuilding the table, and synthetic_results
  // (six figures of rows on a live instance) plus check_locations reference it.
  // A permitted value that is never written again costs nothing; that rebuild
  // could cost data.
  () => {
    const rows = db.prepare("SELECT * FROM synthetic_checks WHERE type = 'reputation' ORDER BY id").all();
    if (!rows.length) return; // fresh install, or no assets were ever created

    // kind normally comes from the stored verdict; this fallback only has to
    // separate an address from a name — db.js must not import the engine, which
    // imports db.js.
    const kindOf = (t) => (/^[0-9.]+$/.test(t) || t.includes(':') ? 'ip' : 'domain');
    const insAsset = db.prepare(`INSERT INTO reputation_assets
      (org_id, target, kind, rdns, interval_s, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const insRun = db.prepare(`INSERT INTO reputation_runs
      (asset_id, ts, status, zones_queried, zones_total, worst_tier, duration_ms,
       unavailable, errored, policy, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insListing = db.prepare(`INSERT INTO reputation_listings
      (asset_id, zone, name, tier, codes, url, first_seen, last_seen, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`);
    const lastResult = db.prepare(
      'SELECT ts, meta FROM synthetic_results WHERE check_id = ? ORDER BY ts DESC, id DESC LIMIT 1');

    for (const c of rows) {
      const last = lastResult.get(c.id);
      let meta = null;
      try { meta = last && last.meta ? JSON.parse(last.meta) : null; } catch { meta = null; }
      const assetId = insAsset.run(c.org_id, c.target, (meta && meta.kind) || kindOf(c.target),
        (meta && meta.rdns) || null, c.interval_s, c.enabled, c.created_at).lastInsertRowid;

      // Carry the latest verdict across. Historical samples are deliberately not
      // migrated — they are the part with a 30-day retention anyway — but an OPEN
      // listing must survive, or the migration would silently clear a critical
      // finding the on-call is currently working.
      if (!meta) continue;
      const listed = Array.isArray(meta.listed) ? meta.listed : [];
      const actionable = listed.filter((l) => l && l.tier !== 'informational');
      const status = actionable.length ? 'listed'
        : meta.error ? 'unknown'
          : listed.length ? 'informational' : 'clean';
      insRun.run(assetId, last.ts, status, meta.zonesQueried ?? 0, meta.zonesQueried ?? 0,
        meta.worstTier || null, null,
        meta.unavailable ? JSON.stringify(meta.unavailable) : null,
        meta.errored ? JSON.stringify(meta.errored) : null,
        meta.policy ? JSON.stringify(meta.policy) : null,
        meta.error || null);
      // first_seen is the run we are reading: the old model never recorded when a
      // listing began, and dating it earlier would be an invention.
      for (const l of listed) {
        if (!l || !l.zone) continue;
        insListing.run(assetId, l.zone, l.name || l.zone, l.tier || 'standard',
          l.codes ? JSON.stringify(l.codes) : null, l.url || null, last.ts, last.ts);
      }
    }

    // Foreign keys are OFF during migrations, so the ON DELETE CASCADE that would
    // normally clear these does not fire — and foreign_key_check runs afterwards.
    const ids = rows.map((r) => r.id).join(',');
    db.exec(`
      DELETE FROM synthetic_results WHERE check_id IN (${ids});
      DELETE FROM check_locations  WHERE check_id IN (${ids});
      DELETE FROM synthetic_checks WHERE id       IN (${ids});
    `);
  },
  // idx 11 -> version 12: reputation checks the hosts a domain's MX records point
  // at, so a listing needs to say WHAT is listed. '' keeps meaning "the asset
  // itself"; an MX finding carries "mail.example.com [1.2.3.4]".
  //
  // NOT NULL DEFAULT '' rather than a nullable column: SQLite treats NULLs as
  // distinct in a UNIQUE index, so nullable `subject` would quietly allow several
  // open episodes for the asset itself on the same zone — the exact invariant the
  // index exists to hold.
  () => {
    if (!hasColumn('reputation_listings', 'subject')) {
      db.exec("ALTER TABLE reputation_listings ADD COLUMN subject TEXT NOT NULL DEFAULT ''");
    }
    addColumn('reputation_runs', 'mx_hosts', 'TEXT');
    // The partial unique index has to widen with it. Indexes can be replaced
    // without touching the table, so this is cheap even on a large history.
    db.exec(`
      DROP INDEX IF EXISTS idx_rep_listing_open;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_rep_listing_open
        ON reputation_listings(asset_id, subject, zone) WHERE resolved_at IS NULL;
    `);
  },
  // idx 12 -> version 13: the Bridge insight analyzer (docs/BRIDGE.md phase 3)
  // tracks how far into the feed it has read, per room, so a server restart
  // neither re-analyzes the whole window nor duplicates insights.
  //
  // THIS ORDER IS LOAD-BEARING. Production already ran this one and sits at
  // user_version 13; the invitation migration below must therefore be 13, not 12.
  // Swapping them would leave every deployed database at 13 with `login_tokens`
  // never gaining its `purpose` column — and nothing would fail loudly, the
  // invitation flow would just start voiding pending invitations.
  () => {
    addColumn('bridges', 'analyzed_feed_id', 'INTEGER NOT NULL DEFAULT 0');
  },
  // idx 13 -> version 14: invited users get an activation LINK, not a password
  // an admin has to relay through a chat. That needs two things:
  //
  //  - login_tokens.purpose, so an activation token (7 days, issued to an address
  //    that has not proven ownership yet) is distinguishable from a magic-link
  //    sign-in (15 minutes, requested by the account owner). Without it the
  //    magic-link cleanup — "delete this user's tokens before issuing a new one" —
  //    would silently void a pending invitation.
  //  - an empty pass_hash has to mean "this account has NO password", which is now
  //    a normal state rather than a broken row. Existing rows are untouched: they
  //    all carry a real hash, and the login route already refuses an empty one.
  () => {
    addColumn('login_tokens', 'purpose', "TEXT NOT NULL DEFAULT 'login'");
  },
  // idx 14 -> version 15: incident primitives (docs/INCIDENTS-V2.md slice 1) —
  // an incident gains an owner, affects status-page components (whose status is
  // then DERIVED from open incidents), and keeps provenance links to the
  // cases/events it grew out of. component_owners feeds auto-assign.
  // The CREATE TABLE blocks mirror schema.sql exactly (fresh installs get them
  // from there; this brings deployed databases forward).
  () => {
    addColumn('incidents', 'assignee_id', 'INTEGER REFERENCES users(id)');
    db.exec(`
      CREATE TABLE IF NOT EXISTS incident_components (
        incident_id  INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
        component_id INTEGER NOT NULL REFERENCES components(id) ON DELETE CASCADE,
        impact       TEXT NOT NULL DEFAULT 'degraded'
                     CHECK (impact IN ('degraded','partial','major')),
        PRIMARY KEY (incident_id, component_id)
      );
      CREATE INDEX IF NOT EXISTS idx_inc_comp_component ON incident_components(component_id);
      CREATE TABLE IF NOT EXISTS incident_links (
        incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
        kind        TEXT NOT NULL CHECK (kind IN ('case','event')),
        ref_id      INTEGER NOT NULL,
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (incident_id, kind, ref_id)
      );
      CREATE INDEX IF NOT EXISTS idx_inc_links_ref ON incident_links(kind, ref_id);
      CREATE TABLE IF NOT EXISTS component_owners (
        component_id INTEGER PRIMARY KEY REFERENCES components(id) ON DELETE CASCADE,
        user_id      INTEGER NOT NULL REFERENCES users(id)
      );
    `);
  },
  // idx 15 -> version 16: status-page subscribers (docs/INCIDENTS-V2.md
  // slice 2) — e-mail double-opt-in + Atom feed. Mirrors schema.sql.
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS status_subscribers (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id       INTEGER NOT NULL,
        email        TEXT NOT NULL,
        token_hash   TEXT NOT NULL,
        confirmed_at INTEGER,
        created_at   INTEGER NOT NULL,
        last_sent_at INTEGER,
        UNIQUE (org_id, email)
      );
      CREATE INDEX IF NOT EXISTS idx_status_subs_org ON status_subscribers(org_id, confirmed_at);
    `);
  },
  // idx 16 -> version 17: per-event timeline (who did what, append-only).
  // Nothing to backfill: the detail endpoint derives the "detected" entry from
  // events.first_seen, so an event that predates this table still opens with a
  // history rather than an empty box. Mirrors schema.sql.
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS event_timeline (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id        INTEGER NOT NULL DEFAULT 1,
        event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        ts            INTEGER NOT NULL,
        user_id       INTEGER REFERENCES users(id),
        action        TEXT NOT NULL,
        detail        TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_event_timeline ON event_timeline(event_id, ts);
    `);
  },
  // idx 17 -> version 18: the status PAGE becomes a first-class row.
  //
  // (This shipped alongside a v17 that created `status_assets` keyed by org.
  // That step was folded in here when it turned out never to have been merged:
  // no database exists in that intermediate state, schema.sql builds the table
  // in its final page-keyed shape, and the rebuild below is guarded on the old
  // column so a branch checkout that DID run it still migrates cleanly.)
  //
  // Until now "the status page" was implicit — one per org, its settings spread
  // through org_settings, addressed by the ORG's slug. Three features need it to
  // be a thing you can have several of: a custom domain (which points at one
  // page, not at an org), a private audience page, and per-page branding. So the
  // page gets a table, its branding moves out of org_settings into COLUMNS (the
  // set is fixed and small — a KV table would buy nothing), and every org gets a
  // default page seeded from what it already had. `/status` and `/status/:slug`
  // keep working because the default page inherits the org's slug.
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS status_pages (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id             INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        slug               TEXT NOT NULL UNIQUE,
        name               TEXT NOT NULL,
        is_default         INTEGER NOT NULL DEFAULT 0,
        published          INTEGER NOT NULL DEFAULT 1,
        visibility         TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
        access_token       TEXT,
        domain             TEXT,
        domain_token       TEXT,
        domain_verified_at INTEGER,
        accent             TEXT NOT NULL DEFAULT '',
        theme              TEXT NOT NULL DEFAULT 'dark',
        description        TEXT NOT NULL DEFAULT '',
        support_url        TEXT NOT NULL DEFAULT '',
        legal_url          TEXT NOT NULL DEFAULT '',
        hide_powered       INTEGER NOT NULL DEFAULT 0,
        custom_css         TEXT NOT NULL DEFAULT '',
        created_at         INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_status_pages_org ON status_pages(org_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_status_pages_domain
        ON status_pages(domain) WHERE domain IS NOT NULL AND domain <> '';

      -- which components a page shows. NO rows for a page = every component of
      -- the org, which is what the default page wants and saves backfilling it.
      CREATE TABLE IF NOT EXISTS status_page_components (
        page_id      INTEGER NOT NULL REFERENCES status_pages(id) ON DELETE CASCADE,
        component_id INTEGER NOT NULL REFERENCES components(id) ON DELETE CASCADE,
        PRIMARY KEY (page_id, component_id)
      );
    `);

    // one default page per org, carrying over everything it had. Guarded like
    // every migration here: on a FRESH install schema.sql has already built the
    // v18 shape and this still runs, so it must be a no-op the second time.
    const orgs = db.prepare(`SELECT id, slug FROM organizations o
      WHERE NOT EXISTS (SELECT 1 FROM status_pages p WHERE p.org_id = o.id AND p.is_default = 1)`).all();
    const setting = db.prepare('SELECT value FROM org_settings WHERE org_id = ? AND key = ?');
    const get = (orgId, key, dflt) => {
      const r = setting.get(orgId, key);
      return r === undefined ? dflt : r.value;
    };
    const ins = db.prepare(`INSERT INTO status_pages (org_id, slug, name, is_default, published,
        accent, theme, description, support_url, legal_url, hide_powered, created_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const t = Date.now();
    for (const o of orgs) {
      ins.run(o.id, o.slug, get(o.id, 'org_name', 'OpsCat'),
        get(o.id, 'status_published', '1') === '1' ? 1 : 0,
        get(o.id, 'status_accent', ''),
        get(o.id, 'status_theme', 'dark') === 'light' ? 'light' : 'dark',
        get(o.id, 'status_description', ''),
        get(o.id, 'status_support_url', ''),
        get(o.id, 'status_legal_url', ''),
        get(o.id, 'status_hide_powered', '0') === '1' ? 1 : 0,
        t);
    }
    // the branding keys now live on the page row; leaving copies behind in
    // org_settings would give the next reader two sources of truth
    db.prepare(`DELETE FROM org_settings WHERE key IN
      ('status_accent','status_theme','status_description','status_support_url',
       'status_legal_url','status_hide_powered')`).run();

    // assets hang off the page, not the org (v17 keyed them by org_id)
    if (hasColumn('status_assets', 'org_id')) {
      db.exec(`
        CREATE TABLE status_assets_v18 (
          page_id    INTEGER NOT NULL REFERENCES status_pages(id) ON DELETE CASCADE,
          kind       TEXT NOT NULL CHECK (kind IN ('logo','favicon')),
          mime       TEXT NOT NULL,
          bytes      BLOB NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (page_id, kind)
        );
        INSERT INTO status_assets_v18 (page_id, kind, mime, bytes, updated_at)
          SELECT p.id, a.kind, a.mime, a.bytes, a.updated_at
            FROM status_assets a JOIN status_pages p ON p.org_id = a.org_id AND p.is_default = 1;
        DROP TABLE status_assets;
        ALTER TABLE status_assets_v18 RENAME TO status_assets;
      `);
    }

    // Subscribers belong to the page they signed up on. This is a table REBUILD
    // rather than an added column because the unique key has to move too: with
    // UNIQUE(org_id, email) the same person subscribing to a second page of the
    // same org would collide with their first subscription and be silently told
    // "already subscribed" — which defeats the whole idea of an audience.
    if (!hasColumn('status_subscribers', 'page_id')) {
      db.exec(`
        CREATE TABLE status_subscribers_v18 (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          org_id       INTEGER NOT NULL,
          page_id      INTEGER NOT NULL REFERENCES status_pages(id) ON DELETE CASCADE,
          email        TEXT NOT NULL,
          token_hash   TEXT NOT NULL,
          confirmed_at INTEGER,
          created_at   INTEGER NOT NULL,
          last_sent_at INTEGER,
          UNIQUE (page_id, email)
        );
        INSERT INTO status_subscribers_v18
            (id, org_id, page_id, email, token_hash, confirmed_at, created_at, last_sent_at)
          SELECT s.id, s.org_id, p.id, s.email, s.token_hash, s.confirmed_at, s.created_at, s.last_sent_at
            FROM status_subscribers s
            JOIN status_pages p ON p.org_id = s.org_id AND p.is_default = 1;
        DROP TABLE status_subscribers;
        ALTER TABLE status_subscribers_v18 RENAME TO status_subscribers;
        CREATE INDEX IF NOT EXISTS idx_status_subs_org ON status_subscribers(org_id, confirmed_at);
      `);
    }
    // outside the guard: schema.sql cannot create this one (it runs before the
    // migrations, when page_id may not exist yet), so a FRESH install — where
    // the rebuild above is correctly skipped — would otherwise never get it
    db.exec('CREATE INDEX IF NOT EXISTS idx_status_subs_page ON status_subscribers(page_id, confirmed_at)');
  },
  // idx 18 -> version 19: managed sensor location history. No FK and no cascade —
  // teardown deletes the synthetic_locations row, and the history has to outlive it.
  // Mirrors schema.sql.
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS node_timeline (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        location_id   INTEGER NOT NULL,
        label         TEXT,
        ts            INTEGER NOT NULL,
        user_id       INTEGER REFERENCES users(id),
        action        TEXT NOT NULL,
        detail        TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_node_timeline ON node_timeline(location_id, ts);
    `);
  },

  // idx 19 -> version 20: per-minute ingest counters. The hourly ingest_stats
  // cannot answer "what is the peak the ingest has to survive" — a burst inside an
  // hour is averaged away, and an hourly average is the one number nobody should
  // size a pipeline on. Kept for 48h only (retention.js), so the table stays small:
  // 1440 rows per org per day. Mirrors schema.sql.
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ingest_minutes (
        org_id        INTEGER NOT NULL,
        bucket        INTEGER NOT NULL,
        lines         INTEGER NOT NULL DEFAULT 0,
        bytes         INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (org_id, bucket)
      ) WITHOUT ROWID;
    `);
  },

  // idx 20 -> version 21: users and organizations get UUID primary keys, and every
  // column referencing them follows. 56 columns across 40 tables.
  //
  // Why the whole thing is generated rather than hand-written: SQLite cannot alter
  // a column's type, so each affected table has to be rebuilt (create → copy →
  // drop → rename → reindex). Writing that out 40 times is where a migration
  // forgets a CHECK constraint or an index. So the new CREATE statement is derived
  // from the table's OWN stored SQL with only the column type rewritten — every
  // default, check, collation and foreign key comes along untouched, and the
  // indexes are replayed verbatim from sqlite_master.
  //
  // The old integer ids are mapped, not discarded: org 1 becomes the fixed
  // DEFAULT_ORG_ID (see util.js) so a single-tenant install keeps a recognisable
  // id, everything else gets a fresh uuid. Both maps live in temp tables so the
  // copy is a plain SQL join instead of a row-by-row round trip.
  () => {
    const { randomUUID } = require('crypto');
    const DEFAULT_ORG_ID = '00000000-0000-4000-8000-000000000001';

    const ORG_COLS = ['org_id', 'active_org_id'];
    const USER_COLS = ['user_id', 'created_by', 'assignee_id', 'assigned_user_id', 'finished_by'];

    db.exec(`CREATE TEMP TABLE _org_map (old INTEGER PRIMARY KEY, new TEXT NOT NULL);
             CREATE TEMP TABLE _user_map (old INTEGER PRIMARY KEY, new TEXT NOT NULL);`);
    const insOrgMap = db.prepare('INSERT INTO _org_map (old, new) VALUES (?, ?)');
    const insUserMap = db.prepare('INSERT INTO _user_map (old, new) VALUES (?, ?)');
    for (const r of db.prepare('SELECT id FROM organizations').all()) {
      // String(), not `=== 1`: on a FRESH install schema.sql already declares the
      // column TEXT, so migration idx 1's `VALUES (1, …)` is stored as the string
      // '1' by text affinity — and `'1' === 1` is false. That mismatch handed the
      // default org a random uuid, and the seed's user insert (which references
      // DEFAULT_ORG_ID) then died on a foreign key. An old database really does
      // hold the integer 1 here, so both spellings have to map to the same place.
      insOrgMap.run(r.id, String(r.id) === '1' ? DEFAULT_ORG_ID : randomUUID());
    }
    for (const r of db.prepare('SELECT id FROM users').all()) insUserMap.run(r.id, randomUUID());

    // Rewrite one column's declared type inside a CREATE TABLE statement. Anchored
    // to the column name at the start of its line so `org_id` cannot match inside
    // `REFERENCES organizations(id)` or a comment.
    const retype = (sql, col) => sql.replace(
      new RegExp(`(^|\\n)(\\s*)"?${col}"?(\\s+)INTEGER\\b`, 'g'),
      (_m, lead, indent, gap) => `${lead}${indent}${col}${gap}TEXT`);

    const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?");
    const idxSql = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name = ? AND sql IS NOT NULL");

    // cols: [{name, map}] — map is the temp table holding old→new for that column
    function convert(table, cols, pk) {
      const row = tableSql.get(table);
      if (!row) return;                                   // table absent on this install
      let create = row.sql;
      for (const c of cols) create = retype(create, c.name);
      if (pk) {
        // AUTOINCREMENT is only legal on INTEGER PRIMARY KEY, so it goes with it.
        // NOT NULL is explicit: SQLite only implies it for an INTEGER primary
        // key, so without it a TEXT key accepts NULL and the foreign keys break
        // elsewhere. (Found by e2e-invite, which inserts an org without an id.)
        create = create.replace(/(^|\n)(\s*)"?id"?\s+INTEGER PRIMARY KEY AUTOINCREMENT/,
          (_m, lead, indent) => `${lead}${indent}id            TEXT PRIMARY KEY NOT NULL`);
      }
      const indexes = idxSql.all(table).map((r) => r.sql);
      const tmp = `${table}__uuid`;
      db.exec(create.replace(
        new RegExp(`CREATE TABLE (IF NOT EXISTS )?"?${table}"?`), `CREATE TABLE ${tmp}`));

      const names = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      const all = pk ? [...cols, { name: 'id', map: pk }] : cols;
      const select = names.map((n) => {
        const c = all.find((x) => x.name === n);
        // LEFT-JOIN semantics via subselect: a NULL stays NULL, and a dangling id
        // (possible — several of these columns carry no foreign key) becomes NULL
        // rather than a string that references nothing.
        return c ? `(SELECT new FROM ${c.map} WHERE old = t.${n}) AS ${n}` : `t.${n}`;
      }).join(', ');
      db.exec(`INSERT INTO ${tmp} (${names.join(', ')}) SELECT ${select} FROM ${table} t`);
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);
      for (const s of indexes) db.exec(s);
    }

    // Walk every table and convert whatever it carries — no hand-kept list to fall
    // out of date with the schema.
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    for (const { name } of tables) {
      if (name === 'users' || name === 'organizations') continue;   // done last, below
      const cols = db.prepare(`PRAGMA table_info(${name})`).all()
        .filter((c) => ORG_COLS.includes(c.name) || USER_COLS.includes(c.name))
        .map((c) => ({ name: c.name, map: ORG_COLS.includes(c.name) ? '_org_map' : '_user_map' }));
      if (cols.length) convert(name, cols, null);
    }
    // users references organizations, so organizations is rebuilt last.
    convert('users', [{ name: 'org_id', map: '_org_map' }], '_user_map');
    convert('organizations', [], '_org_map');

    // sqlite_sequence rows for the two tables are meaningless now — an AUTOINCREMENT
    // counter for a key nothing counts.
    db.exec("DELETE FROM sqlite_sequence WHERE name IN ('users', 'organizations')");
    db.exec('DROP TABLE _org_map; DROP TABLE _user_map;');
  },
  // idx 21 -> version 22: the Microsoft Teams alert channel is renamed
  // 'teams' -> 'msteams', and its org setting with it. The On-Call module
  // (docs/ONCALL-V1.md) introduces a Team object of our own, and a paging
  // target `kind = 'team'` one letter away from `channel = 'teams'` is a
  // collision in the one subsystem where getting it wrong sends a page to a
  // webhook instead of to a person. Renamed now rather than later because the
  // value is about to be embedded in automation graph documents, which
  // AUTOMATION-V1 §9.2 keeps as IMMUTABLE version snapshots — after that a
  // rename can only be an alias forever.
  //
  // Breaking on purpose: the API accepts only the new spelling. No alias, no
  // second spelling of one fact (INCIDENTS-V2 §2, same call for `impact`).
  () => {
    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'alert_rules'").get();
    // The channel CHECK is baked into the table, so rebuild it (as migration
    // v3 did to widen it). A fresh install already has the new CHECK.
    if (ddl && !ddl.sql.includes("'msteams'")) {
      // org_id is TEXT here, NOT the integer the pre-v21 table had: migration 20
      // moved organizations to uuid keys, and a rebuild that re-declared it as
      // INTEGER would quietly undo that for this one table — the rows would
      // survive, every org-scoped rule lookup would stop matching, and nothing
      // would raise an error. Mirrors schema.sql.
      db.exec(`
        CREATE TABLE alert_rules_new (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          org_id        TEXT NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001',
          name          TEXT NOT NULL,
          enabled       INTEGER NOT NULL DEFAULT 1,
          channel       TEXT NOT NULL CHECK (channel IN
                          ('email','msteams','webhook','slack','telegram','discord','ntfy','pushover')),
          trigger_name  TEXT,
          severity_min  INTEGER NOT NULL DEFAULT 60,
          cooldown_m    INTEGER NOT NULL DEFAULT 15,
          recipients    TEXT NOT NULL DEFAULT '[]',
          created_at    INTEGER NOT NULL
        );
        INSERT INTO alert_rules_new (id, org_id, name, enabled, channel, trigger_name,
          severity_min, cooldown_m, recipients, created_at)
          SELECT id, org_id, name, enabled,
            CASE channel WHEN 'teams' THEN 'msteams' ELSE channel END,
            trigger_name, severity_min, cooldown_m, recipients, created_at FROM alert_rules;
        DROP TABLE alert_rules;
        ALTER TABLE alert_rules_new RENAME TO alert_rules;
        CREATE INDEX IF NOT EXISTS idx_rules_org ON alert_rules(org_id);
      `);
    }
    // The delivery log carries the same fact and has no CHECK; rewrite it too
    // rather than leave two spellings in the one screen that answers "why did
    // nothing arrive". Bounded: engine/retention.js prunes this table.
    db.prepare("UPDATE notifications SET channel = 'msteams' WHERE channel = 'teams'").run();
    // Per-org webhook URL. INSERT-then-DELETE rather than UPDATE, so an org
    // that somehow holds both keys keeps the value it was already using.
    db.prepare(`INSERT INTO org_settings (org_id, key, value)
      SELECT org_id, 'msteams_webhook_url', value FROM org_settings WHERE key = 'teams_webhook_url'
      ON CONFLICT(org_id, key) DO NOTHING`).run();
    db.prepare("DELETE FROM org_settings WHERE key = 'teams_webhook_url'").run();
    db.prepare("DELETE FROM settings WHERE key = 'teams_webhook_url'").run();
  },
  // idx 22 -> version 23: On-Call slice 1 (docs/ONCALL-V1.md) — teams, schedules,
  // layers, participants and overrides. Who has the duty, computable for any
  // instant. The CREATE TABLE blocks mirror schema.sql exactly (fresh installs
  // get them from there; this brings deployed databases forward).
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS teams (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id        TEXT NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'
                      REFERENCES organizations(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        UNIQUE (org_id, name)
      );
      CREATE TABLE IF NOT EXISTS team_members (
        team_id       INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (team_id, user_id)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS schedules (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id        TEXT NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001'
                      REFERENCES organizations(id) ON DELETE CASCADE,
        team_id       INTEGER REFERENCES teams(id) ON DELETE SET NULL,
        name          TEXT NOT NULL,
        timezone      TEXT NOT NULL DEFAULT 'UTC',
        gap_alerted_at INTEGER,
        created_at    INTEGER NOT NULL,
        UNIQUE (org_id, name)
      );
      CREATE TABLE IF NOT EXISTS schedule_layers (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule_id   INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
        position      INTEGER NOT NULL,
        rotation      TEXT NOT NULL DEFAULT 'weekly'
                      CHECK (rotation IN ('daily','weekly','custom')),
        interval_d    INTEGER NOT NULL DEFAULT 1,
        handoff_at    INTEGER NOT NULL,
        restrict_json TEXT,
        UNIQUE (schedule_id, position)
      );
      CREATE TABLE IF NOT EXISTS schedule_participants (
        layer_id      INTEGER NOT NULL REFERENCES schedule_layers(id) ON DELETE CASCADE,
        position      INTEGER NOT NULL,
        user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (layer_id, position)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS schedule_overrides (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule_id   INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
        user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        starts_at     INTEGER NOT NULL,
        ends_at       INTEGER NOT NULL,
        created_by    TEXT REFERENCES users(id),
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sched_ovr ON schedule_overrides(schedule_id, starts_at, ends_at);
    `);
  },
];
// Foreign keys are off while migrating so table rebuilds (drop + rename) do not
// cascade into referencing tables (e.g. notifications.rule_id ON DELETE SET NULL);
// a foreign_key_check afterwards guards against real integrity breaks.
if (getVersion() < MIGRATIONS.length) {
  db.pragma('foreign_keys = OFF');
  for (let v = getVersion(); v < MIGRATIONS.length; v++) {
    db.transaction(() => { MIGRATIONS[v](); db.pragma(`user_version = ${v + 1}`); })();
  }
  db.pragma('foreign_keys = ON');
  const fkErrors = db.pragma('foreign_key_check');
  if (fkErrors.length) throw new Error(`migration left broken foreign keys: ${JSON.stringify(fkErrors.slice(0, 5))}`);
}

// --- settings helpers ---
const settingGetStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const settingSetStmt = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

function getSetting(key, def = null) {
  const row = settingGetStmt.get(key);
  return row ? row.value : def;
}
function setSetting(key, value) { settingSetStmt.run(key, String(value)); }

// per-organization settings
const orgSettingGetStmt = db.prepare('SELECT value FROM org_settings WHERE org_id = ? AND key = ?');
const orgSettingSetStmt = db.prepare(
  `INSERT INTO org_settings (org_id, key, value) VALUES (?, ?, ?)
   ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value`);
function getOrgSetting(orgId, key, def = null) {
  const row = orgSettingGetStmt.get(orgId, key);
  return row ? row.value : def;
}
function setOrgSetting(orgId, key, value) { orgSettingSetStmt.run(orgId, key, String(value)); }

// --- memberships (multi-org): who is in which org, with what role ---
const membershipGetStmt = db.prepare('SELECT role FROM memberships WHERE user_id = ? AND org_id = ?');
const membershipUpsertStmt = db.prepare(
  `INSERT INTO memberships (user_id, org_id, role, created_at) VALUES (?, ?, ?, ?)
   ON CONFLICT(user_id, org_id) DO UPDATE SET role = excluded.role`);
const membershipListStmt = db.prepare(
  `SELECT m.org_id, m.role, o.name, o.slug, o.plan, o.status
   FROM memberships m JOIN organizations o ON o.id = m.org_id
   WHERE m.user_id = ? ORDER BY o.name`);
const membershipDelStmt = db.prepare('DELETE FROM memberships WHERE user_id = ? AND org_id = ?');
const membershipAnyStmt = db.prepare('SELECT org_id, role FROM memberships WHERE user_id = ? ORDER BY org_id LIMIT 1');

function getMembership(userId, orgId) { return membershipGetStmt.get(userId, orgId); }
function addMembership(userId, orgId, role = 'analyst') { membershipUpsertStmt.run(userId, orgId, role, Date.now()); }
function listMemberships(userId) { return membershipListStmt.all(userId); }
function removeMembership(userId, orgId) { membershipDelStmt.run(userId, orgId); }
function anyMembership(userId) { return membershipAnyStmt.get(userId); }

// Persist an app secret if none provided via env (used for SNMP community encryption).
if (!config.secret) {
  let s = getSetting('app_secret');
  if (!s) { s = require('crypto').randomBytes(32).toString('hex'); setSetting('app_secret', s); }
  config.secret = s;
}

module.exports = {
  db, getSetting, setSetting, getOrgSetting, setOrgSetting,
  getMembership, addMembership, listMemberships, removeMembership, anyMembership,
  // The version a fully-migrated database sits at. Exported so a test can assert
  // "migrated to the end" instead of pinning a literal that has to be bumped in
  // every harness each time a migration is added — which is exactly what the
  // reputation harness did, and it went red on an unrelated change.
  SCHEMA_VERSION: MIGRATIONS.length,
};
