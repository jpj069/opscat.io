'use strict';
// Orphan sweeper for auto-provisioned sensor nodes (docs/SENSOR-AGENTS.md §4):
// cloud instances tagged opscat-sensor whose opscat-location no longer exists
// are destroyed — a leaked box bills the CUSTOMER's cloud account forever, so
// this is the cost safety net, not a nice-to-have. Also retries teardown of
// nodes marked 'dead'. Runs hourly; every action lands in the audit log via
// the caller-less system entry (user_id NULL is not supported by sec.audit, so
// we log to console + mark rows instead).
const { db } = require('../db');
const config = require('../config');
const { decrypt } = require('../util');
const providers = require('../providers');

const SWEEP_MS = 60 * 60 * 1000;

async function sweepCredential(cred) {
  const secret = JSON.parse(decrypt(cred.key_enc, config.secret));
  const p = providers.provider(cred.provider);
  // regions we ever provisioned with this credential (AWS lists per region)
  const regions = cred.provider === 'aws'
    ? db.prepare(`SELECT DISTINCT provider_region r FROM sensor_nodes
        WHERE cloud_credential_id = ? AND provider_region IS NOT NULL`).all(cred.id).map((x) => x.r)
    : [null];
  for (const region of regions) {
    const instances = await p.listInstances(secret, { region });
    for (const inst of instances) {
      const loc = inst.locationId
        ? db.prepare('SELECT id FROM synthetic_locations WHERE id = ? AND active = 1').get(inst.locationId)
        : null;
      if (loc) continue; // healthy: instance ↔ active location
      try {
        await p.destroyInstance(secret, { region, providerInstanceId: inst.providerInstanceId });
        console.log(`[reconcile] destroyed orphan ${cred.provider} instance ${inst.providerInstanceId}`
          + ` (location ${inst.locationId ?? 'unknown'} gone)`);
      } catch (e) {
        console.error(`[reconcile] failed to destroy orphan ${inst.providerInstanceId}: ${e.message}`);
      }
    }
  }
  // retry teardown of nodes whose destroy failed at delete time
  const dead = db.prepare(`SELECT * FROM sensor_nodes
    WHERE cloud_credential_id = ? AND status = 'dead' AND provider_instance_id IS NOT NULL`).all(cred.id);
  for (const node of dead) {
    try {
      await p.destroyInstance(secret, { region: node.provider_region, providerInstanceId: node.provider_instance_id });
      db.prepare('DELETE FROM sensor_nodes WHERE id = ?').run(node.id);
      console.log(`[reconcile] retried teardown of dead node ${node.id} ok`);
    } catch { /* keep for next sweep */ }
  }
}

let running = false;
async function sweep() {
  if (running) return;
  running = true;
  try {
    const creds = db.prepare('SELECT * FROM cloud_credentials').all();
    for (const cred of creds) {
      try { await sweepCredential(cred); }
      catch (e) { console.error(`[reconcile] credential ${cred.id} (${cred.provider}): ${e.message}`); }
    }
    // nodes without any instance id and older than an hour never came up — drop them
    db.prepare(`DELETE FROM sensor_nodes WHERE provider_instance_id IS NULL
      AND status = 'provisioning' AND created_at < ?`).run(Date.now() - SWEEP_MS);
  } finally { running = false; }
}

function start() {
  const iv = setInterval(() => { sweep().catch(() => { /* logged inside */ }); }, SWEEP_MS);
  iv.unref();
  // first sweep shortly after boot, once things settled
  const t = setTimeout(() => { sweep().catch(() => { /* logged inside */ }); }, 2 * 60 * 1000);
  t.unref();
}

module.exports = { start, sweep };
