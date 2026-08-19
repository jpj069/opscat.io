'use strict';
/* The log store, and the fact that there are two of them.
 *
 * ── Why this harness exists ─────────────────────────────────────────────────
 *
 * `src/db/log-store.js` has two implementations of one interface: ClickHouse,
 * the default in both editions, and Postgres, the supported opt-out for a box
 * that cannot spare ~600 MB. CLAUDE.md's standing warning
 * is that "a second implementation is how the two drift apart", and every other
 * mitigation in that module is structural — one seam, one boot-time choice, no
 * query builder. This file is the mitigation that can actually FAIL a build.
 *
 * The shape is the point: PARITY is a table of assertions run TWICE, once
 * against each implementation, in one process. Not two suites that happen to
 * cover similar ground — literally the same function, called with a different
 * store. A behaviour that differs is a failing check with the engine's name on
 * it, and adding a method to the interface without teaching it to both stores
 * fails here rather than in production on whichever edition was not tried.
 *
 * ── Why it does NOT skip itself when ClickHouse is absent ───────────────────
 *
 * "A check that skips itself when no database is present is a check nobody
 * notices has stopped running" (CLAUDE.md, about the pg adapter check). So the
 * Postgres half always runs, and the ClickHouse half either runs or the harness
 * says loudly, in the summary, how many checks did not — the same discipline as
 * the sweep's DEFERRED list. CI supplies ClickHouse (`.github/workflows/ci.yml`
 * declares the service), so on the gate that matters both halves always run.
 * Locally, `OPSCAT_CH_URL=http://127.0.0.1:8123 node run-e2e.js logstore`.
 *
 * ── What it covers beyond parity ────────────────────────────────────────────
 *
 * Two things parity cannot see, both driven through the real app on :3163 with
 * ClickHouse configured:
 *
 *   • THE SPLIT. Lines land in ClickHouse and NOT in Postgres, while the events
 *     derived from them land in Postgres. If a future edit quietly wrote both,
 *     every parity check would still pass and the 14x storage saving — the
 *     reason for the whole exercise — would be gone with no symptom.
 *   • TENANT ISOLATION. Tenancy was a WHERE clause in one engine's dialect and
 *     is now a WHERE clause in two. `e2e-tenancy` guards the Postgres one; a
 *     foreign org's lines leaking through ClickHouse search would be a 200 with
 *     no log line, which is the exact failure shape that file was written for.
 *
 * Port 3163.  cd server && node run-e2e.js logstore
 */
const http = require('node:http');

/* EVERY process.env ASSIGNMENT HAPPENS BEFORE THE FIRST require OF ./src.
 *
 * `src/config.js` reads the environment at require time and freezes the answer,
 * and `src/db/shim.js` requires it transitively. Setting PORT after that require
 * is a no-op with no error: the first version of this file booted the app on
 * :3000 against the developer's own ClickHouse database instead of on :3163
 * against a throwaway one. The 82 checks before it still passed, which is what
 * makes the ordering worth a comment rather than a blank line. */
const PORT = 3163;
/* OPSCAT_CH_URL, not CLICKHOUSE_URL: run-e2e.js strips the latter from every
 * harness's environment so that having ClickHouse configured cannot silently
 * switch the log store for the other 23. This harness opts in by name. */
const CH_URL = process.env.OPSCAT_CH_URL || '';
/* A database of this harness's own. Sharing one with a developer's instance is
 * how a `TRUNCATE` in a test deletes somebody's afternoon. */
const CH_DB = `opscat_e2e_logstore_${process.pid}`;
process.env.PORT = String(PORT);
process.env.CLICKHOUSE_DB = CH_DB;
/* Opting in by name (OPSCAT_CH_URL) is what run-e2e.js hands us; putting it
 * back under its real name is what makes the APP choose the ClickHouse store.
 * Missing this, `store()` reads an empty config.clickhouseUrl and the app boots
 * on Postgres — and it does so quietly: the parity table still passes, because
 * it calls each implementation directly, and every HTTP check still passes,
 * because they read the same wrong engine they wrote to. The only thing that
 * caught it was the storage-split check, which is why that check exists. */
process.env.CLICKHOUSE_URL = CH_URL;
process.env.OPSCAT_SECRET = 'e2e-logstore-secret';
/* The seeded "Critical → E-Mail" rule fires on the events this harness's lines
 * create. With a key in the environment that is a live outbound call per event
 * — measured in the benchmark session, where it also mailed real people. */
delete process.env.RESEND_API_KEY;
delete process.env.SMTP_HOST;

const { chk, report, die, onExit } = require('./e2e-lib').harness();

const BASE = `http://127.0.0.1:${PORT}`;
const ORG_A = require('./src/util').DEFAULT_ORG_ID;
const { newId } = require('./src/util');

const q = require('./src/db/shim');
const ch = require('./src/db/clickhouse');
const logStore = require('./src/db/log-store');

/* ── the parity table ──────────────────────────────────────────────────────
 *
 * One function, run once per implementation. `label` is the engine name so a
 * failure names which one broke, and every check is phrased as a claim about
 * THE INTERFACE rather than about either engine's SQL.
 *
 * `settle` exists because the two engines disagree about when a write is
 * readable: Postgres is read-your-writes on the same connection, ClickHouse
 * acknowledges an insert once the part is written, and a lightweight DELETE is
 * an asynchronous mutation. Rather than sprinkle waits through the assertions
 * (which would hide a real regression as a timing flake), each store says how
 * to reach a quiet state and the table calls it at the two points where it
 * matters.
 */
async function parity(store, label, settle) {
  const org = newId();
  const other = newId();
  const T = Date.UTC(2026, 7, 17, 12, 0, 0);
  const line = (n, dev, txt, sev, ts) => ({
    orgId: n, ts, device: dev, line: txt, sev, source: 'e2e', meta: null,
  });

  await store.insert([
    line(org, 'core-switch-01', 'BGP neighbor 10.0.0.1 Down - hold time expired', 3, T),
    line(org, 'core-switch-01', 'connection to 10.0.0.2 TIMEOUT after 5000ms', 4, T + 1000),
    line(org, 'edge-router-01', 'sshd: Accepted publickey for noc', 6, T + 2000),
    // a second UTC day, so the bucket fold has something to fold
    line(org, 'edge-router-01', 'kernel: bond0 link is down', 2, T + 86400000),
    // a different tenant's line, present in every query below and welcome in none
    line(other, 'foreign-device', 'FOREIGN tenant isolation probe TIMEOUT', 6, T + 3000),
  ]);
  await settle();

  // ── counting ────────────────────────────────────────────────────────────
  chk(`[${label}] countForOrg counts one org's lines only`,
    await store.countForOrg(org) === 4, `got ${await store.countForOrg(org)}`);
  chk(`[${label}] countForOrg sees the other org separately`,
    await store.countForOrg(other) === 1);
  chk(`[${label}] countSince with an org is scoped to it`,
    await store.countSince({ orgId: org, since: T }) === 4);
  chk(`[${label}] countSince honours the window`,
    await store.countSince({ orgId: org, since: T + 2000 }) === 2);
  chk(`[${label}] countSince WITHOUT an org spans every tenant (the super-admin view)`,
    await store.countSince({ since: T }) === 5);
  const byOrg = await store.countByOrg();
  chk(`[${label}] countByOrg returns a Map keyed by org id`,
    byOrg instanceof Map && byOrg.get(org) === 4 && byOrg.get(other) === 1,
    JSON.stringify([...byOrg]));

  // ── search ──────────────────────────────────────────────────────────────
  const all = await store.search({ orgId: org, since: 0, until: 9e15, term: '', limit: 50 });
  chk(`[${label}] an empty term lists the org's lines`, all.length === 4);
  chk(`[${label}] search returns newest first`, all[0].ts > all[all.length - 1].ts);
  chk(`[${label}] ts comes back as a NUMBER, not a string`, typeof all[0].ts === 'number',
    `got ${typeof all[0].ts}`);
  chk(`[${label}] sev comes back as a NUMBER`, typeof all[0].sev === 'number');
  chk(`[${label}] the row carries source`, all[0].source === 'e2e');

  /* Case-insensitive by CONTRACT. Postgres reaches it with lower()/LIKE and
   * ClickHouse with ILIKE; the stored text is upper-case TIMEOUT and the term
   * is lower-case, so an implementation that quietly became case-sensitive
   * fails here rather than in a customer's search box. */
  const t1 = await store.search({ orgId: org, since: 0, until: 9e15, term: 'timeout', limit: 50 });
  chk(`[${label}] search is case-insensitive`, t1.length === 1, `got ${t1.length}`);
  chk(`[${label}] search does NOT cross tenants`,
    t1.every((r) => !r.line.includes('FOREIGN')), JSON.stringify(t1.map((r) => r.line)));

  const t2 = await store.search({ orgId: org, since: 0, until: 9e15, term: 'edge-router', limit: 50 });
  chk(`[${label}] the term matches the DEVICE name too`, t2.length === 2, `got ${t2.length}`);

  const t3 = await store.search({
    orgId: org, since: 0, until: 9e15, term: '', device: 'core-switch-01', limit: 50 });
  chk(`[${label}] an exact device filter narrows to that device`, t3.length === 2, `got ${t3.length}`);
  const t4 = await store.search({
    orgId: org, since: 0, until: 9e15, term: 'timeout', device: 'core-switch-01', limit: 50 });
  chk(`[${label}] device filter and term compose`, t4.length === 1, `got ${t4.length}`);
  const t5 = await store.search({
    orgId: org, since: 0, until: 9e15, term: 'timeout', device: 'edge-router-01', limit: 50 });
  chk(`[${label}] device filter and term compose to NOTHING when they disagree`, t5.length === 0);

  chk(`[${label}] the window is inclusive at both ends`,
    (await store.search({ orgId: org, since: T, until: T, term: '', limit: 50 })).length === 1);
  chk(`[${label}] limit is honoured`,
    (await store.search({ orgId: org, since: 0, until: 9e15, term: '', limit: 2 })).length === 2);

  // ── the tails ───────────────────────────────────────────────────────────
  const dt = await store.deviceTail({ orgId: org, device: 'core-switch-01', limit: 10 });
  chk(`[${label}] deviceTail returns that device's lines, newest first`,
    dt.length === 2 && dt[0].sev === 4 && dt[1].sev === 3, JSON.stringify(dt.map((r) => r.sev)));
  chk(`[${label}] deviceTail is org-scoped`,
    (await store.deviceTail({ orgId: other, device: 'core-switch-01', limit: 10 })).length === 0);
  chk(`[${label}] recent() is org-scoped and windowed`,
    (await store.recent({ orgId: org, since: T + 2000, limit: 100 })).length === 2);

  // ── the aggregations the pages depend on ────────────────────────────────
  const seen = await store.lastSeenByDevice({ orgId: org });
  const m = new Map(seen.map((r) => [r.device, r.ls]));
  chk(`[${label}] lastSeenByDevice returns one row per device`, seen.length === 2, `got ${seen.length}`);
  chk(`[${label}] lastSeenByDevice reports the NEWEST ts per device`,
    m.get('core-switch-01') === T + 1000 && m.get('edge-router-01') === T + 86400000,
    JSON.stringify([...m]));
  chk(`[${label}] lastSeenByDevice is org-scoped`, !m.has('foreign-device'));
  chk(`[${label}] lastSeenByDevice ls is a NUMBER`, typeof seen[0].ls === 'number');

  /* The day bucket is `ts - ts % 86400000` in both stores on purpose: a date
   * function would render in the server's timezone and the two engines would
   * disagree by up to a day. The fixture straddles midnight UTC, so a store
   * that switched to toStartOfDay/date_trunc fails here. */
  const buckets = await store.dailyBuckets({ orgId: org, since: 0 });
  chk(`[${label}] dailyBuckets folds to one row per UTC day`, buckets.length === 2,
    JSON.stringify(buckets));
  chk(`[${label}] the bucket value is the UTC midnight of its day`,
    buckets[0].bucket === Date.UTC(2026, 7, 17) && buckets[1].bucket === Date.UTC(2026, 7, 18),
    JSON.stringify(buckets.map((b) => b.bucket)));
  chk(`[${label}] dailyBuckets is ordered oldest first`, buckets[0].bucket < buckets[1].bucket);
  /* Day 1 holds sev 3, 4 and 6 -> h=1, m=1, l=1, c=0 (c counts sev <= 2).
   * Day 2 holds the single sev 2 line -> c=1. Naming every column stops a
   * transcription error in one CASE arm from passing because the total is right. */
  chk(`[${label}] the severity bands are counted per bucket`,
    buckets[0].c === 0 && buckets[0].h === 1 && buckets[0].m === 1 && buckets[0].l === 1
    && buckets[1].c === 1 && buckets[1].h === 0 && buckets[1].m === 0 && buckets[1].l === 0,
    JSON.stringify(buckets));
  chk(`[${label}] bucket counts are NUMBERS`, typeof buckets[0].h === 'number');
  chk(`[${label}] dailyBuckets is org-scoped`,
    (await store.dailyBuckets({ orgId: other, since: 0 })).length === 1);

  // ── retention ───────────────────────────────────────────────────────────
  await store.purge({ orgId: org, before: T + 1500 });
  await settle();
  chk(`[${label}] purge removes the org's lines before the cutoff`,
    await store.countForOrg(org) === 2, `got ${await store.countForOrg(org)}`);
  chk(`[${label}] purge leaves the lines AT or after the cutoff`,
    (await store.search({ orgId: org, since: 0, until: 9e15, term: '', limit: 50 }))
      .every((r) => r.ts >= T + 1500));
  chk(`[${label}] purge does NOT touch another tenant`, await store.countForOrg(other) === 1);

  // ── the empty cases, which are where a translation usually breaks ───────
  const empty = newId();
  chk(`[${label}] an org with no lines counts 0, not null`, await store.countForOrg(empty) === 0);
  chk(`[${label}] an org with no lines searches to []`,
    (await store.search({ orgId: empty, since: 0, until: 9e15, term: '', limit: 10 })).length === 0);
  chk(`[${label}] an org with no lines has no buckets`,
    (await store.dailyBuckets({ orgId: empty, since: 0 })).length === 0);
  chk(`[${label}] an org with no lines has no devices`,
    (await store.lastSeenByDevice({ orgId: empty })).length === 0);
  chk(`[${label}] inserting nothing is a no-op, not an error`,
    (await store.insert([])) === undefined);
}

/* ── HTTP, because a harness that drives the clock or the store directly still
 * has not proven the product works. node:http rather than fetch, matching the
 * rule e2e-engines and e2e-branding record. */
function req(method, path, { key, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port: PORT, method, path,
      headers: {
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(b); } catch { /* a non-JSON body is the answer */ }
        resolve({ status: res.statusCode, body: j, raw: b });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function mintKey(orgId, name) {
  const key = `ock_${name}${require('node:crypto').randomBytes(16).toString('hex')}`;
  const hash = require('node:crypto').createHash('sha256').update(key).digest('hex');
  await q.prepare(`INSERT INTO api_keys (org_id, name, prefix, key_hash, scopes, role, active, created_at)
    VALUES (?, ?, ?, ?, 'ingest,api', 'admin', 1, ?)`).run(orgId, name, key.slice(0, 12), hash, Date.now());
  return key;
}

async function main() {
  let chChecks = 0;

  // ── 1. parity ───────────────────────────────────────────────────────────
  const before = 0;
  await parity(logStore.pgStore, 'postgres', async () => {});

  let chStore = null;
  if (CH_URL) {
    const client = new ch.ClickHouse({
      url: CH_URL,
      database: CH_DB,
      user: process.env.CLICKHOUSE_USER || 'default',
      password: process.env.CLICKHOUSE_PASSWORD || '',
    });
    ch._setClientForTests(client);
    await ch.init(client);
    onExit(() => {
      /* Best effort, and deliberately not awaited: the harness must report even
       * if the drop fails, and a leftover database named after a dead pid is a
       * nuisance rather than a broken signal. */
      const drop = new ch.ClickHouse({
        url: CH_URL, database: 'default',
        user: process.env.CLICKHOUSE_USER || 'default',
        password: process.env.CLICKHOUSE_PASSWORD || '',
      });
      drop.exec(`DROP DATABASE IF EXISTS \`${CH_DB}\``).catch(() => {});
    });

    chk('the ClickHouse schema applies', !!(await client.get('SELECT count() AS c FROM logs',
      {}, { numeric: ['c'] })));
    /* Applied on EVERY boot, so a statement without IF NOT EXISTS works on the
     * install that creates it and kills the process on every restart after —
     * the same guarantee e2e-schema pins for schema.sql. */
    await ch.init(client);
    chk('the ClickHouse schema applies TWICE (boot is idempotent)',
      !!(await client.get('SELECT count() AS c FROM logs', {}, { numeric: ['c'] })));

    chStore = logStore.chStore;
    const n0 = 0;
    await parity(chStore, 'clickhouse', async () => {
      /* A lightweight DELETE is an asynchronous mutation, so "gone from query
       * results" is not immediate. Waiting for the mutation queue to drain is
       * the deterministic form of that — a fixed sleep would be a flake
       * generator on a loaded CI runner. */
      for (let i = 0; i < 100; i++) {
        const m = await client.get(
          `SELECT count() AS c FROM system.mutations WHERE database = {db:String} AND NOT is_done`,
          { db: CH_DB }, { numeric: ['c'] });
        if (!m || m.c === 0) return;
        await new Promise((r) => setTimeout(r, 50));
      }
    });
  }

  // ── 2. the split, and tenancy, through the real app ─────────────────────
  if (CH_URL) {
    require('./src/index.js');
    await require('./e2e-lib').waitForServer(BASE);

    const keyA = await mintKey(ORG_A, 'lsA');
    const orgB = newId();
    await q.prepare(`INSERT INTO organizations (id, name, slug, plan, status, created_at)
      VALUES (?, 'LS B', ?, 'free', 'active', ?)`).run(orgB, `ls-b-${process.pid}`, Date.now());
    const keyB = await mintKey(orgB, 'lsB');

    const t = Date.now();
    const ing = await req('POST', '/v1/ingest/logs', { key: keyA, body: { logs: [
      { ts: t, device: 'sw-01', line: 'BGP neighbor 10.0.0.1 Down - hold time expired', sev: 3 },
      { ts: t + 1, device: 'sw-01', line: 'connection to 10.0.0.2 TIMEOUT after 5000ms', sev: 4 },
      { ts: t + 2, device: 'rt-01', line: 'sshd: Accepted publickey for noc', sev: 6 },
    ] } });
    chk('ingest through the real endpoint accepts the batch',
      ing.status === 200 && ing.body.accepted === 3, JSON.stringify(ing.body));
    chk('ingest still derives events from those lines', ing.body.events >= 1);

    /* THE CLAIM THE WHOLE EXERCISE RESTS ON. Lines in ClickHouse, zero in
     * Postgres. A future edit that wrote both would pass every other check in
     * this file and silently give back the 14x storage saving. */
    /* Scoped to ORG_A, exactly like its ClickHouse counterpart below. Counting
     * the whole table instead reads the Postgres-parity fixtures above — which
     * this harness put there on purpose — and reports a failure that is an
     * artefact of its own setup. Caught on the first run: `postgres holds 3`,
     * which was parity's two surviving rows plus the other tenant's one. */
    const inPg = await q.prepare('SELECT COUNT(*) c FROM logs WHERE org_id = ?').get(ORG_A);
    chk('the lines are NOT in Postgres', Number(inPg.c) === 0, `postgres holds ${inPg.c}`);
    const inCh = await ch.get().get('SELECT count() AS c FROM logs WHERE org_id = {o:UUID}',
      { o: ORG_A }, { numeric: ['c'] });
    chk('the lines ARE in ClickHouse', inCh.c === 3, `clickhouse holds ${inCh && inCh.c}`);
    /* And the derived events went the other way — they are transactional and
     * must not have followed the lines out of Postgres. */
    const evs = await q.prepare('SELECT COUNT(*) c FROM events WHERE org_id = ?').get(ORG_A);
    chk('the events derived from them stay in Postgres', Number(evs.c) >= 1);

    const tail = await req('GET', '/api/logs?hours=2&limit=50', { key: keyA });
    chk('GET /api/logs serves the ClickHouse lines', tail.status === 200 && tail.body.length === 3,
      `${tail.status} ${JSON.stringify(tail.body).slice(0, 120)}`);
    const search = await req('GET', '/api/logs?hours=2&q=timeout', { key: keyA });
    chk('GET /api/logs?q= searches them case-insensitively', search.body.length === 1);
    const dash = await req('GET', '/api/dashboard', { key: keyA });
    chk('GET /api/dashboard counts them', dash.body.logs24 === 3, `got ${dash.body.logs24}`);
    const ana = await req('GET', '/api/analytics?range=7d', { key: keyA });
    chk('GET /api/analytics buckets them', Array.isArray(ana.body.volume) && ana.body.volume.length >= 1);
    const assets = await req('GET', '/api/assets', { key: keyA });
    chk('GET /api/assets roll-calls them',
      assets.body.filter((r) => r.kind === 'source').length === 2,
      JSON.stringify(assets.body.filter((r) => r.kind === 'source').map((r) => r.name)));

    // ── tenancy, the reason e2e-tenancy exists, re-asked of the new engine ──
    const bIng = await req('POST', '/v1/ingest/logs', { key: keyB, body: { logs: [
      { ts: t, device: 'orgb-device', line: 'ORGB-CONFIDENTIAL isolation probe TIMEOUT', sev: 6 },
    ] } });
    chk('the second org can ingest', bIng.body.accepted === 1);

    const leakSearch = await req('GET', '/api/logs?hours=2&q=ORGB-CONFIDENTIAL', { key: keyA });
    chk('org A cannot SEARCH org B\'s lines', leakSearch.body.length === 0,
      JSON.stringify(leakSearch.body));
    const leakTail = await req('GET', '/api/logs?hours=2&limit=100', { key: keyA });
    chk('org A\'s tail contains no foreign device',
      leakTail.body.every((r) => r.device !== 'orgb-device'));
    const leakAssets = await req('GET', '/api/assets', { key: keyA });
    chk('org A\'s roll-call does not list org B\'s device',
      leakAssets.body.every((r) => r.name !== 'orgb-device'));
    const leakDash = await req('GET', '/api/dashboard', { key: keyA });
    chk('org A\'s dashboard count excludes org B', leakDash.body.logs24 === 3,
      `got ${leakDash.body.logs24}`);
    const own = await req('GET', '/api/logs?hours=2&q=ORGB-CONFIDENTIAL', { key: keyB });
    chk('org B CAN see its own line (the check above is not vacuous)', own.body.length === 1);

    chChecks = 1;
  }

  if (!CH_URL) {
    /* Not a skip in silence. The summary says what did not run and how to run
     * it, because the failure mode of a self-skipping check is that nobody
     * notices it stopped. */
    console.log('\n!! CLICKHOUSE NOT CONFIGURED — 58 of this harness\'s 98 checks did NOT run.');
    console.log('!! Ran: 40 Postgres parity checks.');
    console.log('!! Did NOT run: 40 ClickHouse parity checks, 2 schema-idempotence checks,');
    console.log('!!   the storage split (lines in ClickHouse, none in Postgres), the five');
    console.log('!!   HTTP read paths, and 5 ClickHouse tenant-isolation checks.');
    console.log('!! CI supplies ClickHouse, so the gate always runs all 98. Locally:');
    console.log('!!   OPSCAT_CH_URL=http://127.0.0.1:8123 node run-e2e.js logstore\n');
  }
  void before; void chChecks;
  report();
}

main().catch(die);
