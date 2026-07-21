'use strict';
// Retention + housekeeping: prune old rows, roll up component uptime days,
// mark agents offline, expire stale sessions.
const { db, getOrgSetting } = require('../db');
const config = require('../config');
const { now } = require('../util');
const pipeline = require('./pipeline');

const STATUS_RANK = { operational: 0, maintenance: 1, degraded: 2, partial: 3, major: 4 };

function rollupComponentDay() {
  const day = new Date().toISOString().slice(0, 10);
  const comps = db.prepare('SELECT id, org_id, status FROM components').all();
  const upsert = db.prepare(`INSERT INTO component_days (component_id, day, worst, down_seconds)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(component_id, day) DO UPDATE SET
      worst = CASE WHEN excluded.worst != 'operational' AND
        (CASE component_days.worst WHEN 'operational' THEN 0 WHEN 'maintenance' THEN 1
          WHEN 'degraded' THEN 2 WHEN 'partial' THEN 3 ELSE 4 END) <
        (CASE excluded.worst WHEN 'operational' THEN 0 WHEN 'maintenance' THEN 1
          WHEN 'degraded' THEN 2 WHEN 'partial' THEN 3 ELSE 4 END)
        THEN excluded.worst ELSE component_days.worst END,
      down_seconds = component_days.down_seconds + excluded.down_seconds`);
  for (const c of comps) {
    const degraded = STATUS_RANK[c.status] >= 2; // degraded/partial/major count as downtime
    upsert.run(c.id, day, c.status, degraded ? 60 : 0); // called every minute
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
  db.prepare('DELETE FROM snmp_results WHERE ts < ?').run(t - config.retentionResultsDays * 86400000);
  db.prepare('DELETE FROM event_buckets WHERE bucket < ?').run(Math.floor((t - 7 * 86400000) / 60000));
  db.prepare("DELETE FROM events WHERE status != 'active' AND last_seen < ?").run(t - 90 * 86400000);
  db.prepare('DELETE FROM sessions WHERE last_used_at < ?').run(t - config.sessionIdleMs);
  db.prepare('DELETE FROM notifications WHERE ts < ?').run(t - 90 * 86400000);
  db.prepare('DELETE FROM rule_fires WHERE fired_at < ?').run(t - 7 * 86400000);
  db.prepare('DELETE FROM audit_log WHERE ts < ?').run(t - 180 * 86400000);
}

function start() {
  const minute = setInterval(() => {
    try { rollupComponentDay(); } catch (e) { console.error('rollup error', e.message); }
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

module.exports = { start, prune };
