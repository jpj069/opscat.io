'use strict';
/* Shared assertion helpers for the e2e harnesses.
 *
 * These were nine byte-identical copies of `chk` and two of `until`. One copy
 * is not a style preference here — it is the only place a guard can be added
 * once and hold everywhere, and the guard below is the reason this file exists.
 *
 * ── Why a thenable must never reach an assertion ─────────────────────────────
 *
 * `chk(name, value)` records a PASS when `value` is truthy. **A Promise is
 * always truthy.** The day the storage layer becomes async — which is the whole
 * point of the Postgres port — every assertion written as
 *
 *     chk('the row exists', db.prepare(…).get(…))
 *
 * starts passing unconditionally and never fails again, while the summary line
 * still prints "N/N checks passed". The harness does not go red. It goes
 * PERMANENTLY GREEN, which is strictly worse than having no harness at all:
 * a missing test is a known gap, a lying test is a false guarantee.
 *
 * `until(fn, ms)` has the same hole one level deeper. It polls `while (!fn())`,
 * so a thenable satisfies the loop on the first iteration, `until` returns
 * immediately, and it returns that same truthy Promise to a `chk`. Both harnesses
 * using it cover fire-and-forget work — alert dispatch and mail sending — i.e.
 * exactly the assertions whose failure is otherwise invisible.
 *
 * So both throw on a thenable rather than recording anything. A hard error at
 * the call site, naming the check, is the only outcome that cannot be mistaken
 * for a pass.
 *
 * This guard is deliberately live NOW, while the storage layer is still
 * synchronous and it can therefore never fire. It is a tripwire for a change
 * that has not been made yet — planted before the change rather than after,
 * because after is too late to know which assertions stopped meaning anything.
 */

// `typeof v.then === 'function'` is the language's own definition of a thenable
// (it is what `await` and the Promise constructor test), so this also catches
// hand-rolled deferreds and any driver that returns its own promise-alike —
// not just native Promises.
function isThenable(v) {
  return v !== null
    && (typeof v === 'object' || typeof v === 'function')
    && typeof v.then === 'function';
}

function thenableError(what, name) {
  return new Error(
    `${what} received a thenable for "${name}". A Promise is truthy, so this would `
    + 'have been recorded as a PASS without testing anything. Add the missing await.',
  );
}

/* Creates one harness's assertion state. Call once per file.
 *
 *   const { chk, until, report } = require('./e2e-lib').harness();
 */
function harness() {
  const R = [];

  const chk = (name, pass, detail = '') => {
    if (isThenable(pass)) throw thenableError('chk', name);
    R.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : ` — ${detail}`}`);
  };

  // Polls until `fn()` is truthy or the deadline passes, then returns its final
  // value so the caller can `chk` it. The deadline is what makes a failure a
  // FAIL rather than a hang.
  const until = async (fn, ms = 4000) => {
    const t0 = Date.now();
    for (;;) {
      const v = fn();
      if (isThenable(v)) throw thenableError('until', fn.name || 'anonymous predicate');
      if (v) return v;
      if (Date.now() - t0 >= ms) return v;
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  // Prints the log and the summary, runs the cleanups, and exits with the right
  // code. Cleanups run before exit and are best-effort: a harness that leaks a
  // temp directory is a nuisance, but one that fails to REPORT because cleanup
  // threw is a broken build signal.
  const cleanups = [];
  const onExit = (fn) => cleanups.push(fn);
  const runCleanups = () => {
    for (const fn of cleanups) {
      try { fn(); } catch { /* best effort — never mask the result */ }
    }
  };

  const report = () => {
    const fails = R.filter((l) => l.startsWith('FAIL'));
    console.log(R.join('\n'));
    console.log(`\n${R.length - fails.length}/${R.length} checks passed`);
    runCleanups();
    process.exit(fails.length ? 1 : 0);
  };

  // For the `main().catch(...)` tail: a harness that throws has not proven
  // anything, so it must exit non-zero even though no check said FAIL.
  const die = (e) => {
    /* Print what was already established BEFORE the throw.
     *
     * `chk` collects into R and only `report()` prints it, so a harness that
     * crashed mid-run used to show a bare stack trace and nothing else — every
     * PASS and, far worse, every FAIL recorded before the crash was discarded.
     * That inverts what a harness is for: the checks that had already failed are
     * usually the DIAGNOSIS of the crash, and throwing them away leaves the
     * reader with a TypeError twenty lines downstream of the real problem.
     *
     * Found while mutation-testing the probe-location fix: reintroducing the
     * literal org id made two named checks fail and then a fixture insert throw,
     * and the output showed only the throw. The mutation was caught either way —
     * a crash is a non-zero exit — but "caught" and "diagnosed" are not the same
     * thing, and the difference is paid by whoever reads the CI log.
     */
    if (R.length) {
      const fails = R.filter((l) => l.startsWith('FAIL'));
      console.log(R.join('\n'));
      console.log(`\n${R.length - fails.length}/${R.length} checks passed before the error below`);
    }
    console.error('harness error:', e);
    runCleanups();
    process.exit(1);
  };

  return { chk, until, report, onExit, die };
}

/* Wait for the app to answer /api/health.
 *
 * `require('./src/index.js')` starts `boot()` and returns immediately: since the
 * spine conversion, boot awaits db.init() and seed() and calls `app.listen`
 * LAST, so the port is not open when the require returns. Most harnesses already
 * had a private copy of this loop; three did not and were relying on their first
 * `await` happening to give boot enough turns of the event loop — which held
 * only because better-sqlite3 resolves in microtasks, i.e. for exactly as long
 * as SQLite is the driver.
 *
 * A poll on /api/health is now a STRICTER gate than it used to be, not a weaker
 * one: an answer means the database is migrated, the settings are loaded and the
 * seed has run, where before it meant only that the port was open.
 */
async function waitForServer(base, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return true; } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 100));
  }
  return false;
}

module.exports = { harness, isThenable, waitForServer };
