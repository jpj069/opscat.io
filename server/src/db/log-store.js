'use strict';
/**
 * WHERE LOG LINES LIVE.
 *
 * Raw log lines are the one table in this product that is append-only, never
 * updated, read by scanning, and large. Everything else — events, cases,
 * incidents, users, the whole spine — is transactional and stays in PostgreSQL.
 * So this is the one seam where a second engine earns its place, and it is
 * deliberately ONE seam and not a branch at each of the fourteen call sites.
 *
 * Measured reasons, all in docs/BENCHMARKS.md § 5:
 *   • 22 bytes/row against 301 — 14x less disk, which is what decides how much
 *     retention fits on a small volume.
 *   • Log search over 7 days: 17-25 ms against 435 ms. The throughput chart:
 *     26 ms against 261 ms, and 134 ms against 2,620 ms at ten times the data.
 *   • Production was already OUTSIDE the 250 ms budget on two user-facing
 *     queries at 392,319 rows (§ 5.7.1).
 *
 * TWO IMPLEMENTATIONS, ONE INTERFACE, AND WHY THE SECOND ONE STAYS:
 *
 * ClickHouse is the default in BOTH editions. It was cloud-only for about a
 * day, on the argument that a self-hoster should not be made to pay ~600 MB of
 * resident memory for it — that call was reversed deliberately: the stack goes
 * from ~400 MB to ~750 MB and the numbers are now published rather than
 * avoided, because a self-hosted install with real log volume hits the same
 * 250 ms wall the cloud one did.
 *
 * The Postgres implementation is NOT vestigial and NOT deprecated. Leaving
 * `CLICKHOUSE_URL` empty is a supported configuration, and it is what a box too
 * small for a column store should run — a Pi, a 1 GB VPS, an appliance. It is
 * also what keeps an upgrade from being a cliff: an existing install that has
 * not read the notes gets an explicit error about a missing password, not a
 * silent switch of where its data lives.
 *
 * Two implementations is exactly the situation CLAUDE.md warns about ("a second
 * implementation is how the two drift apart"), and the mitigation is structural
 * rather than hopeful: every caller talks to THIS module, the choice is made
 * once at boot, and `e2e-logstore.js` runs the SAME 40 assertions against both
 * in one process on every pull request. A behaviour that differs fails the
 * build. That is the only reason a second store is affordable at all — remove
 * the parity harness and this paragraph becomes wishful thinking.
 *
 * WHAT THIS MODULE MAY NOT BECOME: a query builder. Each method answers one
 * question the product actually asks. Adding a `where` parameter would move the
 * SQL back out to the call sites and give up the only property that makes two
 * engines survivable.
 */

const q = require('./shim');
const ch = require('./clickhouse');
const config = require('../config');
const { utcDaySql, DAY_MS } = require('../util');

/* ---------------------------------------------------------------- PostgreSQL */

/* The statements are the ones that were inlined at the call sites before this
 * module existed, moved rather than rewritten — so a behaviour change here
 * would be a deliberate edit and not a translation artefact. */
const pgSearch = q.prepare(`SELECT ts, device, line, sev, source FROM logs
  WHERE ts >= ? AND ts <= ? AND org_id = ?
    AND (lower(line) LIKE lower(?) OR lower(device) LIKE lower(?))
  ORDER BY ts DESC LIMIT ?`);
const pgList = q.prepare(`SELECT ts, device, line, sev, source FROM logs
  WHERE ts >= ? AND ts <= ? AND org_id = ? ORDER BY ts DESC LIMIT ?`);
/* The MCP tool filters by an EXACT device as well as by a term, which the web
 * Logs page does not. Two more prepared statements rather than a `where`
 * parameter: a builder here would put SQL back at the call sites, which is the
 * one thing this module exists to prevent. */
const pgSearchDev = q.prepare(`SELECT ts, device, line, sev, source FROM logs
  WHERE ts >= ? AND ts <= ? AND org_id = ? AND device = ?
    AND (lower(line) LIKE lower(?) OR lower(device) LIKE lower(?))
  ORDER BY ts DESC LIMIT ?`);
const pgListDev = q.prepare(`SELECT ts, device, line, sev, source FROM logs
  WHERE ts >= ? AND ts <= ? AND org_id = ? AND device = ? ORDER BY ts DESC LIMIT ?`);
const pgDeviceTail = q.prepare(`SELECT ts, device, line, sev, source FROM logs
  WHERE device = ? AND org_id = ? ORDER BY ts DESC LIMIT ?`);
const pgRecent = q.prepare(`SELECT ts, device, line, sev, source FROM logs
  WHERE org_id = ? AND ts >= ? ORDER BY ts DESC LIMIT ?`);
const pgCountSinceOrg = q.prepare('SELECT COUNT(*) c FROM logs WHERE ts >= ? AND org_id = ?');
const pgCountSinceAll = q.prepare('SELECT COUNT(*) c FROM logs WHERE ts >= ?');
const pgCountForOrg = q.prepare('SELECT COUNT(*) c FROM logs WHERE org_id = ?');
const pgCountByOrg = q.prepare('SELECT org_id, COUNT(*) c FROM logs GROUP BY org_id');
const pgLastSeen = q.prepare('SELECT device, MAX(ts) AS ls FROM logs WHERE org_id = ? GROUP BY device');
const pgDailyBuckets = q.prepare(`SELECT ${utcDaySql('ts')} bucket,
    SUM(CASE WHEN sev <= 2 THEN 1 ELSE 0 END) c,
    SUM(CASE WHEN sev = 3 THEN 1 ELSE 0 END) h,
    SUM(CASE WHEN sev = 4 THEN 1 ELSE 0 END) m,
    SUM(CASE WHEN sev >= 5 THEN 1 ELSE 0 END) l
  FROM logs WHERE ts >= ? AND org_id = ? GROUP BY bucket ORDER BY bucket`);
const pgPurge = q.prepare('DELETE FROM logs WHERE org_id = ? AND ts < ?');

/* Batched for the same reason it always was: an agent posts up to 500 lines and
 * awaited singly that is 500 round trips. 100 rows x 7 columns = 700 bound
 * parameters, well inside Postgres's 65,535. */
const LOG_TUPLE = '(?, ?, ?, ?, ?, ?, ?)';
const PG_BATCH = 100;
const insertSqlCache = new Map();
function pgInsertSql(rows) {
  let sql = insertSqlCache.get(rows);
  if (sql === undefined) {
    sql = `INSERT INTO logs (org_id, ts, device, line, sev, source, meta) VALUES ${
      new Array(rows).fill(LOG_TUPLE).join(', ')}`;
    insertSqlCache.set(rows, sql);
  }
  return sql;
}

const pgStore = {
  kind: 'postgres',
  /* Postgres is the same connection the caller's transaction is on, so a write
   * here joins it — which is why `insert` is safe to call inside `withTx` on
   * this implementation and explicitly is not on the other. */
  transactional: true,

  async insert(rows) {
    for (let i = 0; i < rows.length; i += PG_BATCH) {
      const chunk = rows.slice(i, i + PG_BATCH);
      const args = [];
      for (const r of chunk) args.push(r.orgId, r.ts, r.device, r.line, r.sev, r.source, r.meta);
      await q.run(pgInsertSql(chunk.length), ...args);
    }
  },

  async search({ orgId, since, until, term, device = null, limit }) {
    if (device) {
      return term
        ? pgSearchDev.all(since, until, orgId, device, `%${term}%`, `%${term}%`, limit)
        : pgListDev.all(since, until, orgId, device, limit);
    }
    return term
      ? pgSearch.all(since, until, orgId, `%${term}%`, `%${term}%`, limit)
      : pgList.all(since, until, orgId, limit);
  },
  async deviceTail({ orgId, device, limit }) { return pgDeviceTail.all(device, orgId, limit); },
  async recent({ orgId, since, limit }) { return pgRecent.all(orgId, since, limit); },
  async countSince({ orgId = null, since }) {
    return (orgId ? await pgCountSinceOrg.get(since, orgId) : await pgCountSinceAll.get(since)).c;
  },
  async countForOrg(orgId) { return (await pgCountForOrg.get(orgId)).c; },
  async countByOrg() {
    const out = new Map();
    for (const r of await pgCountByOrg.all()) out.set(String(r.org_id), Number(r.c));
    return out;
  },
  async lastSeenByDevice({ orgId }) { return pgLastSeen.all(orgId); },
  async dailyBuckets({ orgId, since }) { return pgDailyBuckets.all(since, orgId); },
  async purge({ orgId, before }) { await pgPurge.run(orgId, before); },
};

/* ---------------------------------------------------------------- ClickHouse */

/* Every value below is a BOUND parameter (`{name:Type}` + `param_name`), never
 * interpolated — the search term is user input, and this is the read path a
 * customer types into. */

const chStore = {
  kind: 'clickhouse',
  /* ClickHouse has no transaction the Postgres write can join. A caller inside
   * `withTx` must therefore write log lines OUTSIDE it and accept that a crash
   * between the two stores loses lines while keeping the events derived from
   * them. That is a deliberate trade stated in engine/pipeline.js, and this
   * flag is what lets that code know which world it is in rather than guessing
   * from config. */
  transactional: false,

  async insert(rows) {
    await ch.get().insert('logs', rows.map((r) => ({
      org_id: r.orgId, ts: r.ts, device: r.device, line: r.line,
      sev: r.sev, source: r.source ?? '', meta: r.meta ?? null,
    })));
  },

  async search({ orgId, since, until, term, device = null, limit }) {
    /* ILIKE, not `lower(col) LIKE lower(...)`: wrapping the column in a
     * function is what stops any index from being consulted, and ILIKE is the
     * same semantics in one operator.
     *
     * The clause list is assembled from FIXED strings — no caller value ever
     * reaches it. Every value below is a bound parameter. */
    const where = ['ts >= {since:Int64}', 'ts <= {until:Int64}', 'org_id = {org:UUID}'];
    const params = { since, until, org: orgId, limit };
    if (device) { where.push('device = {device:String}'); params.device = device; }
    if (term) {
      where.push('(line ILIKE {term:String} OR device ILIKE {term:String})');
      params.term = `%${term}%`;
    }
    return ch.get().query(
      `SELECT ts, device, line, sev, source FROM logs WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT {limit:UInt32}`,
      params, { numeric: ['ts', 'sev'] });
  },

  async deviceTail({ orgId, device, limit }) {
    return ch.get().query(
      `SELECT ts, device, line, sev, source FROM logs
       WHERE device = {device:String} AND org_id = {org:UUID} ORDER BY ts DESC LIMIT {limit:UInt32}`,
      { device, org: orgId, limit }, { numeric: ['ts', 'sev'] });
  },

  async recent({ orgId, since, limit }) {
    return ch.get().query(
      `SELECT ts, device, line, sev, source FROM logs
       WHERE org_id = {org:UUID} AND ts >= {since:Int64} ORDER BY ts DESC LIMIT {limit:UInt32}`,
      { org: orgId, since, limit }, { numeric: ['ts', 'sev'] });
  },

  async countSince({ orgId = null, since }) {
    const row = await ch.get().get(
      `SELECT COUNT(*) AS c FROM logs WHERE ts >= {since:Int64}${orgId ? ' AND org_id = {org:UUID}' : ''}`,
      orgId ? { since, org: orgId } : { since }, { numeric: ['c'] });
    return row ? row.c : 0;
  },

  async countForOrg(orgId) {
    const row = await ch.get().get('SELECT COUNT(*) AS c FROM logs WHERE org_id = {org:UUID}',
      { org: orgId }, { numeric: ['c'] });
    return row ? row.c : 0;
  },

  async countByOrg() {
    const out = new Map();
    for (const r of await ch.get().query('SELECT org_id, COUNT(*) AS c FROM logs GROUP BY org_id',
      {}, { numeric: ['c'] })) out.set(String(r.org_id), r.c);
    return out;
  },

  async lastSeenByDevice({ orgId }) {
    return ch.get().query('SELECT device, MAX(ts) AS ls FROM logs WHERE org_id = {org:UUID} GROUP BY device',
      { org: orgId }, { numeric: ['ls'] });
  },

  async dailyBuckets({ orgId, since }) {
    /* Integer arithmetic, exactly as in util.js's utcDaySql, and for exactly the
     * same reason: a UTC day IS `ts - ts % 86400000`, so no engine gets an
     * opinion about where a day starts. Using ClickHouse's toStartOfDay here
     * would render in the SERVER's timezone and disagree with Postgres by up to
     * a day — the bug that put `strftime` on the deferral list. */
    return ch.get().query(
      `SELECT ts - ts % ${DAY_MS} AS bucket,
         SUM(sev <= 2) AS c, SUM(sev = 3) AS h, SUM(sev = 4) AS m, SUM(sev >= 5) AS l
       FROM logs WHERE ts >= {since:Int64} AND org_id = {org:UUID}
       GROUP BY bucket ORDER BY bucket`,
      { since, org: orgId }, { numeric: ['bucket', 'c', 'h', 'm', 'l'] });
  },

  async purge({ orgId, before }) {
    /* A lightweight DELETE, which ClickHouse applies as a mutation. The sweep
     * runs daily per org (engine/retention.js), so an asynchronous mutation is
     * the right shape — and the table's own 400-day TTL is the backstop if this
     * ever stops running. */
    await ch.get().exec('DELETE FROM logs WHERE org_id = {org:UUID} AND ts < {before:Int64}',
      { org: orgId, before });
  },
};

/* ------------------------------------------------------------------- select */

let active = null;

/**
 * Which store is answering. Resolved once, at boot, and never per request:
 * a per-request decision is how half a page ends up reading one engine and
 * half the other after a config reload.
 */
function store() {
  if (!active) active = config.clickhouseUrl && ch.get() ? chStore : pgStore;
  return active;
}

/** Test seam — `e2e-logstore.js` drives both implementations in one process. */
function _setStoreForTests(s) { active = s; }

/* EXPLICIT DELEGATION, NOT A PROXY, AND THAT IS THE WHOLE POINT.
 *
 * The first version of this file exported a Proxy that forwarded every unknown
 * property to the active store. It was shorter and it was wrong: TypeScript
 * cannot see through a Proxy, so `npm run check:server` reported
 * "Property 'countByOrg' does not exist" for correct calls and — far worse —
 * would have reported nothing at all for a missed `await`. The type gate is the
 * FIRST of the three guards this codebase relies on (CLAUDE.md § the type gate),
 * and a clever export that blinds it trades the guard for eleven lines.
 *
 * So every method is named here. Adding one to the interface means adding it in
 * three places — both implementations and this list — which is the cost of
 * having the compiler check all fourteen call sites.
 */
module.exports = {
  /** @returns {'postgres'|'clickhouse'} */
  get kind() { return store().kind; },
  /** True when a write joins the caller's Postgres transaction. */
  get transactional() { return store().transactional; },

  /** @param {{orgId:string, ts:number, device:string, line:string, sev:number, source:string, meta:string|null}[]} rows */
  insert: (rows) => store().insert(rows),
  /** @param {{orgId:string, since:number, until:number, term:string, device?:string|null, limit:number}} a */
  search: (a) => store().search(a),
  /** @param {{orgId:string, device:string, limit:number}} a */
  deviceTail: (a) => store().deviceTail(a),
  /** @param {{orgId:string, since:number, limit:number}} a */
  recent: (a) => store().recent(a),
  /** @param {{orgId?:string|null, since:number}} a @returns {Promise<number>} */
  countSince: (a) => store().countSince(a),
  /** @param {string} orgId @returns {Promise<number>} */
  countForOrg: (orgId) => store().countForOrg(orgId),
  /** @returns {Promise<Map<string, number>>} org id -> line count */
  countByOrg: () => store().countByOrg(),
  /** @param {{orgId:string}} a @returns {Promise<{device:string, ls:number}[]>} */
  lastSeenByDevice: (a) => store().lastSeenByDevice(a),
  /** @param {{orgId:string, since:number}} a */
  dailyBuckets: (a) => store().dailyBuckets(a),
  /** @param {{orgId:string, before:number}} a */
  purge: (a) => store().purge(a),

  pgStore, chStore, store, _setStoreForTests,
};
