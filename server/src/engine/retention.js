'use strict';
// Retention + housekeeping: prune old rows, roll up component uptime days,
// mark agents offline, expire stale sessions.
const { db, getOrgSetting } = require('../db');
const config = require('../config');
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

function prune() {
  const t = now();
  // retention days: use the default org's setting as the platform default
  const logDays = parseInt(getOrgSetting(1, 'retention_logs_days', config.retentionLogsDays), 10);
  db.prepare('DELETE FROM logs WHERE ts < ?').run(t - logDays * 86400000);
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

module.exports = { start, prune, rollupVendorDay };
