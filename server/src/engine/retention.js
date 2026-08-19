'use strict';
// Retention + housekeeping: prune old rows, roll up component uptime days,
// mark agents offline, expire stale sessions.
const q = require('../db/shim');
const logs = require('../db/log-store');   // log LINES may not be in `q` — see db/log-store.js
const config = require('../config');
const plans = require('../plans');
const { now } = require('../util');
const pipeline = require('./pipeline');
const { RANK, rankCaseSql } = require('../lib/status-scale');

// Worst-wins upsert for a *_days rollup table — the ordering comes from the
// shared scale so it cannot drift from the rest of the app.
const dayUpsertSql = (table, idCol) => `INSERT INTO ${table} (${idCol}, day, worst, down_seconds)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(${idCol}, day) DO UPDATE SET
      worst = CASE WHEN excluded.worst != 'operational' AND
        ${rankCaseSql(`${table}.worst`)} < ${rankCaseSql('excluded.worst')}
        THEN excluded.worst ELSE ${table}.worst END,
      down_seconds = ${table}.down_seconds + excluded.down_seconds`;

/*
 * How many seconds of downtime one rollup pass credits.
 *
 * It used to be the literal 60, on the reasoning "this runs once a minute". A
 * setInterval callback is not a clock, and `down_seconds` is the NUMERATOR of the
 * uptime percentage on the public status page (routes/status.js, routes/public.js,
 * routes/admin.js) — a bucket that is only ever added to, so a miscount is
 * permanent and no screen ever contradicts it. Two ways the assumption fails, and
 * both arrive with Phase 4 rather than with concurrency: a tick delayed or dropped
 * by a busy event loop credits 60 for a gap of two minutes, understating downtime
 * and OVERSTATING the uptime a customer is shown; and once these functions await,
 * the next interval fires while the previous pass is still running, so two passes
 * credit the same minute twice.
 *
 * Derive it from the wall clock instead: the seconds actually elapsed since the
 * last pass, with the sub-second remainder carried so ordinary interval jitter
 * keeps summing to 60. The upsert adds, and addition commutes, so two passes that
 * finish out of order still total the elapsed time exactly once.
 */
const ROLLUP_PERIOD_S = 60;
// Beyond this the process was suspended, restarted or the clock was stepped —
// we observed nothing over that gap, so credit one period rather than invent an
// outage out of time we were not watching. This is also what the old code did.
const MAX_GAP_MS = 5 * 60 * 1000;
let rollupAnchor = 0; // instant up to which downtime has been credited

function creditSeconds(at) {
  const prev = rollupAnchor;
  const gap = at - prev;
  if (!prev || gap > MAX_GAP_MS) { // first pass of the process, restart, suspend
    rollupAnchor = at;
    return ROLLUP_PERIOD_S;
  }
  if (gap <= 0) { // two passes in the same millisecond, or the clock stepped back
    rollupAnchor = at;
    return 0;
  }
  const secs = Math.floor(gap / 1000);
  rollupAnchor = prev + secs * 1000; // carry the remainder; do not drop it every tick
  return secs;
}

async function rollupComponentDay(downSecs = ROLLUP_PERIOD_S) {
  const day = new Date().toISOString().slice(0, 10);
  const comps = await q.prepare('SELECT id, org_id, status FROM components').all();
  const upsert = q.prepare(dayUpsertSql('component_days', 'component_id'));
  for (const c of comps) {
    const degraded = RANK[c.status] >= RANK.degraded; // degraded/partial/major count as downtime
    await upsert.run(c.id, day, c.status, degraded ? downSecs : 0);
  }
}

// Same rollup for monitored vendors (Radar heatbars): unknown counts as
// operational (no data is not downtime), degraded/partial/major accrue downtime.
async function rollupVendorDay(downSecs = ROLLUP_PERIOD_S) {
  const day = new Date().toISOString().slice(0, 10);
  const vendors = await q.prepare('SELECT id, status FROM vendors WHERE enabled = 1').all();
  const upsert = q.prepare(dayUpsertSql('vendor_days', 'vendor_id'));
  for (const v of vendors) {
    const status = v.status === 'unknown' ? 'operational' : v.status;
    const degraded = RANK[status] >= RANK.degraded;
    await upsert.run(v.id, day, status, degraded ? downSecs : 0);
  }
}

async function markStaleAgents() {
  const cutoff = now() - 5 * 60 * 1000;
  const stale = await q.prepare(
    'SELECT id, org_id, name FROM agents WHERE active = 1 AND last_seen_at IS NOT NULL AND last_seen_at < ?').all(cutoff);
  for (const a of stale) {
    await pipeline.ingestEvent({
      name: 'agent_offline', device: a.name, severity: 68,
      description: `agent_offline ${a.name} (no heartbeat for 5m)`,
    }, 'agents', false, a.org_id);
  }
}

/**
 * Log cleanup, PER ORGANIZATION.
 *
 * It used to read org 1's `retention_logs_days` and then delete across the whole
 * `logs` table — no `org_id` anywhere. On a single-tenant box that is invisible;
 * in the cloud it meant every tenant inherited our own org's setting, a Business
 * customer paying for 90 days kept 7, and the per-plan `retentionDays` was a
 * number the code never read. A tenant changing the field saw it saved and
 * nothing happen.
 *
 * Now each org is pruned with its own effective retention (`plans.retentionDaysFor`
 * — the plan's ceiling, which the org may only shorten). Orgs are counted in
 * dozens, not thousands, and each DELETE is indexed on (org_id, ts).
 *
 * The delete goes through the log store, because the lines may not be in
 * Postgres. On ClickHouse it is a lightweight DELETE, which is applied as an
 * asynchronous mutation — so rows are gone from query results promptly but the
 * disk they occupy is reclaimed on the next merge. That is the right shape for
 * a sweep that runs once a day, and the table also carries a 400-day TTL as the
 * backstop for the case this loop stops running at all (src/clickhouse-schema.sql).
 *
 * What did NOT change: per-org retention stays a plan ceiling enforced here, in
 * one place, for both engines. A table-level TTL cannot express "each tenant may
 * shorten but not raise its own", so moving this into the schema was never an
 * option.
 */
async function pruneLogs(t) {
  for (const { id } of await q.prepare('SELECT id FROM organizations').all()) {
    const days = await plans.retentionDaysFor(id);
    // A broken setting must not silently switch the cleanup off: parseInt('abc')
    // is NaN, `ts < NaN` matches no row, and the table grows unnoticed. The helper
    // already falls back, this is the second line of defence.
    if (!Number.isFinite(days) || days <= 0) continue;
    await logs.purge({ orgId: id, before: t - days * 86400000 });
  }
}

async function prune() {
  const t = now();
  await pruneLogs(t);
  // 48h, not the log retention: these rows only serve the throughput page's peak
  // figure, and keeping a minute-resolution table for a month would be 43k rows per
  // org for a number nobody reads that far back.
  await q.prepare('DELETE FROM ingest_minutes WHERE bucket < ?').run(t - 48 * 3600000);
  await q.prepare('DELETE FROM agent_metrics WHERE ts < ?').run(t - config.retentionMetricsDays * 86400000);
  await q.prepare('DELETE FROM agent_containers WHERE ts < ?').run(t - config.retentionMetricsDays * 86400000);
  await q.prepare('DELETE FROM maintenance_windows WHERE ends_at < ?').run(t - 30 * 86400000);
  await q.prepare('DELETE FROM synthetic_results WHERE ts < ?').run(t - config.retentionResultsDays * 86400000);
  // reputation_runs is a sample table and ages out with the rest of them.
  // reputation_listings deliberately does NOT: an episode of being listed is the
  // evidence a delisting request or a postmaster escalation is argued with, and
  // "how often were we on Spamhaus last year" has to survive longer than a
  // month. It is bounded by nature — one row per (asset, list, episode).
  await q.prepare('DELETE FROM reputation_runs WHERE ts < ?').run(t - config.retentionResultsDays * 86400000);
  await q.prepare('DELETE FROM snmp_results WHERE ts < ?').run(t - config.retentionResultsDays * 86400000);
  await q.prepare('DELETE FROM event_buckets WHERE bucket < ?').run(Math.floor((t - 7 * 86400000) / 60000));
  await q.prepare("DELETE FROM events WHERE status != 'active' AND last_seen < ?").run(t - 90 * 86400000);
  await q.prepare('DELETE FROM sessions WHERE last_used_at < ?').run(t - config.sessionIdleMs);
  await q.prepare('DELETE FROM notifications WHERE ts < ?').run(t - 90 * 86400000);
  await q.prepare('DELETE FROM rule_fires WHERE fired_at < ?').run(t - 7 * 86400000);
  await q.prepare('DELETE FROM automation_fires WHERE fired_at < ?').run(t - 7 * 86400000);
  // Scout: stale pending templates age out; dismissed ones are kept longer so
  // recurring noise stays remembered (and never re-suggested)
  await q.prepare("DELETE FROM scout_templates WHERE status = 'pending' AND last_seen < ?").run(t - 14 * 86400000);
  await q.prepare("DELETE FROM scout_templates WHERE status = 'dismissed' AND last_seen < ?").run(t - 90 * 86400000);
  await q.prepare('DELETE FROM vendor_incidents WHERE resolved_at IS NOT NULL AND resolved_at < ?')
    .run(t - 90 * 86400000);
  await q.prepare('DELETE FROM status_reports WHERE ts < ?').run(t - 30 * 86400000);
  await q.prepare('DELETE FROM vendor_reports WHERE ts < ?').run(t - 30 * 86400000);
  // `date('now', '-100 days')` was a SQLite function with no Postgres twin, and
  // it also made the cutoff untestable — `now` is whatever the database thinks.
  // Computed here and bound, it is portable and pinnable.
  const cutoff = new Date(Date.now() - 100 * 86400000).toISOString().slice(0, 10);
  await q.prepare('DELETE FROM vendor_days WHERE day < ?').run(cutoff);
  await q.prepare('DELETE FROM audit_log WHERE ts < ?').run(t - 180 * 86400000);
  // On-Call. `alert_attempts` is a record of who was woken at 03:00 — personal
  // data, not telemetry (docs/ONCALL-V1.md §7) — and it cascades from `alerts`,
  // so pruning the parent is what actually removes it. Only ENDED alerts age
  // out: an `active` one is still ringing whatever its age, and a chain that
  // deleted itself out from under its own timers would leave the timers firing
  // into nothing. Expired ack tokens go the moment they are useless.
  await q.prepare('DELETE FROM alerts WHERE ended_at IS NOT NULL AND ended_at < ?').run(t - 180 * 86400000);
  await q.prepare('DELETE FROM alert_tokens WHERE expires_at < ?').run(t - 86400000);
  await q.prepare('DELETE FROM ingest_stats WHERE bucket < ?').run(t - 400 * 86400000);
}

function start() {
  // The passes are async now, so an interval callback that merely CALLS one no
  // longer catches its failure: the try/catch returns before the first await
  // resolves and the rejection becomes an unhandledRejection (which NODE_ENV=test
  // turns into a non-zero exit). Each callback is async and awaits inside its own
  // try/catch, so it still logs exactly what it logged before and never rejects.
  const minute = setInterval(async () => {
    // ONE credit per pass, shared: the two rollups are two views of the same
    // elapsed minute, so the second must not advance the clock a second time.
    const secs = creditSeconds(now());
    try { await rollupComponentDay(secs); } catch (e) { console.error('rollup error', e.message); }
    try { await rollupVendorDay(secs); } catch (e) { console.error('vendor rollup error', e.message); }
  }, 60 * 1000);
  minute.unref();
  const fiveMin = setInterval(async () => {
    try { await markStaleAgents(); } catch (e) { console.error('stale agent check error', e.message); }
  }, 5 * 60 * 1000);
  fiveMin.unref();
  const hourly = setInterval(async () => {
    try { await prune(); } catch (e) { console.error('retention error', e.message); }
  }, 60 * 60 * 1000);
  hourly.unref();
  prune().catch((e) => console.error('retention error', e.message));
}

module.exports = { start, prune, pruneLogs, rollupVendorDay };
