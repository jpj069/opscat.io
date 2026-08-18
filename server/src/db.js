'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config');
const q = require('./db/shim');

/* ── The schema, and how it changes ─────────────────────────────────────────
 *
 * ONE engine, one dialect: `schema.sql` is PostgreSQL DDL and is the only
 * description of the shape. `init()` applies it at boot — every statement in it
 * is `CREATE ... IF NOT EXISTS`, so it creates a fresh install and leaves an
 * existing database alone. There is no provisioning step to remember and no
 * generated intermediate: the file that is reviewed is the file that runs.
 *
 * That replaces two things that retired together with SQLite (decision D6 in
 * docs/POSTGRES-MIGRATION-PLAN.md):
 *
 *   • the 25-entry MIGRATION LADDER that used to live in this file, built from
 *     `PRAGMA user_version`, `PRAGMA table_info` and a dozen whole-table
 *     rebuilds through `sqlite_master`. None of it was portable, and none of it
 *     was ever RUN on Postgres — the Postgres path was always "created fresh at
 *     v-latest, record the number". It was SQLite's history, so it went with
 *     SQLite. `schema_migrations` keeps the number it recorded (25), which is
 *     what makes an existing production database indistinguishable from a fresh
 *     one from here on.
 *   • `scripts/pg-schema.js`, which translated the SQLite DDL into this. The
 *     rule it forced — "never hand-maintain the Postgres schema" — existed
 *     because a second copy drifts, and there is no second copy any more.
 *
 * ── Writing a migration, now that there is one engine ───────────────────────
 *
 * A change to an EXISTING database is a numbered SQL file in `src/migrations/`:
 *
 *     src/migrations/026-add-cases-owner.sql
 *
 * Plain PostgreSQL, no wrapper, no JavaScript. `init()` runs every file
 * numbered ABOVE the version the database carries, each in its own transaction,
 * and records the number. A FRESH database — one with no `schema_migrations`
 * row at all — is stamped at the highest number and runs NONE of them, because
 * `schema.sql` is already that shape.
 *
 * **Which is the rule that matters: a migration and `schema.sql` are written in
 * the SAME commit.** The migration moves the databases that exist; `schema.sql`
 * moves the ones that do not exist yet. Edit only the migration and every fresh
 * install is missing the column; edit only `schema.sql` and production never
 * gets it. Nothing can detect that for you from one side — the two describe
 * different populations — so `e2e-schema.js` guards what it can (the file
 * applies cleanly, twice, and the numbering is sane) and the rest is the commit
 * discipline stated here.
 *
 * Migrations are one-way. There is no `down`, deliberately: a rollback of a
 * schema change on a live database is a restore, not a script nobody has run.
 */

const SCHEMA = path.join(__dirname, 'schema.sql');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/* The version `schema.sql` corresponds to when no migration files exist.
 *
 * 25 is where the SQLite ladder ended, and it is deliberately not 0: production
 * recorded 25 at the cutover, so starting the numbering here means an existing
 * database and a fresh one agree without a special case. Migration 026 is the
 * next one anybody writes.
 */
const BASE_VERSION = 25;

/* The migration files on disk, ascending, as { version, name, file }.
 *
 * `dir` is a parameter for exactly one reason: until somebody writes migration
 * 026 this loader has no input, so nothing would ever execute it and the first
 * real migration would be its first run — at the moment it is least welcome.
 * e2e-schema.js drives it against a directory of its own instead.
 */
function migrationFiles(dir = MIGRATIONS_DIR) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names.sort()) {
    if (!n.endsWith('.sql')) continue;
    const m = /^(\d+)-/.exec(n);
    if (!m) {
      throw new Error(`src/migrations/${n} is not numbered — a migration file is `
        + '`NNN-description.sql`, and the number is what decides the order it runs in');
    }
    const version = Number(m[1]);
    if (version <= BASE_VERSION) {
      throw new Error(`src/migrations/${n} is numbered ${version}, at or below the baseline `
        + `${BASE_VERSION} that schema.sql already carries — it would never run. Number it higher.`);
    }
    if (out.some((o) => o.version === version)) {
      throw new Error(`two migrations are numbered ${version} — the order they run in would be `
        + 'whatever readdir returned');
    }
    out.push({ version, name: n, file: path.join(dir, n) });
  }
  return out.sort((a, b) => a.version - b.version);
}

/** The highest version this BUILD knows about. */
const latestVersion = (dir) => {
  const files = migrationFiles(dir);
  return files.length ? files[files.length - 1].version : BASE_VERSION;
};

/* Bring the database to the shape this build expects.
 *
 * `schema.sql` first and always: it is idempotent, and running it on every boot
 * is what makes a fresh install need no provisioning step. Then the ladder, if
 * this database is behind. A database AHEAD of this build is refused rather
 * than migrated backwards by a ladder that only goes one way — it was written
 * by a newer OpsCat, and serving from it would mean writing rows in a shape
 * this build does not know.
 */
/** @param {{ migrationsDir?: string }} [opts] */
async function applySchema(opts = {}) {
  const migrationsDir = opts.migrationsDir;
  await q.exec(fs.readFileSync(SCHEMA, 'utf8'));

  const files = migrationFiles(migrationsDir);
  const latest = latestVersion(migrationsDir);
  const row = await q.get('SELECT MAX(version) AS v FROM schema_migrations');
  const at = row && row.v != null ? Number(row.v) : null;

  if (at === null) {
    // Fresh: schema.sql IS the latest shape, so stamp it and run nothing.
    await q.run('INSERT INTO schema_migrations (version) VALUES (?)', latest);
    return;
  }
  if (at > latest) {
    throw new Error(`database is at schema version ${at}, this build knows ${latest} `
      + '— it was written by a newer OpsCat and this one must not run against it');
  }
  for (const m of files) {
    if (m.version <= at) continue;
    const sql = fs.readFileSync(m.file, 'utf8');
    // One transaction per migration: a failure leaves the database at the last
    // version that fully applied, rather than half-way through one nobody can
    // name. Postgres has transactional DDL, so this is a real guarantee here in
    // a way it never was on the engine this replaced.
    await q.withTx(async () => {
      await q.exec(sql);
      await q.run('INSERT INTO schema_migrations (version) VALUES (?)', m.version);
    });
    console.log(`[db] applied migration ${m.name}`);
  }
}

/** The version this database sits at. */
async function schemaVersion() {
  const row = await q.get('SELECT MAX(version) AS v FROM schema_migrations');
  return row && row.v != null ? Number(row.v) : 0;
}

/* --- settings helpers: a write-through cache, and why it exists ------------
 *
 * `getSetting` and `getOrgSetting` have 62 call sites, and a large share of
 * them are BOOLEAN GUARDS — `if (getOrgSetting(orgId, 'x') === '1')`, ternaries,
 * `.filter()` predicates. Converting those to `await` is the single most
 * dangerous edit in the whole port, because a missed one is the failure mode
 * nothing can catch: `!Promise` is `false`, the strict thenable never sees a
 * property read, and the type gate is blind to a value that is only TESTED.
 * Measured three separate times in this migration, each time a 200 with no log
 * line.
 *
 * So these two do not become async. The tables are read on every request and
 * written by admin action, which is the exact shape a cache is for: both are
 * loaded once at boot and kept current by the only code that can write them.
 *
 * The precondition is what makes this safe, and it is measured rather than
 * assumed: there are ZERO writes to `settings` or `org_settings` anywhere
 * outside this file (the only direct SQL elsewhere is two READS in
 * lib/status-pages.js). A writer that bypassed `setSetting` would leave the
 * cache stale with nothing to notice — so if one is ever added, it goes through
 * here or this comment is a lie. `e2e-pipeline`'s classifier checks and
 * `e2e-branding`'s plan gates both read through this path, so a broken cache
 * fails the suite rather than production.
 *
 * The cache is PER PROCESS. A second process against the same database (which
 * `e2e-alerts` starts deliberately, and which a scaled-out deployment would)
 * reads its own snapshot from boot and does not see the other's writes. That is
 * a real limitation and it is accepted: settings change by admin action, not by
 * the engines, and D5 already lists cross-instance state as an open question.
 * It is written down here rather than discovered later.
 */
const settingSetStmt = q.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
const orgSettingSetStmt = q.prepare(
  `INSERT INTO org_settings (org_id, key, value) VALUES (?, ?, ?)
   ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value`);
const settingsAllStmt = q.prepare('SELECT key, value FROM settings');
const orgSettingsAllStmt = q.prepare('SELECT org_id, key, value FROM org_settings');

const settingCache = new Map();      // key -> value
const orgSettingCache = new Map();   // `${orgId}\u0000${key}` -> value
// A NUL separator, not a colon: an org id is a uuid today but a key is
// arbitrary text, and `a:b|c` and `a|b:c` must never collide into one entry.
const orgKey = (orgId, key) => `${orgId}\u0000${key}`;

/** Load both tables into the cache. Called by init(), and by a harness that
 *  writes settings behind our back before requiring a route. */
async function loadSettingsCache() {
  const rows = await settingsAllStmt.all();
  const orgRows = await orgSettingsAllStmt.all();
  // Cleared only once both reads have landed: an await between clear() and
  // refill is a window in which every setting reads as its default, and on this
  // path that includes app_secret.
  settingCache.clear();
  orgSettingCache.clear();
  for (const r of rows) settingCache.set(r.key, r.value);
  for (const r of orgRows) orgSettingCache.set(orgKey(r.org_id, r.key), r.value);
}

// getSetting / getOrgSetting stay SYNCHRONOUS. See the block comment above: 62
// call sites, most of them boolean guards, and `Promise === '1'` is `false` with
// nothing in the language able to notice. The writers are async because they
// touch the database; the readers answer from the cache and never will.
function getSetting(key, def = null) {
  const v = settingCache.get(key);
  return v === undefined ? def : v;
}
async function setSetting(key, value) {
  const v = String(value);
  await settingSetStmt.run(key, v);
  settingCache.set(key, v);
}
function getOrgSetting(orgId, key, def = null) {
  const v = orgSettingCache.get(orgKey(orgId, key));
  return v === undefined ? def : v;
}
async function setOrgSetting(orgId, key, value) {
  const v = String(value);
  await orgSettingSetStmt.run(orgId, key, v);
  orgSettingCache.set(orgKey(orgId, key), v);
}

// --- memberships (multi-org): who is in which org, with what role ---
/* `org_id` is selected as well as `role`, and it is load-bearing rather than
 * decorative. `security.js`'s stale-active-org fallback reads
 * `membership.org_id` off this row to decide which org to serve — with `role`
 * alone that was `undefined`, so the session's active org was overwritten with
 * NULL and the request answered 401 "organization missing". A user whose
 * session pointed at an org they had left could not use the product at all
 * until they logged in again, and nothing in the suite said so.
 * Covered by e2e-crossorg.js ("falls back to one they are in"). */
const membershipGetStmt = q.prepare('SELECT org_id, role FROM memberships WHERE user_id = ? AND org_id = ?');
const membershipUpsertStmt = q.prepare(
  `INSERT INTO memberships (user_id, org_id, role, created_at) VALUES (?, ?, ?, ?)
   ON CONFLICT(user_id, org_id) DO UPDATE SET role = excluded.role`);
const membershipListStmt = q.prepare(
  `SELECT m.org_id, m.role, o.name, o.slug, o.plan, o.status
   FROM memberships m JOIN organizations o ON o.id = m.org_id
   WHERE m.user_id = ? ORDER BY o.name`);
const membershipDelStmt = q.prepare('DELETE FROM memberships WHERE user_id = ? AND org_id = ?');
const membershipAnyStmt = q.prepare('SELECT org_id, role FROM memberships WHERE user_id = ? ORDER BY org_id LIMIT 1');

/* All five are async, and four of their call sites read the answer straight into
 * a boolean — security.js's `||` chain, routes/auth.js's switch-org guard,
 * routes/admin.js's "already in this organization", routes/mcp-oauth.js's
 * revoked-membership check. That is the one shape neither the type gate nor the
 * strict thenable can see: `!Promise` is `false`, so the guard simply stops
 * firing and the request is answered 200. Each of those four is parenthesised at
 * its call site — `if (!(await getMembership(...)))` — so a lost await is a
 * change to the punctuation of the line rather than an invisible deletion, and
 * e2e-crossorg.js covers the outcome. */
function getMembership(userId, orgId) { return membershipGetStmt.get(userId, orgId); }
async function addMembership(userId, orgId, role = 'analyst') {
  await membershipUpsertStmt.run(userId, orgId, role, Date.now());
}
function listMemberships(userId) { return membershipListStmt.all(userId); }
function removeMembership(userId, orgId) { return membershipDelStmt.run(userId, orgId); }
function anyMembership(userId) { return membershipAnyStmt.get(userId); }

/* Persist an app secret if none was provided via env (it encrypts SNMP
 * communities, telephony credentials and LLM keys). Minting a REPLACEMENT makes
 * every one of those undecryptable and every session invalid — once, silently,
 * on a deploy — which is why e2e-settings.js forks two processes to prove the
 * same one comes back. */
async function ensureAppSecret() {
  if (config.secret) return;
  let s = getSetting('app_secret');
  if (!s) { s = require('crypto').randomBytes(32).toString('hex'); await setSetting('app_secret', s); }
  config.secret = s;
}

/* Bring the database to a state the app can serve from, once per process.
 *
 * Awaited by index.js BEFORE seed(), the engines and app.listen() — see the
 * two-boot-paths note at the top. Idempotent and memoised: a harness that
 * requires db.js directly and an index.js that boots it get the same one run.
 */
let initOnce = null;
function init() {
  if (!initOnce) {
    initOnce = (async () => {
      await applySchema();
      await loadSettingsCache();
      await ensureAppSecret();
    })();
  }
  return initOnce;
}

module.exports = {
  init, schemaVersion, applySchema,
  getSetting, setSetting, getOrgSetting, setOrgSetting, loadSettingsCache,
  getMembership, addMembership, listMemberships, removeMembership, anyMembership,
  // The migration accounting, exported so a harness can assert "at the end"
  // rather than pinning a literal that has to be bumped in every harness each
  // time a migration is added — which is what the reputation harness used to do,
  // and it went red on an unrelated change.
  BASE_VERSION, latestVersion, migrationFiles,
};
