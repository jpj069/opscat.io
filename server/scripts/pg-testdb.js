'use strict';
/* One PostgreSQL database per harness run.  (Phase 6)
 *
 * Every harness is hermetic, which means a database of its own — a DATABASE and
 * not a schema: `schema.sql` is unqualified, several harnesses read
 * `information_schema`, and `DROP SCHEMA` leaves sequences and extensions behind
 * in ways that make one harness's residue another's flake. (The hermetic unit
 * used to be a throwaway SQLite file; this is its replacement.)
 *
 * ── Why a template, and not "apply the DDL 21 times" ────────────────────────
 *
 * `CREATE DATABASE x TEMPLATE t` is a file copy inside the data directory —
 * milliseconds, and identical every time. Applying the generated DDL per
 * harness costs ~21× the parse and would put a schema-translation failure in
 * the middle of every harness's output instead of once, up front, where it
 * belongs. The template is built once per run and dropped with everything else.
 *
 * Two Postgres rules shape the code and are easy to get wrong:
 *   • a template may have NO other connection open while it is being copied, so
 *     the connection that built it must be closed first;
 *   • `DROP DATABASE` fails if anything is still attached — a harness that
 *     called process.exit() without ending its pool leaves exactly that. Hence
 *     `WITH (FORCE)` (PostgreSQL 13+), which terminates the stragglers.
 *
 * ── What it is NOT ─────────────────────────────────────────────────────────
 *
 * Not a way to run the suite against a shared database. Every harness seeds an
 * admin, mints keys and asserts counts; sharing one database would make the
 * results depend on the order the runner happens to discover files in.
 */
const { Client } = require('pg');

// The admin connection: a URL pointing at a database we are NOT going to
// create or drop (postgres/template1 by convention). Everything else is
// derived from it, so a harness never needs to know how to build a URL.
const ADMIN = process.env.OPSCAT_PG_ADMIN || process.env.DATABASE_URL || null;

/* Every name carries a PER-RUN suffix, and that is not cosmetic.
 *
 * The template used to be one fixed name per cluster, dropped `WITH (FORCE)` at
 * teardown. Two runs sharing a cluster therefore destroyed each other: the
 * second run's `buildTemplate` force-dropped the first one's template mid-run,
 * killing its connections (`57P01`), and the first run's teardown then dropped
 * the second's. Both agents converting harnesses hit it independently, and one
 * worked around it by starting a whole second PostgreSQL cluster.
 *
 * It has not bitten CI yet only because the Postgres job is currently alone.
 * The moment a second one shares a cluster — a matrix entry, a re-run of a
 * previous commit, two PRs on a self-hosted runner — it becomes a flaky failure
 * that names the template rather than the collision, which is the hardest kind
 * to diagnose from a log.
 *
 * pid + start time is enough: two runs on one machine cannot share a pid at the
 * same instant, and the names are dropped at teardown either way.
 */
const RUN = `${process.pid.toString(36)}${Math.floor(Date.now() / 1000).toString(36).slice(-4)}`;
const TEMPLATE = `opscat_e2e_tpl_${RUN}`;
// Postgres identifiers are 63 bytes and the harness label is short, but a
// pathological filename must not silently produce a truncated collision.
const dbName = (label) => {
  const safe = String(label).toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (safe.length > 30) throw new Error(`harness label too long for a database name: ${label}`);
  return `opscat_e2e_${safe}_${RUN}`;
};

const urlFor = (name) => {
  const u = new URL(ADMIN);
  u.pathname = `/${name}`;
  return u.toString();
};

async function admin(fn) {
  const c = new Client({ connectionString: ADMIN });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

/** Builds the template once. Safe to call again; it rebuilds from scratch. */
async function buildTemplate(ddl) {
  await admin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${TEMPLATE} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${TEMPLATE}`);
  });
  // Applied on its OWN connection, which is then closed — a template with a
  // live connection cannot be copied, and the error Postgres gives for that
  // ("source database is being accessed by other users") names the template
  // rather than the thing that held it open.
  const c = new Client({ connectionString: urlFor(TEMPLATE) });
  await c.connect();
  try { await c.query(ddl); } finally { await c.end(); }
  return TEMPLATE;
}

/** A fresh database for one harness, copied from the template. */
async function create(label) {
  const name = dbName(label);
  await admin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE}`);
  });
  return { name, url: urlFor(name) };
}

/** Drops one. Never throws — cleanup must not turn a green run red. */
async function drop(name) {
  try {
    await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  } catch (e) {
    console.error(`[pg-testdb] could not drop ${name}: ${e.message}`);
  }
}

async function dropTemplate() { await drop(TEMPLATE); }

module.exports = { ADMIN, TEMPLATE, dbName, urlFor, buildTemplate, create, drop, dropTemplate };
