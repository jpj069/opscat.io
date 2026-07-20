'use strict';
// Session-authenticated synthetics API for the UI: locations, checks, results.
const express = require('express');
const crypto = require('crypto');
const { db } = require('../db');
const { now, sha256, isStr, clampInt, httpError } = require('../util');
const sec = require('../security');
const synthEngine = require('../engine/synthetics');
const plans = require('../plans');

const router = express.Router();
router.use(sec.requireSession);

// Returns true if allowed; otherwise sends a 402 and returns false.
function withinPlan(req, res, resource) {
  const lim = plans.checkLimit(req.orgId, req.org.plan, resource);
  if (!lim.ok) {
    httpError(res, 402, `plan limit reached (${lim.used}/${lim.limit} ${resource}) — upgrade your plan to add more`);
    return false;
  }
  return true;
}

router.get('/locations', (req, res) => {
  const t = now();
  res.json(db.prepare(`SELECT id, city, cc, kind, active, last_seen_at FROM synthetic_locations
    WHERE active = 1 AND org_id = ? ORDER BY kind DESC, id`).all(req.orgId)
    .map((l) => ({ id: l.id, city: l.city, cc: l.cc, kind: l.kind,
      online: l.kind === 'local' || (!!l.last_seen_at && t - l.last_seen_at < 5 * 60 * 1000) })));
});

router.post('/locations', sec.requireRole('lead'), (req, res) => {
  const { city, cc } = req.body || {};
  if (!isStr(city, 80) || !isStr(cc, 2)) return httpError(res, 400, 'city and cc required');
  if (!withinPlan(req, res, 'sensors')) return undefined;
  const probeKey = 'ocp_' + crypto.randomBytes(24).toString('hex');
  const info = db.prepare(`INSERT INTO synthetic_locations (org_id, city, cc, kind, probe_key_hash, active, created_at)
    VALUES (?, ?, ?, 'remote', ?, 1, ?)`).run(req.orgId, city, cc.toUpperCase(), sha256(probeKey), now());
  sec.audit(req.user.id, 'probe_create', city, req.orgId);
  res.json({ id: info.lastInsertRowid, probeKey, note: 'store this probe key now — it is not retrievable later' });
});

router.delete('/locations/:id', sec.requireRole('lead'), (req, res) => {
  const l = db.prepare('SELECT kind FROM synthetic_locations WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!l) return httpError(res, 404, 'location not found');
  if (l.kind === 'local') return httpError(res, 400, 'cannot delete the local probe');
  db.prepare('DELETE FROM synthetic_locations WHERE id = ? AND org_id = ?').run(req.params.id, req.orgId);
  sec.audit(req.user.id, 'probe_delete', `location ${req.params.id}`, req.orgId);
  res.json({ ok: true });
});

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

router.get('/checks', (req, res) => {
  const checks = db.prepare('SELECT * FROM synthetic_checks WHERE org_id = ? ORDER BY id').all(req.orgId);
  const t = now();
  res.json(checks.map((c) => {
    const latest = db.prepare(`SELECT ok FROM synthetic_results WHERE check_id = ?
      ORDER BY ts DESC LIMIT 5`).all(c.id);
    const failing = latest.length > 0 && latest[0].ok === 0;
    const locs = db.prepare(`SELECT COUNT(DISTINCT location_id) c FROM synthetic_results
      WHERE check_id = ? AND ts >= ?`).get(c.id, t - 3600000).c;
    return { id: c.id, type: c.type, target: c.target, intervalS: c.interval_s,
      timeoutMs: c.timeout_ms, enabled: !!c.enabled, passing: !failing, locations: Math.max(locs, 1),
      assertions: c.assertions ? JSON.parse(c.assertions) : null };
  }));
});

router.post('/checks', sec.requireRole('lead'), (req, res) => {
  const { type, target, intervalS, timeoutMs, assertions } = req.body || {};
  if (!['http', 'icmp', 'dns', 'tcp', 'traceroute'].includes(type)) return httpError(res, 400, 'bad type');
  if (!isStr(target, 300)) return httpError(res, 400, 'target required');
  if (!withinPlan(req, res, 'checks')) return undefined;
  const info = db.prepare(`INSERT INTO synthetic_checks (org_id, type, target, interval_s, timeout_ms,
    enabled, assertions, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(req.orgId, type, target, clampInt(intervalS, 15, 3600, 60), clampInt(timeoutMs, 500, 60000, 5000),
      type === 'http' ? cleanAssertions(assertions) : null, now());
  sec.audit(req.user.id, 'check_create', `${type} ${target}`, req.orgId);
  res.json({ id: info.lastInsertRowid });
});

router.patch('/checks/:id', sec.requireRole('lead'), (req, res) => {
  const c = db.prepare('SELECT * FROM synthetic_checks WHERE id = ? AND org_id = ?').get(req.params.id, req.orgId);
  if (!c) return httpError(res, 404, 'check not found');
  const b = req.body || {};
  db.prepare(`UPDATE synthetic_checks SET target = COALESCE(?, target),
      interval_s = COALESCE(?, interval_s), enabled = COALESCE(?, enabled),
      assertions = CASE WHEN ? THEN ? ELSE assertions END WHERE id = ? AND org_id = ?`)
    .run(isStr(b.target, 300) ? b.target : null,
      Number.isFinite(b.intervalS) ? clampInt(b.intervalS, 15, 3600, 60) : null,
      typeof b.enabled === 'boolean' ? (b.enabled ? 1 : 0) : null,
      b.assertions !== undefined && c.type === 'http' ? 1 : 0, cleanAssertions(b.assertions),
      c.id, req.orgId);
  sec.audit(req.user.id, 'check_update', `check ${c.id}`, req.orgId);
  res.json({ ok: true });
});

router.delete('/checks/:id', sec.requireRole('lead'), (req, res) => {
  db.prepare('DELETE FROM synthetic_checks WHERE id = ? AND org_id = ?').run(req.params.id, req.orgId);
  sec.audit(req.user.id, 'check_delete', `check ${req.params.id}`, req.orgId);
  res.json({ ok: true });
});

// Latest result per (check, location) + latency series for the UI.
router.get('/results', (req, res) => {
  const hours = clampInt(req.query.hours, 1, 168, 24);
  const since = now() - hours * 3600000;
  const latest = db.prepare(`SELECT r.check_id, r.location_id, r.ts, r.ok, r.latency_ms, r.meta
    FROM synthetic_results r
    JOIN (SELECT check_id, location_id, MAX(ts) mts FROM synthetic_results
          WHERE ts >= ? GROUP BY check_id, location_id) m
      ON m.check_id = r.check_id AND m.location_id = r.location_id AND m.mts = r.ts
    JOIN synthetic_checks c ON c.id = r.check_id AND c.org_id = ?
    JOIN synthetic_locations loc ON loc.id = r.location_id AND loc.org_id = ?`)
    .all(since, req.orgId, req.orgId)
    .map((r) => ({ checkId: r.check_id, locationId: r.location_id, ts: r.ts, ok: !!r.ok,
      latencyMs: r.latency_ms, meta: r.meta ? JSON.parse(r.meta) : null }));
  res.json({ latest });
});

router.get('/results/series', (req, res) => {
  const checkId = clampInt(req.query.checkId, 1, 1e9, 0);
  const locationId = clampInt(req.query.locationId, 1, 1e9, 0);
  const hours = clampInt(req.query.hours, 1, 168, 24);
  if (!checkId || !locationId) return httpError(res, 400, 'checkId and locationId required');
  const rows = db.prepare(`SELECT r.ts, r.ok, r.latency_ms FROM synthetic_results r
    JOIN synthetic_checks c ON c.id = r.check_id AND c.org_id = ?
    JOIN synthetic_locations loc ON loc.id = r.location_id AND loc.org_id = ?
    WHERE r.check_id = ? AND r.location_id = ? AND r.ts >= ? ORDER BY r.ts`)
    .all(req.orgId, req.orgId, checkId, locationId, now() - hours * 3600000);
  res.json(rows.map((r) => ({ ts: r.ts, ok: !!r.ok, latencyMs: r.latency_ms })));
});

// Most recent traceroute meta for the route card.
router.get('/results/route', (req, res) => {
  const locationId = clampInt(req.query.locationId, 1, 1e9, 0);
  const row = db.prepare(`SELECT r.ts, r.meta, c.target FROM synthetic_results r
    JOIN synthetic_checks c ON c.id = r.check_id
    JOIN synthetic_locations loc ON loc.id = r.location_id
    WHERE c.type = 'traceroute' AND c.org_id = ? AND loc.org_id = ? ${locationId ? 'AND r.location_id = ?' : ''}
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
