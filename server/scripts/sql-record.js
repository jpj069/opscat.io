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
  let Database;
  try { Database = require('better-sqlite3'); } catch { /* not this process */ }

  if (Database) {
    const seen = new Set();
    const lines = [];
    const root = path.join(__dirname, '..');

    // Where the statement was written, taken from the stack — the same reasoning
    // as in pg-sweep: `require` is cached, so "which file are we loading" lies.
    const site = () => {
      const st = new Error().stack.split('\n').slice(3);
      for (const l of st) {
        const m = /\((.*?\/src\/[^:]+):(\d+):\d+\)/.exec(l) || /at (.*?\/src\/[^:]+):(\d+):\d+/.exec(l);
        if (m) return path.relative(root, m[1]) + ':' + m[2];
      }
      return '(unknown)';
    };

    const orig = Database.prototype.prepare;
    Database.prototype.prepare = function (sql) {
      if (typeof sql === 'string' && !seen.has(sql)) {
        seen.add(sql);
        lines.push(JSON.stringify({ sql, where: site() }));
      }
      return orig.call(this, sql);
    };

    // Harnesses end with process.exit(), which skips async work — appendFileSync
    // in an 'exit' handler is the one thing that still runs.
    process.on('exit', () => {
      if (!lines.length) return;
      try { fs.appendFileSync(FILE, lines.join('\n') + '\n'); } catch { /* best effort */ }
    });
  }
}
