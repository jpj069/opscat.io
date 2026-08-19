'use strict';
/**
 * A small ClickHouse client over its HTTP interface.
 *
 * WHY NOT `@clickhouse/client`. This repository ships eight runtime
 * dependencies, the SDK and the agent are dependency-free on purpose, and the
 * surface we actually need is three verbs: run a statement, read rows, insert
 * rows. ClickHouse's HTTP interface gives all three with a POST, including
 * SERVER-SIDE parameter binding — so the argument that usually settles this
 * ("hand-rolled clients end up interpolating strings") does not apply. What a
 * driver would add here is connection pooling we do not need (HTTP keep-alive
 * covers it) and a compression path we can turn on with a header.
 *
 * PARAMETERS ARE BOUND, NEVER INTERPOLATED. `query({a: 1})` sends `param_a=1`
 * and the statement says `{a:Int64}`; ClickHouse parses the value against the
 * declared type on its side. There is no code path in this file that pastes a
 * caller's value into SQL, and there must never be one — the log-search term is
 * user input on the hottest read path in the product.
 *
 * PLAIN `fetch`, NOT `safeFetch`. The SSRF guard exists for URLs a USER can
 * type (alert webhooks, synthetic checks, vendor feeds). `CLICKHOUSE_URL` comes
 * from the environment, is set by whoever runs the server, and is *supposed* to
 * point at a private address — the compose sidecar. Routing it through
 * `assertPublicHost` would refuse the only configuration that works.
 */

const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

const DEFAULT_TIMEOUT_MS = 30000;

/* Read timeouts and write timeouts are not the same question. A log search that
 * takes 30s is broken and should be abandoned; an INSERT that takes 30s under a
 * merge storm is slow but still worth finishing, because abandoning it loses
 * the lines. Kept separate so neither gets tuned into the other by accident. */
const INSERT_TIMEOUT_MS = 60000;

class ClickHouseError extends Error {
  constructor(message, { status = 0, code = null, query = null } = {}) {
    super(message);
    this.name = 'ClickHouseError';
    this.status = status;
    this.code = code;
    this.query = query;
  }
}

/* ClickHouse reports its error class in the body as `Code: 60. DB::Exception:`.
 * Pulling the number out means callers can branch on it (60 = unknown table)
 * without matching on prose that changes between versions. */
function parseCode(body) {
  const m = /^Code:\s*(\d+)/m.exec(body || '');
  return m ? Number(m[1]) : null;
}

/* The body of a failed request carries the statement it failed on, and the
 * statement carries the user's search term. That is fine in a thrown Error the
 * request handler turns into a 500, and NOT fine in a log line — so the message
 * is truncated hard and the query is kept on the error object, where a caller
 * has to ask for it. Same reasoning as the `req.user` column list in
 * security.js: the way data reaches a log is by being convenient. */
function errorMessage(body) {
  const first = String(body || '').split('\n')[0];
  return first.length > 300 ? `${first.slice(0, 300)}…` : first || 'clickhouse request failed';
}

class ClickHouse {
  /**
   * @param {object} opts
   * @param {string} opts.url   base URL, e.g. http://clickhouse:8123
   * @param {string} [opts.database]
   * @param {string} [opts.user]
   * @param {string} [opts.password]
   */
  constructor({ url, database = 'opscat', user = 'default', password = '' }) {
    this.url = String(url).replace(/\/+$/, '');
    this.database = database;
    this.user = user;
    this.password = password;
  }

  /** Headers carry the credential; the URL never does, so it stays loggable. */
  #headers(extra = {}) {
    const h = {
      'X-ClickHouse-User': this.user,
      'X-ClickHouse-Database': this.database,
      ...extra,
    };
    if (this.password) h['X-ClickHouse-Key'] = this.password;
    return h;
  }

  async #post(search, body, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, sqlForError = null } = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(`${this.url}/?${search}`, {
        method: 'POST', body, signal: ac.signal, headers: this.#headers(headers),
      });
    } catch (e) {
      if (e.name === 'AbortError') {
        throw new ClickHouseError(`clickhouse timed out after ${timeoutMs}ms`, { query: sqlForError });
      }
      throw new ClickHouseError(`clickhouse unreachable: ${e.message}`, { query: sqlForError });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new ClickHouseError(errorMessage(text), {
        status: res.status, code: parseCode(text), query: sqlForError,
      });
    }
    return text;
  }

  /**
   * Run a statement that returns no rows (DDL, INSERT … SELECT, DELETE).
   * @param {string} sql
   * @param {Record<string, string|number|null>} [params]
   */
  async exec(sql, params = {}) {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) search.set(`param_${k}`, v === null ? '\\N' : String(v));
    await this.#post(search.toString(), sql, { sqlForError: sql });
  }

  /**
   * Run a SELECT and return its rows as objects.
   *
   * `JSONEachRow` rather than `JSON`: one object per line, no envelope to parse
   * and no `meta` block to skip. Int64 comes back as a STRING in ClickHouse's
   * JSON output (it does not fit a double), so any caller reading `ts` or a
   * count gets a string unless it is converted — `numeric` names the columns to
   * coerce, which is explicit at the call site instead of a guess in here.
   *
   * @param {string} sql
   * @param {Record<string, string|number|null>} [params]
   * @param {{numeric?: string[]}} [opts]
   * @returns {Promise<object[]>}
   */
  async query(sql, params = {}, { numeric = [] } = {}) {
    const search = new URLSearchParams({ default_format: 'JSONEachRow' });
    for (const [k, v] of Object.entries(params)) search.set(`param_${k}`, v === null ? '\\N' : String(v));
    const text = await this.#post(search.toString(), sql, { sqlForError: sql });
    const rows = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      const row = JSON.parse(line);
      for (const c of numeric) if (row[c] !== undefined && row[c] !== null) row[c] = Number(row[c]);
      rows.push(row);
    }
    return rows;
  }

  /** The single-row convenience `query` callers kept writing by hand. */
  async get(sql, params = {}, opts = {}) {
    const rows = await this.query(sql, params, opts);
    return rows.length ? rows[0] : null;
  }

  /**
   * Insert rows.
   *
   * `FORMAT JSONEachRow` with the rows in the BODY, not as bound parameters:
   * an insert of 500 log lines would otherwise be 3,500 query-string
   * parameters, and ClickHouse's own guidance is that the body is the insert
   * path. It also means the batch size is bounded by bytes rather than by a
   * parameter ceiling, so `pipeline.js`'s LOG_BATCH chunking exists for
   * Postgres's limit and not for this one.
   *
   * @param {string} table
   * @param {object[]} rows
   */
  async insert(table, rows) {
    if (!rows.length) return;
    const body = rows.map((r) => JSON.stringify(r)).join('\n');
    const search = new URLSearchParams({ query: `INSERT INTO ${table} FORMAT JSONEachRow` });
    await this.#post(search.toString(), body, {
      timeoutMs: INSERT_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/x-ndjson' },
      sqlForError: `INSERT INTO ${table}`,
    });
  }

  /**
   * Is the server there and is our database present?
   *
   * Deliberately not a plain `SELECT 1`: that succeeds against a server whose
   * database was never created, which is the state a fresh volume is in, and
   * answering "healthy" there would send every read into a table that does not
   * exist.
   */
  async ping() {
    await this.query('SELECT 1 AS ok AND currentDatabase() != \'\' AS db');
    return true;
  }
}

/**
 * The process-wide client, or null when ClickHouse is not configured.
 *
 * Null is a supported state, not a failure: the community edition runs without
 * ClickHouse and serves logs from Postgres (see db/log-store.js). Callers must
 * therefore never reach for this directly — go through the log store, which is
 * the only place allowed to know which of the two is answering.
 */
let client = null;
function get() {
  if (client) return client;
  if (!config.clickhouseUrl) return null;
  client = new ClickHouse({
    url: config.clickhouseUrl,
    database: config.clickhouseDatabase,
    user: config.clickhouseUser,
    password: config.clickhousePassword,
  });
  return client;
}

/** Test seam: `e2e-logstore` points the module at a throwaway database. */
function _setClientForTests(c) { client = c; }

/**
 * Apply `clickhouse-schema.sql`, idempotently, on every boot.
 *
 * Same contract as `db.init()` and `schema.sql`: the file that is reviewed is
 * the file that runs, there is no provisioning step to remember, and every
 * statement in it must tolerate being applied to a database that already has
 * it. `e2e-logstore.js` applies the file TWICE for exactly that reason.
 *
 * The database itself is created FIRST and with a client that does not name it:
 * `X-ClickHouse-Database: opscat` against a server where `opscat` does not
 * exist is an error, so a fresh volume could never bootstrap itself.
 *
 * @param {ClickHouse} [c] client to use; defaults to the process-wide one
 * @returns {Promise<boolean>} false when ClickHouse is not configured
 */
async function init(c = get()) {
  if (!c) return false;
  const bootstrap = new ClickHouse({
    url: c.url, database: 'default', user: c.user, password: c.password,
  });
  await bootstrap.exec(`CREATE DATABASE IF NOT EXISTS \`${c.database.replace(/`/g, '')}\``);

  const file = fs.readFileSync(path.join(__dirname, '..', 'clickhouse-schema.sql'), 'utf8');
  /* Split on a line that is only a semicolon, not on every `;` — the file has
   * semicolons inside comments, and cutting a statement in half there would
   * fail in a way that reads like a syntax error in the DDL. */
  for (const stmt of file.split(/\n\s*;\s*\n/)) {
    const sql = stmt.replace(/^\s*--.*$/gm, '').trim();
    if (sql) await c.exec(sql);
  }
  return true;
}

module.exports = { ClickHouse, ClickHouseError, get, init, _setClientForTests };
