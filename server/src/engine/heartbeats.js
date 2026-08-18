'use strict';
// Dead-man's-switch engine: a cron job / backup script pings its heartbeat URL;
// when a heartbeat stays silent past interval + grace, raise ONE
// heartbeat_missed event (re-armed by the next successful ping).
const q = require('../db/shim');
const { now } = require('../util');
const pipeline = require('./pipeline');

const getActive = q.prepare('SELECT * FROM heartbeats WHERE enabled = 1');
// The whole decision — still silent past interval + grace, and this miss not
// reported yet — lives in the WHERE, evaluated against the row as it is NOW,
// and `changes` says whether this sweep owns the miss. Deciding it in JS from a
// row read a moment earlier breaks in two directions at once:
//   · two sweeps both read alerted_at = NULL and both raise heartbeat_missed
//     for one dead cron job, so the same silent backup pages twice;
//   · a ping that lands between the read and the write re-arms the switch
//     (routes/heartbeat.js sets last_ping_at = now, alerted_at = NULL) and the
//     sweep then writes alerted_at back over it from the pre-ping row — the job
//     is alive, we page for it anyway, and because alerted_at now sits above
//     the ping the NEXT real miss is the one that stays silent.
const claimMiss = q.prepare(`UPDATE heartbeats SET alerted_at = ?
  WHERE id = ? AND enabled = 1
    AND ? >= COALESCE(last_ping_at, created_at) + (interval_s + grace_s) * 1000
    AND (alerted_at IS NULL OR alerted_at < COALESCE(last_ping_at, created_at))`);

async function tick() {
  const t = now();
  for (const hb of await getActive.all()) {
    const base = hb.last_ping_at || hb.created_at;
    // Cheap pre-filter only — it saves an UPDATE per healthy heartbeat every
    // 15s. The claim below re-tests the same condition and is the authority.
    if (t < base + (hb.interval_s + hb.grace_s) * 1000) continue;
    if ((await claimMiss.run(t, hb.id, t)).changes !== 1) continue; // pinged, disabled, or already reported
    const silentMin = Math.round((t - base) / 60000);
    await pipeline.ingestEvent({
      name: 'heartbeat_missed', device: hb.name, target: null, severity: 70,
      description: `heartbeat_missed ${hb.name} — no ping for ${silentMin} min (expected every ${hb.interval_s}s)`,
    }, 'heartbeat', false, hb.org_id);
  }
}

function start() {
  // tick() is async now, so a throw inside it is a rejected promise rather than
  // an exception the timer would surface. Handled here, or NODE_ENV=test exits
  // non-zero on the unhandled rejection and production loses the sweep silently.
  const iv = setInterval(() => {
    tick().catch((e) => console.error('heartbeat sweep error', e.message));
  }, 15000);
  iv.unref();
}

module.exports = { start, tick };
