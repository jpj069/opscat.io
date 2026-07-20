'use strict';
// Dead-man's-switch engine: a cron job / backup script pings its heartbeat URL;
// when a heartbeat stays silent past interval + grace, raise ONE
// heartbeat_missed event (re-armed by the next successful ping).
const { db } = require('../db');
const { now } = require('../util');
const pipeline = require('./pipeline');

const getActive = db.prepare('SELECT * FROM heartbeats WHERE enabled = 1');
const markAlerted = db.prepare('UPDATE heartbeats SET alerted_at = ? WHERE id = ?');

function tick() {
  const t = now();
  for (const hb of getActive.all()) {
    const base = hb.last_ping_at || hb.created_at;
    if (t < base + (hb.interval_s + hb.grace_s) * 1000) continue;
    if (hb.alerted_at && hb.alerted_at >= base) continue; // this miss was already reported
    markAlerted.run(t, hb.id);
    const silentMin = Math.round((t - base) / 60000);
    pipeline.ingestEvent({
      name: 'heartbeat_missed', device: hb.name, target: null, severity: 70,
      description: `heartbeat_missed ${hb.name} — no ping for ${silentMin} min (expected every ${hb.interval_s}s)`,
    }, 'heartbeat', false, hb.org_id);
  }
}

function start() {
  const iv = setInterval(tick, 15000);
  iv.unref();
}

module.exports = { start, tick };
