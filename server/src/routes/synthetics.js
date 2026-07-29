'use strict';
// Session-authenticated synthetics API for the UI: sensor-agent locations
// (self-hosted, BYO-cloud, managed bookings), cloud credentials, checks and
// results. Concept: docs/SENSOR-AGENTS.md.
const express = require('express');
const crypto = require('crypto');
const { db } = require('../db');
const config = require('../config');
const { now, sha256, isStr, clampInt, httpError, encrypt, decrypt } = require('../util');
const sec = require('../security');
const synthEngine = require('../engine/synthetics');
const plans = require('../plans');
const providers = require('../providers');

const router = express.Router();
router.use(sec.requireSessionOrToken);

// Returns true if allowed; otherwise sends a 402 and returns false.
function withinPlan(req, res, resource) {
  const lim = plans.checkLimit(req.orgId, req.org.plan, resource);
  if (!lim.ok) {
    httpError(res, 402, `plan limit reached (${lim.used}/${lim.limit} ${resource}) — upgrade your plan to add more`);
    return false;
  }
  return true;
}

// A location the org may see/use: its own, or a visible managed one.
function accessibleLocation(req, id) {
  return db.prepare(`SELECT * FROM synthetic_locations WHERE id = ? AND active = 1
    AND (org_id = ? OR (kind = 'managed' AND visible = 1))`).get(id, req.orgId);
}

// ---- locations ---------------------------------------------------------------

router.get('/locations', (req, res) => {
  const t = now();
  const rows = db.prepare(`SELECT l.*, n.status AS node_status,
      EXISTS(SELECT 1 FROM org_location_access a WHERE a.org_id = ? AND a.location_id = l.id) AS booked
    FROM synthetic_locations l LEFT JOIN sensor_nodes n ON n.id = l.node_id
    WHERE l.active = 1 AND (l.org_id = ? OR (l.kind = 'managed' AND l.visible = 1))
    ORDER BY l.kind = 'local' DESC, l.kind, l.region, l.id`).all(req.orgId, req.orgId);
  res.json(rows.map((l) => ({
    id: l.id, city: l.city, cc: l.cc, kind: l.kind, region: l.region,
    isPremium: !!l.is_premium, booked: !!l.booked,
    provider: l.provider, nodeStatus: l.node_status || null,
    online: l.kind === 'local' || (!!l.last_seen_at && t - l.last_seen_at < 5 * 60 * 1000),
  })));
});

// Self-hosted sensor agent (unlimited on every plan — it is not our workload).
router.post('/locations', sec.requireRole('lead'), (req, res) => {
  const { city, cc, region } = req.body || {};
  if (!isStr(city, 80) || !isStr(cc, 2)) return httpError(res, 400, 'city and cc required');
  const probeKey = 'ocp_' + crypto.randomBytes(24).toString('hex');
  const info = db.prepare(`INSERT INTO synthetic_locations
      (org_id, city, cc, kind, region, probe_key_hash, active, created_at)
    VALUES (?, ?, ?, 'customer', ?, ?, 1, ?)`)
    .run(req.orgId, city, cc.toUpperCase(), isStr(region, 40) ? region : null, sha256(probeKey), now());
  sec.audit(req.user.id, 'sensor_create', city, req.orgId);
  res.json({ id: info.lastInsertRowid, probeKey, note: 'store this probe key now — it is not retrievable later' });
});

// BYO-cloud: provision a sensor agent into the customer's own AWS/GCP account
// using their stored (encrypted) credential. The box runs on THEIR cloud bill;
// hard caps + the reconcile sweeper are the cost safety net.
router.post('/locations/provision', sec.requireRole('lead'), async (req, res) => {
  const { provider: pk, region: code, credentialId, instanceClass } = req.body || {};
  const entry = providers.catalogEntry(pk, code);
  if (!entry) return httpError(res, 400, 'unknown provider/region');
  const cls = instanceClass === 'browser' ? 'browser' : 'standard';
  const cred = db.prepare('SELECT * FROM cloud_credentials WHERE id = ? AND org_id = ?')
    .get(clampInt(credentialId, 1, 1e9, 0), req.orgId);
  if (!cred || cred.provider !== pk) return httpError(res, 400, 'credential not found for this provider — add it first');
  const cap = config.sensorNodeCapPerOrg;
  const nodeCount = db.prepare(`SELECT COUNT(*) c FROM sensor_nodes n
    JOIN synthetic_locations l ON l.node_id = n.id WHERE l.org_id = ? AND n.status != 'dead'`).get(req.orgId).c;
  if (nodeCount >= cap) return httpError(res, 429, `node cap reached (${cap}) — remove a sensor agent first`);

  const probeKey = 'ocp_' + crypto.randomBytes(24).toString('hex');
  const t = now();
  const loc = db.prepare(`INSERT INTO synthetic_locations
      (org_id, city, cc, kind, region, provider, probe_key_hash, active, created_at)
    VALUES (?, ?, ?, 'customer', ?, ?, ?, 1, ?)`)
    .run(req.orgId, entry.city, entry.cc, entry.region, pk, sha256(probeKey), t);
  const locationId = loc.lastInsertRowid;
  const node = db.prepare(`INSERT INTO sensor_nodes
      (provider, provider_region, cloud_credential_id, instance_class, status, created_at)
    VALUES (?, ?, ?, ?, 'provisioning', ?)`).run(pk, code, cred.id, cls, t);
  db.prepare('UPDATE synthetic_locations SET node_id = ? WHERE id = ?').run(node.lastInsertRowid, locationId);
  sec.audit(req.user.id, 'sensor_provision', `${pk} ${code} ${entry.city}`, req.orgId);

  try {
    const secret = JSON.parse(decrypt(cred.key_enc, config.secret));
    const userData = providers.renderCloudInit({ opscatUrl: config.baseUrl, probeKey });
    const created = await providers.provider(pk).createInstance(secret, {
      region: code, instanceType: providers.instanceType(pk, cls), userData, locationId,
    });
    db.prepare('UPDATE sensor_nodes SET provider_instance_id = ? WHERE id = ?')
      .run(created.providerInstanceId, node.lastInsertRowid);
    db.prepare('UPDATE synthetic_locations SET provider_ref = ? WHERE id = ?')
      .run(created.providerInstanceId, locationId);
    db.prepare('UPDATE cloud_credentials SET last_used_at = ? WHERE id = ?').run(now(), cred.id);
    res.json({ id: locationId, status: 'provisioning' });
  } catch (e) {
    // roll back the location so the probe key dies with it; keep nothing dangling
    db.prepare('DELETE FROM synthetic_locations WHERE id = ?').run(locationId);
    db.prepare('DELETE FROM sensor_nodes WHERE id = ?').run(node.lastInsertRowid);
    httpError(res, 502, `provisioning failed: ${e.message}`);
  }
});

// Teardown order (docs/SENSORS.md): the location row goes first — that revokes
// the probe key immediately — then the VM. A failed destroy leaves the node
// marked dead for the reconcile sweeper to retry.
router.delete('/locations/:id', sec.requireRole('lead'), async (req, res) => {
  const l = db.prepare('SELECT * FROM synthetic_locations WHERE id = ? AND org_id = ?')
    .get(req.params.id, req.orgId);
  if (!l) return httpError(res, 404, 'location not found');
  if (l.kind === 'local') return httpError(res, 400, 'cannot delete the local probe');
  const node = l.node_id ? db.prepare('SELECT * FROM sensor_nodes WHERE id = ?').get(l.node_id) : null;
  db.prepare('DELETE FROM synthetic_locations WHERE id = ? AND org_id = ?').run(req.params.id, req.orgId);
  sec.audit(req.user.id, 'sensor_delete', `location ${req.params.id}`, req.orgId);
  let teardown = 'n/a';
  if (node && node.provider_instance_id && node.cloud_credential_id) {
    try {
      const cred = db.prepare('SELECT * FROM cloud_credentials WHERE id = ?').get(node.cloud_credential_id);
      const secret = JSON.parse(decrypt(cred.key_enc, config.secret));
      await providers.provider(node.provider).destroyInstance(secret, {
        region: node.provider_region, providerInstanceId: node.provider_instance_id,
      });
      db.prepare('DELETE FROM sensor_nodes WHERE id = ?').run(node.id);
      teardown = 'destroyed';
    } catch (e) {
      db.prepare("UPDATE sensor_nodes SET status = 'dead' WHERE id = ?").run(node.id);
      teardown = `destroy failed (reconcile will retry): ${e.message}`;
    }
  } else if (node) {
    db.prepare('DELETE FROM sensor_nodes WHERE id = ?').run(node.id);
  }
  res.json({ ok: true, teardown });
});

// ---- managed location booking (EE plan quota) ---------------------------------

router.post('/locations/:id/book', sec.requireRole('lead'), (req, res) => {
  const l = db.prepare("SELECT * FROM synthetic_locations WHERE id = ? AND kind = 'managed' AND visible = 1 AND active = 1")
    .get(req.params.id);
  if (!l) return httpError(res, 404, 'managed location not found');
  if (l.is_premium && !plans.hasFeature(req.org.plan, 'premium_locations')) {
    return httpError(res, 402, 'premium location — available on the Enterprise plan');
  }
  if (!withinPlan(req, res, 'managedLocations')) return undefined;
  db.prepare(`INSERT OR IGNORE INTO org_location_access (org_id, location_id, source, created_at)
    VALUES (?, ?, 'plan', ?)`).run(req.orgId, l.id, now());
  sec.audit(req.user.id, 'managed_location_book', l.city, req.orgId);
  res.json({ ok: true });
});

router.delete('/locations/:id/book', sec.requireRole('lead'), (req, res) => {
  db.prepare('DELETE FROM org_location_access WHERE org_id = ? AND location_id = ?')
    .run(req.orgId, req.params.id);
  db.prepare(`DELETE FROM check_locations WHERE location_id = ?
    AND check_id IN (SELECT id FROM synthetic_checks WHERE org_id = ?)`).run(req.params.id, req.orgId);
  sec.audit(req.user.id, 'managed_location_unbook', `location ${req.params.id}`, req.orgId);
  res.json({ ok: true });
});

// ---- cloud credentials (BYO) ---------------------------------------------------
// Secrets are encrypted at rest; responses carry label + hint only, never the key.

router.get('/cloud-credentials', (req, res) => {
  res.json(db.prepare(`SELECT id, provider, label, key_hint, created_at, last_used_at
    FROM cloud_credentials WHERE org_id = ? ORDER BY id`).all(req.orgId)
    .map((c) => ({ id: c.id, provider: c.provider, label: c.label, hint: c.key_hint,
      createdAt: c.created_at, lastUsedAt: c.last_used_at })));
});

router.post('/cloud-credentials', sec.requireRole('lead'), (req, res) => {
  const { provider: pk, label, secret } = req.body || {};
  if (!['aws', 'gcp'].includes(pk)) return httpError(res, 400, 'provider must be aws or gcp');
  if (!isStr(label, 60)) return httpError(res, 400, 'label required');
  if (!secret || typeof secret !== 'object') return httpError(res, 400, 'secret object required');
  let hint = '';
  if (pk === 'aws') {
    if (!isStr(secret.accessKeyId, 128) || !isStr(secret.secretAccessKey, 256)) {
      return httpError(res, 400, 'aws secret needs {accessKeyId, secretAccessKey}');
    }
    hint = `${secret.accessKeyId.slice(0, 4)}····${secret.accessKeyId.slice(-4)}`;
  } else {
    if (!isStr(secret.client_email, 200) || !isStr(secret.private_key, 8192) || !isStr(secret.project_id, 100)) {
      return httpError(res, 400, 'gcp secret needs the service-account JSON ({client_email, private_key, project_id})');
    }
    hint = secret.client_email.slice(0, 24);
  }
  const info = db.prepare(`INSERT INTO cloud_credentials
      (org_id, provider, label, key_enc, key_hint, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(req.orgId, pk, label, encrypt(JSON.stringify(secret), config.secret), hint, req.user.id, now());
  sec.audit(req.user.id, 'cloud_credential_create', `${pk} ${label}`, req.orgId);
  res.json({ id: info.lastInsertRowid, provider: pk, label, hint });
});

router.delete('/cloud-credentials/:id', sec.requireRole('lead'), (req, res) => {
  const used = db.prepare(`SELECT COUNT(*) c FROM sensor_nodes n
    JOIN synthetic_locations l ON l.node_id = n.id
    WHERE n.cloud_credential_id = ? AND l.org_id = ? AND n.status != 'dead'`).get(req.params.id, req.orgId).c;
  if (used > 0) return httpError(res, 409, `credential is used by ${used} sensor node(s) — remove them first`);
  db.prepare('DELETE FROM cloud_credentials WHERE id = ? AND org_id = ?').run(req.params.id, req.orgId);
  sec.audit(req.user.id, 'cloud_credential_delete', `credential ${req.params.id}`, req.orgId);
  res.json({ ok: true });
});

// Region/city catalog for the wizard (step 2), grouped client-side by `region`.
router.get('/provider-catalog', (req, res) => {
  res.json({ catalog: providers.CATALOG, instanceClasses: Object.keys(providers.INSTANCE_TYPES) });
});

// ---- checks -------------------------------------------------------------------

// Sanitize the optional http assertions object; null when nothing is set.
function cleanAssertions(a) {
  if (!a || typeof a !== 'object') return null;
  const out = {};
  const status = parseInt(a.status, 10);
  if (Number.isFinite(status) && status >= 100 && status <= 599) out.status = status;
  if (isStr(a.keyword, 200) && a.keyword.trim()) out.keyword = a.keyword.trim();
  if (isStr(a.jsonPath, 200) && a.jsonPath.trim()) {
    out.jsonPath = a.jsonPath.trim();
    out.jsonValue = isStr(a.jsonValue, 200) ? a.jsonValue : '';
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

// Validate + persist the check→location assignment. undefined/empty = all
// agents incl. future ones (no rows). Only accessible locations are accepted.
function setCheckLocations(req, checkId, locationIds) {
  if (!Array.isArray(locationIds)) return;
  db.prepare('DELETE FROM check_locations WHERE check_id = ?').run(checkId);
  const ins = db.prepare('INSERT OR IGNORE INTO check_locations (check_id, location_id) VALUES (?, ?)');
  for (const raw of locationIds.slice(0, 200)) {
    const id = clampInt(raw, 1, 1e9, 0);
    if (id && accessibleLocation(req, id)) ins.run(checkId, id);
  }
}

// Reputation assets live on their own page (/api/reputation/assets) — they are a
// separate feature that merely reuses this table, so they are excluded here
// rather than cluttering the reachability view with checks that never measure it.
router.get('/checks', (req, res) => {
  const checks = db.prepare(
    "SELECT * FROM synthetic_checks WHERE org_id = ? AND type != 'reputation' ORDER BY id")
    .all(req.orgId);
  const t = now();
  const locIds = db.prepare('SELECT location_id FROM check_locations WHERE check_id = ?');
  res.json(checks.map((c) => {
    const latest = db.prepare(`SELECT ok FROM synthetic_results WHERE check_id = ?
      ORDER BY ts DESC LIMIT 5`).all(c.id);
    const failing = latest.length > 0 && latest[0].ok === 0;
    const locs = db.prepare(`SELECT COUNT(DISTINCT location_id) c FROM synthetic_results
      WHERE check_id = ? AND ts >= ?`).get(c.id, t - 3600000).c;
    return { id: c.id, type: c.type, target: c.target, intervalS: c.interval_s,
      timeoutMs: c.timeout_ms, enabled: !!c.enabled, passing: !failing, locations: Math.max(locs, 1),
      locationIds: locIds.all(c.id).map((r) => r.location_id),
      assertions: c.assertions ? JSON.parse(c.assertions) : null };
  }));
});

router.post('/checks', sec.requireRole('lead'), (req, res) => {
  const { type, target, intervalS, timeoutMs, assertions, locationIds } = req.body || {};
  // 'reputation' is a valid row type but belongs to its own feature and endpoint;
  // accepting it here would create assets this API's own GET then hides.
  if (type === 'reputation') {
    return httpError(res, 400, 'reputation assets are managed at /api/reputation/assets');
  }
  if (!['http', 'icmp', 'dns', 'tcp', 'traceroute'].includes(type)) return httpError(res, 400, 'bad type');
  if (!isStr(target, 300)) return httpError(res, 400, 'target required');
  if (!withinPlan(req, res, 'checks')) return undefined;
  const minIv = plans.minIntervalFor(req.org.plan); // plan-dependent cadence floor
  const info = db.prepare(`INSERT INTO synthetic_checks (org_id, type, target, interval_s, timeout_ms,
    enabled, assertions, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(req.orgId, type, target, clampInt(intervalS, minIv, 3600, Math.max(60, minIv)),
      clampInt(timeoutMs, 500, 60000, 5000),
      type === 'http' ? cleanAssertions(assertions) : null, now());
  setCheckLocations(req, info.lastInsertRowid, locationIds);
  sec.audit(req.user.id, 'check_create', `${type} ${target}`, req.orgId);
  res.json({ id: info.lastInsertRowid });
});

router.patch('/checks/:id', sec.requireRole('lead'), (req, res) => {
  const c = db.prepare(
    "SELECT * FROM synthetic_checks WHERE id = ? AND org_id = ? AND type != 'reputation'")
    .get(req.params.id, req.orgId);
  if (!c) return httpError(res, 404, 'check not found');
  const b = req.body || {};
  const minIv = plans.minIntervalFor(req.org.plan);
  db.prepare(`UPDATE synthetic_checks SET target = COALESCE(?, target),
      interval_s = COALESCE(?, interval_s), enabled = COALESCE(?, enabled),
      assertions = CASE WHEN ? THEN ? ELSE assertions END WHERE id = ? AND org_id = ?`)
    .run(isStr(b.target, 300) ? b.target : null,
      Number.isFinite(b.intervalS) ? clampInt(b.intervalS, minIv, 3600, Math.max(60, minIv)) : null,
      typeof b.enabled === 'boolean' ? (b.enabled ? 1 : 0) : null,
      b.assertions !== undefined && c.type === 'http' ? 1 : 0, cleanAssertions(b.assertions),
      c.id, req.orgId);
  if (b.locationIds !== undefined) setCheckLocations(req, c.id, b.locationIds);
  sec.audit(req.user.id, 'check_update', `check ${c.id}`, req.orgId);
  res.json({ ok: true });
});

router.delete('/checks/:id', sec.requireRole('lead'), (req, res) => {
  db.prepare("DELETE FROM synthetic_checks WHERE id = ? AND org_id = ? AND type != 'reputation'")
    .run(req.params.id, req.orgId);
  sec.audit(req.user.id, 'check_delete', `check ${req.params.id}`, req.orgId);
  res.json({ ok: true });
});

// ---- results ------------------------------------------------------------------
// Location joins accept managed locations (org_id NULL); tenant isolation is
// carried by the check join (c.org_id = req.orgId) in every query.

router.get('/results', (req, res) => {
  const hours = clampInt(req.query.hours, 1, 168, 24);
  const since = now() - hours * 3600000;
  const latest = db.prepare(`SELECT r.check_id, r.location_id, r.ts, r.ok, r.latency_ms, r.meta
    FROM synthetic_results r
    JOIN (SELECT check_id, location_id, MAX(ts) mts FROM synthetic_results
          WHERE ts >= ? GROUP BY check_id, location_id) m
      ON m.check_id = r.check_id AND m.location_id = r.location_id AND m.mts = r.ts
    JOIN synthetic_checks c ON c.id = r.check_id AND c.org_id = ? AND c.type != 'reputation'
    JOIN synthetic_locations loc ON loc.id = r.location_id AND (loc.org_id = ? OR loc.kind = 'managed')`)
    .all(since, req.orgId, req.orgId)
    .map((r) => ({ checkId: r.check_id, locationId: r.location_id, ts: r.ts, ok: !!r.ok,
      latencyMs: r.latency_ms, meta: r.meta ? JSON.parse(r.meta) : null }));
  res.json({ latest });
});

// Bucketed uptime history per check for the HeatBar. Bucket state is
// worst-status-wins: 'bad' = only failures in the bucket, 'warn' = mixed,
// 'ok' = only successes, 'na' = no data. Also returns uptime % over the range
// and per-bucket avg latency (successful runs) for sparklines.
router.get('/history', (req, res) => {
  const minutes = clampInt(req.query.minutes, 5, 44640, 1440);
  const buckets = clampInt(req.query.buckets, 10, 64, 32);
  const since = now() - minutes * 60000;
  const bucketMs = (minutes * 60000) / buckets;
  const rows = db.prepare(`SELECT r.check_id cid,
      CAST((r.ts - ?) / ? AS INTEGER) b,
      SUM(r.ok) oks, COUNT(*) total,
      AVG(CASE WHEN r.ok = 1 THEN r.latency_ms END) ms
    FROM synthetic_results r
    JOIN synthetic_checks c ON c.id = r.check_id AND c.org_id = ? AND c.type != 'reputation'
    WHERE r.ts >= ? GROUP BY r.check_id, b`).all(since, bucketMs, req.orgId, since);
  const byCheck = new Map();
  for (const r of rows) {
    let o = byCheck.get(r.cid);
    if (!o) {
      o = { buckets: Array.from({ length: buckets }, () => ({ s: 'na', ms: null })), oks: 0, total: 0 };
      byCheck.set(r.cid, o);
    }
    if (r.b >= 0 && r.b < buckets) {
      o.buckets[r.b] = {
        s: r.oks === r.total ? 'ok' : r.oks === 0 ? 'bad' : 'warn',
        ms: r.ms == null ? null : Math.round(r.ms),
      };
    }
    o.oks += r.oks; o.total += r.total;
  }
  res.json({
    since, bucketMs,
    checks: [...byCheck.entries()].map(([checkId, o]) => ({
      checkId, buckets: o.buckets,
      uptimePct: o.total ? Math.round((o.oks / o.total) * 10000) / 100 : null,
    })),
  });
});

router.get('/results/series', (req, res) => {
  const checkId = clampInt(req.query.checkId, 1, 1e9, 0);
  const locationId = clampInt(req.query.locationId, 1, 1e9, 0);
  const hours = clampInt(req.query.hours, 1, 168, 24);
  if (!checkId || !locationId) return httpError(res, 400, 'checkId and locationId required');
  const rows = db.prepare(`SELECT r.ts, r.ok, r.latency_ms FROM synthetic_results r
    JOIN synthetic_checks c ON c.id = r.check_id AND c.org_id = ? AND c.type != 'reputation'
    JOIN synthetic_locations loc ON loc.id = r.location_id AND (loc.org_id = ? OR loc.kind = 'managed')
    WHERE r.check_id = ? AND r.location_id = ? AND r.ts >= ? ORDER BY r.ts`)
    .all(req.orgId, req.orgId, checkId, locationId, now() - hours * 3600000);
  res.json(rows.map((r) => ({ ts: r.ts, ok: !!r.ok, latencyMs: r.latency_ms })));
});

// Most recent traceroute meta for the route card.
router.get('/results/route', (req, res) => {
  const locationId = clampInt(req.query.locationId, 1, 1e9, 0);
  const row = db.prepare(`SELECT r.ts, r.meta, c.target FROM synthetic_results r
    JOIN synthetic_checks c ON c.id = r.check_id
    JOIN synthetic_locations loc ON loc.id = r.location_id AND (loc.org_id = ? OR loc.kind = 'managed')
    WHERE c.type = 'traceroute' AND c.org_id = ? ${locationId ? 'AND r.location_id = ?' : ''}
    ORDER BY r.ts DESC LIMIT 1`).get(...[req.orgId, req.orgId, ...(locationId ? [locationId] : [])]);
  if (!row) return res.json(null);
  res.json({ ts: row.ts, target: row.target, meta: row.meta ? JSON.parse(row.meta) : null });
});

router.post('/run', (req, res) => {
  synthEngine.runAllNow(req.orgId)
    .then((results) => res.json({ ran: results.length, results }))
    .catch((e) => httpError(res, 500, e.message));
});

module.exports = router;
