'use strict';
/* Records every SQL string the app prepares, so the PREPARE sweep can reach the
 * statements that module-load collection cannot see.
 *
 * `pg-sweep.js` alone captures the ~390 statements prepared at module scope, by
 * requiring every file. The other ~380 are built INSIDE request handlers — they
 * do not exist until a request runs — and several are assembled by string
 * interpolation, so a grep would collect a template rather than the SQL that
 * actually reaches the database.
 *
 * The fix costs no new test code: run the existing harness suite with this file
 * preloaded, and every statement the tests cause the app to prepare is written
 * out. The harnesses already drive 1000+ assertions across every subsystem, so
 * they are the corpus.
 *
 *   OPSCAT_SQL_RECORD=/tmp/corpus.jsonl NODE_OPTIONS=--require=./scripts/sql-record.js npm test
 *   node scripts/pg-sweep.js "postgres://…" --corpus /tmp/corpus.jsonl
 *
 * Appends, never truncates: `npm test` spawns one process per harness, and all
 * of them must land in the same corpus. Deduplicated on read, not on write —
 * cross-process dedupe would need a lock, and the file is small.
 */
const FILE = process.env.OPSCAT_SQL_RECORD;
if (FILE) {
  const fs = require('fs');
  const path = require('path');

  {
    const seen = new Set();
    const lines = [];
    const root = path.join(__dirname, '..');

    // Where the statement was written, taken from the stack — the same reasoning
    // as in pg-sweep: `require` is cached, so "which file are we loading" lies.
    // The rule itself lives in sql-site.js because the sweep needs the identical
    // one and reports failures by this string.
    const { callSite } = require('./sql-site');

    /* The shim's statements, hooked when the shim is LOADED — not now.
     *
     * Why they need hooking at all: `q.prepare(sql)` is lazy, so nothing
     * reaches the driver at module load; and when a call finally executes, the
     * query runs inside a promise callback where the caller's stack frames are
     * gone, so the call site resolves to null and the statement is dropped.
     * Measured: four converted route files took the corpus from 448 statements
     * to 240, and the sweep still printed "all of them PREPARE cleanly".
     * Coverage halving in the direction of green is the worst failure this tool
     * has.
     *
     * Why it must be lazy: this file is a --require preload, and the shim
     * CONNECTS a pool when it is required. Requiring it here would open that
     * pool against whatever DATABASE_URL happens to be set at preload time —
     * before the runner hands the harness its own — and `require` is cached, so
     * every harness would then talk to the wrong database.
     */
    const Module = require('module');
    const origLoad = Module._load;
    let patched = false;
    Module._load = function (request, parent, isMain) {
      const exports = origLoad.call(this, request, parent, isMain);
      if (patched || !exports || typeof exports.prepare !== 'function'
        || typeof exports.lockOrg !== 'function') return exports;
      if (!/db\/shim(\.js)?$/.test(request)) return exports;
      patched = true;
      const note = (sql) => {
        if (typeof sql === 'string' && !seen.has(sql)) {
          seen.add(sql);
          const where = callSite(3);
          if (where) lines.push(JSON.stringify({ sql, where }));
        }
      };
      const origPrep = exports.prepare;
      exports.prepare = function (sql) { note(sql); return origPrep.call(this, sql); };
      for (const fn of ['get', 'all', 'run']) {
        const o = exports[fn];
        exports[fn] = function (sql, ...args) { note(sql); return o.call(this, sql, ...args); };
      }
      return exports;
    };

    /* There is no second hook any more.
     *
     * This file used to intercept `Database.prototype.prepare` as well, to catch
     * statements issued through the raw better-sqlite3 handle. Nothing reaches a
     * driver except through the shim now, and there is no driver to reach into:
     * node-postgres has no prototype-level prepare, because the SQL travels with
     * the query rather than being compiled first. The shim hook above is the
     * whole mechanism.
     *
     * `note()` drops a statement whose call site resolves to null — that means
     * no application frame in the stack, i.e. a harness prepared it against its
     * own scratch table, and recording it would hand the sweep a statement whose
     * table exists in no schema.
     */

    // Harnesses end with process.exit(), which skips async work — appendFileSync
    // in an 'exit' handler is the one thing that still runs.
    process.on('exit', () => {
      if (!lines.length) return;
      try { fs.appendFileSync(FILE, lines.join('\n') + '\n'); } catch { /* best effort */ }
    });
  }
}
