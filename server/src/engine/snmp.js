'use strict';
// SNMP poller (v2c + v3): polls each enabled target on its interval for
// sysUpTime, sysName + any custom OIDs. Unreachable targets raise pipeline events.
const snmp = require('net-snmp');
const { db } = require('../db');
const config = require('../config');
const { now, decrypt } = require('../util');
const pipeline = require('./pipeline');

const BASE_OIDS = [
  { oid: '1.3.6.1.2.1.1.3.0', label: 'sysUpTime' },
  { oid: '1.3.6.1.2.1.1.5.0', label: 'sysName' },
];

const getTargets = db.prepare('SELECT * FROM snmp_targets WHERE enabled = 1');
const insResult = db.prepare(`INSERT INTO snmp_results (target_id, ts, oid, value) VALUES (?, ?, ?, ?)
  ON CONFLICT(target_id, oid, ts) DO UPDATE SET value = excluded.value`);
const setStatus = db.prepare('UPDATE snmp_targets SET last_status = ?, last_seen_at = ? WHERE id = ?');

// Build a session for the target's SNMP version; throws on bad credentials.
function openSession(target) {
  const opts = { port: target.port || 161, timeout: 3000, retries: 1 };
  if (target.version === '3') {
    const level = { noAuthNoPriv: snmp.SecurityLevel.noAuthNoPriv,
      authNoPriv: snmp.SecurityLevel.authNoPriv, authPriv: snmp.SecurityLevel.authPriv }[target.v3_level];
    if (!target.v3_user || level === undefined) throw new Error('bad v3 credentials');
    const user = { name: target.v3_user, level };
    if (level !== snmp.SecurityLevel.noAuthNoPriv) {
      user.authProtocol = target.v3_auth_protocol === 'sha' ? snmp.AuthProtocols.sha : snmp.AuthProtocols.md5;
      user.authKey = decrypt(target.v3_auth_key_enc, config.secret);
    }
    if (level === snmp.SecurityLevel.authPriv) {
      user.privProtocol = target.v3_priv_protocol === 'aes' ? snmp.PrivProtocols.aes : snmp.PrivProtocols.des;
      user.privKey = decrypt(target.v3_priv_key_enc, config.secret);
    }
    return snmp.createV3Session(target.host, user, opts);
  }
  const community = decrypt(target.community_enc, config.secret);
  return snmp.createSession(target.host, community, { ...opts, version: snmp.Version2c });
}

function pollTarget(target) {
  return new Promise((resolve) => {
    let custom = [];
    try { custom = JSON.parse(target.oids || '[]'); } catch { /* noop */ }
    const oids = [...BASE_OIDS, ...custom].map((o) => o.oid).slice(0, 50);

    let session;
    try { session = openSession(target); }
    catch (e) { setStatus.run(`bad credentials (${String(e.message).slice(0, 60)})`, now(), target.id); return resolve(); }
    session.get(oids, (error, varbinds) => {
      const t = now();
      if (error) {
        setStatus.run('unreachable', t, target.id);
        pipeline.ingestEvent({
          name: 'snmp_unreachable', device: target.name, target: target.host, severity: 75,
          description: `snmp_unreachable ${target.host} (${String(error.message).slice(0, 80)})`,
        }, 'snmp', false, target.org_id);
      } else {
        const minute = Math.floor(t / 60000) * 60000;
        for (const vb of varbinds) {
          if (snmp.isVarbindError(vb)) continue;
          insResult.run(target.id, minute, vb.oid, String(vb.value).slice(0, 500));
        }
        setStatus.run('ok', t, target.id);
      }
      session.close();
      resolve();
    });
  });
}

const lastRun = new Map();

function tick() {
  const t = now();
  for (const target of getTargets.all()) {
    const last = lastRun.get(target.id) || 0;
    if (t - last < target.interval_s * 1000) continue;
    lastRun.set(target.id, t);
    pollTarget(target).catch((e) => console.error('snmp poll error', e.message));
  }
}

function start() {
  const iv = setInterval(tick, 5000);
  iv.unref();
}

module.exports = { start, pollTarget };
