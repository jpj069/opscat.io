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
 * The Postgres rows are NOT deleted. Dropping them is a separate decision with
 * a separate blast radius; once the copy is verified, `TRUNCATE logs` in
 * Postgres reclaims the space and the retention sweep will otherwise do it
 * gradually anyway.
 */

const q = require('../src/db/shim');
const ch = require('../src/db/clickhouse');
const config = require('../src/config');

const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
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
  console.log('\nrow counts agree. The Postgres rows were NOT deleted — verify the Logs page,');
  console.log('then reclaim the space with:  TRUNCATE logs;   (in Postgres)');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
