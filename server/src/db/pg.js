'use strict';
/* The PostgreSQL backend for the storage shim.
 *
 * Same surface as src/db/shim.js — get/all/run/withTx — so Phase 4's converted
 * call sites do not change when the driver does. This file is the ONLY place
 * that knows the app is talking to Postgres. The placeholder rewriting lives
 * next door in pg-sql.js, which has no dependencies and is fuzz-tested by
 * e2e-pgsql.js on every run of the ordinary suite.
 *
 * ── The type parsers are not a detail ───────────────────────────────────────
 *
 * node-postgres returns int8 (OID 20) and numeric (OID 1700) as STRINGS, to
 * avoid silently losing precision above 2^53. That default is correct in
 * general and catastrophic here, because every COUNT(*) in this codebase is an
 * int8:
 *
 *     db.js       COUNT(*) === 0        becomes '0' === 0   -> false
 *                 → a fresh install seeds NO organisation, then no admin, no
 *                   components, no default alert rule. Every seed guard reads
 *                   the same way, and each one fails by doing nothing.
 *     plans.js    used + 1 > limit      becomes '3' + 1 = '31'  -> quota refused
 *     ops.js      mttr / resolution rate become string concatenation
 *
 * Every one of those is a 200 OK with wrong data — no throw, no log line. The
 * largest realistic value in this schema is a byte counter, orders of magnitude
 * below 2^53, so parsing them as numbers is safe here. Registered BEFORE the
 * pool exists, because a parser registered afterwards does not apply to
 * connections already open.
 */
const { Pool, types } = require('pg');
const { AsyncLocalStorage } = require('async_hooks');
const { rewritePlaceholders, bindArgs } = require('./pg-sql');

// ── type parsers, before any pool exists ────────────────────────────────────
const OID_INT8 = 20;
const OID_NUMERIC = 1700;
types.setTypeParser(OID_INT8, (v) => (v === null ? null : Number(v)));
types.setTypeParser(OID_NUMERIC, (v) => (v === null ? null : Number(v)));

// The rewrite is pure and the same ~773 statements run over and over, so it is
// worth caching — but an unbounded Map keyed by SQL text is a leak the moment a
// runtime-BUILT statement varies (ops.js interpolates a column list). Cap it.
const CACHE_MAX = 2000;
const cache = new Map();
function compile(sql) {
  let hit = cache.get(sql);
  if (!hit) {
    hit = rewritePlaceholders(sql);
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(sql, hit);
  }
  return hit;
}

// ── error mapping ───────────────────────────────────────────────────────────
// routes/vendors.js detects a duplicate with String(e.message).includes('UNIQUE'),
// which is better-sqlite3's wording. Under pg that 409 would become an unhandled
// 500. The adapter tags the error instead of every call site learning SQLSTATE.
const PG_UNIQUE_VIOLATION = '23505';
function tag(e) {
  if (e && e.code === PG_UNIQUE_VIOLATION) {
    e.isUniqueViolation = true;
    // Keep the substring the existing handlers look for, so a call site that
    // has not been converted yet still behaves. Case-SENSITIVE on purpose:
    // pg's own wording is "duplicate key value violates unique constraint",
    // lowercase, and `routes/vendors.js` matches `includes('UNIQUE')`. A
    // case-insensitive guard here reads pg's own message as already having the
    // marker and prefixes nothing — the 409 becomes a 500, and the test that
    // caught it is scripts/pg-adapter-check.js.
    if (!e.message.includes('UNIQUE')) e.message = `UNIQUE constraint failed: ${e.message}`;
  }
  return e;
}

// ── the pool, and the transaction-pinned client ─────────────────────────────
const als = new AsyncLocalStorage();
let pool = null;

function connect(connectionString, opts = {}) {
  if (pool) return pool;
  pool = new Pool({
    connectionString,
    // Sized for ONE app instance (decision D5). More instances need this
    // revisited together with leader election, not on its own.
    max: opts.max || 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  // A pool error with no listener is an uncaught exception that kills the
  // process — and a backend restart raises exactly that on every idle client.
  pool.on('error', (e) => console.error('[pg] idle client error:', e.message));
  return pool;
}

async function close() {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}

const runner = () => als.getStore() || pool;

async function query(sql, args) {
  const { text, names } = compile(sql);
  try {
    return await runner().query({ text, values: bindArgs(names, args) });
  } catch (e) {
    throw tag(e);
  }
}

/* Multi-statement DDL, on the SIMPLE query protocol.
 *
 * `schema.sql` and every migration file are many statements in one string, and
 * the extended protocol `query()` above uses accepts exactly one. It also takes
 * no parameters, so the placeholder rewriting is bypassed on purpose rather
 * than by accident: a `?` inside a DDL comment or a CHECK constraint is not a
 * bind marker, and rewriting it would corrupt the schema silently.
 */
async function exec(sql) {
  try {
    await runner().query(sql);
  } catch (e) {
    throw tag(e);
  }
}

async function all(sql, ...args) { return (await query(sql, args)).rows; }
async function get(sql, ...args) { return (await query(sql, args)).rows[0]; }
async function run(sql, ...args) {
  const r = await query(sql, args);
  // `changes` is what every Phase 2 at-most-once gate decides on, so it has to
  // mean exactly what it means on better-sqlite3: rows actually affected.
  return { changes: r.rowCount, rows: r.rows };
}

/* A transaction pins ONE client for its whole body, carried in
 * AsyncLocalStorage. This is the risk the plan ranks #3: with a pool and no
 * pinning, BEGIN goes to one connection and the writes to others. Every
 * statement succeeds, no error is ever raised, and the ROLLBACK covers nothing.
 */
async function withTx(fn) {
  if (als.getStore()) return fn();          // join the open transaction
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await als.run(client, fn);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw tag(e);
  } finally {
    client.release();
  }
}

module.exports = { connect, close, exec, all, get, run, withTx, tag, inTx: () => als.getStore() || null };
