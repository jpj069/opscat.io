'use strict';
/* End-to-end check for BUILD IDENTITY — `/api/version` and the identity block on
 * `/api/health`.
 *
 * Hermetic: throwaway database, no network, no mail.
 *
 * Why this has a harness at all: the endpoint exists so a deploy can be verified
 * from outside the host, and its failure mode is silent in both directions. If the
 * server stops reading `build-info.json` (a moved file, a renamed key, a require
 * that throws and gets swallowed) every answer is `"unknown"` — a string that looks
 * like a legitimate state, on an endpoint that stays 200, in a deploy that stays
 * green. And if `/api/health` ever grew an auth guard or lost `ok`, the container's
 * own HEALTHCHECK would fail while every browser stayed happy.
 *
 * The resolver is order-dependent, so each source is checked in a CHILD PROCESS:
 * `version.js` freezes its answer at require time, and the app is a singleton.
 *
 * What it guards, in order:
 *   - /api/health keeps its old shape (ok, service, ts) — the HEALTHCHECK contract;
 *   - /api/health and /api/version report the same identity, unauthenticated;
 *   - `ts` moves between calls, `startedAt` does not (liveness vs. identity);
 *   - build-info.json is READ, and its commit BEATS a conflicting OPSCAT_COMMIT —
 *     the file is a fact about the image, the env var is a claim by an operator;
 *   - OPSCAT_COMMIT is used when no file exists;
 *   - the Dockerfile's own ARG default ("unknown") is not reported as a commit;
 *   - a missing/garbage file degrades to a real answer, never a crash — a broken
 *     build stamp may not take the app down with it.
 *
 *   cd server && node e2e-version.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const R = [];
const chk = (name, pass, detail = '') => R.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : ` — ${detail}`}`);

// Environment BEFORE any src/ require — db.js and config.js are singletons.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opscat-version-'));
process.env.OPSCAT_DATA_DIR = tmp;
process.env.OPSCAT_SECRET = 'e2e-version-secret';
process.env.PORT = '3127';
process.env.OPSCAT_EDITION = 'cloud';
process.env.OPSCAT_ADMIN_EMAIL = 'seed-admin@e2e.test';
process.env.OPSCAT_ADMIN_PASSWORD = 'seed-admin-password-1';

const INFO_FILE = path.join(tmp, 'build-info.json');
fs.writeFileSync(INFO_FILE, JSON.stringify({ commit: 'abc1234', builtAt: '2026-08-16T23:00:20Z' }));
process.env.OPSCAT_BUILD_INFO = INFO_FILE;
process.env.OPSCAT_COMMIT = 'ffffff9'; // deliberately conflicting: the file must win

require('./src/index.js'); // boots the app on :3127

const BASE = 'http://127.0.0.1:3127';

// Each case resolves the identity in a fresh process: version.js reads its sources
// once, at require time, which is exactly the behaviour under test.
function resolveWith(env) {
  const merged = { ...process.env, ...env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete merged[k];
  const out = execFileSync(process.execPath,
    ['-e', 'process.stdout.write(JSON.stringify(require("./src/version").INFO))'],
    { cwd: __dirname, env: merged, encoding: 'utf8' });
  return JSON.parse(out);
}

const gitHead = () => {
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'],
      { cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) { return null; }
};

async function get(p) {
  const r = await fetch(BASE + p);
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function main() {
  // ── the HEALTHCHECK contract ──────────────────────────────────────────────
  const h = await get('/api/health');
  chk('/api/health answers 200 without a session', h.status === 200, `got ${h.status}`);
  chk('…still carries ok/service/ts',
    h.body?.ok === true && h.body?.service === 'opscat' && Number.isFinite(h.body?.ts),
    JSON.stringify(h.body));

  // ── the identity block ────────────────────────────────────────────────────
  const v = await get('/api/version');
  chk('/api/version answers 200 without a session', v.status === 200, `got ${v.status}`);
  chk('…reports the commit from build-info.json', v.body?.commit === 'abc1234', v.body?.commit);
  chk('…reports its build time', v.body?.builtAt === '2026-08-16T23:00:20Z', v.body?.builtAt);
  chk('…reports the package version', v.body?.version === require('./package.json').version,
    v.body?.version);
  chk('…reports the edition', v.body?.edition === 'cloud', v.body?.edition);
  chk('…reports when the process started',
    !Number.isNaN(Date.parse(v.body?.startedAt || '')), v.body?.startedAt);
  for (const k of ['commit', 'builtAt', 'version', 'edition', 'startedAt']) {
    chk(`health and version agree on ${k}`, h.body?.[k] === v.body?.[k],
      `${h.body?.[k]} vs ${v.body?.[k]}`);
  }

  // ── liveness moves, identity does not ─────────────────────────────────────
  await new Promise((r) => setTimeout(r, 5));
  const again = await get('/api/health');
  chk('ts moves between calls', again.body?.ts >= h.body?.ts, `${h.body?.ts} → ${again.body?.ts}`);
  chk('startedAt does not', again.body?.startedAt === h.body?.startedAt, again.body?.startedAt);

  // ── resolution order ──────────────────────────────────────────────────────
  chk('the file beats a conflicting OPSCAT_COMMIT',
    resolveWith({}).commit === 'abc1234', resolveWith({}).commit);

  const noFile = { OPSCAT_BUILD_INFO: path.join(tmp, 'does-not-exist.json') };
  chk('without a file, OPSCAT_COMMIT is used',
    resolveWith(noFile).commit === 'ffffff9', resolveWith(noFile).commit);
  chk('…and builtAt is null rather than invented',
    resolveWith(noFile).builtAt === null, JSON.stringify(resolveWith(noFile).builtAt));

  const argDefault = { ...noFile, OPSCAT_COMMIT: 'unknown' };
  chk('the Dockerfile ARG default is not a commit',
    resolveWith(argDefault).commit === 'unknown', resolveWith(argDefault).commit);

  // Neither source present: a plain `npm start` from a checkout, i.e. development.
  // An empty value counts as absent — compose passes `${OPSCAT_COMMIT:-}` as an
  // empty env var for every whitelisted-but-unconfigured variable, and an empty
  // string reported as the commit would be a blank line in the deploy check.
  const head = gitHead();
  for (const [label, val] of [['unset', undefined], ['empty', '']]) {
    const got = resolveWith({ ...noFile, OPSCAT_COMMIT: val }).commit;
    chk(`with OPSCAT_COMMIT ${label}, a dev checkout answers with its own HEAD`,
      head ? got === head : got === 'unknown', `${got} vs ${head}`);
  }

  const junkFile = path.join(tmp, 'junk.json');
  fs.writeFileSync(junkFile, 'not json at all');
  const junk = resolveWith({ OPSCAT_BUILD_INFO: junkFile });
  chk('a corrupt build stamp does not take the app down', junk.commit === 'ffffff9', junk.commit);

  const halfFile = path.join(tmp, 'half.json');
  fs.writeFileSync(halfFile, JSON.stringify({ builtAt: '2026-01-01T00:00:00Z' }));
  const half = resolveWith({ OPSCAT_BUILD_INFO: halfFile });
  chk('a stamp without a commit falls through to the env', half.commit === 'ffffff9', half.commit);

  const fails = R.filter((l) => l.startsWith('FAIL'));
  console.log(R.join('\n'));
  console.log(`\n${R.length - fails.length}/${R.length} checks passed`);
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
