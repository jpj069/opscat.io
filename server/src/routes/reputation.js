'use strict';
// Reputation — blocklist monitoring for the org's sending assets.
//
// Its own feature, its own page, its own storage: `reputation_assets` with
// `reputation_runs` (the time series) and `reputation_listings` (the record of
// every episode of being listed). See engine/reputation.js for why those are two
// tables and docs/ARCHITECTURE.md for why they are not synthetic_checks rows.
const express = require('express');
const q = require('../db/shim');
const { now, isStr, clampInt, httpError } = require('../util');
const sec = require('../security');
const plans = require('../plans');
const reputation = require('../engine/reputation');

const router = express.Router();
router.use(sec.requireSessionOrToken);

const MAX_INTERVAL_S = 86400;      // 24h — blocklist state moves over hours
const DEFAULT_INTERVAL_S = 21600;  // 6h
// A reputation run costs ~93 DNS queries on a cold canary cache (31 zones plus
// both controls each) and 31 warm, against third-party lists that rate-limit per
// source IP — and blocklist state does not move in minutes. The floor is
// therefore this feature's own, NOT the plan's synthetic-check floor (15s/60s):
// a plan that allows fast HTTP checks must not turn a handful of assets into a
// query flood that gets the whole host refused by Spamhaus.
const MIN_INTERVAL_S = 3600;       // 1h

// The effective floor: this feature's minimum, never below the org's plan floor.
const floorFor = (plan) => Math.max(MIN_INTERVAL_S, plans.minIntervalFor(plan));

const listAssets = q.prepare('SELECT * FROM reputation_assets WHERE org_id = ? ORDER BY id');
const getAsset = q.prepare('SELECT * FROM reputation_assets WHERE id = ? AND org_id = ?');
const latestRun = q.prepare(
  'SELECT * FROM reputation_runs WHERE asset_id = ? ORDER BY ts DESC, id DESC LIMIT 1');
const openListings = q.prepare(`SELECT * FROM reputation_listings
  WHERE asset_id = ? AND resolved_at IS NULL ORDER BY
    CASE tier WHEN 'critical' THEN 0 WHEN 'standard' THEN 1 ELSE 2 END, name`);
const listingHistory = q.prepare(`SELECT * FROM reputation_listings
  WHERE asset_id = ? ORDER BY COALESCE(resolved_at, first_seen) DESC, id DESC LIMIT ?`);

const parseJson = (raw, fallback) => {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
};
const nameOf = (z) => (z && typeof z === 'object' ? z.name : z);

// A listing as the API speaks it. `firstSeen` is the whole point of the table:
// "on Spamhaus since the 3rd" is the first thing anyone asks, and the previous
// model — verdicts stored as samples — could not answer it.
const toListing = (l) => ({
  zone: l.zone,
  name: l.name,
  tier: l.tier,
  codes: parseJson(l.codes, []),
  url: l.url || null,
  // '' = the asset itself; otherwise the mail server this finding is about,
  // e.g. "mail4.link11.com [85.131.131.20]". A listed MX and a listed domain are
  // different problems with different fixes, so the UI must not merge them.
  subject: l.subject || null,
  firstSeen: l.first_seen,
  lastSeen: l.last_seen,
  resolvedAt: l.resolved_at,
});

// One asset as the UI wants it: what it is, whether it is listed, and why.
// `status` is the single field a table row renders from:
//   listed        - on a critical/standard list, alerting
//   informational - only on range/ASN-wide lists; recorded, never alerted
//   clean         - queried successfully, nothing found
//   unknown       - could not be checked (no reachable critical zone / error)
//   pending       - never run yet
async function toAsset(asset) {
  const run = await latestRun.get(asset.id);
  const listings = (await openListings.all(asset.id)).map(toListing);
  return {
    id: asset.id,
    target: asset.target,
    kind: asset.kind,
    rdns: asset.rdns || null,
    enabled: !!asset.enabled,
    intervalS: asset.interval_s,
    status: run ? run.status : 'pending',
    worstTier: run ? run.worst_tier : null,
    listings,
    // Stored with full per-zone detail, surfaced as names: that is the shape the
    // page renders, and it diffs them against GET /zones for the breakdown.
    policy: run ? parseJson(run.policy, []).map(nameOf) : [],
    unavailable: run ? parseJson(run.unavailable, []).map(nameOf) : [],
    errored: run ? parseJson(run.errored, []).map(nameOf) : [],
    zonesQueried: run ? run.zones_queried : null,
    zonesTotal: run ? run.zones_total : null,
    error: run ? run.error : null,
    lastCheckedAt: run ? run.ts : null,
    lastDurationMs: run ? run.duration_ms : null,
    // For a domain: the mail servers behind its MX records, each with its own
    // verdict. Empty for IP assets.
    mxHosts: run ? parseJson(run.mx_hosts, []) : [],
  };
}

// ---- assets -----------------------------------------------------------------

router.get('/assets', async (req, res) => {
  res.json(await Promise.all((await listAssets.all(req.orgId)).map(toAsset)));
});

router.get('/overview', async (req, res) => {
  const assets = await Promise.all((await listAssets.all(req.orgId)).map(toAsset));
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
  return res.json({
    total: assets.length,
    ip: assets.filter((a) => a.kind === 'ip').length,
    domain: assets.filter((a) => a.kind === 'domain').length,
    listed: count('listed'),
    informational: count('informational'),
    clean: count('clean'),
    unknown: count('unknown'),
    pending: count('pending'),
    coverage: { ip: coverageFor('ip'), domain: coverageFor('domain') },
  });
});

router.post('/assets', sec.requireRole('lead'), async (req, res) => {
  const { target, intervalS } = req.body || {};
  if (!isStr(target, 300)) return httpError(res, 400, 'target required');
  const normalized = reputation.normalizeTarget(target);
  if (!normalized) {
    return httpError(res, 400, 'target must be an IP address or a domain name (no scheme or path)');
  }
  const parsed = reputation.parseTarget(normalized);
  // Compare canonical keys, not raw strings: MAIL.example.com. and
  // mail.example.com are one asset, and so are 2001:0db8::1 and 2001:db8::1.
  const key = reputation.targetKey(normalized);
  const dup = (await listAssets.all(req.orgId)).find((a) => reputation.targetKey(a.target) === key);
  if (dup) return httpError(res, 409, 'this target is already monitored');
  // Shares the org's check budget — the `checks` counter in plans.js spans both
  // tables, so assets cannot be used to slip past the plan limit.
  const lim = await plans.checkLimit(req.orgId, req.org.plan, 'checks');
  if (!lim.ok) {
    return httpError(res, 402, `plan limit reached (${lim.used}/${lim.limit} checks) — upgrade your plan to add more`);
  }
  const minIv = floorFor(req.org.plan);
  // insert() rather than run().lastInsertRowid: better-sqlite3 reports one and
  // node-postgres has no such field, so the shim uses RETURNING id on both.
  const id = await q.prepare(`INSERT INTO reputation_assets
      (org_id, target, kind, rdns, interval_s, enabled, created_at)
    VALUES (?, ?, ?, NULL, ?, 1, ?)`)
    .insert(req.orgId, normalized, parsed.kind,
      clampInt(intervalS, minIv, MAX_INTERVAL_S, Math.max(DEFAULT_INTERVAL_S, minIv)), now());
  sec.audit(req.user.id, 'reputation_asset_create', normalized, req.orgId);
  res.json({ id });
});

router.patch('/assets/:id', sec.requireRole('lead'), async (req, res) => {
  const asset = await getAsset.get(req.params.id, req.orgId);
  if (!asset) return httpError(res, 404, 'asset not found');
  const b = req.body || {};
  const minIv = floorFor(req.org.plan);
  await q.prepare(`UPDATE reputation_assets SET enabled = COALESCE(?, enabled),
      interval_s = COALESCE(?, interval_s) WHERE id = ? AND org_id = ?`)
    .run(typeof b.enabled === 'boolean' ? (b.enabled ? 1 : 0) : null,
      Number.isFinite(b.intervalS)
        ? clampInt(b.intervalS, minIv, MAX_INTERVAL_S, Math.max(DEFAULT_INTERVAL_S, minIv)) : null,
      asset.id, req.orgId);
  // A shortened interval should take effect now, not after the old one elapses.
  reputation.resetSchedule(asset.id);
  sec.audit(req.user.id, 'reputation_asset_update', asset.target, req.orgId);
  res.json({ ok: true });
});

router.delete('/assets/:id', sec.requireRole('lead'), async (req, res) => {
  const asset = await getAsset.get(req.params.id, req.orgId);
  if (!asset) return httpError(res, 404, 'asset not found');
  // runs + listings cascade
  await q.prepare('DELETE FROM reputation_assets WHERE id = ? AND org_id = ?').run(asset.id, req.orgId);
  reputation.resetSchedule(asset.id);
  sec.audit(req.user.id, 'reputation_asset_delete', asset.target, req.orgId);
  res.json({ ok: true });
});

// Every episode of being listed, newest first — open ones and delisted ones.
// This is what the new model buys: the answer to "how long were we on Spamhaus
// in March", which a table of samples cannot give.
router.get('/assets/:id/history', async (req, res) => {
  const asset = await getAsset.get(req.params.id, req.orgId);
  if (!asset) return httpError(res, 404, 'asset not found');
  const limit = clampInt(req.query.limit, 1, 500, 100);
  res.json((await listingHistory.all(asset.id, limit)).map(toListing));
});

// Run one asset now. 31 zones at up to 3s each, so this can take a few seconds
// on a cold canary cache — the client shows a spinner rather than polling.
router.post('/assets/:id/run', sec.requireRole('lead'), async (req, res) => {
  const asset = await getAsset.get(req.params.id, req.orgId);
  if (!asset) return httpError(res, 404, 'asset not found');
  try {
    await reputation.runAsset(asset);
    // re-read: runAsset may have updated rdns and has written a new run
    return res.json({ ok: true, result: await toAsset(await getAsset.get(asset.id, req.orgId)) });
  } catch (e) {
    return httpError(res, 502, `lookup failed: ${String(e.message).slice(0, 200)}`);
  }
});

// ---- discovery ---------------------------------------------------------------

// Read a domain's SPF record and propose the senders worth watching. This is the
// step that makes the feature usable: the address that started this whole thread
// (a forgotten relay on a budget hoster, outside the company's own ASN) is only
// ever found by parsing the record — asking an operator to type it in by hand
// just relocates the problem.
//
// POST rather than GET because it performs a bounded fan-out of DNS queries, and
// lead-only for the same reason. It writes nothing.
router.post('/discover', sec.requireRole('lead'), async (req, res) => {
  const { domain } = req.body || {};
  if (!isStr(domain, 300)) return httpError(res, 400, 'domain required');
  let result;
  try {
    result = await reputation.discoverSpf(domain);
  } catch (e) {
    return httpError(res, 400, String(e.message).slice(0, 200));
  }
  // Mark what is already monitored so the UI can pre-select only the rest
  // instead of offering duplicates that would 409 one by one.
  const known = new Set((await listAssets.all(req.orgId)).map((a) => reputation.targetKey(a.target)));
  res.json({
    ...result,
    candidates: result.candidates.map((c) => ({
      ...c, alreadyMonitored: known.has(reputation.targetKey(c.target)),
    })),
  });
});

// Add several assets at once — the natural follow-up to discovery. Partial
// success is reported per target rather than failing the batch: one bad entry in
// a list of eight should not cost the other seven.
router.post('/assets/bulk', sec.requireRole('lead'), async (req, res) => {
  const targets = Array.isArray(req.body?.targets) ? req.body.targets.slice(0, 100) : null;
  if (!targets || !targets.length) return httpError(res, 400, 'expected {targets:[...]}');
  const minIv = floorFor(req.org.plan);
  const intervalS = clampInt(req.body?.intervalS, minIv, MAX_INTERVAL_S,
    Math.max(DEFAULT_INTERVAL_S, minIv));
  const ins = q.prepare(`INSERT INTO reputation_assets
      (org_id, target, kind, rdns, interval_s, enabled, created_at)
    VALUES (?, ?, ?, NULL, ?, 1, ?)`);

  const added = [];
  const skipped = [];
  for (const raw of targets) {
    const normalized = isStr(raw, 300) ? reputation.normalizeTarget(raw) : null;
    if (!normalized) { skipped.push({ target: String(raw).slice(0, 80), reason: 'not an IP or domain' }); continue; }
    const key = reputation.targetKey(normalized);
    // Re-read inside the loop: two targets in the same batch can collapse onto
    // one canonical key, and the earlier one is already in the table by then.
    if ((await listAssets.all(req.orgId)).some((a) => reputation.targetKey(a.target) === key)) {
      skipped.push({ target: normalized, reason: 'already monitored' });
      continue;
    }
    // Checked per row, not once up front: the budget is consumed as we go, so a
    // batch must stop at the limit rather than sail past it.
    const lim = await plans.checkLimit(req.orgId, req.org.plan, 'checks');
    if (!lim.ok) { skipped.push({ target: normalized, reason: `plan limit reached (${lim.used}/${lim.limit})` }); continue; }
    await ins.run(req.orgId, normalized, reputation.parseTarget(normalized).kind, intervalS, now());
    added.push(normalized);
  }
  if (added.length) sec.audit(req.user.id, 'reputation_asset_create', `${added.length} from SPF: ${added.join(', ')}`.slice(0, 300), req.orgId);
  res.json({ added, skipped });
});

// The curated zone list, so the UI can explain what "19 of 31" actually covers.
router.get('/zones', async (req, res) => {
  const shape = (z) => ({ name: z.name, zone: z.zone, tier: z.tier });
  res.json({ ip: reputation.IP_ZONES.map(shape), domain: reputation.DOMAIN_ZONES.map(shape) });
});

module.exports = router;
