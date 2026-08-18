'use strict';
/* The async storage surface, backed by node-postgres.
 *
 * ── The problem it solves ────────────────────────────────────────────────────
 *
 * Phase 4 converted ~700 call sites from synchronous to awaited. The dominant
 * cost was the conversion; the dominant RISK is that it fails quietly. A missed
 * `await` does not throw — it yields a Promise, and a Promise is an object:
 *
 *     const rows = q.all(sql, a);      // forgot await
 *     rows.length                      // undefined, no error
 *     rows.map(...)                    // TypeError, but only if reached
 *     if (rows.length) { … }           // silently false
 *     JSON.stringify(rows)             // "{}"
 *     rows.filter(r => r.orgId === x)  // a Promise is TRUTHY → keeps everything
 *
 * The last one is the tenant-isolation class (risk #1 in the migration plan).
 *
 * ── Three layers, in order of how much they catch ───────────────────────────
 *
 * 1. TYPES. shim.d.ts declares the async surface; `npm run check:server` runs
 *    tsc --checkJs over server/src. `Property 'map' does not exist on type
 *    Promise<Row[]>` is a build error across all 46 files, without executing
 *    anything.
 *
 * 2. THE STRICT THENABLE, below. Types cannot see dynamic shapes; this Proxy
 *    throws on ANY property access other than then/catch/finally, at the exact
 *    call site. It makes `rows.length`, `JSON.stringify(rows)`,
 *    `for (const r of rows)` and `[...rows]` all throw instead of lying.
 *
 * 3. RUNTIME BACKSTOPS — `NODE_ENV=test` exits non-zero on an unhandled
 *    rejection (src/index.js), and withTx carries its client in
 *    AsyncLocalStorage so a query cannot escape an open transaction onto
 *    another pooled connection, which is a failure that produces no error at
 *    all otherwise.
 *
 * There used to be a fourth, and it is worth recording that it did its job and
 * ended: the shim SHIPPED on better-sqlite3 for all of Phase 4, so a missed
 * await failed in the harnesses with the working synchronous path still there
 * to compare against, and the driver was the only new variable when the adapter
 * landed. SQLite is gone (D6); the sequencing is history, not a live guard.
 *
 * ── The one hole, stated plainly ────────────────────────────────────────────
 *
 * TRUTHINESS. No proxy can trap `if (x)` or `Boolean(x)` — the language does not
 * offer a hook. `rows.filter(() => somePromise)` keeps every row and throws
 * nothing, here or anywhere. That is why the `.filter()` sites were eliminated
 * in Phase 2, BEFORE any await existed. The sequencing was the mitigation; this
 * file is not.
 */
const config = require('../config');
const pg = require('./pg');

// ── the strict thenable ─────────────────────────────────────────────────────
// Anything but awaiting it is a bug, so anything but awaiting it throws.
const PASS_THROUGH = new Set(['then', 'catch', 'finally']);

function strict(promise, what) {
  return new Proxy(promise, {
    get(target, key) {
      if (typeof key === 'string' && PASS_THROUGH.has(key)) {
        const v = target[key];
        return typeof v === 'function' ? v.bind(target) : v;
      }
      // Symbol.toStringTag only, so `Object.prototype.toString` still reports a
      // Promise. NOT Symbol.toPrimitive: `String(rows)` and `` `${rows}` `` go
      // through that one, and a pending query interpolated into a string is a
      // real bug — it would render "[object Promise]" into a log line, an audit
      // detail or a status page. Debuggability is served by the thrown message,
      // which names the statement.
      if (key === Symbol.toStringTag) return 'Promise';
      throw new Error(
        `unawaited DB result: read ${String(key)} on a pending query (${what}). `
        + 'Add the missing await.');
    },
    has(target, key) {
      // `'length' in rows` is the same mistake wearing a different hat
      if (key === Symbol.toStringTag || (typeof key === 'string' && PASS_THROUGH.has(key))) {
        return Reflect.has(target, key);
      }
      throw new Error(`unawaited DB result: tested for ${String(key)} on a pending query (${what})`);
    },
  });
}

const summarise = (sql) => String(sql).replace(/\s+/g, ' ').trim().slice(0, 80);
const summariseCache = new Map();
function labelFor(sql) {
  let s = summariseCache.get(sql);
  if (s === undefined) {
    s = summarise(sql);
    if (summariseCache.size > 2000) summariseCache.clear();
    summariseCache.set(sql, s);
  }
  return s;
}

/* `RETURNING id` rather than `lastInsertRowid`.
 *
 * better-sqlite3 reported a lastInsertRowid, node-postgres does not have one at
 * all, and there are 46 call sites. One statement text works, and there is no
 * dialect branch to get wrong — which is why the three earlier attempts at a
 * hand-written RETURNING conversion were reverted: each left a different subset
 * half-converted.
 *
 * Assumes the primary key is called `id`, which it is everywhere here except
 * users and organizations — and those two mint uuids in JS (util.newId,
 * CLAUDE.md § Identity keys). A table with a differently-named key uses `.get()`
 * with its own RETURNING clause instead.
 */
const withReturningId = (sql) => (/\breturning\b/i.test(sql)
  ? sql
  : `${String(sql).trimEnd().replace(/;$/, '')} RETURNING id`);

/* A `run()` result must not quietly carry lastInsertRowid.
 *
 * node-postgres has no such field, and `undefined` written into a foreign key is
 * a NULL nobody notices until a join comes back empty. So the shim refuses the
 * read outright and says what to use instead, rather than answering `undefined`.
 */
function runResult(r) {
  return Object.defineProperty({ changes: r.changes, rows: r.rows }, 'lastInsertRowid', {
    enumerable: false,
    get() {
      throw new Error('lastInsertRowid is not available through the shim — use stmt.insert(), '
        + 'which uses RETURNING id');
    },
  });
}

if (!config.databaseUrl) {
  throw new Error('DATABASE_URL is required — PostgreSQL is the only engine (see '
    + 'docs/POSTGRES-MIGRATION-PLAN.md, decision D6)');
}
pg.connect(config.databaseUrl);

/* ── Prepared statements ─────────────────────────────────────────────────────
 *
 * `prepare(sql)` returns a handle whose get/all/run are async. It exists so
 * Phase 4 was an `await` insertion rather than a rewrite: the codebase's
 * dominant shape is a module-scope table of statements
 *
 *     const q = { byId: db.prepare('SELECT * FROM cases WHERE id = ?'), … };
 *     const c = await q.byId.get(id);
 *
 * and 766 of those definitions exist. Rewriting each call site to carry its own
 * SQL (`await q.get(BY_ID_SQL, id)`) would have touched the definitions AND the
 * calls, scattered the SQL, and given the renumbering-style bug class a second
 * place to live.
 *
 * The handle is LAZY on purpose: it only remembers the text. Nothing is
 * compiled at module-load time, so requiring a module is not a database
 * dependency and the pool need not be connected yet.
 */
function prepare(sql) {
  const what = labelFor(sql);
  return {
    source: sql,
    get: (...args) => strict(pg.get(sql, ...args), what),
    all: (...args) => strict(pg.all(sql, ...args), what),
    run: (...args) => strict(pg.run(sql, ...args).then(runResult), what),
    /** INSERT returning the new integer id. See withReturningId above. */
    insert: (...args) => strict(
      pg.get(withReturningId(sql), ...args).then((r) => (r ? r.id : undefined)), what),
  };
}

/* Serialise a per-organisation gate.
 *
 * `plans.insertWithinLimit` used to argue that putting the count in the WHERE
 * of the INSERT made it atomic — "one statement, so there is no instant between
 * them for a second request to occupy". That was true on better-sqlite3, which
 * had one writer and serialised statements. **It is false on Postgres.** Under
 * the default READ COMMITTED, a statement's subquery reads a snapshot that does
 * not include rows other in-flight transactions have inserted and not yet
 * committed, so N concurrent requests each count the same N-1 and each write.
 * Measured against a real PostgreSQL 16: seven parallel inserts against a cap of
 * three wrote FOUR rows. One statement is not one isolation unit.
 *
 * That is a paying customer past their plan on the cheap end and, at
 * `routes/synthetics.js`, cloud VMs provisioned past the cap on the expensive
 * end — the customer's bill.
 *
 * It MUST be called inside a transaction — `FOR UPDATE` outside one takes a
 * lock and drops it on the next statement, which looks like it works. (It used
 * to be a no-op on SQLite, where the single writer gave the property for free.
 * With one engine there is no asymmetry left to explain: the lock is the only
 * thing providing it, always.)
 */
async function lockOrg(orgId) {
  if (!pg.inTx()) throw new Error('lockOrg must be called inside withTx — a FOR UPDATE outside a '
    + 'transaction releases immediately and gates nothing.');
  await pg.get('SELECT 1 FROM organizations WHERE id = ? FOR UPDATE', orgId);
}

module.exports = {
  prepare,
  lockOrg,
  withTx: pg.withTx,
  inTx: pg.inTx,
  strict,
  /** Multi-statement DDL (schema.sql, migration files). No parameters. */
  exec: (sql) => pg.exec(sql),
  // The SQL-carrying forms stay for the handful of statements built at runtime
  // (ops.js, status.js, superadmin.js, synthetics.js, mcp/tools.js), where
  // there is no statement to hold onto.
  get: (sql, ...args) => strict(pg.get(sql, ...args), labelFor(sql)),
  all: (sql, ...args) => strict(pg.all(sql, ...args), labelFor(sql)),
  run: (sql, ...args) => strict(pg.run(sql, ...args).then(runResult), labelFor(sql)),
};
