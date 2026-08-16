'use strict';
// Retention + housekeeping: prune old rows, roll up component uptime days,
// mark agents offline, expire stale sessions.
const { db } = require('../db');
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

function rollupComponentDay() {
  const day = new Date().toISOString().slice(0, 10);
  const comps = db.prepare('SELECT id, org_id, status FROM components').all();
  const upsert = db.prepare(dayUpsertSql('component_days', 'component_id'));
  for (const c of comps) {
    const degraded = RANK[c.status] >= RANK.degraded; // degraded/partial/major count as downtime
    upsert.run(c.id, day, c.status, degraded ? 60 : 0); // called every minute
  }
}

// Same rollup for monitored vendors (Radar heatbars): unknown counts as
// operational (no data is not downtime), degraded/partial/major accrue downtime.
function rollupVendorDay() {
  const day = new Date().toISOString().slice(0, 10);
  const vendors = db.prepare('SELECT id, status FROM vendors WHERE enabled = 1').all();
  const upsert = db.prepare(dayUpsertSql('vendor_days', 'vendor_id'));
  for (const v of vendors) {
    const status = v.status === 'unknown' ? 'operational' : v.status;
    const degraded = RANK[status] >= RANK.degraded;
    upsert.run(v.id, day, status, degraded ? 60 : 0);
  }
}

function markStaleAgents() {
  const cutoff = now() - 5 * 60 * 1000;
  const stale = db.prepare(
    'SELECT id, org_id, name FROM agents WHERE active = 1 AND last_seen_at IS NOT NULL AND last_seen_at < ?').all(cutoff);
  for (const a of stale) {
    pipeline.ingestEvent({
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
 */
function pruneLogs(t) {
  for (const { id } of db.prepare('SELECT id FROM organizations').all()) {
    const days = plans.retentionDaysFor(id);
    // A broken setting must not silently switch the cleanup off: parseInt('abc')
    // is NaN, `ts < NaN` matches no row, and the table grows unnoticed. The helper
    // already falls back, this is the second line of defence.
    if (!Number.isFinite(days) || days <= 0) continue;
    db.prepare('DELETE FROM logs WHERE org_id = ? AND ts < ?').run(id, t - days * 86400000);
  }
}

function prune() {
  const t = now();
  pruneLogs(t);
  // 48h, not the log retention: these rows only serve the throughput page's peak
  // figure, and keeping a minute-resolution table for a month would be 43k rows per
  // org for a number nobody reads that far back.
  db.prepare('DELETE FROM ingest_minutes WHERE bucket < ?').run(t - 48 * 3600000);
  db.prepare('DELETE FROM agent_metrics WHERE ts < ?').run(t - config.retentionMetricsDays * 86400000);
  db.prepare('DELETE FROM agent_containers WHERE ts < ?').run(t - config.retentionMetricsDays * 86400000);
  db.prepare('DELETE FROM maintenance_windows WHERE ends_at < ?').run(t - 30 * 86400000);
  db.prepare('DELETE FROM synthetic_results WHERE ts < ?').run(t - config.retentionResultsDays * 86400000);
  // reputation_runs is a sample table and ages out with the rest of them.
  // reputation_listings deliberately does NOT: an episode of being listed is the
  // evidence a delisting request or a postmaster escalation is argued with, and
  // "how often were we on Spamhaus last year" has to survive longer than a
  // month. It is bounded by nature — one row per (asset, list, episode).
  db.prepare('DELETE FROM reputation_runs WHERE ts < ?').run(t - config.retentionResultsDays * 86400000);
  db.prepare('DELETE FROM snmp_results WHERE ts < ?').run(t - config.retentionResultsDays * 86400000);
  db.prepare('DELETE FROM event_buckets WHERE bucket < ?').run(Math.floor((t - 7 * 86400000) / 60000));
  db.prepare("DELETE FROM events WHERE status != 'active' AND last_seen < ?").run(t - 90 * 86400000);
  db.prepare('DELETE FROM sessions WHERE last_used_at < ?').run(t - config.sessionIdleMs);
  db.prepare('DELETE FROM notifications WHERE ts < ?').run(t - 90 * 86400000);
  db.prepare('DELETE FROM rule_fires WHERE fired_at < ?').run(t - 7 * 86400000);
  db.prepare('DELETE FROM automation_fires WHERE fired_at < ?').run(t - 7 * 86400000);
  // Scout: stale pending templates age out; dismissed ones are kept longer so
  // recurring noise stays remembered (and never re-suggested)
  db.prepare("DELETE FROM scout_templates WHERE status = 'pending' AND last_seen < ?").run(t - 14 * 86400000);
  db.prepare("DELETE FROM scout_templates WHERE status = 'dismissed' AND last_seen < ?").run(t - 90 * 86400000);
  db.prepare('DELETE FROM vendor_incidents WHERE resolved_at IS NOT NULL AND resolved_at < ?')
    .run(t - 90 * 86400000);
  db.prepare('DELETE FROM status_reports WHERE ts < ?').run(t - 30 * 86400000);
  db.prepare('DELETE FROM vendor_reports WHERE ts < ?').run(t - 30 * 86400000);
  db.prepare("DELETE FROM vendor_days WHERE day < date('now', '-100 days')").run();
  db.prepare('DELETE FROM audit_log WHERE ts < ?').run(t - 180 * 86400000);
  db.prepare('DELETE FROM ingest_stats WHERE bucket < ?').run(t - 400 * 86400000);
}

function start() {
  const minute = setInterval(() => {
    try { rollupComponentDay(); } catch (e) { console.error('rollup error', e.message); }
    try { rollupVendorDay(); } catch (e) { console.error('vendor rollup error', e.message); }
  }, 60 * 1000);
  minute.unref();
  const fiveMin = setInterval(() => {
    try { markStaleAgents(); } catch (e) { console.error('stale agent check error', e.message); }
  }, 5 * 60 * 1000);
  fiveMin.unref();
  const hourly = setInterval(() => {
    try { prune(); } catch (e) { console.error('retention error', e.message); }
  }, 60 * 60 * 1000);
  hourly.unref();
  try { prune(); } catch (e) { console.error('retention error', e.message); }
}

module.exports = { start, prune, pruneLogs, rollupVendorDay };
