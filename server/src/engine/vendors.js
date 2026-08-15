'use strict';
// Third-party vendor status monitoring (supply-chain): poll the official
// status feeds of subscribed vendors, mirror their components + incidents,
// and raise vendor_incident / vendor_recovered events through the pipeline.
// Each unique feed URL is fetched ONCE per tick and fanned out to every org
// subscribed to it, so polling load is independent of the org count.
const { db } = require('../db');
const { now } = require('../util');
const pipeline = require('./pipeline');
const feeds = require('./vendor-feeds');

const getEnabled = db.prepare('SELECT * FROM vendors WHERE enabled = 1');
const setError = db.prepare('UPDATE vendors SET last_error = ?, last_checked_at = ? WHERE id = ?');
const setStatus = db.prepare('UPDATE vendors SET status = ?, last_error = NULL, last_checked_at = ? WHERE id = ?');
const upsertComp = db.prepare(`INSERT INTO vendor_components (vendor_id, name, status, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(vendor_id, name) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`);
const delStaleComps = db.prepare('DELETE FROM vendor_components WHERE vendor_id = ? AND updated_at < ?');
const getIncident = db.prepare('SELECT * FROM vendor_incidents WHERE vendor_id = ? AND remote_id = ?');
const insIncident = db.prepare(`INSERT INTO vendor_incidents
  (vendor_id, remote_id, title, status, impact, url, started_at, resolved_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`);
const updIncident = db.prepare(`UPDATE vendor_incidents SET title = ?, status = ?, impact = ?,
  resolved_at = NULL, updated_at = ? WHERE id = ?`);
const getOpenIncidents = db.prepare('SELECT id, remote_id FROM vendor_incidents WHERE vendor_id = ? AND resolved_at IS NULL');
const resolveIncident = db.prepare('UPDATE vendor_incidents SET resolved_at = ?, updated_at = ? WHERE id = ?');
const setMappedComponent = db.prepare('UPDATE components SET status = ? WHERE id = ? AND org_id = ?');

const MAX_COMPONENTS = 300; // bound per-vendor snapshot (some pages list one component per PoP)
const MAX_INCIDENTS = 50;

// event severity by vendor incident impact — 'minor' stays below the default
// alert threshold (60) and the case threshold, majors page.
const IMPACT_SEVERITY = { critical: 90, major: 82, partial: 75, degraded: 55, minor: 55, maintenance: 25, unknown: 65 };
const MAPPABLE = new Set(require('../lib/status-scale').ORDER);

function applyResult(vendor, parsed) {
  const t = now();
  const events = [];
  db.transaction(() => {
    for (const c of parsed.components.slice(0, MAX_COMPONENTS)) {
      upsertComp.run(vendor.id, c.name, c.status, t);
    }
    delStaleComps.run(vendor.id, t);

    const seen = new Set();
    for (const inc of parsed.incidents.slice(0, MAX_INCIDENTS)) {
      if (!inc.remoteId || seen.has(inc.remoteId)) continue;
      seen.add(inc.remoteId);
      const existing = getIncident.get(vendor.id, inc.remoteId);
      if (existing) {
        updIncident.run(inc.title, inc.status, inc.impact, inc.updatedAt || t, existing.id);
      } else {
        insIncident.run(vendor.id, inc.remoteId, inc.title, inc.status, inc.impact,
          inc.url, inc.startedAt || t, inc.updatedAt || t);
        events.push({
          name: 'vendor_incident', device: vendor.name, target: inc.title.slice(0, 200),
          severity: IMPACT_SEVERITY[inc.impact] || IMPACT_SEVERITY.unknown,
          description: `vendor_incident ${vendor.name} — ${inc.title} (${inc.impact || 'unknown'} impact)`.slice(0, 300),
        });
      }
    }
    // incidents gone from the feed are over — mark them resolved
    for (const open of getOpenIncidents.all(vendor.id)) {
      if (!seen.has(open.remote_id)) resolveIncident.run(t, t, open.id);
    }

    setStatus.run(parsed.status, t, vendor.id);
    if (parsed.status === 'operational' && vendor.status !== 'operational' && vendor.status !== 'unknown') {
      events.push({
        name: 'vendor_recovered', device: vendor.name, target: null, severity: 20,
        description: `vendor_recovered ${vendor.name} — status back to operational`,
      });
    }
    // mirror the vendor state onto the mapped own status-page component; the
    // uptime rollup + public page pick it up with zero extra plumbing
    if (vendor.component_id && MAPPABLE.has(parsed.status)) {
      setMappedComponent.run(parsed.status, vendor.component_id, vendor.org_id);
    }
  })();
  for (const ev of events) pipeline.ingestEvent(ev, 'vendors', false, vendor.org_id);
}

// ---- scheduler ---------------------------------------------------------------

const lastRun = new Map(); // vendorId -> ts
const feedCache = new Map(); // feedUrl -> {etag, lastModified, parsed, fetchedAt}
let running = false;

async function pollUrl(feedUrl, vendors) {
  const cache = feedCache.get(feedUrl) || {};
  let parsed;
  try {
    const res = await feeds.fetchFeed(vendors[0].feed_type, feedUrl, cache);
    if (res.notModified) {
      parsed = cache.parsed;
    } else {
      parsed = res.parsed;
      feedCache.set(feedUrl, { etag: res.etag, lastModified: res.lastModified, parsed, fetchedAt: now() });
    }
  } catch (e) {
    const msg = String(e.message || e).slice(0, 200);
    const t = now();
    for (const v of vendors) setError.run(msg, t, v.id);
    return;
  }
  if (!parsed) return;
  for (const v of vendors) {
    try { applyResult(v, parsed); } catch (e) { console.error('vendor apply error', v.slug, e.message); }
  }
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const t = now();
    const byUrl = new Map(); // fetch each unique feed URL once per tick
    for (const v of getEnabled.all()) {
      if (t - (lastRun.get(v.id) || 0) < v.interval_s * 1000) continue;
      lastRun.set(v.id, t);
      if (!byUrl.has(v.feed_url)) byUrl.set(v.feed_url, []);
      byUrl.get(v.feed_url).push(v);
    }
    await Promise.all([...byUrl.entries()].map(([url, vendors]) => pollUrl(url, vendors)));
  } catch (e) {
    console.error('vendor tick error', e.message);
  } finally { running = false; }
}

// Poll one vendor immediately (UI "check now" + right after create).
async function pollNow(vendorId, orgId) {
  const v = db.prepare('SELECT * FROM vendors WHERE id = ? AND org_id = ?').get(vendorId, orgId);
  if (!v) return null;
  lastRun.set(v.id, now());
  feedCache.delete(v.feed_url); // force a fresh fetch
  await pollUrl(v.feed_url, [v]);
  return db.prepare('SELECT * FROM vendors WHERE id = ?').get(v.id);
}

function start() {
  const iv = setInterval(tick, 15000);
  iv.unref();
}

module.exports = { start, tick, pollNow };
