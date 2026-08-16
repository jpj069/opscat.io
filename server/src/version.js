'use strict';
/* WHAT IS ACTUALLY RUNNING HERE.
 *
 * The deploy workflow is `git pull && docker compose up -d --build` over SSH, and
 * until now nothing the running instance served could name the commit it was built
 * from. For a frontend change that was survivable — the bundle filename carries a
 * content hash, so the served `assets/index-<hash>.js` could be compared against a
 * local build. For a **server-only** change it is not: the bundle is byte-identical,
 * every curl stays green, and "the deploy job was green" is an assertion about
 * GitHub, not about the container answering requests.
 *
 * So the image records what it was built from, and the app reports it:
 *
 *   docker build --build-arg OPSCAT_COMMIT=$(git rev-parse --short=7 HEAD) …
 *     → /app/server/build-info.json
 *     → GET /api/version → {"commit":"1bcda1e", …}
 *
 * Resolution order, and why:
 *   1. `build-info.json` — written INTO the image at build time, so it cannot go
 *      stale: a new commit means a new image means a new file. This is the only
 *      source that is a fact about the running code rather than a claim about it,
 *      which is why it wins over the environment.
 *   2. `OPSCAT_COMMIT` — for deployments that are neither this image nor a git
 *      checkout (a tarball, a distro package). It is a promise the operator makes;
 *      an `.env` left behind from an earlier release would lie forever, hence #1
 *      first.
 *   3. `git rev-parse` — a plain `npm start` from a checkout, i.e. development.
 *      Run once at startup, never per request.
 *   4. `null`, reported as `"unknown"`. Never guessed: an endpoint that exists to
 *      answer "which code is this" may not make something up.
 *
 * `OPSCAT_BUILD_INFO` overrides the file path. That seam is what lets a harness
 * prove the file is actually READ — the failure mode this endpoint has is silent
 * (the image writes the file, the server ignores it, every answer says "unknown",
 * and the deploy stays green forever).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');           // repo root (dev) / /app (image)
const DEFAULT_INFO = path.join(__dirname, '..', 'build-info.json');

// An empty string is "unset", not a value: compose passes `${VAR:-}` as an empty
// env var for every whitelisted-but-unconfigured variable.
const env = (k) => {
  const v = process.env[k];
  return v && v.trim() ? v.trim() : null;
};

function readInfoFile() {
  const file = env('OPSCAT_BUILD_INFO') || DEFAULT_INFO;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { commit: j.commit || null, builtAt: j.builtAt || null };
  } catch (e) {
    return { commit: null, builtAt: null }; // absent in a dev checkout — expected
  }
}

function gitCommit() {
  if (!fs.existsSync(path.join(REPO, '.git'))) return null;
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'],
      { cwd: REPO, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch (e) {
    return null; // no git binary, shallow/broken checkout — not worth a startup failure
  }
}

const file = readInfoFile();
const commit = file.commit || env('OPSCAT_COMMIT') || gitCommit();
// `unknown` is deliberately not a placeholder we invent later: the Dockerfile's own
// ARG default is the literal string, so a build that forgot the arg says so.
const clean = (c) => (c && c !== 'unknown' ? c : null);

const INFO = Object.freeze({
  service: 'opscat',
  version: require('../package.json').version,
  edition: require('./edition').EDITION,
  commit: clean(commit) || 'unknown',
  // when the IMAGE was built (null in a dev checkout — nothing was built)
  builtAt: file.builtAt || null,
  // when THIS process started: the second half of "did the deploy actually land",
  // because a restart is what makes new code run.
  startedAt: new Date().toISOString(),
});

module.exports = { INFO };
