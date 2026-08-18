'use strict';
/* End-to-end check for the three engine paths Phase 2 rewrote and NOTHING
 * covered: Scout's mining buffer, the missed-heartbeat sweep, and the agent
 * container diff.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 *
 * Reviewing the Phase 2 container diff turned up something worse than a bug.
 * `engine/scout.js` had no harness at all. `engine/heartbeats.js` had none. The
 * container-diff branch of `routes/ingest.js` had none. All three were changed
 * on the strength of throwaway scripts that no longer exist, and all three
 * encode invariants whose violation is SILENT:
 *
 *   · Scout's flush used to `buffer.clear()` after writing. Put one await in
 *     that loop and every line ingested DURING the flush is discarded — no
 *     error, no counter, no log line. Templates just look rarer than they are,
 *     and rarity is the number the Scout tab ranks by.
 *   · The heartbeat sweep used to decide "still silent?" in JS from a row read
 *     a moment earlier. A ping landing between the read and the write re-arms
 *     the switch and the sweep writes `alerted_at` back over it: a live cron
 *     job gets paged for, and because `alerted_at` now sits above the ping the
 *     NEXT genuine miss is the one that stays silent.
 *   · The container diff reads the previous snapshot and writes the new one.
 *     If those two can interleave, two posts read the SAME predecessor and the
 *     snapshot between them is never diffed at all — a container that came up
 *     and went down inside that window raises no `container_down`.
 *
 * Every check below was verified to fail when the statement or branch it covers
 * is re-broken. That was measured, one mutation at a time, not assumed.
 *
 * ── Two techniques worth explaining before you read them ─────────────────────
 *
 * 1. **Time is driven, never waited on.** `util.now()` is `() => Date.now()`,
 *    and neither `heartbeats.tick()` nor the container route takes an instant,
 *    so the clock is the only parameter available: `at()` freezes `Date.now`
 *    for exactly one synchronous call and restores it. A 90-second grace window
 *    and a five-minute snapshot chain are therefore tested in a millisecond,
 *    and the heartbeat fixtures are anchored in the FUTURE so the engine's own
 *    15s background sweep (real clock) can never reach them.
 *
 * 2. **The interleavings are staged, not hoped for.** The driver is synchronous
 *    today, so "a line arrives mid-flush" and "a ping lands between the read and
 *    the write" cannot happen by themselves. Both are staged deterministically:
 *    the flush by wrapping the shim's COMMIT for the duration of one call, the
 *    sweep by pinging a second heartbeat from inside a pipeline listener that
 *    fires while `tick()` is still walking its list. Those are the real
 *    interleavings, reached the only way this driver allows.
 *
 * Hermetic: throwaway database, own port, no network, no stub server (nothing
 * here dials out, so OPSCAT_ALLOW_PRIVATE_TARGETS is not needed).
 *   cd server && node e2e-engines.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { chk, report, onExit, die } = require('./e2e-lib').harness();

// Environment BEFORE any src/ require — config.js and db.js are singletons.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opscat-engines-'));
process.env.OPSCAT_DATA_DIR = tmp;
onExit(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.OPSCAT_SECRET = 'e2e-engines-secret';
process.env.PORT = '3157';
process.env.OPSCAT_EDITION = 'community';
process.env.OPSCAT_ADMIN_EMAIL = 'admin@e2e.test';
process.env.OPSCAT_ADMIN_PASSWORD = 'seed-admin-password-1';

require('./src/index.js'); // boots the app on :3157

// Fixtures and read-back go through the SHIM, so they land in the database
// `run-e2e.js` handed this process in DATABASE_URL — the same one the code under
// test reads. A connection the harness opened for itself would be a different
// session, and a fixture written there surfaces as a foreign-key violation
// several calls later, pointing at the wrong thing entirely.
const q = require('./src/db/shim');
const { sha256, newId, DEFAULT_ORG_ID } = require('./src/util');
const pipeline = require('./src/engine/pipeline');
const scout = require('./src/engine/scout');
const heartbeats = require('./src/engine/heartbeats');

const BASE = 'http://127.0.0.1:3157';

// ── the clock ────────────────────────────────────────────────────────────────
// `at(t, fn)` runs fn with Date.now() pinned to t. Node's timers use a monotonic
// clock, not Date.now, so nothing else in the process changes behaviour; what
// does change is `util.now()`, which is the instant every engine here reads.
const realNow = Date.now;
function at(t, fn) {
  Date.now = () => t;
  try { return fn(); } finally { Date.now = realNow; }
}
async function atAsync(t, fn) {
  Date.now = () => t;
  try { return await fn(); } finally { Date.now = realNow; }
}

// Requests go through node:http, NOT fetch, and that is not a style choice.
// undici keeps its own coarse clock built on Date.now() to expire connection
// and headers timeouts; pinning Date.now an hour ahead makes every pooled
// connection look timed out, and the global dispatcher then fails requests
// that have nothing to do with this harness. node:http schedules on the
// monotonic timer instead, so the clock can move without breaking the wire.
// Measured: with fetch, whole sections failed intermittently under `at()`.
function req(method, pathname, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(body);
    const r = http.request({
      host: '127.0.0.1', port: 3157, method, path: pathname,
      headers: { ...headers, ...(payload ? { 'content-length': payload.length } : {}) },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(raw); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
const postJson = (pathname, obj, headers = {}) => req('POST', pathname,
  { headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(obj) });

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch { /* not yet */ }
    await new Promise((res) => setTimeout(res, 100));
  }
  return false;
}

// ── fixtures ─────────────────────────────────────────────────────────────────
async function mkOrg(name, slug) {
  const id = newId();
  await q.prepare(`INSERT INTO organizations (id, name, slug, plan, status, created_at)
    VALUES (?, ?, ?, 'enterprise', 'active', ?)`).run(id, name, slug, realNow());
  return id;
}
// `insert()` (RETURNING id), never lastInsertRowid: the shim refuses that field
// on both backends, because node-postgres does not have one at all.
async function mkAgent(name) {
  const token = `agent-token-${name}`;
  const id = await q.prepare(`INSERT INTO agents (org_id, name, token_hash, active, created_at)
    VALUES (?, ?, ?, 1, ?)`).insert(DEFAULT_ORG_ID, name, sha256(token), realNow());
  return { id, name, token };
}
async function mkHeartbeat(name, intervalS, graceS, createdAt, enabled = 1) {
  const token = `hb-token-${name}`;
  const id = await q.prepare(`INSERT INTO heartbeats
    (org_id, name, token_hash, interval_s, grace_s, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .insert(DEFAULT_ORG_ID, name, sha256(token), intervalS, graceS, enabled, createdAt);
  return { id, name, token };
}
const hbRow = (id) => q.prepare('SELECT * FROM heartbeats WHERE id = ?').get(id);

// events are keyed `name|device|target`
const evIn = (orgId, name, device, target = '') => q.prepare(
  "SELECT * FROM events WHERE org_id = ? AND dedupe_key = ? AND status = 'active'")
  .get(orgId, `${name}|${device}|${target}`);
const evRow = (name, device, target = '') => evIn(DEFAULT_ORG_ID, name, device, target);
// `evRow(...)` is awaited at every call site, so `hits` is handed a resolved row.
// never dereference an event that may not exist: a TypeError aborts the whole
// harness, which reports nothing, where a FAIL names the broken invariant.
const hits = (ev) => (ev ? ev.hits : null);
const evCount = async (name, device) => (await q.prepare(
  'SELECT COUNT(*) c FROM events WHERE org_id = ? AND name = ? AND device = ?')
  .get(DEFAULT_ORG_ID, name, device)).c;

// scout rows
const tplAll = (orgId) => q.prepare(
  'SELECT * FROM scout_templates WHERE org_id = ? ORDER BY id').all(orgId);
const tplOf = (orgId, template) => q.prepare(
  'SELECT * FROM scout_templates WHERE org_id = ? AND template = ?').get(orgId, template);

// feed unmatched lines through the REAL pipeline listener scout subscribes to
function feed(orgId, lines, ts) {
  return pipeline.ingestLogs(lines.map((line) => ({ ts, device: 'scout-probe', line })),
    'e2e-engines', orgId);
}

async function main() {
  chk('server boots and answers /api/health', await waitForServer());

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. scout.js — the masking table and template extraction
  //
  // These are pure functions, but they are the ones an "obviously equivalent"
  // regex tidy-up breaks: MASKS and MASK_VALUE are two spellings of the same
  // 14 patterns, and nothing but the round trip below relates them.
  // ═══════════════════════════════════════════════════════════════════════════
  chk('mask() replaces an IPv4 address (with port) by <IP>',
    scout.mask('Connection from 10.0.0.7:5432 closed') === 'Connection from <IP> closed',
    scout.mask('Connection from 10.0.0.7:5432 closed'));
  chk('…a full ISO timestamp by ONE <TS>, not <DATE>T<TIME> (mask order matters)',
    scout.mask('2026-08-17T09:47:14Z ok') === '<TS> ok', scout.mask('2026-08-17T09:47:14Z ok'));
  chk('…a bare date by <DATE> and a bare clock time by <TIME>',
    scout.mask('on 2026-08-17 at 09:47:14 done') === 'on <DATE> at <TIME> done',
    scout.mask('on 2026-08-17 at 09:47:14 done'));
  chk('…a uuid by <UUID> and a MAC by <MAC>',
    scout.mask('session 3f2504e0-4f89-11d3-9a0c-0305e82c3301 mac 00:1b:44:11:3a:b7')
      === 'session <UUID> mac <MAC>',
    scout.mask('session 3f2504e0-4f89-11d3-9a0c-0305e82c3301 mac 00:1b:44:11:3a:b7'));
  chk('…an e-mail by <EMAIL> and a URL by <URL>',
    scout.mask('user alice@example.com hit https://api.example.com/v1/x?id=9')
      === 'user <EMAIL> hit <URL>',
    scout.mask('user alice@example.com hit https://api.example.com/v1/x?id=9'));
  chk('…a path by <PATH>, hex by <HEX>, a dotted version by <VER>',
    scout.mask('wrote /var/lib/opscat/file.log offset 0xdeadbeef v 1.2.3')
      === 'wrote <PATH> offset <HEX> v <VER>',
    scout.mask('wrote /var/lib/opscat/file.log offset 0xdeadbeef v 1.2.3'));
  chk('…a number WITH a unit by <NUM>, keeping the unit as a literal '
    + '(320ms and 320 must not collapse to the same shape)',
    scout.mask('took 320ms') === 'took <NUM>ms' && scout.mask('took 320') === 'took <NUM>',
    `${scout.mask('took 320ms')} / ${scout.mask('took 320')}`);
  chk('…and collapses runs of whitespace so one shape is one string',
    scout.mask('a   b\t\tc  ') === 'a b c', JSON.stringify(scout.mask('a   b\t\tc  ')));
  chk('…and caps the template at 400 chars (an 8k log line cannot become a key)',
    scout.mask('x'.repeat(900)).length === 400, scout.mask('x'.repeat(900)).length);

  // The round trip is the invariant that actually ships: "approve" turns a
  // template back into a classifier regex via MASK_VALUE, and a MASKS entry
  // edited without its MASK_VALUE twin produces a rule that matches nothing —
  // silently, because the rule is created successfully either way.
  const ROUNDTRIP = [
    'Connection from 10.0.0.7:5432 closed after 320ms',
    '2026-08-17T09:47:14Z backup job 42 finished in 12.5s',
    'user alice@example.com fetched https://api.example.com/v1/items?id=9',
    'session 3f2504e0-4f89-11d3-9a0c-0305e82c3301 for mac 00:1b:44:11:3a:b7',
    'wrote /var/lib/opscat/data/file.log offset 0xdeadbeef version 1.2.3',
  ];
  const roundTripFails = ROUNDTRIP.filter((line) => {
    try { return !new RegExp(scout.templateToPattern(scout.mask(line), 1).pattern).test(line); }
    catch { return true; }
  });
  chk('every masked template compiles back into a regex that matches its own raw line '
    + '(MASKS and MASK_VALUE agree)', roundTripFails.length === 0, roundTripFails.join(' | '));

  const p2 = scout.templateToPattern('Connection from <IP> closed after <NUM>ms', 2);
  chk('templateToPattern captures the placeholder it is pointed at, and only that one',
    p2.captureGroup === 1 && (new RegExp(p2.pattern)
      .exec('Connection from 10.0.0.7 closed after 320ms') || [])[1] === '320',
    JSON.stringify(p2));
  chk('…and reports captureGroup null for an index past the last placeholder',
    scout.templateToPattern('a <IP> b', 5).captureGroup === null,
    scout.templateToPattern('a <IP> b', 5).captureGroup);
  chk('…and escapes regex specials in the literal parts',
    new RegExp(scout.templateToPattern('rate (1/s) up 5', 0).pattern).test('rate (1/s) up 5'));

  chk('templateFilter returns the LONGEST literal run — the template itself finds '
    + 'nothing, since <IP> occurs in no raw log line',
    scout.templateFilter('<TS> backup job <NUM> finished in <NUM>s') === 'finished in',
    scout.templateFilter('<TS> backup job <NUM> finished in <NUM>s'));
  chk('…and an all-placeholder template yields no filter rather than "<IP>"',
    scout.templateFilter('<IP> <NUM>') === '', JSON.stringify(scout.templateFilter('<IP> <NUM>')));

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. scout.js — the mining buffer
  //
  // `flush()` is awaited from here on, and the buffer state asserted below is
  // still exactly the state these lines produced. On SQLite every shim call
  // resolves in a MICROTASK, so an awaited flush runs to completion within one
  // drain of the microtask queue and the engine's own 5s flush timer — a
  // macrotask — cannot get between the swap and the writes.
  //
  // Under Postgres that no longer holds: a shim call is a network round trip, so
  // the timer CAN fire between two of them. It does not today only because the
  // whole harness finishes in well under FLUSH_MS, and `scout.js` exports no way
  // to stop the timer it starts — so this is a residual flake, recorded rather
  // than papered over. A background flush landing between a `feed()` and the
  // `scout.flush()` below would write the batch early and the staged arrival
  // would stage nothing; the "the wrapper ran" check turns that into a FAIL
  // instead of a silent pass.
  // ═══════════════════════════════════════════════════════════════════════════
  const ORG_SWAP = await mkOrg('Scout Swap', 'scout-swap');
  const ORG_MERGE = await mkOrg('Scout Merge', 'scout-merge');
  const ORG_FOLD = await mkOrg('Scout Fold', 'scout-fold');
  const ORG_GATE = await mkOrg('Scout Gate', 'scout-gate');
  const ORG_EVICT = await mkOrg('Scout Evict', 'scout-evict');

  const tLog = realNow() - 1000;
  await scout.flush(); // drain anything the boot sequence left buffered

  // ── 2a. the buffer swap ──────────────────────────────────────────────────
  // `flush()` does `const batch = buffer; buffer = new Map();` before its first
  // statement. To prove that is load-bearing, a line has to arrive DURING the
  // flush. Nothing here yields on its own, so the arrival is staged: `q.withTx`
  // is wrapped for exactly this one call, and the wrapper ingests two lines the
  // moment the org's transaction has committed — i.e. after the buffer entry
  // they belong to was already written out.
  //
  // With the swap, both land in the fresh buffer and the NEXT flush writes them.
  // With `buffer.clear()` at the end instead, one is a repeat of a key whose
  // count was already read and one is a key appended after the iterator was
  // exhausted: neither is visited again, and clear() drops both. No error.
  //
  // The hook has moved twice with the conversion. flush() goes through
  // `q.withTx` rather than `db.transaction`, and Phase 6 moves the boundary once
  // more: wrapping better-sqlite3's `COMMIT` statement staged nothing under
  // Postgres, where the COMMIT is `client.query('COMMIT')` on a pooled client
  // and never passes through `db.prepare` at all — the section would have gone
  // on passing while staging nothing, which is the one outcome this hook exists
  // to make impossible. `q.withTx` is the same instant on both engines (the
  // org's writes are committed, the flush has not returned) and it is the
  // boundary the engine itself uses.
  const SWAP_A = 'apollo cache primed for tenant 10.0.0.7 in 320ms';
  const SWAP_B = 'borealis queue drained 18 jobs in 90ms';
  const TPL_A = 'apollo cache primed for tenant <IP> in <NUM>ms';
  const TPL_B = 'borealis queue drained <NUM> jobs in <NUM>ms';

  await feed(ORG_SWAP, [SWAP_A, SWAP_A], tLog);
  let injected = false;
  // ingestLogs is awaited since the Phase 4 conversion, so the mid-flush arrival
  // is a PROMISE started inside the COMMIT rather than a write completed there.
  // It is held and awaited below: without that the next flush reads the buffer
  // before the arrival has reached it, and the section passes while staging
  // nothing — which is the failure this hook exists to make impossible.
  let injectedFeed = null;
  const realWithTx = q.withTx;
  q.withTx = async (fn) => {
    const out = await realWithTx(fn);
    if (!injected) {
      injected = true;
      // AWAITED here, inside flush(), and that is the whole staging. `feed()`
      // is a promise since Phase 4, and merely starting it leaves the arrival
      // to land after flush() has returned — which is not a mid-flush arrival
      // at all: `buffer.clear()` at the end of flush() then drops nothing, the
      // lines are counted into the fresh buffer either way, and every check
      // below passes under the mutation the section exists for. Measured, on
      // both engines: started-and-awaited-later, the mutant survives;
      // awaited here, it dies.
      injectedFeed = feed(ORG_SWAP, [SWAP_A, SWAP_B], tLog); // arrives mid-flush
      await injectedFeed;
    }
    return out;
  };
  try { await scout.flush(); } finally { q.withTx = realWithTx; }
  await injectedFeed;

  chk('a mid-flush arrival was actually staged (the wrapper ran)', injected);
  chk('the flush wrote exactly what it swapped out', (await tplOf(ORG_SWAP, TPL_A))
    && (await tplOf(ORG_SWAP, TPL_A)).count === 2, JSON.stringify((await tplOf(ORG_SWAP, TPL_A))));

  await scout.flush();
  chk('a REPEAT counted during the flush survives into the next one '
    + '(clear() would have dropped it after its count was read)',
    (await tplOf(ORG_SWAP, TPL_A)) && (await tplOf(ORG_SWAP, TPL_A)).count === 3,
    JSON.stringify((await tplOf(ORG_SWAP, TPL_A))));
  chk('…and so does a brand-new template first seen during the flush',
    !!(await tplOf(ORG_SWAP, TPL_B)), (await tplAll(ORG_SWAP)).map((r) => r.template).join(' | '));
  chk('…with the count it arrived with, not zero',
    (await tplOf(ORG_SWAP, TPL_B)) && (await tplOf(ORG_SWAP, TPL_B)).count === 1,
    (await tplOf(ORG_SWAP, TPL_B)) && (await tplOf(ORG_SWAP, TPL_B)).count);

  // ── 2b. insert, and the near-match merge inside ONE flush ────────────────
  // The second entry can only merge into the first if `insTemplate`'s
  // `RETURNING id` really handed back the row it just wrote — the merge renames
  // BY THAT ID. Drop the RETURNING and the rename targets nothing, silently.
  const MERGE_A = 'quasar shard 7 rebalanced onto node 10.0.0.7 in 45ms';
  const MERGE_B = 'quasar shard 7 rebalanced onto host 10.0.0.9 in 61ms';
  const MERGE_MERGED = 'quasar shard <NUM> rebalanced onto <*> <IP> in <NUM>ms';
  await feed(ORG_MERGE, [MERGE_A, MERGE_A, MERGE_B], tLog);
  await scout.flush();
  let mrows = (await tplAll(ORG_MERGE));
  chk('two near-identical shapes collapse into ONE template row',
    mrows.length === 1, mrows.map((r) => r.template).join(' | '));
  chk('…with the differing token replaced by <*>',
    mrows[0] && mrows[0].template === MERGE_MERGED, mrows[0] && mrows[0].template);
  chk('…summing both counts onto the surviving row (the rename found the id '
    + 'that INSERT … RETURNING handed back)',
    mrows[0] && mrows[0].count === 3, mrows[0] && mrows[0].count);
  chk('…keeping the first raw line as the sample',
    mrows[0] && mrows[0].sample === MERGE_A, mrows[0] && mrows[0].sample);

  // the two halves of the merge guard, from both sides
  await feed(ORG_MERGE, ['zephyr shard 7 rebalanced onto node 10.0.0.7 in 45ms'], tLog);
  await scout.flush();
  chk('a line with a different FIRST token starts its own template, however '
    + 'similar the rest is', (await tplAll(ORG_MERGE)).length === 2,
    (await tplAll(ORG_MERGE)).map((r) => r.template).join(' | '));
  await feed(ORG_MERGE, ['quasar alpha beta gamma delta epsilon zeta eta theta'], tLog);
  await scout.flush();
  chk('…and so does one that shares the first token but falls under the 60% '
    + 'similarity threshold', (await tplAll(ORG_MERGE)).length === 3,
    (await tplAll(ORG_MERGE)).map((r) => r.template).join(' | '));

  // ── 2c. the fold across two flushes ─────────────────────────────────────
  const FOLD_1 = 'delta pool resized to 12 members';
  const FOLD_2 = 'delta pool resized to 48 members';
  const TPL_FOLD = 'delta pool resized to <NUM> members';
  const tsEarly = tLog;
  const tsLate = tLog + 120000;
  await feed(ORG_FOLD, [FOLD_1, FOLD_1, FOLD_1], tsEarly);
  await scout.flush();
  const fold1 = (await tplOf(ORG_FOLD, TPL_FOLD));
  chk('a novel template is inserted with the count it was buffered with',
    fold1 && fold1.count === 3, fold1 && fold1.count);
  chk('…carrying one raw sample line', fold1 && fold1.sample === FOLD_1, fold1 && fold1.sample);
  chk('…and first_seen = last_seen on the insert',
    fold1 && fold1.first_seen === tsEarly && fold1.last_seen === tsEarly,
    fold1 && `${fold1.first_seen}/${fold1.last_seen}`);

  await feed(ORG_FOLD, [FOLD_2, FOLD_2], tsLate);
  await scout.flush();
  const fold2 = (await tplOf(ORG_FOLD, TPL_FOLD));
  chk('a second flush of the same template SUMS the counts rather than replacing them',
    fold2 && fold2.count === 5, fold2 && fold2.count);
  chk('…on the same row', fold2 && fold1 && fold2.id === fold1.id, fold2 && fold2.id);
  chk('…preserving first_seen (the age of the template is what "new" means here)',
    fold2 && fold2.first_seen === tsEarly, fold2 && fold2.first_seen);
  chk('…preserving the original sample', fold2 && fold2.sample === FOLD_1, fold2 && fold2.sample);
  chk('…and advancing last_seen', fold2 && fold2.last_seen === tsLate, fold2 && fold2.last_seen);
  chk('…and still exactly one row for that shape', (await tplAll(ORG_FOLD)).length === 1,
    (await tplAll(ORG_FOLD)).map((r) => r.template).join(' | '));

  // ── 2d. what onLog refuses to mine ──────────────────────────────────────
  await feed(ORG_GATE, ['BGP neighbor 10.0.0.1 down', 'ab', '  '], tLog);
  await scout.flush();
  const gate = (await tplAll(ORG_GATE)).map((r) => r.template);
  chk('a line a classifier already matched is NOT mined (Scout exists for the '
    + 'unmatched remainder)', !gate.includes('BGP neighbor <IP> down'), gate.join(' | '));
  chk('…a masked line shorter than 4 chars is dropped rather than stored as a template',
    !gate.includes('ab'), gate.join(' | '));
  chk('…and a whitespace-only line masks to nothing and is dropped',
    (await tplAll(ORG_GATE)).length === 0, gate.join(' | '));
  chk('the matched line did reach the pipeline, so the check above is about '
    + 'Scout refusing to mine it and not about the line never arriving',
    !!(await evIn(ORG_GATE, 'bgp', 'scout-probe')));

  // ── 2e. the per-org ceiling ─────────────────────────────────────────────
  // 505 distinct first tokens: nothing merges, so the buffer really produces
  // 505 rows and the eviction is the only thing that can bring it back to 500.
  const many = [];
  for (let i = 0; i < 505; i++) many.push(`t${i} steady state marker`);
  await feed(ORG_EVICT, many, tLog);
  await scout.flush();
  chk('an org over MAX_TEMPLATES_PER_ORG is trimmed back to the ceiling '
    + '(505 mined → 500 kept)', (await tplAll(ORG_EVICT)).length === 500, (await tplAll(ORG_EVICT)).length);
  chk('…and the trim is scoped to that org — the other scout orgs are untouched',
    (await tplAll(ORG_FOLD)).length === 1 && (await tplAll(ORG_SWAP)).length === 2,
    `${(await tplAll(ORG_FOLD)).length} / ${(await tplAll(ORG_SWAP)).length}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. heartbeats.js — the missed-heartbeat sweep
  //
  // Anchored an hour in the FUTURE so the engine's real 15s sweep, which runs on
  // the real clock for the whole life of this process, can never reach these
  // rows: every one of them reads as "pinged in the future, not due yet".
  // ═══════════════════════════════════════════════════════════════════════════
  const TA = realNow() + 3600000;
  const DUE = 90000; // interval 60s + grace 30s
  const hbA = await mkHeartbeat('hb-grace', 60, 30, TA);
  const hbR = await mkHeartbeat('hb-rearm', 60, 30, TA);
  const hbD = await mkHeartbeat('hb-disabled', 60, 30, TA, 0);

  await atAsync(TA + DUE - 1, () => heartbeats.tick());
  chk('a heartbeat one millisecond inside its grace window raises nothing',
    !(await evRow('heartbeat_missed', 'hb-grace')), 'alerted early');
  chk('…and is not marked as reported', (await hbRow(hbA.id)).alerted_at === null,
    (await hbRow(hbA.id)).alerted_at);

  await atAsync(TA + DUE, () => heartbeats.tick());
  const missA = (await evRow('heartbeat_missed', 'hb-grace'));
  chk('at EXACTLY interval + grace it alerts (the boundary is >=, not >)',
    !!missA, 'no event at the boundary');
  chk('…exactly once', missA && missA.hits === 1, missA && missA.hits);
  chk('…at severity 70', missA && missA.severity === 70, missA && missA.severity);
  chk('…and the row records when the miss was reported',
    (await hbRow(hbA.id)).alerted_at === TA + DUE, (await hbRow(hbA.id)).alerted_at);
  chk('…and the description says how long it has been silent and what was expected',
    missA && missA.description
      === 'heartbeat_missed hb-grace — no ping for 2 min (expected every 60s)',
    missA && missA.description);
  chk('a heartbeat that is DISABLED is never swept, however overdue',
    !(await evRow('heartbeat_missed', 'hb-disabled')) && (await hbRow(hbD.id)).alerted_at === null,
    'disabled heartbeat alerted');

  await atAsync(TA + DUE + 30000, () => heartbeats.tick());
  chk('a miss already reported does not alert a second time',
    hits((await evRow('heartbeat_missed', 'hb-grace'))) === 1,
    hits((await evRow('heartbeat_missed', 'hb-grace'))));
  chk('…and alerted_at is not moved forward by the re-sweep',
    (await hbRow(hbA.id)).alerted_at === TA + DUE, (await hbRow(hbA.id)).alerted_at);

  // ── the re-arm, through the real ping endpoint ───────────────────────────
  const missR = (await evRow('heartbeat_missed', 'hb-rearm'));
  chk('the second heartbeat missed on the same sweep', !!missR && missR.hits === 1,
    missR && missR.hits);
  const P = TA + DUE + 60000;
  const pingRes = await atAsync(P, () => req('GET', `/v1/heartbeat/${hbR.token}`));
  chk('the public ping endpoint accepts the token', pingRes.status === 200, pingRes.status);
  chk('…and re-arms the switch (last_ping_at set, alerted_at cleared)',
    (await hbRow(hbR.id)).last_ping_at === P && (await hbRow(hbR.id)).alerted_at === null,
    `${(await hbRow(hbR.id)).last_ping_at}/${(await hbRow(hbR.id)).alerted_at}`);

  await atAsync(P + 50000, () => heartbeats.tick());
  chk('a sweep inside the grace window AFTER a ping does not page for a live job',
    hits((await evRow('heartbeat_missed', 'hb-rearm'))) === 1,
    hits((await evRow('heartbeat_missed', 'hb-rearm'))));
  chk('…and leaves alerted_at NULL, so the next genuine miss is still armed',
    (await hbRow(hbR.id)).alerted_at === null, (await hbRow(hbR.id)).alerted_at);

  await atAsync(P + DUE, () => heartbeats.tick());
  chk('the next genuine miss after a ping alerts again',
    hits((await evRow('heartbeat_missed', 'hb-rearm'))) === 2,
    hits((await evRow('heartbeat_missed', 'hb-rearm'))));
  chk('…and records the new report time',
    (await hbRow(hbR.id)).alerted_at === P + DUE, (await hbRow(hbR.id)).alerted_at);

  await q.prepare('UPDATE heartbeats SET enabled = 0 WHERE id IN (?, ?)').run(hbA.id, hbR.id);

  // ── the race the WHERE clause exists for ────────────────────────────────
  // tick() reads its list ONCE and then claims one row at a time. Anything that
  // happens while it is walking that list makes the rest of the list stale —
  // and dispatching an event is exactly such a thing: it runs listeners, which
  // is where the real product does slow work. So a ping and a disable are
  // staged from inside the listener for the FIRST heartbeat's event, landing
  // between tick()'s read of the second and third rows and its writes to them.
  //
  // Deciding "still silent?" in JS from the pre-read row alerts both, and — the
  // half that costs a real page later — writes alerted_at ABOVE the fresh ping,
  // which silences the next genuine miss for good.
  const TR = TA + 1000000;
  const hbX = await mkHeartbeat('hb-race-trigger', 60, 30, TR);
  const hbY = await mkHeartbeat('hb-race-ping', 60, 30, TR);
  const hbZ = await mkHeartbeat('hb-race-disable', 60, 30, TR);
  let staged = false;
  let stagedWrites = null;
  pipeline.on('event', (ev) => {
    if (staged || ev.name !== 'heartbeat_missed' || ev.device !== 'hb-race-trigger') return;
    staged = true;
    // byte-for-byte what routes/heartbeat.js does on a ping
    stagedWrites = (async () => {
      await q.prepare('UPDATE heartbeats SET last_ping_at = ?, alerted_at = NULL WHERE id = ?')
        .run(TR + DUE, hbY.id);
      await q.prepare('UPDATE heartbeats SET enabled = 0 WHERE id = ?').run(hbZ.id);
    })();
  });
  // `emit()` calls its listeners and DISCARDS what they return, so once the
  // writes above are awaited they are still in flight when tick() reaches the
  // next row — on SQLite they happen to land first (a shim call resolves in a
  // microtask), on Postgres they are a network round trip and land far too
  // late. That would make the interleaving a coin toss rather than a staging,
  // and the checks below would fail for a reason that has nothing to do with
  // the sweep. The one seam tick() does await between two rows is
  // `ingestEvent`, so the staged writes are joined there: the same instant as
  // before, deterministic on both engines.
  const realIngestEvent = pipeline.ingestEvent;
  pipeline.ingestEvent = async (...args) => {
    const out = await realIngestEvent(...args);
    if (stagedWrites) { const w = stagedWrites; stagedWrites = null; await w; }
    return out;
  };
  try { await atAsync(TR + DUE, () => heartbeats.tick()); }
  finally { pipeline.ingestEvent = realIngestEvent; }
  chk('the mid-sweep ping and disable were actually staged', staged);
  chk('the heartbeat that was genuinely silent still alerts',
    !!(await evRow('heartbeat_missed', 'hb-race-trigger')), 'trigger did not alert');
  chk('a ping that lands mid-sweep cancels the miss the sweep had already read',
    !(await evRow('heartbeat_missed', 'hb-race-ping')), 'paged for a live job');
  chk('…and the sweep does NOT write alerted_at back over the fresh ping',
    (await hbRow(hbY.id)).alerted_at === null, (await hbRow(hbY.id)).alerted_at);
  chk('a heartbeat disabled mid-sweep is not alerted from the stale row either',
    !(await evRow('heartbeat_missed', 'hb-race-disable')) && (await hbRow(hbZ.id)).alerted_at === null,
    (await hbRow(hbZ.id)).alerted_at);

  await atAsync(TR + DUE + DUE, () => heartbeats.tick());
  const missY = (await evRow('heartbeat_missed', 'hb-race-ping'));
  chk('and the next REAL miss after that ping is not silent — which is what a '
    + 'stale alerted_at would have made it. Reported AT that instant, not '
    + 'earlier: an event alone would also be satisfied by the false page above',
    !!missY && missY.hits === 1 && (await hbRow(hbY.id)).alerted_at === TR + DUE + DUE,
    `${hits(missY)} hit(s), reported ${(await hbRow(hbY.id)).alerted_at} want ${TR + DUE + DUE}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. routes/ingest.js — the container diff
  //
  // Driven over HTTP with the agent's own Bearer token, one snapshot per
  // minute, minutes supplied by the clock rather than waited for.
  // ═══════════════════════════════════════════════════════════════════════════
  const CM = Math.floor(realNow() / 60000) * 60000 - 30 * 60000;
  const M = (n) => CM + n * 60000;

  const snapshot = (agent, containers, minute) => atAsync(minute,
    () => postJson('/v1/agents/containers', { containers },
      { authorization: `Bearer ${agent.token}` }));
  const run = (name) => ({ name, state: 'running', cpuPct: 1.5, memUsed: 100, memLimit: 1000 });
  const stored = (agentId, minute) => q.prepare(
    'SELECT * FROM agent_containers WHERE agent_id = ? AND ts = ? ORDER BY name')
    .all(agentId, minute);

  // auth first — the diff is only reachable through it
  const noTok = await postJson('/v1/agents/containers', { containers: [] });
  chk('the container endpoint refuses a request with no agent token',
    noTok.status === 401, noTok.status);
  const badTok = await postJson('/v1/agents/containers', { containers: [] },
    { authorization: 'Bearer nope' });
  chk('…and one with an unknown token', badTok.status === 401, badTok.status);

  // ── 4a. a container that vanishes ───────────────────────────────────────
  const aVanish = await mkAgent('agent-vanish');
  const s0 = await snapshot(aVanish, [run('web'), run('db')], M(0));
  chk('the first snapshot is accepted', s0.status === 200 && s0.body.ok === true,
    JSON.stringify(s0));
  chk('…and stores one row per container in that minute',
    (await stored(aVanish.id, M(0))).length === 2,
    (await stored(aVanish.id, M(0))).map((r) => r.name).join(','));
  chk('…and raises nothing at all, because there is no predecessor to diff against',
    (await evCount('container_down', 'agent-vanish')) === 0,
    `${(await evCount('container_down', 'agent-vanish'))} events on the first snapshot`);

  await snapshot(aVanish, [run('web')], M(1));
  const goneEv = (await evRow('container_down', 'agent-vanish', 'db'));
  chk('a container that was running and is now absent raises container_down',
    !!goneEv, 'no event for the vanished container');
  chk('…described as (gone), not (undefined)',
    goneEv && goneEv.description === 'container_down db on agent-vanish (gone)',
    goneEv && goneEv.description);
  chk('…at severity 65 and targeted at the container, not the host',
    goneEv && goneEv.severity === 65 && goneEv.target === 'db',
    goneEv && `${goneEv.severity}/${goneEv.target}`);
  chk('…and the container that is still running raises nothing',
    !(await evRow('container_down', 'agent-vanish', 'web')), 'false positive on a running container');

  // ── 4b. present, but not running ────────────────────────────────────────
  const aExit = await mkAgent('agent-exit');
  await snapshot(aExit, [run('api'), run('sidecar')], M(0));
  await snapshot(aExit, [{ name: 'api', state: 'exited' },
    { name: 'sidecar', state: 'restarting' }], M(1));
  const exitEv = (await evRow('container_down', 'agent-exit', 'api'));
  chk('a container still listed but no longer running raises container_down',
    !!exitEv, 'no event for the exited container');
  chk('…described with the state it is actually IN, not "gone" — that split is '
    + 'the difference between "crashed" and "someone removed it"',
    exitEv && exitEv.description === 'container_down api on agent-exit (exited)',
    exitEv && exitEv.description);
  const restartEv = (await evRow('container_down', 'agent-exit', 'sidecar'));
  chk('…and any non-running state counts, not just "exited"',
    restartEv && restartEv.description === 'container_down sidecar on agent-exit (restarting)',
    restartEv && restartEv.description);

  // ── 4c. an empty list ───────────────────────────────────────────────────
  const aEmptyFirst = await mkAgent('agent-empty-first');
  const e0 = await snapshot(aEmptyFirst, [], M(0));
  chk('an empty container list is accepted rather than rejected',
    e0.status === 200 && e0.body.stored === 0, JSON.stringify(e0));
  chk('…and stores nothing', (await stored(aEmptyFirst.id, M(0))).length === 0,
    (await stored(aEmptyFirst.id, M(0))).length);
  const missingBody = await atAsync(M(0), () => postJson('/v1/agents/containers', {},
    { authorization: `Bearer ${aEmptyFirst.token}` }));
  chk('…and so is a body with no containers key at all',
    missingBody.status === 200 && missingBody.body.stored === 0, JSON.stringify(missingBody));

  const aEmpty = await mkAgent('agent-empty');
  await snapshot(aEmpty, [run('cron'), run('mailer')], M(0));
  await snapshot(aEmpty, [], M(1));
  chk('an empty list after a populated one reports EVERY container as gone '
    + '(the agent lost docker, and that is worth a page)',
    !!(await evRow('container_down', 'agent-empty', 'cron'))
    && !!(await evRow('container_down', 'agent-empty', 'mailer')), 'empty snapshot raised nothing');

  // ── 4d. names that are not names ────────────────────────────────────────
  const aBad = await mkAgent('agent-bad');
  const bad = await snapshot(aBad, [
    { name: 12345, state: 'running' },
    { name: '', state: 'running' },
    { name: 'x'.repeat(201), state: 'running' },
    run('good'),
  ], M(0));
  chk('a snapshot carrying invalid container names still answers 200',
    bad.status === 200, bad.status);
  chk('…skipping every one of them and storing only the valid container',
    (await stored(aBad.id, M(0))).length === 1 && (await stored(aBad.id, M(0)))[0].name === 'good',
    (await stored(aBad.id, M(0))).map((r) => r.name).join(','));
  chk('…while the response counts what was SUBMITTED, not what was kept '
    + '(documented as-is: `stored` is list.length)', bad.body.stored === 4, bad.body.stored);

  // ── 4e. the chain: every snapshot is diffed against its predecessor ─────
  // down at M-1, up at M, down at M+1. If the middle snapshot were skipped —
  // which is what two interleaved posts reading the same predecessor produce —
  // M+1 would diff against M-1, where the container was already down, and raise
  // NOTHING. That is the failure the read-and-write transaction exists for, and
  // it has no symptom: no error, no counter, no log line.
  const aChain = await mkAgent('agent-chain');
  await snapshot(aChain, [{ name: 'job', state: 'exited' }], M(0));
  chk('a container that is already down on the first snapshot raises nothing',
    !(await evRow('container_down', 'agent-chain', 'job')), 'event on first sighting');
  await snapshot(aChain, [run('job')], M(1));
  chk('…and coming back up raises nothing either',
    !(await evRow('container_down', 'agent-chain', 'job')), 'event when the container recovered');
  await snapshot(aChain, [{ name: 'job', state: 'exited' }], M(2));
  const chainEv = (await evRow('container_down', 'agent-chain', 'job'));
  chk('going down again after a recovery DOES raise container_down — each '
    + 'snapshot is diffed against the one immediately before it',
    !!chainEv, 'the recovery snapshot was not diffed');
  chk('…once', chainEv && chainEv.hits === 1, chainEv && chainEv.hits);
  await snapshot(aChain, [], M(3));
  chk('…and a container that was ALREADY down when it disappeared is not reported '
    + 'again — only a RUNNING predecessor can go down',
    hits((await evRow('container_down', 'agent-chain', 'job'))) === 1,
    hits((await evRow('container_down', 'agent-chain', 'job'))));

  // ── 4f. two posts inside the same minute ───────────────────────────────
  // The predecessor lookup is `ts < minute`, strictly. With `<=` the second post
  // of a minute reads the row the first post just wrote as its "previous
  // snapshot" and reports every container it stopped listing — an agent that
  // posts twice a minute would page the on-call for containers that are fine.
  const aMin = await mkAgent('agent-minute');
  await snapshot(aMin, [run('svc')], M(5));
  const second = await snapshot(aMin, [{ name: 'svc', state: 'exited' }], M(5));
  chk('two snapshots in the same minute are both accepted', second.status === 200, second.status);
  chk('…the later one overwrites the earlier state in that minute bucket',
    (await stored(aMin.id, M(5))).length === 1 && (await stored(aMin.id, M(5)))[0].state === 'exited',
    JSON.stringify((await stored(aMin.id, M(5)))));
  chk('…and the minute does not diff against ITSELF',
    !(await evRow('container_down', 'agent-minute', 'svc')), 'a same-minute repost raised an event');

  report();
}

main().catch(die);
