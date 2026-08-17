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
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const files = fs.readdirSync(HERE)
  .filter((f) => /^e2e-.*\.js$/.test(f) && f !== 'e2e-lib.js')
  .sort();

if (!files.length) {
  console.error('no e2e-*.js harnesses found — that is almost certainly a mistake');
  process.exit(1);
}

const label = (f) => f.replace(/^e2e-|\.js$/g, '');
const width = Math.max(...files.map((f) => label(f).length));
const results = [];

console.log(`running ${files.length} harnesses\n`);

for (const f of files) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(HERE, f)], {
    cwd: HERE,
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
    // NODE_ENV=test makes index.js exit non-zero on an unhandled rejection
    // instead of logging it. See the handler at the bottom of src/index.js.
    env: { ...process.env, NODE_ENV: 'test' },
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const out = `${r.stdout || ''}${r.stderr || ''}`;

  // The harnesses print "N/M checks passed" as their last meaningful line.
  const m = out.match(/(\d+)\/(\d+) checks passed/);
  const ok = r.status === 0;
  results.push({ f, ok, counts: m ? `${m[1]}/${m[2]}` : '—', secs, out });

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label(f).padEnd(width)}  `
    + `${(m ? `${m[1]}/${m[2]}` : 'no summary').padStart(9)}  ${secs}s`);

  // A passing harness's output is noise; a failing one's is the whole point.
  if (!ok) {
    console.log(out.split('\n').filter((l) => l.startsWith('FAIL') || /Error|error:/.test(l))
      .map((l) => `      ${l}`).join('\n') || `      (no FAIL lines — exited ${r.status})`);
  }
}

const failed = results.filter((r) => !r.ok);
const total = results.reduce((n, r) => n + (Number(r.counts.split('/')[1]) || 0), 0);

console.log(`\n${results.length - failed.length}/${results.length} harnesses passed `
  + `(${total} checks)`);
if (failed.length) {
  console.log(`failed: ${failed.map((r) => label(r.f)).join(', ')}`);
  console.log('\nfull output of the first failure:\n');
  console.log(failed[0].out);
}
process.exit(failed.length ? 1 : 0);
