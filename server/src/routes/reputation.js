'use strict';
// Reputation — blocklist monitoring for the org's sending assets.
//
// Its own feature and its own top-level page, but deliberately NOT its own
// storage: an asset is a `synthetic_checks` row of type 'reputation' and its
// history is `synthetic_results`. That reuse is what buys the scheduler, the
// result history, the event pipeline, alert rules, cases and the status page
// without a line of duplicated machinery — see docs/ARCHITECTURE.md.
//
// This module exists so the *API* reads like the feature: callers talk about
// assets and listings, not about check rows they have to join themselves.
const express = require('express');
const { db } = require('../db');
const { now, isStr, clampInt, httpError } = require('../util');
const sec = require('../security');
const plans = require('../plans');
const synthEngine = require('../engine/synthetics');
const reputation = require('../engine/reputation');

const router = express.Router();
router.use(sec.requireSessionOrToken);

const MAX_INTERVAL_S = 86400;      // 24h — blocklist state moves over hours
const DEFAULT_INTERVAL_S = 21600;  // 6h
// A reputation run costs ~93 DNS queries on a cold canary cache (31 zones plus
// both controls each) and 31 warm, against third-party lists that rate-limit per
// source IP — and blocklist state does not move in minutes. The
// floor is therefore this feature's own, NOT the plan's synthetic-check floor
// (15s/60s) — a plan that allows fast HTTP checks must not turn a handful of
// assets into a query flood that gets the whole host refused by Spamhaus.
const MIN_INTERVAL_S = 3600;       // 1h

// The effective floor: this feature's minimum, never below the org's plan floor.
const floorFor = (plan) => Math.max(MIN_INTERVAL_S, plans.minIntervalFor(plan));

const listChecks = db.prepare(
  "SELECT * FROM synthetic_checks WHERE org_id = ? AND type = 'reputation' ORDER BY id");
const getCheck = db.prepare(
  "SELECT * FROM synthetic_checks WHERE id = ? AND org_id = ? AND type = 'reputation'");
// Latest result per check. Reputation runs on the server's local probe only —
// /v1/synthetics/checks never hands the type to an agent and /v1/synthetics/report
// rejects it — so there is exactly one location in play and no per-location
// fan-out to collapse. `id DESC` breaks ties because `ts` is millisecond
// granularity and a manual "run now" right after a scheduled run can land on
// the same millisecond.
const latestResult = db.prepare(`SELECT ok, ts, latency_ms, meta FROM synthetic_results
  WHERE check_id = ? ORDER BY ts DESC, id DESC LIMIT 1`);

function parseMeta(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// One asset as the UI wants it: what it is, whether it is listed, and why.
// `status` is the single field a table row renders from:
//   listed        - on a critical/standard list, alerting, check is failing
//   informational - only on range/ASN-wide lists; recorded, never alerted
//   clean         - queried successfully, nothing found
//   unknown       - could not be checked (no reachable critical zone / error)
//   pending       - never run yet
function toAsset(check) {
  const last = latestResult.get(check.id);
  const meta = last ? parseMeta(last.meta) : null;
  const listed = (meta && Array.isArray(meta.listed)) ? meta.listed : [];
  const actionable = listed.filter((l) => l.tier !== 'informational');

  let status = 'pending';
  if (last) {
    // A finding outranks a partial outage: if some zones answered and one of
    // them listed the asset, that is a fact, and recordResult has already raised
    // the event. Reporting 'unknown' here would contradict the alert the on-call
    // just received. The `error` field still rides along so the UI can say the
    // run was incomplete.
    if (actionable.length) status = 'listed';
    else if (meta && meta.error) status = 'unknown';
    else if (listed.length) status = 'informational';
    else status = 'clean';
  }

  return {
    id: check.id,
    target: check.target,
    kind: meta ? meta.kind : null,          // 'ip' | 'domain'
    rdns: meta ? (meta.rdns || null) : null, // resolved role, e.g. mail4.link11.com
    enabled: !!check.enabled,
    intervalS: check.interval_s,
    status,
    worstTier: meta ? (meta.worstTier || null) : null,
    listings: listed,
    policy: (meta && meta.policy) || [],
    unavailable: (meta && meta.unavailable) || [],
    errored: (meta && meta.errored) || [],   // answered with an error, NOT clean
    zonesQueried: meta ? (meta.zonesQueried ?? null) : null,
    error: meta ? (meta.error || null) : null,
    lastCheckedAt: last ? last.ts : null,
    lastDurationMs: last ? last.latency_ms : null,
  };
}

// ---- assets -----------------------------------------------------------------

router.get('/assets', (req, res) => {
  res.json(listChecks.all(req.orgId).map(toAsset));
});

router.get('/overview', (req, res) => {
  const assets = listChecks.all(req.orgId).map(toAsset);
  const count = (s) => assets.filter((a) => a.status === s).length;
  // Coverage is "how many lists actually answered", which is the honest ceiling
  // on what any verdict here is worth — a resolver the lists refuse silently
  // turns every asset green. Reported per kind because the denominators differ
  // (31 IP zones vs 8 domain zones); mixing them made "7 of 31" look like a
  // catastrophic outage on an org that only monitors domains.
  const coverageFor = (kind) => {
    const of = assets.filter((a) => a.kind === kind && a.zonesQueried != null);
    if (!of.length) return { queried: null, total: null, unavailable: 0 };
    return {
      queried: Math.max(...of.map((a) => a.zonesQueried)),
      total: kind === 'ip' ? reputation.IP_ZONES.length : reputation.DOMAIN_ZONES.length,
      unavailable: of.reduce((m, a) => Math.max(m, a.unavailable.length), 0),
    };
  };
  const ipCov = coverageFor('ip');
  const domainCov = coverageFor('domain');
  return res.json({
    total: assets.length,
    ip: assets.filter((a) => a.kind === 'ip').length,
    domain: assets.filter((a) => a.kind === 'domain').length,
    listed: count('listed'),
    informational: count('informational'),
    clean: count('clean'),
    unknown: count('unknown'),
    pending: count('pending'),
    coverage: { ip: ipCov, domain: domainCov },
  });
});

router.post('/assets', sec.requireRole('lead'), (req, res) => {
  const { target, intervalS } = req.body || {};
  if (!isStr(target, 300)) return httpError(res, 400, 'target required');
  const normalized = reputation.normalizeTarget(target);
  if (!normalized) {
    return httpError(res, 400, 'target must be an IP address or a domain name (no scheme or path)');
  }
  // Compare canonical keys, not raw strings: MAIL.example.com. and
  // mail.example.com are one asset, and so are 2001:0db8::1 and 2001:db8::1.
  const key = reputation.targetKey(normalized);
  const dup = listChecks.all(req.orgId).find((c) => reputation.targetKey(c.target) === key);
  if (dup) return httpError(res, 409, 'this target is already monitored');
  // shares the org's synthetic-check quota — it is the same underlying resource
  const lim = plans.checkLimit(req.orgId, req.org.plan, 'checks');
  if (!lim.ok) {
    return httpError(res, 402, `plan limit reached (${lim.used}/${lim.limit} checks) — upgrade your plan to add more`);
  }
  const minIv = floorFor(req.org.plan);
  const info = db.prepare(`INSERT INTO synthetic_checks
      (org_id, type, target, interval_s, timeout_ms, enabled, assertions, created_at)
    VALUES (?, 'reputation', ?, ?, ?, 1, NULL, ?)`)
    .run(req.orgId, normalized,
      clampInt(intervalS, minIv, MAX_INTERVAL_S, Math.max(DEFAULT_INTERVAL_S, minIv)),
      reputation.DEFAULT_TIMEOUT_MS, now());
  sec.audit(req.user.id, 'reputation_asset_create', normalized, req.orgId);
  res.json({ id: info.lastInsertRowid });
});

router.patch('/assets/:id', sec.requireRole('lead'), (req, res) => {
  const check = getCheck.get(req.params.id, req.orgId);
  if (!check) return httpError(res, 404, 'asset not found');
  const b = req.body || {};
  const minIv = floorFor(req.org.plan);
  db.prepare(`UPDATE synthetic_checks SET enabled = COALESCE(?, enabled),
      interval_s = COALESCE(?, interval_s) WHERE id = ? AND org_id = ?`)
    .run(typeof b.enabled === 'boolean' ? (b.enabled ? 1 : 0) : null,
      Number.isFinite(b.intervalS)
        ? clampInt(b.intervalS, minIv, MAX_INTERVAL_S, Math.max(DEFAULT_INTERVAL_S, minIv)) : null,
      check.id, req.orgId);
  sec.audit(req.user.id, 'reputation_asset_update', check.target, req.orgId);
  res.json({ ok: true });
});

router.delete('/assets/:id', sec.requireRole('lead'), (req, res) => {
  const check = getCheck.get(req.params.id, req.orgId);
  if (!check) return httpError(res, 404, 'asset not found');
  db.prepare('DELETE FROM synthetic_checks WHERE id = ? AND org_id = ?').run(check.id, req.orgId);
  sec.audit(req.user.id, 'reputation_asset_delete', check.target, req.orgId);
  res.json({ ok: true });
});

// Run one asset now. 31 zones at up to 3s each, so this can take a few seconds
// on a cold canary cache — the client shows a spinner rather than polling.
router.post('/assets/:id/run', sec.requireRole('lead'), async (req, res) => {
  const check = getCheck.get(req.params.id, req.orgId);
  if (!check) return httpError(res, 404, 'asset not found');
  try {
    const result = await synthEngine.runCheckNow(check);
    return res.json({ ok: true, result: toAsset(check), raw: { ok: result.ok } });
  } catch (e) {
    return httpError(res, 502, `lookup failed: ${String(e.message).slice(0, 200)}`);
  }
});

// The curated zone list, so the UI can explain what "19 of 31" actually covers.
router.get('/zones', (req, res) => {
  const shape = (z) => ({ name: z.name, zone: z.zone, tier: z.tier });
  res.json({ ip: reputation.IP_ZONES.map(shape), domain: reputation.DOMAIN_ZONES.map(shape) });
});

module.exports = router;
