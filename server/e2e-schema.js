'use strict';
/* Guards `src/schema.sql`, which is now the schema rather than a source for one.
 *
 * ── What this file used to be, and why it is not that any more ──────────────
 *
 * It existed to catch drift between two paths that no longer both exist. A
 * fresh install ran `schema.sql`; an existing one ran `schema.sql` plus the
 * 25-step migration ladder in `db.js`, and nothing checked that they converged
 * — they had not: **17 indexes existed only in migrations**, including
 * `idx_events_dedupe_active`, the partial unique index that IS the
 * event-deduplication invariant. That comparison retired with the ladder
 * (decision D6): SQLite is gone, the ladder was SQLite's history, and there is
 * no second path left to converge with.
 *
 * Its other half retired into the ENGINE. `schema.sql` used to declare five
 * tables referencing tables created later in the same file — SQLite resolves
 * foreign keys lazily and does not care, Postgres fails on `CREATE TABLE` — so
 * the ordering had to be checked here. Now the file IS PostgreSQL DDL and is
 * applied by `db.init()` at every boot and by `run-e2e.js` to build the test
 * template, so a forward reference is a hard failure before any check runs.
 *
 * ── What it is FOR now ──────────────────────────────────────────────────────
 *
 * Applying `schema.sql` on every boot is a new property, and it brings a new
 * silent failure with it: **a table or index declared without `IF NOT EXISTS`
 * works exactly once.** The install that creates it is fine; every restart
 * afterwards dies in `db.init()` with `relation already exists`, before
 * `app.listen`. On a deploy that is a container that will not come up, and the
 * commit that caused it looks like an ordinary `CREATE TABLE`. So the load-
 * bearing check here is that the file applies TWICE.
 *
 * The rest is the migration accounting: that a fresh database is stamped at the
 * version this build knows and runs nothing, that a database ahead of the build
 * is refused rather than served, that the numbering rules hold — and that the
 * loader itself works, driven against a directory of throwaway migration files.
 * Without that last one the ladder is dead code until somebody needs it in a
 * hurry, which is the worst moment for its first execution.
 *
 * Boots no server and needs no port; it needs the DATABASE_URL run-e2e.js hands
 * it.  cd server && node run-e2e.js schema
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('pg');

const { chk, report, onExit, die } = require('./e2e-lib').harness();

process.env.OPSCAT_SECRET = 'e2e-schema-secret';

const SCHEMA_PATH = path.join(__dirname, 'src', 'schema.sql');
const schemaText = fs.readFileSync(SCHEMA_PATH, 'utf8');

const q = require('./src/db/shim');
const dbMod = require('./src/db');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opscat-migrations-'));
onExit(() => fs.rmSync(tmp, { recursive: true, force: true }));

/* A private schema inside this harness's own database, so the file can be
 * applied to genuinely empty space without a second database (and without
 * `CREATE TABLE IF NOT EXISTS` finding the app's tables through the search
 * path and skipping every statement, which would make the whole section pass
 * while testing nothing). `search_path` names ONE schema for that reason.
 */
async function inCleanSchema(fn) {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query('DROP SCHEMA IF EXISTS probe CASCADE');
    await c.query('CREATE SCHEMA probe');
    await c.query('SET search_path TO probe');
    return await fn(c);
  } finally {
    try { await c.query('DROP SCHEMA IF EXISTS probe CASCADE'); } catch { /* best effort */ }
    await c.end();
  }
}

/**
 * Every `<table>.<column>` that a migration at or above the baseline ADDs.
 *
 * Parsed out of the SQL rather than maintained by hand: a list someone has to
 * remember to extend is a list that stops covering the newest migration, which
 * is precisely the one that can break boot.
 *
 * @returns {[string, string][]}
 */
function pendingAddedColumns() {
  const dir = path.join(__dirname, 'src', 'migrations');
  /** @type {[string, string][]} */
  const out = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8')
      .replace(/--[^\n]*/g, '');                       // comments carry examples
    // `ALTER TABLE x ADD COLUMN [IF NOT EXISTS] c ...`, including the
    // comma-separated form, which migration 031 uses.
    const m = /ALTER\s+TABLE\s+(\w+)([\s\S]*?);/gi;
    let hit;
    while ((hit = m.exec(sql)) !== null) {
      const table = hit[1];
      const body = hit[2];
      const cols = /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi;
      let c;
      while ((c = cols.exec(body)) !== null) out.push([table, c[1]]);
    }
  }
  return out;
}

async function main() {
  // ── 1. the file applies to an empty database, and applies AGAIN ───────────
  const applied = await inCleanSchema(async (c) => {
    let firstErr = null;
    try { await c.query(schemaText); } catch (e) { firstErr = e; }
    chk('schema.sql applies to an empty database', firstErr === null, String(firstErr));

    const tables = (await c.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'probe'")).rows.map((r) => r.tablename);
    const indexes = (await c.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'probe'")).rows.map((r) => r.indexname);
    chk('…and creates the tables', tables.length > 50, `${tables.length} tables`);
    chk('…and the indexes', indexes.length > 50, `${indexes.length} indexes`);

    /* THE check this file exists for now. db.init() runs schema.sql on every
     * boot, so a statement without IF NOT EXISTS works on the install that
     * creates it and kills the process on every restart after that. Nothing
     * else in the suite would notice: every harness gets a fresh database.
     */
    let secondErr = null;
    try { await c.query(schemaText); } catch (e) { secondErr = e; }
    chk('schema.sql is IDEMPOTENT — applying it twice is a no-op, because boot does',
      secondErr === null,
      secondErr ? `${secondErr.message} — add IF NOT EXISTS to that statement` : '');

    const after = (await c.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'probe'")).rows.length;
    chk('…and the second pass creates nothing new', after === tables.length,
      `${tables.length} -> ${after}`);

    /* ── and it applies to a database that PREDATES the newest migrations ──
     *
     * This is the check that was missing on 2026-08-24, and its absence took
     * production down for 23 minutes.
     *
     * `applySchema` runs this file BEFORE the migration runner. On an existing
     * database every `CREATE TABLE IF NOT EXISTS` is a no-op, so the columns a
     * pending migration adds are simply not there yet — and a STANDALONE
     * statement that references one of them (an index, a constraint, a view)
     * dies with `column "x" does not exist`, before the migration that would
     * have created it can run. A boot loop on every install that already
     * existed, from a commit whose fresh-install path is perfect.
     *
     * Nothing above can see it: both passes run against a database that
     * schema.sql itself just created, where CREATE TABLE included the column.
     * So the old world is SIMULATED — drop exactly what the pending migrations
     * add, then apply the file again. That is the shape of every existing
     * install at the moment it boots the new code.
     */
    const added = pendingAddedColumns();
    for (const [table, col] of added) {
      // eslint-disable-next-line no-await-in-loop
      await c.query(`ALTER TABLE probe.${table} DROP COLUMN IF EXISTS ${col} CASCADE`);
    }
    chk('the pending migrations do add columns, so this check is not vacuous',
      added.length > 0, `${added.length} column(s) parsed out of src/migrations/`);
    let oldErr = null;
    try { await c.query(schemaText); } catch (e) { oldErr = e; }
    chk('schema.sql applies to a database PREDATING its own migrations',
      oldErr === null,
      oldErr ? `${oldErr.message} — a standalone statement in schema.sql depends on a `
        + 'column only a migration adds; move it into the CREATE TABLE, because this '
        + 'file runs BEFORE migrations on every existing install' : '');
    return { tables, indexes };
  });

  // ── 2. the invariant index, named so a deletion reads as deliberate ───────
  // Every other missing index costs performance. This one costs correctness:
  // without it the dedupe upsert has nothing to conflict on and every active
  // event duplicates, with no error anywhere.
  chk('idx_events_dedupe_active exists (the dedupe invariant, not an optimisation)',
    applied.indexes.includes('idx_events_dedupe_active'));
  chk('…and it is the PARTIAL unique index the invariant needs, not a plain one',
    /CREATE UNIQUE INDEX[^;]*idx_events_dedupe_active[^;]*WHERE\s+status\s*=\s*'active'/i
      .test(schemaText));

  // ── 3. version accounting on a database this build created ───────────────
  await dbMod.init();
  const latest = dbMod.latestVersion();
  chk('the baseline is where the SQLite ladder ended', dbMod.BASE_VERSION === 25,
    String(dbMod.BASE_VERSION));
  chk('a fresh database is stamped at the version this build knows',
    (await dbMod.schemaVersion()) === latest, `${await dbMod.schemaVersion()} vs ${latest}`);
  chk('…exactly once — init() is idempotent and must not stamp again',
    (await q.get('SELECT COUNT(*) c FROM schema_migrations')).c === 1,
    String((await q.get('SELECT COUNT(*) c FROM schema_migrations')).c));

  // A database written by a NEWER build must be refused, not served: this one
  // would write rows in a shape it does not understand.
  await q.run('INSERT INTO schema_migrations (version) VALUES (?)', latest + 5);
  let refused = null;
  try { await dbMod.applySchema(); } catch (e) { refused = e; }
  chk('a database ahead of this build is refused rather than served',
    refused !== null && /newer OpsCat/.test(String(refused.message)), String(refused));
  await q.run('DELETE FROM schema_migrations WHERE version = ?', latest + 5);

  // ── 4. the migration loader, driven ──────────────────────────────────────
  // The throwaway files are numbered ABOVE whatever `src/migrations/` really
  // holds, and that is not tidiness. This database was stamped at `latest` a few
  // lines up, so a fixture numbered 026 is "already applied" the moment a real
  // 026 exists — the loader skips it, `mig_probe` is never created, and the file
  // fails on the NEXT migration with `relation "mig_probe" does not exist`,
  // pointing at the loader instead of at the fixture. Measured the first time a
  // real migration landed after the SQLite ladder retired.
  const write = (name, sql) => fs.writeFileSync(path.join(tmp, name), sql);
  chk('an empty migrations directory leaves the baseline alone',
    dbMod.latestVersion(tmp) === dbMod.BASE_VERSION, String(dbMod.latestVersion(tmp)));

  const V1 = latest + 1, V2 = latest + 2, V3 = latest + 3;
  write(`${V1}-probe-one.sql`, 'CREATE TABLE IF NOT EXISTS mig_probe (n BIGINT NOT NULL);');
  write(`${V2}-probe-two.sql`, 'ALTER TABLE mig_probe ADD COLUMN label TEXT;');
  chk('files are ordered by their number, not by readdir',
    dbMod.migrationFiles(tmp).map((m) => m.version).join(',') === `${V1},${V2}`,
    dbMod.migrationFiles(tmp).map((m) => m.version).join(','));

  await dbMod.applySchema({ migrationsDir: tmp });
  chk('a pending migration runs', !!(await q.get(
    "SELECT 1 AS ok FROM information_schema.tables WHERE table_name = 'mig_probe'")));
  chk('…and the one after it too, in order', !!(await q.get(
    "SELECT 1 AS ok FROM information_schema.columns "
    + "WHERE table_name = 'mig_probe' AND column_name = 'label'")));
  chk('…and the version moves to the last one applied',
    (await dbMod.schemaVersion()) === V2, String(await dbMod.schemaVersion()));

  // Re-running must be a no-op. The second fixture is an ALTER TABLE ADD COLUMN with no
  // IF NOT EXISTS — it would THROW on a second pass — so this check has teeth:
  // it fails loudly if the "already applied" guard ever stops working.
  let rerun = null;
  try { await dbMod.applySchema({ migrationsDir: tmp }); } catch (e) { rerun = e; }
  chk('an applied migration is not run again', rerun === null, String(rerun));

  // A migration that FAILS must leave the database at the last version that
  // fully applied — Postgres has transactional DDL, so this is a real guarantee.
  write(`${V3}-probe-broken.sql`,
    'ALTER TABLE mig_probe ADD COLUMN ok BIGINT; SELECT * FROM no_such_table_at_all;');
  let broke = null;
  try { await dbMod.applySchema({ migrationsDir: tmp }); } catch (e) { broke = e; }
  chk('a failing migration propagates rather than being swallowed', broke !== null);
  chk('…the version stays at the last one that fully applied',
    (await dbMod.schemaVersion()) === V2, String(await dbMod.schemaVersion()));
  chk('…and its partial work is rolled back, not left half-applied',
    !(await q.get("SELECT 1 AS ok FROM information_schema.columns "
      + "WHERE table_name = 'mig_probe' AND column_name = 'ok'")));
  fs.rmSync(path.join(tmp, `${V3}-probe-broken.sql`));

  // ── 5. the numbering rules, which are the only thing ordering rests on ───
  const throwsOn = (name, sql, re) => {
    write(name, sql);
    let e = null;
    try { dbMod.migrationFiles(tmp); } catch (err) { e = err; }
    fs.rmSync(path.join(tmp, name));
    return e !== null && re.test(String(e.message));
  };
  chk('an unnumbered migration file is refused',
    throwsOn('add-a-column.sql', 'SELECT 1;', /not numbered/));
  chk('a migration at or below the baseline is refused — it would never run',
    throwsOn('025-too-old.sql', 'SELECT 1;', /baseline/));
  chk('two migrations with the same number are refused',
    throwsOn(`${V2}-also-a-duplicate.sql`, 'SELECT 1;', /two migrations are numbered/));

  // ── 6. the shipped directory obeys its own rules ─────────────────────────
  let realErr = null;
  try { dbMod.migrationFiles(); } catch (e) { realErr = e; }
  chk('src/migrations/ (whatever is in it) parses under those rules',
    realErr === null, String(realErr));

  report();
}

main().catch(die);
