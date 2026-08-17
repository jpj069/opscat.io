'use strict';
/* Guards `src/schema.sql` against the two ways it silently stops being the schema.
 *
 * ── Why ──────────────────────────────────────────────────────────────────────
 *
 * A fresh install runs `schema.sql`. An existing install runs `schema.sql` and
 * then every migration in `db.js`. Nothing checked that those two paths converge,
 * and they had not: **17 indexes existed only in migrations**, so a database
 * created from `schema.sql` alone was missing them — including
 * `idx_events_dedupe_active`, the partial unique index that IS the
 * event-deduplication invariant. A Postgres schema generated from `schema.sql`
 * would have duplicated every active event, forever, with no error anywhere.
 *
 * The drift survived four PRs untouched, and #118's rebuild of 40 tables replayed
 * it verbatim from `sqlite_master` rather than healing it. It does not fix itself,
 * and nothing about it is visible in a green build. Hence a check.
 *
 * Second failure mode, and the reason for the ordering test: `schema.sql`
 * declared five tables that reference tables created LATER in the same file.
 * SQLite resolves foreign keys lazily and does not care. **Postgres fails on
 * `CREATE TABLE`** — so the file was unusable as a Postgres schema, which is a
 * hard wall discovered at the worst possible moment rather than here.
 *
 * Boots no server and needs no port.  cd server && node e2e-schema.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { chk, report, onExit, die } = require('./e2e-lib').harness();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opscat-schema-'));
process.env.OPSCAT_DATA_DIR = tmp;
onExit(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.OPSCAT_SECRET = 'e2e-schema-secret';

const SCHEMA_PATH = path.join(__dirname, 'src', 'schema.sql');
const schemaText = fs.readFileSync(SCHEMA_PATH, 'utf8');

// `db.js` applies schema.sql AND every migration to OPSCAT_DATA_DIR — that is
// the "existing install" side of the comparison.
const { SCHEMA_VERSION } = require('./src/db');

// Two spellings mean the same schema and must not read as drift:
//   • a table rebuilt by a migration comes back as `CREATE TABLE "users"` —
//     SQLite quotes the identifier on RENAME, and 40 tables were rebuilt by the
//     uuid migration alone;
//   • `IF NOT EXISTS` is in schema.sql but sqlite_master never stores it.
// Everything else is compared literally, including comments, so a column added
// by a migration and not written back here still fails.
const norm = (sql) => String(sql || '')
  .replace(/\s+/g, ' ')
  .replace(/\bIF NOT EXISTS\s+/gi, '')
  .replace(/^(CREATE (?:UNIQUE )?(?:TABLE|INDEX) )"([^"]+)"/i, '$1$2')
  .trim();
const objects = (db) => {
  const out = new Map();
  for (const r of db.prepare(
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all()) {
    out.set(`${r.type} ${r.name}`, norm(r.sql));
  }
  return out;
};

function main() {
  // ── 1. every table is declared before anything references it ───────────────
  // Postgres resolves a REFERENCES target at CREATE TABLE time; SQLite does not.
  const pos = new Map();
  const order = [];
  for (const m of schemaText.matchAll(/^CREATE TABLE(?: IF NOT EXISTS)?\s+([A-Za-z0-9_]+)/gim)) {
    pos.set(m[1], m.index); order.push(m[1]);
  }
  chk('schema.sql declares tables', order.length > 50, `${order.length} found`);

  const forward = [];
  for (let i = 0; i < order.length; i++) {
    const start = pos.get(order[i]);
    const end = i + 1 < order.length ? pos.get(order[i + 1]) : schemaText.length;
    for (const r of schemaText.slice(start, end).matchAll(/REFERENCES\s+([A-Za-z0-9_]+)/gi)) {
      if (pos.has(r[1]) && pos.get(r[1]) > start) forward.push(`${order[i]} -> ${r[1]}`);
    }
  }
  chk('no table references one declared later in the file (Postgres CREATE fails on this)',
    forward.length === 0, forward.join(', '));

  // ── 2. a fresh install and a fully-migrated one converge ───────────────────
  const migrated = objects(new Database(path.join(tmp, 'opscat.db')));
  const fresh = new Database(':memory:');
  fresh.exec(schemaText);
  const declared = objects(fresh);

  chk(`db.js reports a schema version (${SCHEMA_VERSION})`, Number.isInteger(SCHEMA_VERSION) && SCHEMA_VERSION > 0);

  const missing = [...migrated.keys()].filter((k) => !declared.has(k));
  chk('every object a migrated database has is declared in schema.sql',
    missing.length === 0,
    `missing from schema.sql: ${missing.join(', ')}`);

  const extra = [...declared.keys()].filter((k) => !migrated.has(k));
  chk('…and schema.sql declares nothing a migrated database lacks',
    extra.length === 0, `only in schema.sql: ${extra.join(', ')}`);

  // Shape, not just presence: a column added by a migration and never written
  // back into schema.sql is exactly as invisible as a missing index.
  const differing = [...migrated.keys()]
    .filter((k) => declared.has(k) && declared.get(k) !== migrated.get(k));
  chk('…and the two agree on every object\'s definition, not just its name',
    differing.length === 0,
    differing.map((k) => `${k}\n    migrated:  ${migrated.get(k)}\n    schema.sql:${declared.get(k)}`).join('\n  '));

  // ── 3. the one whose absence is silent, named explicitly ───────────────────
  // Every other missing index costs performance. This one costs correctness:
  // without it the dedupe upsert has nothing to conflict on and every active
  // event duplicates. It is called out by name so a future deletion reads as
  // deliberate rather than as a tidy-up.
  chk('idx_events_dedupe_active is in schema.sql (the dedupe invariant, not an optimisation)',
    /CREATE UNIQUE INDEX[^;]*idx_events_dedupe_active/i.test(schemaText));
  chk('…and it is the PARTIAL index the invariant needs, not a plain unique one',
    /idx_events_dedupe_active[^;]*WHERE\s+status\s*=\s*'active'/i.test(schemaText));

  report();
}

try { main(); } catch (e) { die(e); }
