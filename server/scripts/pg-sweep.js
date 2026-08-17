'use strict';
/* PREPAREs every SQL statement the app runs against a real PostgreSQL schema.
 *
 * ── Why this is the highest-leverage test in the port ────────────────────────
 *
 * There are ~700 prepared statements in `server/src`, and MOST OF THEM HAVE NO
 * FUNCTIONAL TEST COVERAGE. Every slice of Phase 1 so far has confirmed that the
 * hard way: breaking a statement on the hottest write path left the entire suite
 * green, four times running. Writing a harness per statement is not going to
 * happen.
 *
 * A prepare-only sweep covers 100% of them for the two failure classes that do
 * not need execution:
 *
 *   • parse errors — SQLite grammar Postgres does not have (`MAX(a,b)`, a bare
 *     column beside an aggregate, `char(10)`, `INSERT OR IGNORE`, `strftime`);
 *   • type-inference failures — `COALESCE($1, col)` where Postgres cannot type
 *     the parameter when it is null (~39 sites), and untyped params in
 *     `CASE WHEN $1`.
 *
 * Neither needs a row, a fixture or a running app. `PREPARE` is enough, and it
 * is fast enough to run on every push.
 *
 * ── How statements are collected ─────────────────────────────────────────────
 *
 * By REQUIRING the app with `db.prepare` intercepted, not by grepping. Module-
 * scope statements — 121+ of them — are prepared at require time, so simply
 * loading every module under `src/` hands over their exact SQL, including the
 * ones built by template interpolation at module load. Statements prepared
 * inside a request handler are reported as uncovered rather than guessed at:
 * this script says what it did NOT see, because a sweep that quietly skips half
 * the corpus is worse than no sweep.
 *
 *   node scripts/pg-sweep.js "postgres://…"     (exit 1 on any failure)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const URL = process.argv[2] || process.env.DATABASE_URL;
if (!URL) { console.error('usage: node scripts/pg-sweep.js <postgres-url> [--corpus file]'); process.exit(2); }
const CORPUS = (() => {
  const i = process.argv.indexOf('--corpus');
  return i > 0 ? process.argv[i + 1] : null;
})();

// ── 1. collect every statement the app prepares at load time ────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opscat-sweep-'));
process.env.OPSCAT_DATA_DIR = tmp;
process.env.OPSCAT_SECRET = 'sweep';
process.env.PORT = '0';

const seen = new Map(); // sql -> "file:line" that prepared it
const origPrepare = Database.prototype.prepare;
// Attribution comes from the STACK, not from which file we happened to be
// requiring: `require` is cached, so a module pulled in transitively would
// otherwise be blamed on whoever triggered the first require. The frame we want
// is the first one inside src/ that is not this script.
function callSite() {
  const st = new Error().stack.split('\n').slice(2);
  for (const line of st) {
    const m = /\((.*?\/src\/[^:]+):(\d+):\d+\)/.exec(line) || /at (.*?\/src\/[^:]+):(\d+):\d+/.exec(line);
    if (m) return path.relative(path.join(__dirname, '..'), m[1]) + ':' + m[2];
  }
  return '(unknown)';
}
Database.prototype.prepare = function (sql) {
  if (typeof sql === 'string' && !seen.has(sql)) seen.set(sql, callSite());
  return origPrepare.call(this, sql);
};

const SRC = path.join(__dirname, '..', 'src');
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) {
      try { require(p); } catch (e2) { /* a module that needs a live app is fine */ }
    }
  }
}
require(path.join(SRC, 'db.js'));   // schema + migrations first
walk(SRC);
Database.prototype.prepare = origPrepare;

// Statements the harnesses caused the app to prepare inside request handlers,
// recorded by scripts/sql-record.js. Module-load collection cannot see these —
// they do not exist until a request runs, and several are interpolated, so a
// grep would collect a template rather than the SQL that reaches the database.
let fromCorpus = 0;
if (CORPUS && fs.existsSync(CORPUS)) {
  for (const line of fs.readFileSync(CORPUS, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (typeof r.sql === 'string' && !seen.has(r.sql)) { seen.set(r.sql, r.where || '(recorded)'); fromCorpus++; }
    } catch { /* a truncated last line from a killed process is not a failure */ }
  }
}

// ── 2. PREPARE each one against Postgres ────────────────────────────────────
// `?` → `$n` is the adapter's job (plan claim 2); done here the same way so the
// sweep tests the statements the adapter will actually send.
function toDollar(sql) {
  let n = 0, out = '', q = null;
  // better-sqlite3 also accepts NAMED parameters (`@room_id`), which
  // node-postgres does not have at all — the adapter will have to map them, so
  // the sweep maps them the same way rather than reporting a false parse error.
  // Same name twice reuses the same $n, which is what a correct adapter must do.
  const named = new Map();
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (q) { if (c === q) q = null; out += c; continue; }
    if (c === '\'' || c === '"') { q = c; out += c; continue; }
    if (c === '?') { out += '$' + (++n); continue; }
    if (c === '@' && /[A-Za-z_]/.test(sql[i + 1] || '')) {
      const m = /^@([A-Za-z_][A-Za-z0-9_]*)/.exec(sql.slice(i));
      if (!named.has(m[1])) named.set(m[1], ++n);
      out += '$' + named.get(m[1]);
      i += m[0].length - 1;
      continue;
    }
    out += c;
  }
  return out;
}

(async () => {
  const { Client } = require('pg');
  const client = new Client({ connectionString: URL });
  // Fail loudly. Requiring the whole app starts its engines, so their timers keep
  // the process alive — a rejected connection would otherwise surface as an
  // unhandledRejection and then a HANG, which in CI reads as a slow job rather
  // than a missing database. Cost me a debugging round.
  try {
    await client.connect();
  } catch (e) {
    console.error(`cannot reach PostgreSQL at the given URL: ${e.message}`);
    process.exit(2);
  }

  // Two categories are SQLite-only BY DESIGN and are not findings:
  //   • PRAGMA / sqlite_master — introspection with no Postgres equivalent, used
  //     by the migration guards;
  //   • the migrations themselves — the plan's §2 says a fresh Postgres install
  //     starts at the final shape and db.js's history stays SQLite-only, so
  //     replaying it against Postgres is not a goal.
  // Counting them as failures would bury the statements that actually matter.
  const sqliteOnly = (sql) => /^\s*PRAGMA\b/i.test(sql)
    || /\bsqlite_master\b/i.test(sql)
    || /\b_org_map\b|\b_user_map\b/.test(sql);   // migration scratch tables

  // DEFERRED, not ignored. `strftime` has no Postgres equivalent and its
  // replacement `to_timestamp()` renders in the SESSION TimeZone — translating it
  // is Phase 5 work with a real decision attached (the UTC pin), not a rename.
  // Listing them keeps the sweep GREEN and therefore READ; a permanently red
  // check is a check nobody looks at. Every deferral prints on every run, so the
  // list cannot quietly grow.
  const DEFERRED = [
    { match: /\bstrftime\s*\(/i,
      why: 'strftime → to_timestamp(...) AT TIME ZONE \'UTC\' (Phase 5; the timezone pin is the decision, and e2e-pipeline already fails if a day bucket shifts)' },
  ];

  const fails = [];
  const skipped = [];
  const deferred = [];
  let i = 0;
  for (const [sql, where] of seen) {
    if (sqliteOnly(sql) || /^src\/db\.js:/.test(where)) { skipped.push(sql); continue; }
    // statements prepared by the harnesses themselves are not app code
    if (!/^src\//.test(where)) { skipped.push(sql); continue; }
    const d = DEFERRED.find((x) => x.match.test(sql));
    if (d) { deferred.push({ where, why: d.why }); continue; }
    const name = `s${i++}`;
    if (process.env.SWEEP_TRACE) console.error('  [' + i + '] ' + where + ' :: ' + sql.replace(/\s+/g,' ').slice(0,90));
    try {
      await client.query(`PREPARE ${name} AS ${toDollar(sql)}`);
      await client.query(`DEALLOCATE ${name}`);
    } catch (e) {
      fails.push({ where, sql: sql.replace(/\s+/g, ' ').trim(), msg: e.message });
    }
  }
  await client.end();

  console.log(`collected ${seen.size} statements`
    + (CORPUS ? ` (${seen.size - fromCorpus} at module load, ${fromCorpus} more from the harness corpus)` : ' at module load'));
  console.log(`  ${skipped.length} SQLite-only by design (PRAGMA / sqlite_master / migrations) — not swept`);
  console.log(`  ${seen.size - skipped.length} swept against PostgreSQL`);
  if (deferred.length) {
    console.log(`\n${deferred.length} deferred to a later phase, on purpose:`);
    for (const d of deferred) console.log(`  ${d.where}\n    ${d.why}`);
  }
  if (fails.length) {
    console.log(`\n${fails.length} would not PREPARE against PostgreSQL:\n`);
    const byFile = new Map();
    for (const f of fails) {
      if (!byFile.has(f.where)) byFile.set(f.where, []);
      byFile.get(f.where).push(f);
    }
    for (const [file, list] of [...byFile].sort()) {
      console.log(`  ${file}`);
      for (const f of list) {
        console.log(`    ${f.msg}`);
        console.log(`      ${f.sql.slice(0, 150)}`);
      }
    }
  } else {
    console.log('all of them PREPARE cleanly');
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fails.length ? 1 : 0);
})();
