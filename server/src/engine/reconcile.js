'use strict';
// Orphan sweeper for auto-provisioned sensor nodes (docs/SENSOR-AGENTS.md §4):
// cloud instances tagged opscat-sensor whose opscat-location no longer exists
// are destroyed — a leaked box bills the CUSTOMER's cloud account forever, so
// this is the cost safety net, not a nice-to-have. Also retries teardown of
// nodes marked 'dead'. Runs hourly; every action lands in the audit log via
// the caller-less system entry (user_id NULL is not supported by sec.audit, so
// we log to console + mark rows instead).
const q = require('../db/shim');
const config = require('../config');
const { decrypt } = require('../util');
const providers = require('../providers');

const SWEEP_MS = 60 * 60 * 1000;

async function sweepCredential(cred) {
  const secret = JSON.parse(decrypt(cred.key_enc, config.secret));
  const p = providers.provider(cred.provider);
  /* Regions we EVER provisioned with this credential (AWS lists per region).
   *
   * This used to be `SELECT DISTINCT provider_region FROM sensor_nodes` — live
   * rows — and the comment above it already said "ever", which is the bug in one
   * line. This same function DELETEs node rows (the dead-node retry below, and
   * the stuck-provisioning sweep in sweep()), so the moment the last node in a
   * region went away the region stopped being listed, and an orphan there was
   * never destroyed. A leaked instance bills the customer forever, and the sweep
   * that exists to catch it had quietly stopped looking.
   *
   * `cloud_regions_used` is written on a successful launch and never deleted
   * here. The union with the live rows is not belt-and-braces for its own sake:
   * a node created by an older build, or by a path that forgets to record, still
   * gets swept — the set can only be too big, never too small, and too big costs
   * one extra DescribeInstances. */
  const regions = cred.provider === 'aws'
    ? (await q.prepare(`SELECT region r FROM cloud_regions_used WHERE credential_id = ?
        UNION
        SELECT provider_region r FROM sensor_nodes
        WHERE cloud_credential_id = ? AND provider_region IS NOT NULL`)
      .all(cred.id, cred.id)).map((x) => x.r)
    : [null];
  for (const region of regions) {
    const instances = await p.listInstances(secret, { region });
    for (const inst of instances) {
      // eslint-disable-next-line no-await-in-loop
      const loc = inst.locationId
        ? await q.prepare('SELECT id FROM synthetic_locations WHERE id = ? AND active = 1').get(inst.locationId)
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
  const dead = await q.prepare(`SELECT * FROM sensor_nodes
    WHERE cloud_credential_id = ? AND status = 'dead' AND provider_instance_id IS NOT NULL`).all(cred.id);
  for (const node of dead) {
    try {
      await p.destroyInstance(secret, { region: node.provider_region, providerInstanceId: node.provider_instance_id });
      // eslint-disable-next-line no-await-in-loop
      await q.prepare('DELETE FROM sensor_nodes WHERE id = ?').run(node.id);
      // eslint-disable-next-line no-await-in-loop
      if (node.agent_id) await q.prepare('DELETE FROM agents WHERE id = ?').run(node.agent_id);
      console.log(`[reconcile] retried teardown of dead node ${node.id} ok`);
    } catch { /* keep for next sweep */ }
  }
}

let running = false;
async function sweep() {
  if (running) return;
  running = true;
  try {
    const creds = await q.prepare('SELECT * FROM cloud_credentials').all();
    for (const cred of creds) {
      try { await sweepCredential(cred); }
      catch (e) { console.error(`[reconcile] credential ${cred.id} (${cred.provider}): ${e.message}`); }
    }
    /* Nodes without any instance id and older than an hour never came up — drop
     * them, AND the host-agent registration that was minted with them. A
     * stranded `agents` row is not cosmetic: it is a live agent token for a box
     * that does not exist, sitting in Assets › Agents as a machine that has
     * never checked in. The provision handler cleans both up on a failed
     * createInstance; this is the path for a process that died between the two
     * writes. */
    const stuck = await q.prepare(`SELECT id, agent_id FROM sensor_nodes
      WHERE provider_instance_id IS NULL AND status = 'provisioning' AND created_at < ?`)
      .all(Date.now() - SWEEP_MS);
    for (const node of stuck) {
      // eslint-disable-next-line no-await-in-loop
      await q.prepare('DELETE FROM sensor_nodes WHERE id = ?').run(node.id);
      // eslint-disable-next-line no-await-in-loop
      if (node.agent_id) await q.prepare('DELETE FROM agents WHERE id = ?').run(node.agent_id);
    }
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
