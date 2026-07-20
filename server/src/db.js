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
};
