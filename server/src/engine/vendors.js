'use strict';
// Third-party vendor status monitoring (supply-chain): poll the official
// status feeds of subscribed vendors, mirror their components + incidents,
// and raise vendor_incident / vendor_recovered events through the pipeline.
// Each unique feed URL is fetched ONCE per tick and fanned out to every org
// subscribed to it, so polling load is independent of the org count.
const q = require('../db/shim');
const { now } = require('../util');
const pipeline = require('./pipeline');
const feeds = require('./vendor-feeds');

const getEnabled = q.prepare('SELECT * FROM vendors WHERE enabled = 1');
const setError = q.prepare('UPDATE vendors SET last_error = ?, last_checked_at = ? WHERE id = ?');
const setStatus = q.prepare('UPDATE vendors SET status = ?, last_error = NULL, last_checked_at = ? WHERE id = ?');
const upsertComp = q.prepare(`INSERT INTO vendor_components (vendor_id, name, status, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(vendor_id, name) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`);
const delStaleComps = q.prepare('DELETE FROM vendor_components WHERE vendor_id = ? AND updated_at < ?');
const getIncident = q.prepare('SELECT * FROM vendor_incidents WHERE vendor_id = ? AND remote_id = ?');
// One statement for both branches. The read above it decides only whether this
// incident is NEW TO US, i.e. whether it is worth an event; the WRITE may not
// depend on that read, because `vendor_incidents` has a UNIQUE (vendor_id,
// remote_id) and a losing INSERT raises 23505 under Postgres — which aborts the
// ENCLOSING transaction, so one colliding remote_id would discard the whole
// snapshot, components and resolutions included. `url` and `started_at` are
// deliberately left alone on conflict: an episode keeps the start and the
// delisting/incident link it was opened with, exactly as the old UPDATE did.
const upsertIncident = q.prepare(`INSERT INTO vendor_incidents
  (vendor_id, remote_id, title, status, impact, url, started_at, resolved_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
  ON CONFLICT(vendor_id, remote_id) DO UPDATE SET
    title = excluded.title, status = excluded.status, impact = excluded.impact,
    resolved_at = NULL, updated_at = excluded.updated_at`);
const getOpenIncidents = q.prepare('SELECT id, remote_id FROM vendor_incidents WHERE vendor_id = ? AND resolved_at IS NULL');
const resolveIncident = q.prepare('UPDATE vendor_incidents SET resolved_at = ?, updated_at = ? WHERE id = ?');

const MAX_COMPONENTS = 300; // bound per-vendor snapshot (some pages list one component per PoP)
const MAX_INCIDENTS = 50;

// event severity by vendor incident impact — 'minor' stays below the default
// alert threshold (60) and the case threshold, majors page.
const IMPACT_SEVERITY = { critical: 90, major: 82, partial: 75, degraded: 55, minor: 55, maintenance: 25, unknown: 65 };
// The points of the shared scale a vendor state may be mirrored onto. `unknown`
// is the vendors table's "no reading yet", not a point on the scale, so it is
// the one value that must not reach a component.
const MAPPABLE = require('../lib/status-scale').ORDER;

// The mirror is DERIVED from the vendors row this pass just wrote, in one
// statement, instead of stamping the JS value that produced it. `parsed.status`
// is computed before the feed fetch is awaited and the two writes land in
// different tables, so a JS-held copy is a snapshot of a fact another writer may
// already have replaced — and `components.status` is the colour the PUBLIC
// status page prints, which nothing reads back and nobody sees go wrong.
// NOTE this column has a second writer (lib/incidents.js `setCompStatus`), and
// the two derive it by different rules; see the comment on the call site.
const mirrorComponent = q.prepare(`UPDATE components SET status = v.status
  FROM vendors v
  WHERE components.id = ? AND components.org_id = ? AND v.id = ?
    AND v.status IN (${MAPPABLE.map(() => '?').join(', ')})`);

async function applyResult(vendor, parsed) {
  const t = now();
  const events = [];
  await q.withTx(async () => {
    for (const c of parsed.components.slice(0, MAX_COMPONENTS)) {
      // eslint-disable-next-line no-await-in-loop
      await upsertComp.run(vendor.id, c.name, c.status, t);
    }
    await delStaleComps.run(vendor.id, t);

    const seen = new Set();
    for (const inc of parsed.incidents.slice(0, MAX_INCIDENTS)) {
      if (!inc.remoteId || seen.has(inc.remoteId)) continue;
      seen.add(inc.remoteId);
      // eslint-disable-next-line no-await-in-loop
      const existing = await getIncident.get(vendor.id, inc.remoteId);
      // eslint-disable-next-line no-await-in-loop
      await upsertIncident.run(vendor.id, inc.remoteId, inc.title, inc.status, inc.impact,
        inc.url, inc.startedAt || t, inc.updatedAt || t);
      if (!existing) {
        events.push({
          name: 'vendor_incident', device: vendor.name, target: inc.title.slice(0, 200),
          severity: IMPACT_SEVERITY[inc.impact] || IMPACT_SEVERITY.unknown,
          description: `vendor_incident ${vendor.name} — ${inc.title} (${inc.impact || 'unknown'} impact)`.slice(0, 300),
        });
      }
    }
    // incidents gone from the feed are over — mark them resolved
    for (const open of await getOpenIncidents.all(vendor.id)) {
      // eslint-disable-next-line no-await-in-loop
      if (!seen.has(open.remote_id)) await resolveIncident.run(t, t, open.id);
    }

    await setStatus.run(parsed.status, t, vendor.id);
    if (parsed.status === 'operational' && vendor.status !== 'operational' && vendor.status !== 'unknown') {
      events.push({
        name: 'vendor_recovered', device: vendor.name, target: null, severity: 20,
        description: `vendor_recovered ${vendor.name} — status back to operational`,
      });
    }
    // Mirror the vendor state onto the mapped own status-page component; the
    // uptime rollup + public page pick it up with zero extra plumbing. The value
    // and the `unknown` guard both come out of the vendors row in SQL — see
    // mirrorComponent. This still does NOT agree with lib/incidents.js, which
    // derives the same column from the open incidents alone: whichever writes
    // last wins, so a poll erases an incident's impact and the next incident
    // transition erases the vendor mirror. Reconciling them needs ONE derivation
    // both call, not a second copy of the other's subquery here.
    if (vendor.component_id) {
      await mirrorComponent.run(vendor.component_id, vendor.org_id, vendor.id, ...MAPPABLE);
    }
  });
  for (const ev of events) await pipeline.ingestEvent(ev, 'vendors', false, vendor.org_id);
}

// ---- scheduler ---------------------------------------------------------------

const lastRun = new Map(); // vendorId -> ts
const feedCache = new Map(); // feedUrl -> {etag, lastModified, parsed, fetchedAt}
let running = false; // guards tick against ANOTHER TICK — and nothing else

// What `running` was actually protecting is applyResult's mark-and-sweep, and it
// never protected it: `pollNow` (the UI's "check now", also fired right after a
// vendor is created) does not take it, so two passes over the SAME vendor
// already overlap today. That is harmless only for as long as applyResult is
// synchronous. The sweep stamps every component of the snapshot with `t` and
// then deletes the vendor's rows older than `t`; once there is an await between
// those two statements, a pass whose upserts land BEFORE an older pass's sweep
// has its marks deleted, and the vendor's component list — the detail page, and
// the state mirrored onto the status-page component — comes back EMPTY, with no
// error raised anywhere. Serialising per vendor is the assumption the timestamp
// sweep is built on; this is that assumption made to hold for both doors.
const vendorPass = new Map(); // vendorId -> promise of the pass holding that vendor

function runExclusive(vendors, fn) {
  const held = vendors.map((v) => vendorPass.get(v.id)).filter(Boolean);
  // allSettled, not all: a pass that failed still releases its vendors.
  const pass = (held.length ? Promise.allSettled(held) : Promise.resolve()).then(fn);
  const done = pass.catch(() => {});
  for (const v of vendors) vendorPass.set(v.id, done);
  done.then(() => {
    for (const v of vendors) if (vendorPass.get(v.id) === done) vendorPass.delete(v.id);
  });
  return pass;
}

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
    // eslint-disable-next-line no-await-in-loop
    for (const v of vendors) await setError.run(msg, t, v.id);
    return;
  }
  if (!parsed) return;
  for (const v of vendors) {
    // eslint-disable-next-line no-await-in-loop
    try { await applyResult(v, parsed); } catch (e) { console.error('vendor apply error', v.slug, e.message); }
  }
}

/**
 * One sweep over every due vendor.
 *
 * @returns {Promise<boolean>} false when another tick was already in flight and
 *   this call did nothing. `start()`'s interval ignores it — a skipped tick is
 *   the guard working, not an error — but a CALLER that needs the sweep to have
 *   actually happened cannot otherwise tell. `e2e-vendors` stages a tick racing
 *   a "check now" to prove they take the same per-vendor lock, and without this
 *   it could only guess whether its own tick took part: it retried blindly and
 *   went red on a loaded CI runner, where the background sweep over 222 catalog
 *   subscriptions holds `running` for longer and swallowed every attempt.
 */
async function tick() {
  if (running) return false;
  running = true;
  try {
    const t = now();
    const byUrl = new Map(); // fetch each unique feed URL once per tick
    for (const v of await getEnabled.all()) {
      if (t - (lastRun.get(v.id) || 0) < v.interval_s * 1000) continue;
      lastRun.set(v.id, t);
      if (!byUrl.has(v.feed_url)) byUrl.set(v.feed_url, []);
      byUrl.get(v.feed_url).push(v);
    }
    await Promise.all([...byUrl.entries()].map(
      ([url, vendors]) => runExclusive(vendors, () => pollUrl(url, vendors))));
  } catch (e) {
    console.error('vendor tick error', e.message);
  } finally { running = false; }
  return true;
}

// Poll one vendor immediately (UI "check now" + right after create).
async function pollNow(vendorId, orgId) {
  const v = await q.prepare('SELECT * FROM vendors WHERE id = ? AND org_id = ?').get(vendorId, orgId);
  if (!v) return null;
  lastRun.set(v.id, now());
  // Same lock as the tick, and the cache is dropped INSIDE it: dropping it while
  // another pass is mid-fetch would neither help this call nor stay dropped.
  await runExclusive([v], () => {
    feedCache.delete(v.feed_url); // force a fresh fetch
    return pollUrl(v.feed_url, [v]);
  });
  return await q.prepare('SELECT * FROM vendors WHERE id = ?').get(v.id);
}

function start() {
  // tick() catches internally, but an async timer callback whose promise nobody
  // holds turns any escape into an unhandledRejection — which NODE_ENV=test
  // makes a non-zero exit. Keep the rejection owned here.
  const iv = setInterval(() => { tick().catch((e) => console.error('vendor tick error', e.message)); }, 15000);
  iv.unref();
}

module.exports = { start, tick, pollNow };
