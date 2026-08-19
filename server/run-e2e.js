'use strict';
/* Runs every e2e harness and reports all of them.  npm test
 *
 * Three deliberate choices:
 *
 * 1. **Harnesses are DISCOVERED, not listed.** `e2e-*.js` is the contract. A
 *    harness someone adds and forgets to register is not a gate, and a list in
 *    a package.json is exactly the kind of thing that gets forgotten — this
 *    repo already had nine harnesses and a `test` script that ran none of them.
 *
 * 2. **Every harness runs, even after one fails.** `node a.js && node b.js`
 *    stops at the first failure, so a CI run tells you about one broken thing
 *    per push and you find the second one tomorrow. Here everything runs and
 *    the summary names all failures at once.
 *
 * 3. **Each in its own process.** `src/db.js` and `src/config.js` are
 *    singletons keyed to a data directory frozen at first require, and each
 *    harness boots the whole app on its own port. Two in one process would
 *    share a database and collide on a listener.
 *
 * Each harness gets its own DATABASE, cloned from a template built once here —
 * see scripts/pg-testdb.js. It is provisioned before the child is spawned and
 * handed over in `DATABASE_URL`. Sharing one database would make every result
 * depend on the order readdir happened to return, since each harness seeds an
 * admin and asserts counts.
 *
 * There is no engine switch any more (D6). It used to be inert unless
 * `OPSCAT_DB=postgres`, and three harnesses declared themselves sqlite-only and
 * were skipped; all three were converted or retired when SQLite was, so the
 * suite is one list that runs on one engine.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const all = fs.readdirSync(HERE)
  .filter((f) => /^e2e-.*\.js$/.test(f) && f !== 'e2e-lib.js')
  .sort();

/* An OPTIONAL substring filter, for working on one harness at a time — which is
 * what converting 21 of them onto Postgres actually looks like.
 *
 * It narrows only when an argument is given, so CI (which passes none) still
 * runs everything, and DISCOVERY stays the rule: a harness someone adds and
 * forgets to register must never silently not be a gate. The banner exists for
 * the other half of that — a partial run must not be mistakable for the gate in
 * a scrollback or a pasted log, so it says so before and after, and the summary
 * line refuses to look like the full one.
 */
const patterns = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const files = patterns.length
  ? all.filter((f) => patterns.some((p) => f.includes(p)))
  : all;
if (patterns.length && !files.length) {
  console.error(`no harness matches ${JSON.stringify(patterns)} — of ${all.length} available`);
  process.exit(2);
}
const PARTIAL = files.length !== all.length;
if (PARTIAL) {
  console.log(`\n*** PARTIAL RUN — ${files.length} of ${all.length} harnesses `
    + `(filter: ${patterns.join(', ')}). NOT the CI gate. ***\n`);
}

if (!files.length) {
  console.error('no e2e-*.js harnesses found — that is almost certainly a mistake');
  process.exit(1);
}

const label = (f) => f.replace(/^e2e-|\.js$/g, '');
const width = Math.max(...files.map((f) => label(f).length));
const results = [];

console.log(`running ${files.length} harnesses\n`);

// ── Postgres: one database per harness, cloned from a template ─────────────
let testdb = null;
async function setupPg() {
  testdb = require('./scripts/pg-testdb');
  if (!testdb.ADMIN) {
    console.error('the suite needs OPSCAT_PG_ADMIN (a URL to a database this runner may '
      + 'NOT create or drop, e.g. .../postgres)');
    process.exit(2);
  }
  // schema.sql IS the DDL now — there is no translation step between the file
  // under review and the database the harnesses run against.
  const ddl = fs.readFileSync(path.join(HERE, 'src', 'schema.sql'), 'utf8');
  const t = Date.now();
  await testdb.buildTemplate(ddl);
  console.log(`template database built in ${Date.now() - t}ms\n`);
}
// Cleanup runs even on a failure, and never turns a green run red — a leaked
// database only wastes disk, while a cleanup that throws hides the result the
// run was for.
async function teardownPg(names) {
  if (!testdb) return;
  if (process.env.OPSCAT_KEEP_TESTDB === '1') {
    console.log(`\nkept ${names.length} test database(s) — OPSCAT_KEEP_TESTDB=1`);
    return;
  }
  for (const n of names) await testdb.drop(n);
  await testdb.dropTemplate();
}

(async () => {
await setupPg();
const made = [];

for (const f of files) {
  const t0 = Date.now();
  const db = await testdb.create(label(f));
  made.push(db.name);
  const dbUrl = db.url;
  const r = spawnSync(process.execPath, [path.join(HERE, f)], {
    cwd: HERE,
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
    /* NODE_ENV=test makes index.js exit non-zero on an unhandled rejection
     * instead of logging it. See the handler at the bottom of src/index.js.
     *
     * CLICKHOUSE_URL is deliberately REMOVED and handed on under another name.
     * The child env is inherited wholesale, so a developer (or CI) with
     * ClickHouse configured would otherwise switch the log store for ALL 24
     * harnesses at once — silently, and only on machines that happen to have
     * it. Every harness but one asserts against the Postgres log store, which
     * is what the community edition runs and therefore what must stay covered;
     * `e2e-logstore` is the one that wants ClickHouse and reads OPSCAT_CH_URL
     * to get it. Opting in by name beats inheriting by accident. */
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: dbUrl,
      CLICKHOUSE_URL: '',
      OPSCAT_CH_URL: process.env.OPSCAT_CH_URL || process.env.CLICKHOUSE_URL || '',
    },
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const out = `${r.stdout || ''}${r.stderr || ''}`;

  // The harnesses print "N/M checks passed" as their last meaningful line.
  const m = out.match(/(\d+)\/(\d+) checks passed/);
  const ok = r.status === 0;
  results.push({ f, ok, counts: m ? `${m[1]}/${m[2]}` : '—', secs, out });

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label(f).padEnd(width)}  `
    + `${(m ? `${m[1]}/${m[2]}` : 'no summary').padStart(9)}  ${secs}s`);

  /* A NOTICE survives a pass, and that is the one exception to the rule below.
   *
   * A harness that quietly covers less than it claims is the failure mode
   * CLAUDE.md keeps naming — "a check that skips itself when no database is
   * present is a check nobody notices has stopped running". `e2e-logstore`
   * covers 98 checks with ClickHouse configured and 40 without it, and both
   * exit 0; without this, the only evidence is a number in a column nobody
   * has a baseline for. Any harness may print a line starting with `!!` to
   * say what it did NOT do, and it is echoed even on a pass. */
  for (const line of out.split('\n')) {
    if (line.startsWith('!!')) console.log(`      ${line}`);
  }

  // Otherwise: a passing harness's output is noise; a failing one's is the whole point.
  if (!ok) {
    console.log(out.split('\n').filter((l) => l.startsWith('FAIL') || /Error|error:/.test(l))
      .map((l) => `      ${l}`).join('\n') || `      (no FAIL lines — exited ${r.status})`);
  }
}

await teardownPg(made);

const failed = results.filter((r) => !r.ok);
const total = results.reduce((n, r) => n + (Number(r.counts.split('/')[1]) || 0), 0);

console.log(`\n${results.length - failed.length}/${results.length} harnesses passed `
  + `(${total} checks)${PARTIAL ? ` — PARTIAL RUN, ${all.length - files.length} harness(es) not run` : ''}`);
if (failed.length) {
  console.log(`failed: ${failed.map((r) => label(r.f)).join(', ')}`);
  console.log('\nfull output of the first failure:\n');
  console.log(failed[0].out);
}
process.exit(failed.length ? 1 : 0);
})();
