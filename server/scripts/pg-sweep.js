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
 * By REQUIRING the app with the shim's `prepare` intercepted, not by grepping.
 * Module-scope statements — 121+ of them — are declared at require time, so
 * simply loading every module under `src/` hands over their exact SQL, including
 * the ones built by template interpolation at module load. Statements prepared
 * inside a request handler are reported as uncovered rather than guessed at:
 * this script says what it did NOT see, because a sweep that quietly skips half
 * the corpus is worse than no sweep.
 *
 *   node scripts/pg-sweep.js "postgres://…"     (exit 1 on any failure)
 */
const fs = require('fs');
const path = require('path');

const URL = process.argv[2] || process.env.DATABASE_URL;
if (!URL) { console.error('usage: node scripts/pg-sweep.js <postgres-url> [--corpus file]'); process.exit(2); }
const CORPUS = (() => {
  const i = process.argv.indexOf('--corpus');
  return i > 0 ? process.argv[i + 1] : null;
})();

// ── 1. collect every statement the app prepares at load time ────────────────
// The shim connects at require time, so the URL under sweep is the one the app
// modules will hold — which is also what makes `walk()` below safe to run.
process.env.DATABASE_URL = URL;
process.env.OPSCAT_SECRET = 'sweep';
process.env.PORT = '0';

const seen = new Map(); // sql -> "file:line" that prepared it
// Attribution comes from the STACK, not from which file we happened to be
// requiring: `require` is cached, so a module pulled in transitively would
// otherwise be blamed on whoever triggered the first require. The frame we want
// is the first one inside src/ that is not this script.
function callSite() {
  // The rule lives in sql-site.js: the recorder preload needs the identical one,
  // and two answers to "where is the bad SQL" is worse than one wrong answer.
  // It skips src/db/* — the shim is plumbing, not the author of a statement, and
  // once Phase 4 routes ~700 call sites through it every statement would
  // otherwise be attributed to that one file.
  return require('./sql-site').callSite(3) || '(unknown)';
}

/* The shim's prepare, intercepted — and hooking it at THIS level is not
 * incidental.
 *
 * `q.prepare(sql)` is LAZY: it holds the text and touches the driver only when a
 * call executes, and by then the work happens inside a promise callback where
 * the caller's stack frames are gone — sql-site.js would find no application
 * frame, return null, and the statement would be DROPPED from the corpus.
 *
 * Measured while Phase 4 was in flight: after four route files converted, a
 * sweep hooked at the driver went from 448 statements to 240 and still printed
 * "all of them PREPARE cleanly". That is the worst possible failure for this
 * tool — coverage halved, in the direction of green, with the count the only
 * evidence.
 *
 * prepare() is the right level: it is synchronous, it happens at module scope
 * where the caller's frame is real, and it is the exact text the shim sends.
 */
const shim = require('../src/db/shim');
const origShimPrepare = shim.prepare;
shim.prepare = function (sql) {
  if (typeof sql === 'string' && !seen.has(sql)) seen.set(sql, callSite());
  return origShimPrepare.call(this, sql);
};
for (const fn of ['get', 'all', 'run']) {
  const orig = shim[fn];
  shim[fn] = function (sql, ...args) {
    if (typeof sql === 'string' && !seen.has(sql)) seen.set(sql, callSite());
    return orig.call(this, sql, ...args);
  };
}

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
require(path.join(SRC, 'db.js'));
walk(SRC);

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
// `?` → `$n` is THE ADAPTER'S rewriter, imported rather than reimplemented.
//
// This file used to carry its own copy — subtly weaker (it did not skip
// comments, and it refused nothing) — and it was the copy CI ran. So the sweep
// was certifying statements in a spelling the adapter would not actually send,
// which is the "second copy drifts, and the copy that drifts is the one that
// runs" failure CLAUDE.md names for the classifier preview. Importing it makes
// this sweep the corpus-level test of the rewriter for free: 680 real
// statements, parsed by a real PostgreSQL, on every pull request.
const { rewritePlaceholders } = require('../src/db/pg-sql');
const toDollar = (sql) => rewritePlaceholders(sql).text;

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

  /* There is no skip category left, and that is a change worth naming.
   *
   * The sweep used to excuse two: `PRAGMA`/`sqlite_master` introspection, and
   * everything prepared by `src/db.js`, whose 25-step migration ladder was
   * SQLite-only by design. Both went with SQLite (D6). `db.js` now holds six
   * ordinary statements — the settings cache and the membership lookups — and
   * they are swept like any others, which they always should have been.
   */
  // DEFERRED, not ignored: a statement listed here is one we know is not portable
  // yet and have decided to carry, printed on every run so the list cannot
  // quietly grow. Listing keeps the sweep GREEN and therefore READ; a
  // permanently red check is a check nobody looks at.
  //
  // It is EMPTY, and that is the point. The one entry it ever held was
  // `strftime`, deferred because its replacement renders in the SESSION
  // TimeZone and pinning that to UTC was a decision rather than a rename. The
  // decision got made — the three analytics charts bucket arithmetically now
  // (util.js `utcDaySql`), so neither engine has an opinion about what a day is
  // — and the entry came out with it. Deliberately: leaving the matcher behind
  // would DEFER a reintroduced strftime instead of failing it, and now that a
  // portable alternative exists in the codebase, reintroducing it should be a
  // hard error rather than a line in a list.
  const DEFERRED = [];

  const fails = [];
  const skipped = [];
  const deferred = [];
  let i = 0;
  for (const [sql, where] of seen) {
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
  console.log(`  ${skipped.length} prepared by the harnesses rather than by app code — not swept`);
  const swept = seen.size - skipped.length;
  console.log(`  ${swept} swept against PostgreSQL`);

  /* A floor, because this tool's worst failure is shrinking quietly.
   *
   * It already happened once. Four route files converted to the storage shim,
   * whose handle is LAZY — so their statements stopped reaching the hook at
   * module load, and when they finally executed it was inside a promise callback
   * with the caller's stack gone, so attribution failed and they were dropped.
   * The corpus went 448 -> 240 and this script still printed "all of them
   * PREPARE cleanly". Phase 4 converted every file, so left alone the sweep
   * would have reduced itself to nothing while staying green the whole way.
   *
   * RAISE this number when the corpus grows. Lowering it is a decision that
   * needs a sentence next to it saying which statements went away and why —
   * "the number went down" is not that sentence.
   */
  // Only when a corpus was supplied, i.e. the full CI configuration. Running
  // this script bare is a legitimate dev workflow that sees module-scope
  // statements only, and failing THAT would be the gate crying wolf — which is
  // how a gate stops being read.
  const MIN_SWEPT = 430;
  if (CORPUS && swept < MIN_SWEPT) {
    console.error(`\nonly ${swept} statements swept, expected at least ${MIN_SWEPT}.`);
    console.error('The corpus SHRANK. Something stopped being collected — check that new '
      + 'storage layers are hooked in scripts/sql-record.js and above, and do not lower '
      + 'MIN_SWEPT to make this pass.');
    process.exit(1);
  }
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
  process.exit(fails.length ? 1 : 0);
})();
