'use strict';
// Session-authenticated synthetics API for the UI: sensor-agent locations
// (self-hosted, BYO-cloud, managed bookings), cloud credentials, checks and
// results. Concept: docs/SENSOR-AGENTS.md.
const express = require('express');
const crypto = require('crypto');
const q = require('../db/shim');
const config = require('../config');
const { now, sha256, isStr, clampInt, httpError, encrypt, decrypt } = require('../util');
const sec = require('../security');
const synthEngine = require('../engine/synthetics');
const plans = require('../plans');
const providers = require('../providers');

const router = express.Router();
router.use(sec.requireSessionOrToken);

// The one 402 for a spent allowance. The creating routes no longer ASK whether
// there is room and then insert — `plans.insertWithinLimit` puts the counter in
// the INSERT's own WHERE, and this only renders the refusal it comes back with.
// Wording unchanged: the UI shows it verbatim.
function planLimitError(res, resource, r) {
  return httpError(res, 402, `plan limit reached (${r.used}/${r.limit} ${resource}) — upgrade your plan to add more`);
}

// A location the org may see/use: its own, or a visible managed one.
// Async since the shim: every caller uses the row in a BOOLEAN context, and a
// pending query is truthy — the `await`s below are load-bearing, not cosmetic.
async function accessibleLocation(req, id) {
  return q.prepare(`SELECT * FROM synthetic_locations WHERE id = ? AND active = 1
    AND (org_id = ? OR (kind = 'managed' AND visible = 1))`).get(id, req.orgId);
}

// ---- locations ---------------------------------------------------------------

router.get('/locations', async (req, res) => {
  const t = now();
  const rows = await q.prepare(`SELECT l.*, n.status AS node_status,
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
router.post('/locations', sec.requireRole('lead'), async (req, res) => {
  const { city, cc, region } = req.body || {};
  if (!isStr(city, 80) || !isStr(cc, 2)) return httpError(res, 400, 'city and cc required');
  const probeKey = 'ocp_' + crypto.randomBytes(24).toString('hex');
  // insert() rather than run().lastInsertRowid: better-sqlite3 reports one and
  // node-postgres has no such field, so the shim uses RETURNING id on both.
  const id = await q.prepare(`INSERT INTO synthetic_locations
      (org_id, city, cc, kind, region, probe_key_hash, active, created_at)
    VALUES (?, ?, ?, 'customer', ?, ?, 1, ?)`)
    .insert(req.orgId, city, cc.toUpperCase(), isStr(region, 40) ? region : null, sha256(probeKey), now());
  sec.audit(req.user.id, 'sensor_create', city, req.orgId);
  res.json({ id, probeKey, note: 'store this probe key now — it is not retrievable later' });
});

// BYO-cloud: provision a sensor agent into the customer's own AWS/GCP account
// using their stored (encrypted) credential. The box runs on THEIR cloud bill;
// hard caps + the reconcile sweeper are the cost safety net.
router.post('/locations/provision', sec.requireRole('lead'), async (req, res) => {
  const { provider: pk, region: code, credentialId, instanceClass } = req.body || {};
  const entry = providers.catalogEntry(pk, code);
  if (!entry) return httpError(res, 400, 'unknown provider/region');
  const cls = instanceClass === 'browser' ? 'browser' : 'standard';
  const cred = await q.prepare('SELECT * FROM cloud_credentials WHERE id = ? AND org_id = ?')
    .get(clampInt(credentialId, 1, 1e9, 0), req.orgId);
  if (!cred || cred.provider !== pk) return httpError(res, 400, 'credential not found for this provider — add it first');
  const cap = config.sensorNodeCapPerOrg;
  const probeKey = 'ocp_' + crypto.randomBytes(24).toString('hex');
  const t = now();
  // The node row goes FIRST so the location can be written with `node_id`
  // already set — which is what lets the cap and the write that consumes it be
  // ONE statement. As a COUNT, a comparison in JS and then an INSERT (how this
  // read before Phase 2) two requests arriving together at cap-1 both pass and
  // both boot a VM on the customer's cloud bill, and nothing in the app ever
  // learns about the second one.
  const nodeId = await q.prepare(`INSERT INTO sensor_nodes
      (provider, provider_region, cloud_credential_id, instance_class, status, created_at)
    VALUES (?, ?, ?, ?, 'provisioning', ?)`).insert(pk, code, cred.id, cls, t);
  // The gated INSERT writes zero rows when the cap is spent, and `insert()` is
  // `RETURNING id` — so no id back IS the refusal, exactly as `changes !== 1`
  // was before the shim. Nothing else can make it undefined: the row's own id
  // is never null.
  const locationId = await q.prepare(`INSERT INTO synthetic_locations
      (org_id, city, cc, kind, region, provider, probe_key_hash, node_id, active, created_at)
    SELECT ?, ?, ?, 'customer', ?, ?, ?, ?, 1, ?
    WHERE (SELECT COUNT(*) FROM sensor_nodes n JOIN synthetic_locations l ON l.node_id = n.id
           WHERE l.org_id = ? AND n.status != 'dead') < ?`)
    .insert(req.orgId, entry.city, entry.cc, entry.region, pk, sha256(probeKey),
      nodeId, t, req.orgId, cap);
  if (locationId == null) {
    // a sensor_nodes row is only ever reachable through its location, so an
    // unlinked one is invisible to the teardown path AND to the reconcile
    // sweeper — drop it rather than leave a VM nobody can find later
    await q.prepare('DELETE FROM sensor_nodes WHERE id = ?').run(nodeId);
    return httpError(res, 429, `node cap reached (${cap}) — remove a sensor agent first`);
  }
  sec.audit(req.user.id, 'sensor_provision', `${pk} ${code} ${entry.city}`, req.orgId);

  try {
    const secret = JSON.parse(decrypt(cred.key_enc, config.secret));
    const userData = providers.renderCloudInit({ opscatUrl: config.baseUrl, probeKey });
    const created = await providers.provider(pk).createInstance(secret, {
      region: code, instanceType: providers.instanceType(pk, cls), userData, locationId,
    });
    await q.prepare('UPDATE sensor_nodes SET provider_instance_id = ? WHERE id = ?')
      .run(created.providerInstanceId, nodeId);
    await q.prepare('UPDATE synthetic_locations SET provider_ref = ? WHERE id = ?')
      .run(created.providerInstanceId, locationId);
    await q.prepare('UPDATE cloud_credentials SET last_used_at = ? WHERE id = ?').run(now(), cred.id);
    res.json({ id: locationId, status: 'provisioning' });
  } catch (e) {
    // roll back the location so the probe key dies with it; keep nothing dangling
    await q.prepare('DELETE FROM synthetic_locations WHERE id = ?').run(locationId);
    await q.prepare('DELETE FROM sensor_nodes WHERE id = ?').run(nodeId);
    httpError(res, 502, `provisioning failed: ${e.message}`);
  }
});

// Teardown order (docs/SENSORS.md): the location row goes first — that revokes
// the probe key immediately — then the VM. A failed destroy leaves the node
// marked dead for the reconcile sweeper to retry.
router.delete('/locations/:id', sec.requireRole('lead'), async (req, res) => {
  const l = await q.prepare('SELECT * FROM synthetic_locations WHERE id = ? AND org_id = ?')
    .get(req.params.id, req.orgId);
  if (!l) return httpError(res, 404, 'location not found');
  if (l.kind === 'local') return httpError(res, 400, 'cannot delete the local probe');
  const node = l.node_id
    ? await q.prepare('SELECT * FROM sensor_nodes WHERE id = ?').get(l.node_id) : null;
  await q.prepare('DELETE FROM synthetic_locations WHERE id = ? AND org_id = ?').run(req.params.id, req.orgId);
  sec.audit(req.user.id, 'sensor_delete', `location ${req.params.id}`, req.orgId);
  let teardown = 'n/a';
  if (node && node.provider_instance_id && node.cloud_credential_id) {
    try {
      const cred = await q.prepare('SELECT * FROM cloud_credentials WHERE id = ?').get(node.cloud_credential_id);
      const secret = JSON.parse(decrypt(cred.key_enc, config.secret));
      await providers.provider(node.provider).destroyInstance(secret, {
        region: node.provider_region, providerInstanceId: node.provider_instance_id,
      });
      await q.prepare('DELETE FROM sensor_nodes WHERE id = ?').run(node.id);
      teardown = 'destroyed';
    } catch (e) {
      await q.prepare("UPDATE sensor_nodes SET status = 'dead' WHERE id = ?").run(node.id);
      teardown = `destroy failed (reconcile will retry): ${e.message}`;
    }
  } else if (node) {
    await q.prepare('DELETE FROM sensor_nodes WHERE id = ?').run(node.id);
  }
  res.json({ ok: true, teardown });
});

// ---- managed location booking (EE plan quota) ---------------------------------

router.post('/locations/:id/book', sec.requireRole('lead'), async (req, res) => {
  const l = await q.prepare("SELECT * FROM synthetic_locations WHERE id = ? AND kind = 'managed' AND visible = 1 AND active = 1")
    .get(req.params.id);
  if (!l) return httpError(res, 404, 'managed location not found');
  if (l.is_premium && !plans.hasFeature(req.org.plan, 'premium_locations')) {
    return httpError(res, 402, 'premium location — available on the Enterprise plan');
  }
  // The allowance is enforced BY the insert. `changes === 0` is not on its own an
  // answer here — booking is idempotent, so re-booking a location the org already
  // has writes nothing either; `refused` is the one that means "cap reached".
  const r = await plans.insertWithinLimit(req.orgId, req.org.plan, 'managedLocations',
    `INSERT INTO org_location_access (org_id, location_id, source, created_at)
     SELECT ?, ?, 'plan', ?`,
    [req.orgId, l.id, now()], 'ON CONFLICT DO NOTHING');
  if (r.refused) return planLimitError(res, 'managedLocations', r);
  sec.audit(req.user.id, 'managed_location_book', l.city, req.orgId);
  res.json({ ok: true });
});

router.delete('/locations/:id/book', sec.requireRole('lead'), async (req, res) => {
  await q.prepare('DELETE FROM org_location_access WHERE org_id = ? AND location_id = ?')
    .run(req.orgId, req.params.id);
  await q.prepare(`DELETE FROM check_locations WHERE location_id = ?
    AND check_id IN (SELECT id FROM synthetic_checks WHERE org_id = ?)`).run(req.params.id, req.orgId);
  sec.audit(req.user.id, 'managed_location_unbook', `location ${req.params.id}`, req.orgId);
  res.json({ ok: true });
});

// ---- cloud credentials (BYO) ---------------------------------------------------
// Secrets are encrypted at rest; responses carry label + hint only, never the key.

router.get('/cloud-credentials', async (req, res) => {
  res.json((await q.prepare(`SELECT id, provider, label, key_hint, created_at, last_used_at
    FROM cloud_credentials WHERE org_id = ? ORDER BY id`).all(req.orgId))
    .map((c) => ({ id: c.id, provider: c.provider, label: c.label, hint: c.key_hint,
      createdAt: c.created_at, lastUsedAt: c.last_used_at })));
});

router.post('/cloud-credentials', sec.requireRole('lead'), async (req, res) => {
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
  const id = await q.prepare(`INSERT INTO cloud_credentials
      (org_id, provider, label, key_enc, key_hint, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .insert(req.orgId, pk, label, encrypt(JSON.stringify(secret), config.secret), hint, req.user.id, now());
  sec.audit(req.user.id, 'cloud_credential_create', `${pk} ${label}`, req.orgId);
  res.json({ id, provider: pk, label, hint });
});

router.delete('/cloud-credentials/:id', sec.requireRole('lead'), async (req, res) => {
  const used = (await q.prepare(`SELECT COUNT(*) c FROM sensor_nodes n
    JOIN synthetic_locations l ON l.node_id = n.id
    WHERE n.cloud_credential_id = ? AND l.org_id = ? AND n.status != 'dead'`).get(req.params.id, req.orgId)).c;
  if (used > 0) return httpError(res, 409, `credential is used by ${used} sensor node(s) — remove them first`);
  await q.prepare('DELETE FROM cloud_credentials WHERE id = ? AND org_id = ?').run(req.params.id, req.orgId);
  sec.audit(req.user.id, 'cloud_credential_delete', `credential ${req.params.id}`, req.orgId);
  res.json({ ok: true });
});

// Region/city catalog for the wizard (step 2), grouped client-side by `region`.
router.get('/provider-catalog', (req, res) => {
  res.json({
    catalog: providers.CATALOG,
    instanceClasses: Object.keys(providers.INSTANCE_TYPES),
    instanceTypes: providers.INSTANCE_TYPES,
    costEstimates: providers.COST_ESTIMATES,
  });
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
async function setCheckLocations(req, checkId, locationIds) {
  if (!Array.isArray(locationIds)) return;
  await q.prepare('DELETE FROM check_locations WHERE check_id = ?').run(checkId);
  const ins = q.prepare('INSERT INTO check_locations (check_id, location_id) VALUES (?, ?) ON CONFLICT DO NOTHING');
  for (const raw of locationIds.slice(0, 200)) {
    const id = clampInt(raw, 1, 1e9, 0);
    // the await is the guard: unawaited, `accessibleLocation(...)` is a truthy
    // Promise and every id the caller sends would be accepted, including a
    // location belonging to another org
    if (id && (await accessibleLocation(req, id))) await ins.run(checkId, id);
  }
}

router.get('/checks', async (req, res) => {
  const checks = await q.prepare('SELECT * FROM synthetic_checks WHERE org_id = ? ORDER BY id')
    .all(req.orgId);
  const t = now();
  const locIds = q.prepare('SELECT location_id FROM check_locations WHERE check_id = ?');
  res.json(await Promise.all(checks.map(async (c) => {
    const latest = await q.prepare(`SELECT ok FROM synthetic_results WHERE check_id = ?
      ORDER BY ts DESC LIMIT 5`).all(c.id);
    const failing = latest.length > 0 && latest[0].ok === 0;
    const locs = (await q.prepare(`SELECT COUNT(DISTINCT location_id) c FROM synthetic_results
      WHERE check_id = ? AND ts >= ?`).get(c.id, t - 3600000)).c;
    return { id: c.id, type: c.type, target: c.target, intervalS: c.interval_s,
      timeoutMs: c.timeout_ms, enabled: !!c.enabled, passing: !failing, locations: Math.max(locs, 1),
      locationIds: (await locIds.all(c.id)).map((r) => r.location_id),
      assertions: c.assertions ? JSON.parse(c.assertions) : null };
  })));
});

router.post('/checks', sec.requireRole('lead'), async (req, res) => {
  const { type, target, intervalS, timeoutMs, assertions, locationIds } = req.body || {};
  if (!['http', 'icmp', 'dns', 'tcp', 'traceroute'].includes(type)) return httpError(res, 400, 'bad type');
  if (!isStr(target, 300)) return httpError(res, 400, 'target required');
  const minIv = plans.minIntervalFor(req.org.plan); // plan-dependent cadence floor
  // The `checks` budget spans synthetic_checks AND reputation_assets, and both
  // counts live in the WHERE of this one statement — so two simultaneous
  // creations at 24 of 25 cannot both be told they are the twenty-fifth.
  const r = await plans.insertWithinLimit(req.orgId, req.org.plan, 'checks',
    `INSERT INTO synthetic_checks (org_id, type, target, interval_s, timeout_ms,
       enabled, assertions, created_at)
     SELECT ?, ?, ?, ?, ?, 1, ?, ?`,
    [req.orgId, type, target, clampInt(intervalS, minIv, 3600, Math.max(60, minIv)),
      clampInt(timeoutMs, 500, 60000, 5000),
      type === 'http' ? cleanAssertions(assertions) : null, now()],
    '', { returningId: true });
  if (r.refused) return planLimitError(res, 'checks', r);
  // `RETURNING id` from the same statement that did the insert, not
  // lastInsertRowid: the shim refuses that on both engines, and "a number came
  // back" is not the same claim as "this is the row that was written".
  await setCheckLocations(req, r.id, locationIds);
  sec.audit(req.user.id, 'check_create', `${type} ${target}`, req.orgId);
  res.json({ id: r.id });
});

router.patch('/checks/:id', sec.requireRole('lead'), async (req, res) => {
  const c = await q.prepare('SELECT * FROM synthetic_checks WHERE id = ? AND org_id = ?')
    .get(req.params.id, req.orgId);
  if (!c) return httpError(res, 404, 'check not found');
  const b = req.body || {};
  const minIv = plans.minIntervalFor(req.org.plan);
  await q.prepare(`UPDATE synthetic_checks SET target = COALESCE(?, target),
      interval_s = COALESCE(?, interval_s), enabled = COALESCE(?, enabled),
      assertions = CASE WHEN ? THEN ? ELSE assertions END WHERE id = ? AND org_id = ?`)
    .run(isStr(b.target, 300) ? b.target : null,
      Number.isFinite(b.intervalS) ? clampInt(b.intervalS, minIv, 3600, Math.max(60, minIv)) : null,
      typeof b.enabled === 'boolean' ? (b.enabled ? 1 : 0) : null,
      b.assertions !== undefined && c.type === 'http' ? 1 : 0, cleanAssertions(b.assertions),
      c.id, req.orgId);
  if (b.locationIds !== undefined) await setCheckLocations(req, c.id, b.locationIds);
  sec.audit(req.user.id, 'check_update', `check ${c.id}`, req.orgId);
  res.json({ ok: true });
});

router.delete('/checks/:id', sec.requireRole('lead'), async (req, res) => {
  await q.prepare('DELETE FROM synthetic_checks WHERE id = ? AND org_id = ?')
    .run(req.params.id, req.orgId);
  sec.audit(req.user.id, 'check_delete', `check ${req.params.id}`, req.orgId);
  res.json({ ok: true });
});

// ---- results ------------------------------------------------------------------
// Location joins accept managed locations (org_id NULL); tenant isolation is
// carried by the check join (c.org_id = req.orgId) in every query.

router.get('/results', async (req, res) => {
  const hours = clampInt(req.query.hours, 1, 168, 24);
  const since = now() - hours * 3600000;
  const latest = (await q.prepare(`SELECT r.check_id, r.location_id, r.ts, r.ok, r.latency_ms, r.meta
    FROM synthetic_results r
    JOIN (SELECT check_id, location_id, MAX(ts) mts FROM synthetic_results
          WHERE ts >= ? GROUP BY check_id, location_id) m
      ON m.check_id = r.check_id AND m.location_id = r.location_id AND m.mts = r.ts
    JOIN synthetic_checks c ON c.id = r.check_id AND c.org_id = ?
    JOIN synthetic_locations loc ON loc.id = r.location_id AND (loc.org_id = ? OR loc.kind = 'managed')`)
    .all(since, req.orgId, req.orgId))
    .map((r) => ({ checkId: r.check_id, locationId: r.location_id, ts: r.ts, ok: !!r.ok,
      latencyMs: r.latency_ms, meta: r.meta ? JSON.parse(r.meta) : null }));
  res.json({ latest });
});

// Bucketed uptime history per check for the HeatBar. Bucket state is
// worst-status-wins: 'bad' = only failures in the bucket, 'warn' = mixed,
// 'ok' = only successes, 'na' = no data. Also returns uptime % over the range
// and per-bucket avg latency (successful runs) for sparklines.
router.get('/history', async (req, res) => {
  const minutes = clampInt(req.query.minutes, 5, 44640, 1440);
  const buckets = clampInt(req.query.buckets, 10, 64, 32);
  const since = now() - minutes * 60000;
  const spanMs = minutes * 60000;
  // still reported to the client (the HeatBar labels its buckets with it);
  // only the SQL stopped dividing by it.
  const bucketMs = spanMs / buckets;
  // Bucket index by INTEGER division, with every operand cast to BIGINT.
  //
  // The trap being avoided: this was `CAST((ts - since) / bucketMs AS INTEGER)`,
  // and `bucketMs` is frequently FRACTIONAL — 60000 does not divide by 64, so a
  // 5-minute window over 64 buckets is 4687.5ms wide. That makes it a float
  // division, and the engines disagree about what CAST does to a float: SQLite
  // TRUNCATES, Postgres ROUNDS. Half the buckets would shift by one on the port,
  // silently, on a chart nobody would re-verify.
  //
  // The CASTs are NOT decoration, and this cost an hour to find: **better-sqlite3
  // binds every JS number as REAL**, including one that satisfies
  // `Number.isInteger()`. So `(ts - ?) * ? / ?` with bound integers is still a
  // FLOAT division — measured, `b` came back as 63.9998. "Integer division
  // truncates in both dialects" is true of the SQL and false of the driver.
  // `CAST(? AS BIGINT)` forces it back: SQLite gives any type name containing
  // INT integer affinity, Postgres reads int8. Plain INTEGER would be int4 in
  // Postgres and epoch-milliseconds overflow it (that is the §2 bigint rule).
  //
  // An event exactly at the window end yields `buckets` itself, which the range
  // guard below drops — same as before, and the reason the harness pins a result
  // just INSIDE the edge rather than on it.
  const rows = await q.prepare(`SELECT r.check_id cid,
      (r.ts - CAST(? AS BIGINT)) * CAST(? AS BIGINT) / CAST(? AS BIGINT) b,
      SUM(r.ok) oks, COUNT(*) total,
      AVG(CASE WHEN r.ok = 1 THEN r.latency_ms END) ms
    FROM synthetic_results r
    JOIN synthetic_checks c ON c.id = r.check_id AND c.org_id = ?
    WHERE r.ts >= ? GROUP BY r.check_id, b`).all(since, buckets, spanMs, req.orgId, since);
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

router.get('/results/series', async (req, res) => {
  const checkId = clampInt(req.query.checkId, 1, 1e9, 0);
  const locationId = clampInt(req.query.locationId, 1, 1e9, 0);
  const hours = clampInt(req.query.hours, 1, 168, 24);
  if (!checkId || !locationId) return httpError(res, 400, 'checkId and locationId required');
  const rows = await q.prepare(`SELECT r.ts, r.ok, r.latency_ms FROM synthetic_results r
    JOIN synthetic_checks c ON c.id = r.check_id AND c.org_id = ?
    JOIN synthetic_locations loc ON loc.id = r.location_id AND (loc.org_id = ? OR loc.kind = 'managed')
    WHERE r.check_id = ? AND r.location_id = ? AND r.ts >= ? ORDER BY r.ts`)
    .all(req.orgId, req.orgId, checkId, locationId, now() - hours * 3600000);
  res.json(rows.map((r) => ({ ts: r.ts, ok: !!r.ok, latencyMs: r.latency_ms })));
});

// Most recent traceroute meta for the route card.
router.get('/results/route', async (req, res) => {
  const locationId = clampInt(req.query.locationId, 1, 1e9, 0);
  const row = await q.prepare(`SELECT r.ts, r.meta, c.target FROM synthetic_results r
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
