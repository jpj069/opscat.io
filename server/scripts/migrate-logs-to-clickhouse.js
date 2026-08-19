#!/usr/bin/env node
'use strict';
/**
 * One-off: copy existing log lines from PostgreSQL into ClickHouse.
 *
 * Run this ONCE, when an instance switches its log store on. Without it the
 * lines already in `logs` stay in Postgres and simply stop being read — the
 * Logs page starts empty and refills as agents ship, which is survivable
 * (retention is days, not years) but is not what anybody expects from a
 * deploy.
 *
 * WHY THIS IS A SCRIPT AND NOT A MIGRATION. `src/migrations/` is Postgres DDL
 * applied automatically at boot, one way, to every database. This is neither
 * DDL nor automatic: it moves rows between two engines, it is only correct on
 * an instance that is switching over, and running it twice would DUPLICATE
 * every line — ClickHouse's MergeTree has no unique constraint to lean on and
 * `logs` has no natural key (two identical lines a second apart are two
 * lines, not one). So it is deliberately a thing a human runs and reads the
 * output of.
 *
 *   docker compose exec -T app node scripts/migrate-logs-to-clickhouse.js --dry-run
 *   docker compose exec -T app node scripts/migrate-logs-to-clickhouse.js
 *
 * It refuses to run when ClickHouse's `logs` is non-empty unless you pass
 * --force, which is the guard against the second run.
 *
 * DROPPING THE POSTGRES ROWS: pass --drop-source, on this run or a later one.
 * It TRUNCATEs `logs` in PostgreSQL, but only after checking, PER ORGANISATION,
 * that ClickHouse holds at least as many lines inside the same timestamp window.
 * That is a real guard and it is not a proof of identity — it cannot be, short
 * of comparing every row — so it is stated for what it is: enough to catch a
 * copy that half-ran, silently targeted the wrong database, or was never run at
 * all, and not enough to catch a copy that wrote the right number of wrong rows.
 * Look at the Logs page before you pass it.
 *
 * Without the flag nothing is deleted. Retention prunes the orphaned Postgres
 * rows on its own schedule anyway; --drop-source reclaims the space now.
 */

const q = require('../src/db/shim');
const ch = require('../src/db/clickhouse');
const config = require('../src/config');

const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const DROP = process.argv.includes('--drop-source');
/* Rows per INSERT. 10k of typical log lines is a few MB in the request body —
 * large enough that the round trip is not the cost, small enough that a failure
 * costs one batch and not an hour. */
const BATCH = 10000;

function fail(msg) { console.error(`\n${msg}\n`); process.exit(1); }

async function main() {
  if (!config.clickhouseUrl) {
    fail('CLICKHOUSE_URL is not set. Nothing to migrate into — configure the log '
       + 'store first (see docs/ARCHITECTURE.md § Log storage).');
  }
  const client = ch.get();
  await ch.init(client);

  const pgTotal = Number((await q.prepare('SELECT COUNT(*) c FROM logs').get()).c);
  const chBefore = (await client.get('SELECT count() AS c FROM logs', {}, { numeric: ['c'] })).c;

  console.log(`postgres logs: ${pgTotal.toLocaleString()} rows`);
  console.log(`clickhouse logs: ${chBefore.toLocaleString()} rows`);

  if (!pgTotal) { console.log('\nnothing to copy.'); return; }
  /* A LATER run, after the copy has already happened: there is nothing to
   * copy (ClickHouse is non-empty, which is what the guard below refuses on),
   * and the caller only wants the drop. Take that path explicitly rather than
   * making them pass --force, which means something else entirely. */
  if (DROP && chBefore && !FORCE) {
    if (DRY) { console.log('\n--dry-run: would verify per-org counts, then TRUNCATE postgres logs.'); return; }
    await dropSource(client);
    return;
  }
  if (chBefore && !FORCE) {
    fail(`ClickHouse already holds ${chBefore.toLocaleString()} lines. Copying again would\n`
       + 'DUPLICATE them — there is no key to deduplicate on. Pass --force only if you\n'
       + 'are certain those rows came from somewhere else.');
  }
  if (DRY) { console.log(`\n--dry-run: would copy ${pgTotal.toLocaleString()} rows.`); return; }

  /* Paged by id, not by OFFSET. OFFSET re-scans everything it skips, so the last
   * page of a large table costs a full scan; `id > last` uses the primary key
   * and each page costs the same. It also means a batch inserted while this runs
   * is picked up rather than shifting every subsequent page by one. */
  const page = q.prepare(`SELECT id, org_id, ts, device, line, sev, source, meta
    FROM logs WHERE id > ? ORDER BY id LIMIT ${BATCH}`);

  let lastId = 0;
  let copied = 0;
  const t0 = Date.now();
  for (;;) {
    const rows = await page.all(lastId);
    if (!rows.length) break;
    await client.insert('logs', rows.map((r) => ({
      org_id: r.org_id, ts: Number(r.ts), device: r.device, line: r.line,
      sev: Number(r.sev), source: r.source ?? '', meta: r.meta ?? null,
    })));
    lastId = rows[rows.length - 1].id;
    copied += rows.length;
    const pct = ((copied / pgTotal) * 100).toFixed(1);
    process.stdout.write(`\r  copied ${copied.toLocaleString()} / ${pgTotal.toLocaleString()} (${pct}%)`);
  }
  const secs = (Date.now() - t0) / 1000;
  process.stdout.write('\n');

  const chAfter = (await client.get('SELECT count() AS c FROM logs', {}, { numeric: ['c'] })).c;
  console.log(`\ncopied ${copied.toLocaleString()} rows in ${secs.toFixed(1)}s `
    + `(${Math.round(copied / Math.max(secs, 0.001)).toLocaleString()}/s)`);
  console.log(`clickhouse now holds ${chAfter.toLocaleString()} rows`);

  /* Verified by counting, not assumed. A silent short copy is exactly the class
   * of failure this whole migration has been about. */
  if (chAfter - chBefore !== pgTotal) {
    fail(`MISMATCH: expected ${pgTotal.toLocaleString()} new rows, ClickHouse gained `
       + `${(chAfter - chBefore).toLocaleString()}. Do NOT truncate the Postgres table.`);
  }
  console.log('\nrow counts agree.');
  if (DROP) await dropSource(client);
  else {
    console.log('The Postgres rows were NOT deleted. Verify the Logs page, then either');
    console.log('re-run with --drop-source, or leave them for the retention sweep.');
  }
}

/**
 * TRUNCATE the PostgreSQL `logs` table, but only if ClickHouse plausibly has
 * everything it held.
 *
 * The check is per ORGANISATION and inside each org's own timestamp window:
 * ClickHouse must hold at least as many lines between that org's oldest and
 * newest Postgres row as Postgres does. Per-org rather than a single total,
 * because one tenant's data going missing is exactly the failure a global
 * count hides — a busy org's new lines would cover for an empty one.
 *
 * TRUNCATE rather than DELETE: it reclaims the space immediately, which is the
 * entire point of running this, and it takes no row locks to escalate.
 */
async function dropSource(client) {
  const orgs = await q.prepare(`SELECT org_id, COUNT(*) c, MIN(ts) lo, MAX(ts) hi
    FROM logs GROUP BY org_id`).all();
  if (!orgs.length) { console.log('\nnothing to drop.'); return; }

  console.log('\nchecking ClickHouse holds what PostgreSQL is about to lose:');
  let bad = 0;
  for (const o of orgs) {
    const row = await client.get(
      `SELECT count() AS c FROM logs
       WHERE org_id = {org:UUID} AND ts >= {lo:Int64} AND ts <= {hi:Int64}`,
      { org: o.org_id, lo: o.lo, hi: o.hi }, { numeric: ['c'] });
    const ok = row && row.c >= Number(o.c);
    if (!ok) bad++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${o.org_id}  postgres ${Number(o.c).toLocaleString()}`
      + `  clickhouse ${(row ? row.c : 0).toLocaleString()} in the same window`);
  }
  if (bad) {
    fail(`${bad} organisation(s) hold fewer lines in ClickHouse than in PostgreSQL.\n`
       + 'NOTHING WAS DELETED. Copy first (run this script without --drop-source),\n'
       + 'or work out where those lines went before forcing anything.');
  }

  await q.exec('TRUNCATE TABLE logs');
  const left = Number((await q.prepare('SELECT COUNT(*) c FROM logs').get()).c);
  if (left !== 0) fail(`TRUNCATE left ${left} rows — stop and investigate.`);
  console.log('\npostgres `logs` truncated; the space is back.');
  console.log('ClickHouse is now the only copy of the log lines — check your backups say so.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
