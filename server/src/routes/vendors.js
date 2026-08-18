'use strict';
// Session-authenticated vendor monitoring API: catalog, subscriptions,
// per-vendor components + incident history. Available on every plan.
const express = require('express');
const path = require('path');
const fs = require('fs');
const q = require('../db/shim');
const { now, isStr, optStr, clampInt, httpError } = require('../util');
const sec = require('../security');
const vendorEngine = require('../engine/vendors');
const { FEED_TYPES, detectFeed } = require('../engine/vendor-feeds');
const { assertPublicHost } = require('../engine/synthetics');

const router = express.Router();
router.use(sec.requireSessionOrToken);

const CATALOG = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'vendor-catalog.json'), 'utf8'));
const bySlug = new Map(CATALOG.map((v) => [v.slug, v]));

const countActiveIncidents = q.prepare(
  'SELECT COUNT(*) c FROM vendor_incidents WHERE vendor_id = ? AND resolved_at IS NULL');
const getVendor = q.prepare('SELECT * FROM vendors WHERE id = ? AND org_id = ?');

async function vendorView(v) {
  return {
    id: v.id, slug: v.slug, name: v.name, feedType: v.feed_type, feedUrl: v.feed_url,
    pageUrl: v.page_url, intervalS: v.interval_s, enabled: !!v.enabled,
    componentId: v.component_id, status: v.status, lastCheckedAt: v.last_checked_at,
    lastError: v.last_error, activeIncidents: (await countActiveIncidents.get(v.id)).c,
  };
}

router.get('/', async (req, res) => {
  const rows = await q.prepare('SELECT * FROM vendors WHERE org_id = ? ORDER BY name').all(req.orgId);
  res.json(await Promise.all(rows.map((v) => vendorView(v))));
});

router.get('/catalog', (req, res) => res.json(CATALOG));

// The ':id' routes below carried an inline `(\\d+)` constraint until Express 5 —
// path-to-regexp v8 removed inline regex from path strings and THROWS at registration.
// Dropping it is safe: the literal routes ('/catalog', '/detect', '/subscribe-catalog')
// are declared before or on a different method than their ':id' counterpart, and a
// non-numeric id simply matches no row, so the handlers already answer 404.

router.get('/:id', async (req, res) => {
  const v = await getVendor.get(req.params.id, req.orgId);
  if (!v) return httpError(res, 404, 'vendor not found');
  const components = (await q.prepare(
    'SELECT name, status, updated_at FROM vendor_components WHERE vendor_id = ? ORDER BY name').all(v.id))
    .map((c) => ({ name: c.name, status: c.status, updatedAt: c.updated_at }));
  const incidents = (await q.prepare(
    'SELECT * FROM vendor_incidents WHERE vendor_id = ? ORDER BY COALESCE(started_at, updated_at) DESC LIMIT 50')
    .all(v.id))
    .map((i) => ({ id: i.id, remoteId: i.remote_id, title: i.title, status: i.status, impact: i.impact,
      url: i.url, startedAt: i.started_at, resolvedAt: i.resolved_at, updatedAt: i.updated_at }));
  res.json({ ...(await vendorView(v)), components, incidents });
});

// Normalize a feed URL so identical vendors entered by different orgs converge
// on one string — the poller dedupes fetches per exact feed_url.
function normalizeFeedUrl(raw) {
  const u = new URL(raw);
  u.hostname = u.hostname.toLowerCase();
  u.hash = '';
  u.pathname = u.pathname.replace(/\/+$/, '') || '/';
  return u.href;
}

// Auto-detect the machine-readable feed behind any status-page URL.
router.post('/detect', sec.requireRole('lead'), async (req, res) => {
  const { url } = req.body || {};
  if (!isStr(url, 500)) return httpError(res, 400, 'url required');
  try {
    const d = await detectFeed(url.trim());
    res.json({
      feedType: d.feedType, feedUrl: normalizeFeedUrl(d.feedUrl), pageUrl: d.pageUrl, name: d.name,
      preview: { status: d.parsed.status, components: d.parsed.components.length,
        incidents: d.parsed.incidents.length },
    });
  } catch (e) {
    httpError(res, 422, String(e.message || e).slice(0, 200));
  }
});

router.post('/', sec.requireRole('lead'), async (req, res) => {
  const b = req.body || {};
  let entry;
  if (isStr(b.slug, 80) && bySlug.has(b.slug)) {
    const c = bySlug.get(b.slug);
    entry = { slug: c.slug, name: c.name, feedType: c.feedType, feedUrl: c.feedUrl, pageUrl: c.pageUrl };
  } else {
    // custom vendor: any https status feed of a supported type
    if (!isStr(b.name, 120)) return httpError(res, 400, 'name required');
    if (!FEED_TYPES.includes(b.feedType)) return httpError(res, 400, `feedType must be one of ${FEED_TYPES.join(', ')}`);
    if (!isStr(b.feedUrl, 500)) return httpError(res, 400, 'feedUrl required');
    if (!optStr(b.pageUrl, 500)) return httpError(res, 400, 'bad pageUrl');
    let parsed;
    try { parsed = new URL(b.feedUrl); } catch { return httpError(res, 400, 'invalid feedUrl'); }
    if (parsed.protocol !== 'https:') return httpError(res, 400, 'feedUrl must be https');
    try { await assertPublicHost(parsed.hostname.replace(/^\[|\]$/g, '')); }
    catch (e) { return httpError(res, 400, e.message); }
    const slug = 'custom-' + b.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    if (slug === 'custom-') return httpError(res, 400, 'name must contain letters or digits');
    entry = { slug, name: b.name.trim(), feedType: b.feedType,
      feedUrl: normalizeFeedUrl(b.feedUrl), pageUrl: b.pageUrl || null };
  }
  // "Already monitored" is decided by the WRITE, not by an error string.
  // `String(e.message).includes('UNIQUE')` was better-sqlite3's wording for the
  // (org_id, slug) constraint; Postgres says `duplicate key value violates unique
  // constraint …`, so the 409 would have silently become a 500 the moment the
  // driver changed — and inside a transaction the 23505 takes the transaction
  // with it. DO NOTHING makes the duplicate a normal outcome and `changes` the
  // answer, which is also the same answer under a concurrent create.
  // `.insert()` carries BOTH facts the old `.run()` did: the shim appends
  // RETURNING id, and a DO NOTHING conflict returns no row — so `undefined` IS
  // `changes === 0`, decided by the write and not by an error string. It also
  // replaces `lastInsertRowid`, which the shim refuses (pg has no such field).
  const id = await q.prepare(`INSERT INTO vendors (org_id, slug, name, feed_type, feed_url, page_url,
    interval_s, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT (org_id, slug) DO NOTHING`)
    .insert(req.orgId, entry.slug, entry.name, entry.feedType, entry.feedUrl, entry.pageUrl,
      clampInt(b.intervalS, 60, 3600, 120), now());
  if (id === undefined) return httpError(res, 409, 'vendor already monitored');
  sec.audit(req.user.id, 'vendor_create', entry.slug, req.orgId);
  // first poll right away so the row shows a real status, but creation
  // succeeds even when the feed is briefly unreachable
  const polled = await vendorEngine.pollNow(id, req.orgId).catch(() => null);
  res.json(polled ? await vendorView(polled) : { id });
});

router.patch('/:id', sec.requireRole('lead'), async (req, res) => {
  const v = await getVendor.get(req.params.id, req.orgId);
  if (!v) return httpError(res, 404, 'vendor not found');
  const b = req.body || {};
  let componentChange = 0;
  let componentId = null;
  if (b.componentId !== undefined) {
    componentChange = 1;
    if (b.componentId !== null) {
      const comp = await q.prepare('SELECT id FROM components WHERE id = ? AND org_id = ?')
        .get(b.componentId, req.orgId);
      if (!comp) return httpError(res, 400, 'component not found');
      componentId = comp.id;
    }
  }
  await q.prepare(`UPDATE vendors SET interval_s = COALESCE(?, interval_s),
      enabled = COALESCE(?, enabled),
      component_id = CASE WHEN ? THEN ? ELSE component_id END
    WHERE id = ? AND org_id = ?`)
    .run(Number.isFinite(b.intervalS) ? clampInt(b.intervalS, 60, 3600, 120) : null,
      typeof b.enabled === 'boolean' ? (b.enabled ? 1 : 0) : null,
      componentChange, componentId, v.id, req.orgId);
  sec.audit(req.user.id, 'vendor_update', v.slug, req.orgId);
  res.json({ ok: true });
});

router.delete('/:id', sec.requireRole('lead'), async (req, res) => {
  const v = await getVendor.get(req.params.id, req.orgId);
  if (!v) return httpError(res, 404, 'vendor not found');
  await q.prepare('DELETE FROM vendors WHERE id = ? AND org_id = ?').run(v.id, req.orgId);
  sec.audit(req.user.id, 'vendor_delete', v.slug, req.orgId);
  res.json({ ok: true });
});

// Subscribe this org to every catalog vendor it doesn't monitor yet (used to
// seed the public vendor grid; also handy for "watch everything" orgs).
router.post('/subscribe-catalog', sec.requireRole('lead'), async (req, res) => {
  // The slug set used to be the gate as well as the count. As a gate it is a
  // check-then-insert against UNIQUE (org_id, slug) wrapped in a transaction
  // spanning the WHOLE catalog: two operators pressing this at once (or this and
  // a plain create) collide on one slug, and under Postgres that 23505 rolls back
  // every other vendor the batch had already inserted — 200+ subscriptions lost
  // to one duplicate. ON CONFLICT DO NOTHING makes the collision the no-op it
  // always meant to be, and `changes` counts what this call actually added.
  const before = (await q.prepare('SELECT COUNT(*) c FROM vendors WHERE org_id = ?').get(req.orgId)).c;
  const ins = q.prepare(`INSERT INTO vendors (org_id, slug, name, feed_type, feed_url, page_url,
    interval_s, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 300, 1, ?)
    ON CONFLICT (org_id, slug) DO NOTHING`);
  let added = 0;
  await q.withTx(async () => {
    for (const c of CATALOG) {
      // eslint-disable-next-line no-await-in-loop
      added += (await ins.run(req.orgId, c.slug, c.name, c.feedType, c.feedUrl, c.pageUrl, now())).changes;
    }
  });
  sec.audit(req.user.id, 'vendor_subscribe_catalog', `${added} vendors`, req.orgId);
  res.json({ added, total: before + added });
});

router.post('/:id/poll', async (req, res) => {
  try {
    const v = await vendorEngine.pollNow(parseInt(req.params.id, 10), req.orgId);
    if (!v) return httpError(res, 404, 'vendor not found');
    res.json(await vendorView(v));
  } catch (e) {
    httpError(res, 500, e.message);
  }
});

module.exports = router;
