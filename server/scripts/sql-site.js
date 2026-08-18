'use strict';
/* "Which file wrote this statement?", answered from the stack.
 *
 * Shared by scripts/sql-record.js (a preload, running inside the harnesses) and
 * scripts/pg-sweep.js (which requires every module). They run in different
 * processes and neither can import the other's state, but the RULE has to be the
 * same one — the sweep reports failures by this string, and two answers to
 * "where is the bad SQL" is worse than one wrong answer.
 *
 * ── Why it is not simply "the first /src/ frame" ────────────────────────────
 *
 * It was, until the storage shim landed. `src/db/shim.js` now sits between every
 * converted caller and the driver, so the first /src/ frame became shim.js for
 * everything routed through it — and Phase 4 routes ~700 call sites through it.
 * Every statement in the corpus would have been attributed to one file, which
 * turns a failing sweep from "routes/ops.js:212 has bad SQL" into a list of 400
 * identical locations.
 *
 * Skipping the db layer also happens to filter the harnesses' own scratch tables
 * for free: e2e-shim.js prepares against a `shim_probe` table that exists in no
 * schema, and with shim.js skipped there is no /src/ frame left, so it is
 * correctly reported as not-application SQL rather than as a broken statement.
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
// The storage layer is plumbing, never the author of a statement.
const PLUMBING = /\/src\/db\/(shim|pg|pg-sql)\.js$/;

/**
 * @param {number} skip stack frames to drop (the interceptor's own frames)
 * @returns {string|null} `src/routes/ops.js:212`, or null when no application
 *   frame is involved at all — which means a test or a script prepared it, and
 *   the caller should drop it rather than sweep it.
 */
function callSite(skip) {
  const stack = new Error().stack.split('\n').slice(skip);
  for (const line of stack) {
    const m = /\((.*?\/src\/[^:]+):(\d+):\d+\)/.exec(line) || /at (.*?\/src\/[^:]+):(\d+):\d+/.exec(line);
    if (!m) continue;
    if (PLUMBING.test(m[1])) continue;
    return `${path.relative(ROOT, m[1])}:${m[2]}`;
  }
  return null;
}

module.exports = { callSite };
