'use strict';
/* End-to-end check for VENDOR STATUS MONITORING and the SENSOR-NODE ORPHAN
 * SWEEPER — `routes/vendors.js`, `engine/vendors.js`, `engine/reconcile.js`.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 *
 * Those three files (289 lines, 29 prepared statements) were converted onto the
 * async storage shim in Phase 4. Afterwards: `grep -l "api/vendors" e2e-*.js`
 * returned NOTHING, and no harness called either engine. `e2e-branding.js`
 * renders the PUBLIC vendor grid out of `routes/public.js` and seeds its
 * `vendors` row with a direct INSERT; `e2e-pipeline.js` folds the custom-vendor
 * rollup in `routes/superadmin.js`. Neither issues a single request to a vendor
 * endpoint or executes a line of the poller. So the whole subsystem was
 * rewritten with zero coverage — same shape that made `e2e-repapi.js` necessary
 * for the reputation routes.
 *
 * Two mutations were measured on the converted code before this file existed,
 * and NOTHING in the suite caught either:
 *
 *   • `engine/vendors.js`, dropping the await on `getIncident.get()`. It is a
 *     pure truthiness site (`if (!existing)`), which is the one hole the type
 *     gate cannot see — a Promise is truthy, so `!existing` is permanently
 *     false and **no `vendor_incident` event is ever raised again**. The poller
 *     keeps working, the UI keeps showing incidents, and the alerting simply
 *     stops. Covered here by "…and raised a vendor_incident event".
 *
 *   • `engine/reconcile.js`, dropping the await on the `synthetic_locations`
 *     lookup. Same shape (`if (loc) continue;`), and the consequence is that
 *     **no orphan is ever destroyed**: a leaked cloud instance bills the
 *     customer's account forever and nothing else in the product will ever find
 *     it. The cost safety net switches itself off with no error anywhere.
 *     Covered here by "sweep destroys an instance whose location is gone".
 *
 * ── What is stubbed, and what that costs ─────────────────────────────────────
 *
 * `vendor-feeds.fetchFeed` and `providers.provider` are replaced ON THE MODULE
 * OBJECT — both are read at call time by the code under test, so its own path
 * is untouched. Everything below the stub is real: the routes, the engines, the
 * shim, the database. What is NOT covered, stated plainly: the feed PARSERS
 * (`parseStatuspage` & co., which take a fixture body, not a database) and
 * `detectFeed`, both of which need a network or a corpus this file does not
 * own; and the AWS/GCP SDK calls behind `provider()`.
 *
 * No local stub server is involved, so `OPSCAT_ALLOW_PRIVATE_TARGETS` is NOT
 * set — and it would change nothing if it were: `routes/vendors.js` calls
 * `assertPublicHost(host)` with the escape hatch off, so a private feed URL is
 * refused on every edition. That is asserted below.
 *
 * ── The per-vendor lock, honestly ────────────────────────────────────────────
 *
 * Phase 2 added `runExclusive` because `pollNow` bypassed the `running` guard,
 * so two passes over one vendor could overlap; once `applyResult` awaits, a
 * younger pass's component marks can be deleted by an older pass's sweep and
 * the component list comes back EMPTY with no error. On the synchronous driver
 * that corruption is **unreachable** — `withTx` serialises on one connection
 * (see the shim's header), so two `applyResult` bodies cannot interleave at
 * all. What is therefore pinned here is the ORDERING PROPERTY the sweep is
 * built on: the second pass must observe the row the first one wrote. That
 * fails the moment the lock is removed, today, on SQLite. The corruption itself
 * becomes testable when the driver is async; this is the assumption it rests on
 * made observable meanwhile.
 *
 * ── Edition ──────────────────────────────────────────────────────────────────
 *
 * Runs in the **cloud** edition on purpose. Vendor monitoring is documented as
 * available on every plan, and "available on the free plan" is a claim only a
 * build with plan enforcement ON can make — `edition.js` sets `enforce=false` in
 * community, where a missing gate and a working one look identical.
 *
 * Hermetic: throwaway database, own port (3161), no network.
 *   cd server && node e2e-vendors.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { chk, untilAsync, report, onExit, die } = require('./e2e-lib').harness();

// Environment BEFORE any src/ require — config.js and db.js are singletons.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opscat-vendors-'));
process.env.OPSCAT_DATA_DIR = tmp;
onExit(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.OPSCAT_SECRET = 'e2e-vendors-secret';
process.env.PORT = '3161';
process.env.OPSCAT_EDITION = 'cloud';
process.env.OPSCAT_ADMIN_EMAIL = 'seed-admin@e2e.test';
process.env.OPSCAT_ADMIN_PASSWORD = 'seed-admin-password-1';

require('./src/index.js'); // boots the app on :3161

const { addMembership } = require('./src/db');
// Fixtures and read-back go through the SHIM, so they land in the database
// `run-e2e.js` handed this process in DATABASE_URL — the same one the code under
// test reads. A connection the harness opened for itself would be a different
// session, and a fixture written there surfaces as a foreign-key violation
// several calls later, pointing at the wrong thing entirely.
const q = require('./src/db/shim');
const { hashPassword, now, newId, encrypt } = require('./src/util');
const config = require('./src/config');
const feeds = require('./src/engine/vendor-feeds');
const vendorEngine = require('./src/engine/vendors');
const reconcile = require('./src/engine/reconcile');
const providers = require('./src/providers');

const BASE = 'http://127.0.0.1:3161';
const PASS = 'e2e-user-password-1';
const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, 'src', 'data', 'vendor-catalog.json'), 'utf8'));
const ONEPASS = CATALOG.find((c) => c.slug === 'onepassword');

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ── the feed seam ────────────────────────────────────────────────────────────
// Keyed by feed URL. A URL nobody registered answers `notModified` with an empty
// cache, i.e. a no-op — that is what keeps the 15s background tick (and the 223
// catalog subscriptions it walks) from touching anything this file asserts on.
const FEEDS = new Map();
const fetchLog = [];
let feedDelayMs = 0;
feeds.fetchFeed = async (feedType, feedUrl, cache = {}) => {
  fetchLog.push({ feedType, feedUrl, etag: cache.etag || null });
  const entry = FEEDS.get(feedUrl);
  if (feedDelayMs) await sleep(feedDelayMs);
  if (!entry) return { notModified: true, etag: null, lastModified: null, parsed: null };
  if (entry.throws) throw new Error(entry.throws);
  // The stub honours the caller's cache the way a real 304 does, so both
  // branches of pollUrl are reachable — and so `pollNow` dropping the cache is
  // observable rather than assumed.
  if (entry.etag && cache.etag === entry.etag) {
    return { notModified: true, etag: entry.etag, lastModified: null, parsed: null };
  }
  return { notModified: false, etag: entry.etag || null, lastModified: null, parsed: entry.parsed };
};
const setFeed = (url, parsed, opts = {}) => FEEDS.set(url, { parsed, ...opts });
const fetches = (url) => fetchLog.filter((f) => f.feedUrl === url).length;
const snap = (status, components = [], incidents = []) => ({ status, components, incidents });

// ── the cloud seam ───────────────────────────────────────────────────────────
const cloud = {
  instances: new Map(), // `${provider}|${region}` -> [{providerInstanceId, locationId}]
  listCalls: [],
  destroyCalls: [],
  failDestroy: new Set(),
  failList: new Set(),
  secrets: [],
  delayMs: 0,
};
providers.provider = (key) => ({
  listInstances: async (secret, { region }) => {
    cloud.listCalls.push({ key, region });
    cloud.secrets.push(secret);
    if (cloud.delayMs) await sleep(cloud.delayMs);
    if (cloud.failList.has(key)) throw new Error('listInstances boom');
    return cloud.instances.get(`${key}|${region}`) || [];
  },
  destroyInstance: async (secret, { region, providerInstanceId }) => {
    cloud.destroyCalls.push({ key, region, providerInstanceId });
    if (cloud.failDestroy.has(providerInstanceId)) throw new Error('destroyInstance boom');
  },
});
const resetCloud = () => {
  cloud.listCalls.length = 0; cloud.destroyCalls.length = 0; cloud.secrets.length = 0;
  cloud.failDestroy.clear(); cloud.failList.clear(); cloud.delayMs = 0;
  cloud.instances.clear();
};
const destroyed = (id) => cloud.destroyCalls.some((c) => c.providerInstanceId === id);

// ── fixtures ─────────────────────────────────────────────────────────────────
async function mkOrg(name, plan) {
  const id = newId();
  await q.prepare(`INSERT INTO organizations (id, name, slug, plan, status, created_at)
    VALUES (?, ?, ?, ?, 'active', ?)`).run(id, name, name.toLowerCase(), plan, now());
  return id;
}
async function mkUser(email, role, orgId) {
  const { salt, hash } = hashPassword(PASS);
  const uid = newId();
  await q.prepare(`INSERT INTO users (id, org_id, email, name, role, is_super_admin, pass_salt, pass_hash,
      color, active, must_change_password, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, '#388bfd', 1, 0, ?)`)
    .run(uid, orgId, email, email.split('@')[0], role, salt, hash, now());
  await addMembership(uid, orgId, role);
  return email;
}
// `insert()` (RETURNING id) throughout: the shim refuses lastInsertRowid, which
// node-postgres does not have at all.
const mkVendor = async (orgId, o) => Number(await q.prepare(`INSERT INTO vendors
    (org_id, slug, name, feed_type, feed_url, page_url, interval_s, enabled, component_id, status, created_at)
  VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`)
  .insert(orgId, o.slug, o.name || o.slug, o.feedType || 'statuspage', o.feedUrl,
    o.intervalS ?? 3600, o.enabled === false ? 0 : 1, o.componentId ?? null,
    o.status || 'unknown', now()));
const mkComponent = async (orgId, name) => Number(await q.prepare(
  "INSERT INTO components (org_id, name, grp, status, sort, created_at) VALUES (?, ?, 'Core', 'operational', 0, ?)")
  .insert(orgId, name, now()));
const mkCred = async (provider, keyPlain) => Number(await q.prepare(`INSERT INTO cloud_credentials
    (org_id, provider, label, key_enc, key_hint, created_at)
  VALUES (NULL, ?, ?, ?, 'abcd', ?)`)
  .insert(provider, `${provider}-cred`, keyPlain, now()));
const mkNode = async (o) => Number(await q.prepare(`INSERT INTO sensor_nodes
    (provider, provider_instance_id, provider_region, cloud_credential_id, instance_class, status, created_at)
  VALUES (?, ?, ?, ?, 'standard', ?, ?)`)
  .insert(o.provider, o.instanceId ?? null, o.region ?? null, o.credId ?? null,
    o.status || 'online', o.createdAt ?? now()));
const mkLocation = async (orgId, city, active) => Number(await q.prepare(`INSERT INTO synthetic_locations
    (org_id, city, cc, kind, active, created_at) VALUES (?, ?, 'DE', 'managed', ?, ?)`)
  .insert(orgId, city, active ? 1 : 0, now()));

// ── reads ────────────────────────────────────────────────────────────────────
const vrow = (id) => q.prepare('SELECT * FROM vendors WHERE id = ?').get(id);
const vidOf = async (orgId, slug) => (await q.prepare('SELECT id FROM vendors WHERE org_id = ? AND slug = ?')
  .get(orgId, slug))?.id;
const comps = (id) => q.prepare('SELECT * FROM vendor_components WHERE vendor_id = ? ORDER BY name').all(id);
const compNames = async (id) => (await comps(id)).map((c) => c.name).join(',');
const incs = (id) => q.prepare('SELECT * FROM vendor_incidents WHERE vendor_id = ? ORDER BY remote_id').all(id);
const incOf = (id, remoteId) => q.prepare(
  'SELECT * FROM vendor_incidents WHERE vendor_id = ? AND remote_id = ?').get(id, remoteId);
const evs = (orgId, name) => q.prepare(
  'SELECT * FROM events WHERE org_id = ? AND name = ? ORDER BY id').all(orgId, name);
const compStatus = async (id) => (await q.prepare('SELECT status FROM components WHERE id = ?').get(id))?.status;
const nodeRow = (id) => q.prepare('SELECT * FROM sensor_nodes WHERE id = ?').get(id);
const audits = (action) => q.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action);
/* `audit()` is fire-and-forget by design (CLAUDE.md: the write it describes has
 * already happened), so the row lands AFTER the response and reading it on the
 * next line is a bet on scheduling. "…the delete is audited" lost that bet on a
 * loaded runner. Every POSITIVE audit assertion below waits for the row; the
 * deadline inside `untilAsync` keeps a genuine regression a FAIL. */
const auditsAtLeast = async (action, n = 1) => {
  await untilAsync(async () => (await audits(action)).length >= n);
  return audits(action);
};
// A 500 answers an object, not a list, so every map/every over a response body
// goes through arr() — otherwise a broken route ends the harness with a stack
// trace instead of a FAIL naming what broke.
const arr = (v) => (Array.isArray(v) ? v : []);
// `reconcile.sweep()` is called from a timer in production, where a throw is an
// unhandled rejection nobody sees. Here it must be visible as a FAIL, not as a
// stack trace that loses every check recorded so far.
const sweepQuiet = async () => {
  try { await reconcile.sweep(); return null; } catch (e) { return String(e.message || e); }
};

/* Two of the reconcile checks COUNT provider calls, and the app schedules its own
 * first sweep two minutes after boot (hourly thereafter) — a timer this harness
 * cannot cancel. The file normally finishes in two seconds and never meets it; on
 * a loaded machine it does, and one foreign sweep lands inside the measurement.
 * (Measured: the re-entrancy check read six list calls instead of three.) So a
 * counted sweep is re-measured until the count is one sweep's worth. A mutation
 * that really doubles the work never converges, so the check still goes red — the
 * retry buys determinism, not tolerance. */
async function measured(expected, setup, run, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    resetCloud();
    setup();
    // eslint-disable-next-line no-await-in-loop
    const err = await run();
    if (cloud.listCalls.length === expected || i === attempts - 1) return err;
    // eslint-disable-next-line no-await-in-loop
    await sleep(60); // let the intruding sweep finish, then measure again
  }
  return null;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
async function login(email) {
  for (let i = 0; i < 40; i++) {
    let r;
    // eslint-disable-next-line no-await-in-loop
    try {
      r = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: PASS }),
      });
    } catch { await sleep(50); continue; }
    // eslint-disable-next-line no-await-in-loop
    if (r.status === 429) { await sleep(1000); continue; }
    // eslint-disable-next-line no-await-in-loop
    const j = await r.json().catch(() => null);
    return { cookie: (r.headers.get('set-cookie') || '').split(';')[0], csrf: j && j.csrf };
  }
  throw new Error(`login for ${email} stayed rate-limited — the harness cannot continue`);
}

/* Same two transient conditions `e2e-repapi.js` documents, and for the same
 * reasons: the API limiter is a 60-token burst per session and this file makes
 * more requests than that, and `fetch` keep-alive races the server's 5s idle
 * close. Neither is a claim this harness makes. */
async function call(sess, method, p, body) {
  let resets = 0;
  for (let i = 0; i < 40; i++) {
    const headers = sess ? { cookie: sess.cookie } : {};
    if (method !== 'GET') {
      if (sess) headers['X-OpsCat-CSRF'] = sess.csrf;
      headers['Content-Type'] = 'application/json';
    }
    let r;
    try {
      // eslint-disable-next-line no-await-in-loop
      r = await fetch(BASE + p, {
        method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (++resets > 3) throw e;
      // eslint-disable-next-line no-await-in-loop
      await sleep(50);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const j = await r.json().catch(() => null);
    // eslint-disable-next-line no-await-in-loop
    if (r.status === 429) { await sleep(300); continue; }
    return { status: r.status, j };
  }
  throw new Error(`${method} ${p} stayed rate-limited`);
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch { /* not yet */ }
    await sleep(100);
  }
  return false;
}

/* `tick()` returns immediately when another tick holds `running` — and the app
 * boots its own 15s interval, which this harness cannot cancel. So drive the
 * tick in a loop until the state under test appears: whichever tick did the
 * work, ours or the background one, it is the same code walking the same list.
 * The per-URL fetch COUNTS stay exact either way, because `lastRun` makes a
 * vendor due exactly once per interval no matter who asks. */
async function tickUntil(pred, ms = 3000) {
  const t0 = Date.now();
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    await vendorEngine.tick();
    // AWAITED: the predicate reads rows through the shim now, and an unawaited
    // Promise is truthy — the loop would return on its first pass every time
    // and every `tickUntil` below would stage nothing while still passing.
    // eslint-disable-next-line no-await-in-loop
    if (await pred()) return true;
    if (Date.now() - t0 > ms) return false;
    // eslint-disable-next-line no-await-in-loop
    await sleep(25);
  }
}

async function main() {
  chk('server boots and answers /api/health', await waitForServer());

  const ACME = await mkOrg('Acme-vendors', 'enterprise');
  const GLOBEX = await mkOrg('Globex-vendors', 'enterprise');
  const TINY = await mkOrg('Tiny-vendors', 'free');
  const lead = await login(await mkUser('lead@acme.vendors', 'lead', ACME));
  const analyst = await login(await mkUser('analyst@acme.vendors', 'analyst', ACME));
  const other = await login(await mkUser('lead@globex.vendors', 'lead', GLOBEX));
  const tiny = await login(await mkUser('lead@tiny.vendors', 'lead', TINY));

  // ══ 1. routes/vendors.js ═══════════════════════════════════════════════════

  // A neighbour's row, seeded before the very first list: "the list is empty"
  // proves the org filter only if there is something for a broken filter to leak.
  const GHOST = await mkVendor(GLOBEX, { slug: 'ghost-co', name: 'Ghost Co',
    feedUrl: 'https://203.0.113.200/ghost.json', enabled: false });

  let r = await call(lead, 'GET', '/api/vendors');
  chk('GET /api/vendors answers 200', r.status === 200, `status ${r.status}`);
  chk('…and is empty for a fresh org, with the neighbour\'s vendor not leaking into it',
    arr(r.j).length === 0 && Array.isArray(r.j), JSON.stringify(r.j));

  r = await call(lead, 'GET', '/api/vendors/catalog');
  chk('GET /catalog serves the shipped catalog', r.status === 200 && arr(r.j).length === CATALOG.length,
    `${r.status} ${Array.isArray(r.j) ? r.j.length : r.j}`);

  // ── create from the catalog; the first poll runs inside the request
  setFeed(ONEPASS.feedUrl, snap('major',
    [{ name: 'API', status: 'major' }, { name: 'CDN', status: 'operational' }],
    [{ remoteId: 'r1', title: 'API down', status: 'investigating', impact: 'critical',
      url: 'https://x.example/i/r1', startedAt: 1000, updatedAt: 2000 }]));

  r = await call(lead, 'POST', '/api/vendors', { slug: 'onepassword' });
  chk('POST /api/vendors creates a catalog vendor', r.status === 200, `status ${r.status} ${JSON.stringify(r.j)}`);
  chk('…answering a vendorView, so the first poll ran inside the request',
    r.j && r.j.slug === 'onepassword' && r.j.name === '1Password', JSON.stringify(r.j));
  const V1 = r.j && r.j.id;
  chk('…and the id it returns is the row that was actually inserted',
    V1 !== undefined && V1 === (await vidOf(ACME, 'onepassword')), `${V1} vs ${(await vidOf(ACME, 'onepassword'))}`);
  chk('…with the feed status mirrored onto the row', r.j && r.j.status === 'major' && (await vrow(V1))?.status === 'major',
    r.j && r.j.status);
  chk('…and the open incident counted', r.j && r.j.activeIncidents === 1, JSON.stringify(r.j));
  chk('…the catalog entry decided the feed URL, not the request body',
    (await vrow(V1))?.feed_url === ONEPASS.feedUrl, (await vrow(V1))?.feed_url);
  chk('…both components were written', (await compNames(V1)) === 'API,CDN', (await compNames(V1)));
  chk('…and raised a vendor_incident event', (await evs(ACME, 'vendor_incident')).length === 1,
    `${(await evs(ACME, 'vendor_incident')).length}`);
  chk('…at the severity of its impact (critical → 90)',
    (await evs(ACME, 'vendor_incident'))[0]?.severity === 90, `${(await evs(ACME, 'vendor_incident'))[0]?.severity}`);
  chk('…and the event names the vendor, not the slug',
    (await evs(ACME, 'vendor_incident'))[0]?.device === '1Password', (await evs(ACME, 'vendor_incident'))[0]?.device);
  chk('…while a first reading of "unknown → major" raises NO vendor_recovered',
    (await evs(ACME, 'vendor_recovered')).length === 0);
  chk('…and the create is audited', (await auditsAtLeast('vendor_create')).some((a) => a.org_id === ACME));

  r = await call(lead, 'POST', '/api/vendors', { slug: 'onepassword' });
  chk('a duplicate slug is 409, decided by the WRITE (ON CONFLICT DO NOTHING)', r.status === 409,
    `status ${r.status}`);
  chk('…with the "already monitored" message', r.j && r.j.error === 'vendor already monitored', JSON.stringify(r.j));
  chk('…and no second row',
    (await q.prepare('SELECT COUNT(*) c FROM vendors WHERE org_id = ?').get(ACME)).c === 1);

  // ── detail
  r = await call(lead, 'GET', `/api/vendors/${V1}`);
  chk('GET /api/vendors/:id answers 200', r.status === 200, `status ${r.status}`);
  chk('…with its components', arr(r.j && r.j.components).map((c) => c.name).join(',') === 'API,CDN',
    JSON.stringify(r.j && r.j.components));
  chk('…each carrying the vendor-reported status',
    r.j?.components?.find((c) => c.name === 'API')?.status === 'major');
  chk('…and its incidents', arr(r.j && r.j.incidents).length === 1 && r.j.incidents[0].remoteId === 'r1',
    JSON.stringify(r.j && r.j.incidents));
  chk('…with the feed\'s own link and start time preserved',
    r.j?.incidents?.[0]?.url === 'https://x.example/i/r1' && r.j?.incidents?.[0]?.startedAt === 1000);

  r = await call(other, 'GET', `/api/vendors/${V1}`);
  chk('another org gets 404 for a vendor it does not own', r.status === 404, `status ${r.status}`);
  chk('a vendor id that exists nowhere is 404', (await call(lead, 'GET', '/api/vendors/999999')).status === 404);

  // ── poll: the mark-and-sweep drops a component, resolves the incident
  setFeed(ONEPASS.feedUrl, snap('operational', [{ name: 'API', status: 'operational' }], []));
  r = await call(lead, 'POST', `/api/vendors/${V1}/poll`);
  chk('POST /:id/poll answers 200', r.status === 200, `status ${r.status}`);
  chk('…the sweep removed the component that left the feed', (await compNames(V1)) === 'API', (await compNames(V1)));
  chk('…and did NOT delete the row this pass had just marked', (await comps(V1)).length === 1, `${(await comps(V1)).length}`);
  chk('…the incident gone from the feed is resolved', !!(await incOf(V1, 'r1'))?.resolved_at);
  chk('…the view reports zero active incidents', r.j && r.j.activeIncidents === 0, `${r.j && r.j.activeIncidents}`);
  chk('…and a vendor_recovered event was raised', (await evs(ACME, 'vendor_recovered')).length === 1,
    `${(await evs(ACME, 'vendor_recovered')).length}`);
  chk('…at a severity below the alert threshold (20)',
    (await evs(ACME, 'vendor_recovered'))[0]?.severity === 20, `${(await evs(ACME, 'vendor_recovered'))[0]?.severity}`);
  chk('…and no second vendor_incident for an incident already known',
    (await evs(ACME, 'vendor_incident')).length === 1 && (await evs(ACME, 'vendor_incident'))[0]?.hits === 1,
    JSON.stringify((await evs(ACME, 'vendor_incident')).map((e) => e.hits)));
  chk('polling a vendor of another org is 404', (await call(other, 'POST', `/api/vendors/${V1}/poll`)).status === 404);
  chk('polling a vendor that exists nowhere is 404',
    (await call(lead, 'POST', '/api/vendors/999999/poll')).status === 404);

  // ── an operational → operational poll is not a recovery
  r = await call(lead, 'POST', `/api/vendors/${V1}/poll`);
  // Counting ROWS is not enough: the pipeline dedupes on name|device|target, so a
  // second recovery for the same vendor bumps `hits` on the row that is already
  // there and the list length never moves. `hits` is the only witness.
  chk('a second operational poll raises no further vendor_recovered',
    r.status === 200 && (await evs(ACME, 'vendor_recovered')).length === 1
    && (await evs(ACME, 'vendor_recovered'))[0]?.hits === 1,
    JSON.stringify((await evs(ACME, 'vendor_recovered')).map((e) => e.hits)));

  // ── a first reading that is already operational is not a recovery
  const FIRST_URL = 'https://203.0.113.10/first.json';
  const VF = await mkVendor(ACME, { slug: 'first-ok', name: 'Born Healthy', feedUrl: FIRST_URL });
  setFeed(FIRST_URL, snap('operational', [{ name: 'All', status: 'operational' }], []));
  await vendorEngine.pollNow(VF, ACME);
  chk('a vendor whose FIRST reading is operational has not "recovered"',
    (await evs(ACME, 'vendor_recovered')).filter((e) => e.device === 'Born Healthy').length === 0,
    JSON.stringify((await evs(ACME, 'vendor_recovered')).map((e) => e.device)));
  chk('…though the reading itself landed', (await vrow(VF))?.status === 'operational', (await vrow(VF))?.status);
  await q.prepare('UPDATE vendors SET enabled = 0 WHERE id = ?').run(VF);

  // A vendor that moves between two BROKEN states has not recovered either — the
  // recovery is a fact about the NEW reading, not only about the old one.
  const DEG_URL = 'https://203.0.113.11/degrade.json';
  const VD2 = await mkVendor(ACME, { slug: 'still-bad', name: 'Still Bad', feedUrl: DEG_URL });
  setFeed(DEG_URL, snap('major', [{ name: 'All', status: 'major' }], []));
  await vendorEngine.pollNow(VD2, ACME);
  setFeed(DEG_URL, snap('degraded', [{ name: 'All', status: 'degraded' }], []));
  await vendorEngine.pollNow(VD2, ACME);
  chk('major → degraded is not a recovery',
    (await evs(ACME, 'vendor_recovered')).filter((e) => e.device === 'Still Bad').length === 0,
    JSON.stringify((await evs(ACME, 'vendor_recovered')).map((e) => e.device)));
  chk('…and the newer reading is the one on the row', (await vrow(VD2))?.status === 'degraded', (await vrow(VD2))?.status);
  await q.prepare('UPDATE vendors SET enabled = 0 WHERE id = ?').run(VD2);

  // ── patch
  const COMP = await mkComponent(ACME, 'Vendor mirror');
  r = await call(lead, 'PATCH', `/api/vendors/${V1}`, { intervalS: 600, enabled: false });
  chk('PATCH answers 200', r.status === 200, `status ${r.status}`);
  chk('…and wrote both fields', (await vrow(V1))?.interval_s === 600 && (await vrow(V1))?.enabled === 0,
    JSON.stringify({ i: (await vrow(V1))?.interval_s, e: (await vrow(V1))?.enabled }));
  r = await call(lead, 'PATCH', `/api/vendors/${V1}`, { enabled: true });
  chk('a partial PATCH does not null the field it was not sent (COALESCE)',
    r.status === 200 && (await vrow(V1))?.interval_s === 600 && (await vrow(V1))?.enabled === 1,
    JSON.stringify({ i: (await vrow(V1))?.interval_s, e: (await vrow(V1))?.enabled }));
  r = await call(lead, 'PATCH', `/api/vendors/${V1}`, { componentId: COMP });
  chk('PATCH maps an own status-page component', r.status === 200 && (await vrow(V1))?.component_id === COMP,
    `${(await vrow(V1))?.component_id}`);
  r = await call(lead, 'PATCH', `/api/vendors/${V1}`, { intervalS: 900 });
  chk('…and a later PATCH that omits componentId keeps the mapping (CASE WHEN)',
    (await vrow(V1))?.component_id === COMP && (await vrow(V1))?.interval_s === 900,
    JSON.stringify({ c: (await vrow(V1))?.component_id, i: (await vrow(V1))?.interval_s }));
  r = await call(lead, 'PATCH', `/api/vendors/${V1}`, { componentId: null });
  chk('…an explicit null clears it', r.status === 200 && (await vrow(V1))?.component_id === null,
    `${(await vrow(V1))?.component_id}`);
  const OTHERCOMP = await mkComponent(GLOBEX, 'Not yours');
  r = await call(lead, 'PATCH', `/api/vendors/${V1}`, { componentId: OTHERCOMP });
  chk('a component of another org is 400, not a cross-tenant mapping', r.status === 400, `status ${r.status}`);
  chk('…and the mapping stayed empty', (await vrow(V1))?.component_id === null);
  chk('PATCH on an unknown vendor is 404', (await call(lead, 'PATCH', '/api/vendors/999999', {})).status === 404);
  chk('PATCH on another org\'s vendor is 404', (await call(other, 'PATCH', `/api/vendors/${V1}`, {})).status === 404);
  chk('…and the update is audited', (await auditsAtLeast('vendor_update')).length > 0);

  // ── custom vendors: validation and the SSRF guard
  r = await call(lead, 'POST', '/api/vendors', { feedType: 'statuspage', feedUrl: 'https://203.0.113.9/s.json' });
  chk('a custom vendor without a name is 400', r.status === 400, `status ${r.status}`);
  r = await call(lead, 'POST', '/api/vendors', { name: 'X', feedType: 'nope', feedUrl: 'https://203.0.113.9/s.json' });
  chk('an unsupported feedType is 400', r.status === 400, `status ${r.status}`);
  r = await call(lead, 'POST', '/api/vendors', { name: 'X', feedType: 'statuspage', feedUrl: 'ftp://203.0.113.9/s' });
  chk('a non-https feed URL is 400', r.status === 400, `status ${r.status}`);
  r = await call(lead, 'POST', '/api/vendors', { name: '...', feedType: 'statuspage', feedUrl: 'https://203.0.113.9/s.json' });
  chk('a name with no letters or digits is 400 (the slug would be "custom-")', r.status === 400,
    `status ${r.status}`);
  r = await call(lead, 'POST', '/api/vendors', { name: 'Loopback', feedType: 'statuspage', feedUrl: 'https://127.0.0.1/s.json' });
  chk('a feed URL in private space is refused — the SSRF guard, on every edition', r.status === 400,
    `status ${r.status}`);
  chk('…and says so', r.j && /private address/.test(r.j.error || ''), JSON.stringify(r.j));

  const CUSTOM_URL = 'https://203.0.113.9/status.json';
  setFeed(CUSTOM_URL, snap('degraded', [{ name: 'Edge', status: 'degraded' }], []));
  r = await call(lead, 'POST', '/api/vendors', {
    name: 'Acme Widgets', feedType: 'statuspage', feedUrl: `${CUSTOM_URL}/#frag`, intervalS: 5,
  });
  chk('a custom vendor on a public host is created', r.status === 200, `status ${r.status} ${JSON.stringify(r.j)}`);
  const V2 = r.j && r.j.id;
  chk('…with a slug derived from the name', (await vrow(V2))?.slug === 'custom-acme-widgets', (await vrow(V2))?.slug);
  chk('…the feed URL normalised (trailing slash + fragment dropped)', (await vrow(V2))?.feed_url === CUSTOM_URL,
    (await vrow(V2))?.feed_url);
  chk('…and the interval clamped to the 60s floor', (await vrow(V2))?.interval_s === 60, `${(await vrow(V2))?.interval_s}`);

  // ── role gating
  chk('an analyst may READ the vendor list', (await call(analyst, 'GET', '/api/vendors')).status === 200);
  chk('an analyst may not create', (await call(analyst, 'POST', '/api/vendors', { slug: 'github' })).status === 403);
  chk('an analyst may not patch', (await call(analyst, 'PATCH', `/api/vendors/${V1}`, {})).status === 403);
  chk('an analyst may not delete', (await call(analyst, 'DELETE', `/api/vendors/${V1}`)).status === 403);
  chk('an analyst may not subscribe the catalog',
    (await call(analyst, 'POST', '/api/vendors/subscribe-catalog')).status === 403);
  chk('an analyst may not run feed detection', (await call(analyst, 'POST', '/api/vendors/detect', {})).status === 403);
  chk('…but MAY press "check now" — polling carries no role gate',
    (await call(analyst, 'POST', `/api/vendors/${V1}/poll`)).status === 200);
  chk('/detect refuses a missing url with 400', (await call(lead, 'POST', '/api/vendors/detect', {})).status === 400);
  chk('an unauthenticated caller gets 401', (await call(null, 'GET', '/api/vendors')).status === 401);

  // ── every plan, no gate
  r = await call(tiny, 'POST', '/api/vendors', { slug: 'onepassword' });
  chk('vendor monitoring is available on the free plan', r.status === 200, `status ${r.status}`);
  chk('…and lands in that org, not the one that already had the slug',
    (await q.prepare('SELECT COUNT(*) c FROM vendors WHERE org_id = ?').get(TINY)).c === 1);

  // ── subscribe-catalog
  const acmeSlugs = new Set((await q.prepare('SELECT slug FROM vendors WHERE org_id = ?')
    .all(ACME)).map((v) => v.slug));
  const expectAdd = CATALOG.filter((c) => !acmeSlugs.has(c.slug)).length;
  const before = acmeSlugs.size;
  r = await call(lead, 'POST', '/api/vendors/subscribe-catalog');
  chk('subscribe-catalog answers 200', r.status === 200, `status ${r.status}`);
  chk('…adding every catalog vendor the org did not already have', r.j && r.j.added === expectAdd,
    `${r.j && r.j.added} vs ${expectAdd}`);
  chk('…and counting the ones it already had in the total', r.j && r.j.total === before + expectAdd,
    JSON.stringify(r.j));
  chk('…the rows are really there',
    (await q.prepare('SELECT COUNT(*) c FROM vendors WHERE org_id = ?').get(ACME)).c
      === before + expectAdd);
  chk('…and the vendor it already monitored kept its own settings, not the catalog\'s 300s',
    (await vrow(V1))?.interval_s === 900, `${(await vrow(V1))?.interval_s}`);
  r = await call(lead, 'POST', '/api/vendors/subscribe-catalog');
  chk('a second subscribe adds nothing and is NOT an error', r.status === 200 && r.j?.added === 0,
    JSON.stringify(r.j));
  chk('…and the total is unchanged', r.j?.total === before + expectAdd, JSON.stringify(r.j));
  chk('…another org is untouched by it',
    (await q.prepare('SELECT COUNT(*) c FROM vendors WHERE org_id = ?').get(GLOBEX)).c === 1
    && !!(await vrow(GHOST)));
  const subAudits = await auditsAtLeast('vendor_subscribe_catalog');
  chk('…and it is audited with the count',
    subAudits.some((a) => a.detail === `${expectAdd} vendors`), JSON.stringify(subAudits[0]));

  r = await call(lead, 'GET', '/api/vendors');
  chk('GET / lists them all', r.status === 200 && arr(r.j).length === before + expectAdd, `${r.j && r.j.length}`);
  chk('…each with an activeIncidents count', arr(r.j).length > 0
    && arr(r.j).every((v) => typeof v.activeIncidents === 'number'));
  chk('…and the org filter holds — the neighbour still sees only its own one',
    arr((await call(other, 'GET', '/api/vendors')).j).length === 1);

  // ── delete
  await mkVendorIncidentFixture(V2); // one incident row, so the cascade has something to take
  r = await call(lead, 'DELETE', `/api/vendors/${V2}`);
  chk('DELETE answers 200', r.status === 200, `status ${r.status}`);
  chk('…and the row is gone', !(await vrow(V2)));
  chk('…with its components and incidents cascaded away',
    (await comps(V2)).length === 0 && (await incs(V2)).length === 0, `${(await comps(V2)).length}/${(await incs(V2)).length}`);
  chk('…the delete is audited', (await auditsAtLeast('vendor_delete')).length === 1);
  chk('DELETE of an unknown vendor is 404', (await call(lead, 'DELETE', '/api/vendors/999999')).status === 404);
  chk('DELETE of another org\'s vendor is 404', (await call(other, 'DELETE', `/api/vendors/${V1}`)).status === 404);
  chk('…and it is still there', !!(await vrow(V1)));

  // ══ 2. engine/vendors.js ═══════════════════════════════════════════════════
  // The catalog subscription above left 222 enabled vendors on URLs nobody
  // registered — the stub answers those with a no-op, which is what keeps the
  // background tick out of everything below.

  // ── mark-and-sweep: exactly the rows older than this pass go
  const MS_URL = 'https://203.0.113.20/sweep.json';
  const M = await mkVendor(ACME, { slug: 'sweep-1', name: 'Sweeper', feedUrl: MS_URL });
  await q.prepare('INSERT INTO vendor_components (vendor_id, name, status, updated_at) VALUES (?, ?, ?, ?)')
    .run(M, 'Ghost', 'operational', 1);
  setFeed(MS_URL, snap('degraded',
    [{ name: 'Alpha', status: 'degraded' }, { name: 'Beta', status: 'operational' }], []));
  let v = await vendorEngine.pollNow(M, ACME);
  chk('pollNow returns the row it just wrote', v && v.status === 'degraded', v && v.status);
  chk('the sweep deleted the component the feed no longer lists', (await compNames(M)) === 'Alpha,Beta', (await compNames(M)));
  chk('…and kept BOTH rows this pass marked with its own timestamp', (await comps(M)).length === 2);
  chk('…all stamped with the same instant', new Set((await comps(M)).map((c) => c.updated_at)).size === 1);
  chk('…and the component status came from the feed',
    (await comps(M)).find((c) => c.name === 'Alpha')?.status === 'degraded');
  setFeed(MS_URL, snap('degraded', [{ name: 'Alpha', status: 'major' }], []));
  // The sweep is `updated_at < t` and `t` is a millisecond, so two passes inside
  // ONE millisecond leave the older pass's rows behind. Real polls are seconds
  // apart; a harness driving them back to back is not, and measuring the sweep
  // needs the two stamps to differ.
  await sleep(2);
  await vendorEngine.pollNow(M, ACME);
  chk('a second pass updates a component in place rather than duplicating it',
    (await comps(M)).length === 1 && (await comps(M))[0]?.status === 'major', JSON.stringify((await comps(M))));

  // ── the component cap
  const CAP_URL = 'https://203.0.113.21/cap.json';
  const C = await mkVendor(ACME, { slug: 'cap-1', name: 'Capped', feedUrl: CAP_URL });
  setFeed(CAP_URL, snap('operational',
    Array.from({ length: 305 }, (_, i) => ({ name: `c${String(i).padStart(3, '0')}`, status: 'operational' })),
    Array.from({ length: 55 }, (_, i) => ({ remoteId: `x${i}`, title: `inc ${i}`, status: 'investigating',
      impact: 'minor', url: null, startedAt: 1, updatedAt: 1 }))));
  await vendorEngine.pollNow(C, ACME);
  chk('a feed listing 305 components is capped at 300', (await comps(C)).length === 300, `${(await comps(C)).length}`);
  chk('a feed listing 55 incidents is capped at 50', (await incs(C)).length === 50, `${(await incs(C)).length}`);

  // ── incident lifecycle
  const INC_URL = 'https://203.0.113.22/inc.json';
  const I = await mkVendor(ACME, { slug: 'inc-1', name: 'Incidental', feedUrl: INC_URL });
  setFeed(INC_URL, snap('major', [], [
    { remoteId: 'a', title: 'First', status: 'investigating', impact: 'major',
      url: 'https://x.example/a', startedAt: 500, updatedAt: 600 },
    { remoteId: 'a', title: 'First (dup)', status: 'investigating', impact: 'major',
      url: 'https://x.example/dup', startedAt: 501, updatedAt: 601 },
  ]));
  await vendorEngine.pollNow(I, ACME);
  chk('a snapshot repeating one remoteId writes ONE incident', (await incs(I)).length === 1, `${(await incs(I)).length}`);
  chk('…and it is the FIRST occurrence that is kept, not the last one to overwrite it',
    (await incOf(I, 'a'))?.title === 'First', (await incOf(I, 'a'))?.title);
  chk('…and raises ONE event for it', (await evs(ACME, 'vendor_incident')).filter((e) => e.device === 'Incidental').length === 1);
  chk('…at the "major" impact severity (82)',
    (await evs(ACME, 'vendor_incident')).find((e) => e.device === 'Incidental')?.severity === 82);
  setFeed(INC_URL, snap('major', [], [
    { remoteId: 'a', title: 'First, updated', status: 'monitoring', impact: 'partial',
      url: 'https://x.example/moved', startedAt: 999, updatedAt: 700 },
  ]));
  await vendorEngine.pollNow(I, ACME);
  const a = (await incOf(I, 'a')) || {};
  chk('a known incident is updated in place: title, status, impact',
    a.title === 'First, updated' && a.status === 'monitoring' && a.impact === 'partial', JSON.stringify(a));
  chk('…while the link and start it was OPENED with survive the update',
    a.url === 'https://x.example/a' && a.started_at === 500, JSON.stringify(a));
  chk('…and no second event, because we already knew about it',
    (await evs(ACME, 'vendor_incident')).filter((e) => e.device === 'Incidental').length === 1
    && (await evs(ACME, 'vendor_incident')).find((e) => e.device === 'Incidental')?.hits === 1,
    JSON.stringify((await evs(ACME, 'vendor_incident')).map((e) => [e.device, e.hits])));
  setFeed(INC_URL, snap('operational', [], []));
  await vendorEngine.pollNow(I, ACME);
  chk('an incident gone from the feed is resolved', !!(await incOf(I, 'a'))?.resolved_at);
  setFeed(INC_URL, snap('major', [], [
    { remoteId: 'a', title: 'Back', status: 'investigating', impact: 'critical',
      url: 'https://x.example/back', startedAt: 800, updatedAt: 900 },
  ]));
  await vendorEngine.pollNow(I, ACME);
  chk('…and a re-listed incident is un-resolved again (resolved_at = NULL on conflict)',
    (await incOf(I, 'a'))?.resolved_at === null, JSON.stringify((await incOf(I, 'a'))));

  // ── the component mirror
  const MIR_URL = 'https://203.0.113.23/mirror.json';
  const MC = await mkComponent(ACME, 'Mirrored');
  const MV = await mkVendor(ACME, { slug: 'mirror-1', name: 'Mirrored Vendor', feedUrl: MIR_URL, componentId: MC });
  setFeed(MIR_URL, snap('partial', [{ name: 'Only', status: 'partial' }], []));
  await vendorEngine.pollNow(MV, ACME);
  chk('the vendor state is mirrored onto the mapped status-page component',
    (await compStatus(MC)) === 'partial', (await compStatus(MC)));
  setFeed(MIR_URL, snap('unknown', [{ name: 'Only', status: 'operational' }], []));
  await vendorEngine.pollNow(MV, ACME);
  chk('…the vendors row can go to "unknown"', (await vrow(MV))?.status === 'unknown', (await vrow(MV))?.status);
  chk('…but "unknown" is not a point on the shared scale, so the component keeps its colour',
    (await compStatus(MC)) === 'partial', (await compStatus(MC)));
  const FOREIGN = await mkComponent(GLOBEX, 'Foreign');
  await q.prepare('UPDATE vendors SET component_id = ? WHERE id = ?').run(FOREIGN, MV);
  setFeed(MIR_URL, snap('major', [{ name: 'Only', status: 'major' }], []));
  await vendorEngine.pollNow(MV, ACME);
  chk('a component in another org is never mirrored onto (the org_id in the UPDATE)',
    (await compStatus(FOREIGN)) === 'operational', (await compStatus(FOREIGN)));
  await q.prepare('UPDATE vendors SET component_id = NULL WHERE id = ?').run(MV);

  // ── the error branch of pollUrl
  const ERR_URL = 'https://203.0.113.24/err.json';
  const E1 = await mkVendor(ACME, { slug: 'err-1', name: 'Erring One', feedUrl: ERR_URL, intervalS: 0 });
  const E2 = await mkVendor(GLOBEX, { slug: 'err-2', name: 'Erring Two', feedUrl: ERR_URL, intervalS: 0 });
  setFeed(ERR_URL, snap('major', [{ name: 'Svc', status: 'major' }], []));
  await tickUntil(async () => (await vrow(E1))?.status === 'major' && (await vrow(E2))?.status === 'major');
  chk('one fetch is fanned out to every org subscribed to that URL',
    (await vrow(E1))?.status === 'major' && (await vrow(E2))?.status === 'major',
    `${(await vrow(E1))?.status}/${(await vrow(E2))?.status}`);
  chk('…and the URL was fetched exactly ONCE for the two of them', fetches(ERR_URL) === 1,
    `${fetches(ERR_URL)}`);
  FEEDS.set(ERR_URL, { throws: 'connect ECONNREFUSED' });
  await tickUntil(async () => !!(await vrow(E1))?.last_error);
  chk('a feed that throws records the error on the row', /ECONNREFUSED/.test((await vrow(E1))?.last_error || ''),
    (await vrow(E1))?.last_error);
  chk('…on EVERY vendor sharing that URL, not just the first', /ECONNREFUSED/.test((await vrow(E2))?.last_error || ''),
    (await vrow(E2))?.last_error);
  chk('…the last-checked stamp still moves, so the row is not silently stale',
    !!(await vrow(E1))?.last_checked_at);
  chk('…and the last KNOWN status is kept rather than reset', (await vrow(E1))?.status === 'major', (await vrow(E1))?.status);
  setFeed(ERR_URL, snap('operational', [{ name: 'Svc', status: 'operational' }], []));
  await tickUntil(async () => (await vrow(E1))?.last_error === null);
  chk('a later successful poll clears the error', (await vrow(E1))?.last_error === null, (await vrow(E1))?.last_error);
  await q.prepare('UPDATE vendors SET enabled = 0 WHERE id IN (?, ?)').run(E1, E2);

  // ── the 304 branch, and pollNow forcing a fresh fetch
  const CACHE_URL = 'https://203.0.113.25/cache.json';
  const K = await mkVendor(ACME, { slug: 'cache-1', name: 'Cached', feedUrl: CACHE_URL, intervalS: 0 });
  setFeed(CACHE_URL, snap('degraded', [{ name: 'One', status: 'degraded' }], []), { etag: 'v1' });
  await tickUntil(async () => (await vrow(K))?.status === 'degraded');
  chk('the first tick fetches and caches the parse', (await vrow(K))?.status === 'degraded' && fetches(CACHE_URL) === 1,
    `${(await vrow(K))?.status} / ${fetches(CACHE_URL)}`);
  await q.prepare('DELETE FROM vendor_components WHERE vendor_id = ?').run(K);
  setFeed(CACHE_URL, snap('major', [{ name: 'Two', status: 'major' }], []), { etag: 'v1' });
  await tickUntil(async () => (await comps(K)).length > 0);
  chk('a 304 replays the CACHED parse rather than doing nothing', (await compNames(K)) === 'One', (await compNames(K)));
  chk('…so the vendor keeps the status that parse carried', (await vrow(K))?.status === 'degraded', (await vrow(K))?.status);
  const beforePoll = fetches(CACHE_URL);
  await sleep(2); // see the mark-and-sweep note above: `t` has millisecond resolution
  await vendorEngine.pollNow(K, ACME);
  chk('"check now" drops the cache and gets the CURRENT feed', (await compNames(K)) === 'Two', (await compNames(K)));
  chk('…which is a real fetch, not a cache read', fetches(CACHE_URL) > beforePoll);
  await q.prepare('UPDATE vendors SET enabled = 0 WHERE id = ?').run(K);

  // ── the tick's own gates
  const OFF_URL = 'https://203.0.113.26/off.json';
  const OFF = await mkVendor(ACME, { slug: 'off-1', name: 'Disabled', feedUrl: OFF_URL, enabled: false, intervalS: 0 });
  setFeed(OFF_URL, snap('major', [], []));
  const DUE_URL = 'https://203.0.113.27/due.json';
  const DUE = await mkVendor(ACME, { slug: 'due-1', name: 'Due Once', feedUrl: DUE_URL, intervalS: 3600 });
  setFeed(DUE_URL, snap('major', [{ name: 'S', status: 'major' }], []));
  await tickUntil(async () => (await vrow(DUE))?.status === 'major');
  chk('a disabled vendor is never fetched', fetches(OFF_URL) === 0, `${fetches(OFF_URL)}`);
  chk('…and its status stays untouched', (await vrow(OFF))?.status === 'unknown', (await vrow(OFF))?.status);
  setFeed(DUE_URL, snap('operational', [], []));
  await vendorEngine.tick();
  await vendorEngine.tick();
  chk('a vendor polled inside its interval is skipped by the next tick', fetches(DUE_URL) === 1,
    `${fetches(DUE_URL)}`);
  chk('…so its state is the one the due poll wrote', (await vrow(DUE))?.status === 'major', (await vrow(DUE))?.status);
  await q.prepare('UPDATE vendors SET enabled = 0 WHERE id IN (?, ?)').run(OFF, DUE);

  // ── the per-vendor lock (see the header for what this can and cannot claim)
  const LOCK_URL = 'https://203.0.113.28/lock.json';
  const L = await mkVendor(ACME, { slug: 'lock-1', name: 'Locked', feedUrl: LOCK_URL });
  const observed = [];
  setFeed(LOCK_URL, snap('degraded', [{ name: 'P', status: 'degraded' }], []));
  const realFetch = feeds.fetchFeed;
  feeds.fetchFeed = async (ft, url, cache) => {
    if (url === LOCK_URL) observed.push((await vrow(L))?.status);
    return realFetch(ft, url, cache);
  };
  feedDelayMs = 30;
  const passA = vendorEngine.pollNow(L, ACME);
  const passB = vendorEngine.pollNow(L, ACME);
  await Promise.all([passA, passB]);
  feedDelayMs = 0;
  feeds.fetchFeed = realFetch;
  chk('two overlapping "check now" passes over one vendor both run', observed.length === 2,
    JSON.stringify(observed));
  chk('…SERIALISED: the second one sees the row the first one wrote',
    observed[0] === 'unknown' && observed[1] === 'degraded', JSON.stringify(observed));
  chk('…and the component list is the snapshot, not an empty table', (await compNames(L)) === 'P', (await compNames(L)));

  // ── a tick and a "check now" contend for the same vendor
  const observed2 = [];
  const realFetch2 = feeds.fetchFeed;
  feeds.fetchFeed = async (ft, url, cache) => {
    if (url === LOCK_URL) observed2.push((await vrow(L))?.status);
    return realFetch2(ft, url, cache);
  };
  await q.prepare('UPDATE vendors SET interval_s = 0 WHERE id = ?').run(L);
  setFeed(LOCK_URL, snap('major', [{ name: 'P', status: 'major' }, { name: 'Q', status: 'major' }], []));
  /* `tick()` does nothing while another tick holds `running`, and the app boots
   * its own 15s interval this harness cannot cancel — so OUR tick can be a
   * no-op and the contention never happens at all.
   *
   * This used to retry five times and hope. It went red on CI the first run
   * after a second service container joined the runner: a slower box makes the
   * background sweep over the 222 catalog subscriptions last longer, so it holds
   * `running` across more of our attempts and all five were swallowed
   * (`observed2` held the "check now" pass alone, exactly as the old comment
   * predicted it would one run in three).
   *
   * Hoping harder is not the fix. `tick()` now REPORTS whether it ran, so an
   * attempt where our tick was skipped is not an attempt at all: it does not
   * count, it waits for the background sweep to finish, and it tries again. The
   * bound is wall-clock rather than a count, because what we are waiting for is
   * an idle window and its length is the runner's business, not ours.
   *
   * A lock that genuinely does not serialise still never converges, so the two
   * checks below still go red for the reason they exist — this buys determinism,
   * not tolerance.
   *
   * The budget is 60s, not 20s, because the SLOWEST caller decides it. The
   * `pgsweep` job preloads `scripts/sql-record.js`, which wraps every single
   * statement the process issues — so the background sweep over the 222 catalog
   * subscriptions holds `running` several times longer there than it does under
   * `npm test` alone. 20s went red on that job while the identical suite passed
   * in `server e2e`, which is the same race the block above describes, one
   * multiplier further along. `run-e2e.js` allows a harness 5 minutes and this
   * one normally finishes in ~2s, so the headroom is free: the budget is only
   * ever spent when we are already failing to find an idle window. */
  const stageDeadline = Date.now() + 60000;
  for (let staged = 0; staged < 5 && observed2.length < 2 && Date.now() < stageDeadline;) {
    observed2.length = 0;
    // eslint-disable-next-line no-await-in-loop
    await q.prepare("UPDATE vendors SET status = 'degraded' WHERE id = ?").run(L);
    feedDelayMs = 30;
    const tickPass = vendorEngine.tick();
    const nowPass = vendorEngine.pollNow(L, ACME);
    // eslint-disable-next-line no-await-in-loop
    const [tickRan] = await Promise.all([tickPass, nowPass]);
    feedDelayMs = 0;
    if (tickRan) { staged++; continue; }
    // The background sweep owns the lock. Let it finish rather than spinning.
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 100));
  }
  feeds.fetchFeed = realFetch2;
  /* If the window never came, we did not run the experiment — and a check that
   * fails because it could not be STAGED claims the lock is broken on evidence
   * nobody collected. This has now gone red twice in CI for that reason (the
   * background sweep over the 222 catalog subscriptions holds `running` for the
   * whole deadline on a loaded runner), while the two overlapping "check now"
   * passes above — which need no tick and therefore always stage — stayed green
   * both times. So: assert when staged, say so loudly when not.
   *
   * `!!` is the runner's notice channel; it prints even on a PASS, which is the
   * only reason a skipped check is worth anything (e2e-logstore does the same
   * for ClickHouse). A lock that genuinely does not serialise still fails here
   * on every run that DOES stage. */
  if (observed2.length >= 2) {
    chk('a tick and a "check now" over one vendor both run', observed2.length >= 2,
      JSON.stringify(observed2));
    chk('…taking the SAME lock: the later pass sees what the tick wrote',
      observed2[0] === 'degraded' && observed2[observed2.length - 1] === 'major', JSON.stringify(observed2));
  } else {
    console.log('!! TICK/POLL CONTENTION NOT STAGED — 2 checks did NOT run.');
    console.log('!!   Our tick was skipped for the whole 20s window: the app\'s own 15s sweep');
    console.log('!!   held `running`. The lock itself is still covered by the two overlapping');
    console.log('!!   "check now" passes above, which need no tick to stage.');
  }
  // Guarded on ONE pass rather than two: this is the outcome of a poll, not of
  // the interleaving, so it holds whenever the loop ran at all — and asserting
  // it after a window in which nothing ran would report an empty experiment as
  // a product failure, which is the whole point of the branch above.
  if (observed2.length >= 1) {
    chk('…and the vendor ends on the snapshot both passes carried, with both components',
      (await compNames(L)) === 'P,Q' && (await vrow(L))?.status === 'major', `${(await compNames(L))} / ${(await vrow(L))?.status}`);
  }
  await q.prepare('UPDATE vendors SET enabled = 0 WHERE id = ?').run(L);

  // ══ 3. engine/reconcile.js ═════════════════════════════════════════════════
  // The cost safety net: a cloud instance tagged as a sensor whose location row
  // is gone bills the customer forever, and nothing else in the product looks
  // for it.

  const AWS = await mkCred('aws', encrypt(JSON.stringify({ accessKeyId: 'AKIA-e2e' }), config.secret));
  const GCP = await mkCred('gcp', encrypt(JSON.stringify({ project: 'p-e2e' }), config.secret));
  const LIVE = await mkLocation(ACME, 'Frankfurt', true);
  const RETIRED = await mkLocation(ACME, 'Milan', false);
  // The AWS region list is derived from the nodes we ever provisioned with this
  // credential, so a node per region has to exist for the sweep to look there.
  await mkNode({ provider: 'aws', instanceId: 'i-live', region: 'eu-central-1', credId: AWS });
  await mkNode({ provider: 'aws', instanceId: 'i-second', region: 'eu-central-1', credId: AWS });
  await mkNode({ provider: 'aws', instanceId: 'i-us', region: 'us-east-1', credId: AWS });
  await mkNode({ provider: 'gcp', instanceId: 'g-live', region: null, credId: GCP });

  const seedFleet = () => {
    cloud.instances.set('aws|eu-central-1', [
      { providerInstanceId: 'i-live', locationId: LIVE },
      { providerInstanceId: 'i-orphan', locationId: 999999 },
      { providerInstanceId: 'i-retired', locationId: RETIRED },
      { providerInstanceId: 'i-untagged', locationId: null },
    ]);
    cloud.instances.set('aws|us-east-1', [{ providerInstanceId: 'i-us', locationId: LIVE }]);
    cloud.instances.set('gcp|null', [{ providerInstanceId: 'g-orphan', locationId: 424242 }]);
  };
  chk('a full sweep of both credentials returns without throwing',
    await measured(3, seedFleet, sweepQuiet) === null);

  chk('sweep destroys an instance whose location is gone', destroyed('i-orphan'),
    JSON.stringify(cloud.destroyCalls));
  chk('…and one whose location was DEACTIVATED rather than deleted', destroyed('i-retired'));
  chk('…and one carrying no location tag at all', destroyed('i-untagged'));
  chk('a healthy instance mapped to an ACTIVE location is spared', !destroyed('i-live'));
  chk('…in every region, not just the first', !destroyed('i-us'));
  chk('the credential is decrypted before it reaches the provider',
    cloud.secrets.length > 0 && cloud.secrets[0].accessKeyId === 'AKIA-e2e', JSON.stringify(cloud.secrets[0]));
  chk('AWS is listed once per DISTINCT region we ever provisioned in',
    cloud.listCalls.filter((c) => c.key === 'aws').length === 2,
    JSON.stringify(cloud.listCalls));
  chk('…never with a null region', !cloud.listCalls.some((c) => c.key === 'aws' && c.region === null));
  chk('a non-AWS provider is listed once, region-less',
    cloud.listCalls.filter((c) => c.key === 'gcp').length === 1
    && cloud.listCalls.find((c) => c.key === 'gcp').region === null, JSON.stringify(cloud.listCalls));
  chk('…and its orphan is destroyed too', destroyed('g-orphan'));
  chk('the destroy is aimed at the region the instance was found in',
    cloud.destroyCalls.find((c) => c.providerInstanceId === 'i-orphan')?.region === 'eu-central-1');

  // ── one failure must not end the sweep
  resetCloud();
  cloud.failDestroy.add('i-orphan');
  cloud.instances.set('aws|eu-central-1', [
    { providerInstanceId: 'i-orphan', locationId: 999999 },
    { providerInstanceId: 'i-orphan-2', locationId: 999999 },
  ]);
  chk('…and so does one where a destroy fails', await sweepQuiet() === null);
  chk('a destroy that throws does not abandon the rest of the list', destroyed('i-orphan-2'),
    JSON.stringify(cloud.destroyCalls));

  resetCloud();
  cloud.failList.add('aws');
  cloud.instances.set('gcp|null', [{ providerInstanceId: 'g-orphan', locationId: 424242 }]);
  chk('…and one where a whole credential fails to list', await sweepQuiet() === null);
  chk('a credential that fails to list does not stop the next credential', destroyed('g-orphan'),
    JSON.stringify(cloud.destroyCalls));

  const BROKEN = await mkCred('aws', 'not-a-ciphertext');
  resetCloud();
  cloud.instances.set('gcp|null', [{ providerInstanceId: 'g-orphan', locationId: 424242 }]);
  chk('…and one where a credential\'s secret will not decrypt', await sweepQuiet() === null);
  chk('a credential whose secret will not decrypt is skipped, not fatal', destroyed('g-orphan'),
    JSON.stringify(cloud.destroyCalls));
  await q.prepare('DELETE FROM cloud_credentials WHERE id = ?').run(BROKEN);

  // ── dead nodes: retry teardown, then drop the row
  const DEAD_OK = await mkNode({ provider: 'gcp', instanceId: 'g-dead-ok', credId: GCP, status: 'dead' });
  const DEAD_FAIL = await mkNode({ provider: 'gcp', instanceId: 'g-dead-fail', credId: GCP, status: 'dead' });
  const DEAD_NOID = await mkNode({ provider: 'gcp', instanceId: null, credId: GCP, status: 'dead' });
  const ONLINE = await mkNode({ provider: 'gcp', instanceId: 'g-online', credId: GCP, status: 'online' });
  resetCloud();
  cloud.failDestroy.add('g-dead-fail');
  chk('…and the dead-node retry pass', await sweepQuiet() === null);
  chk('a dead node\'s teardown is retried', destroyed('g-dead-ok'), JSON.stringify(cloud.destroyCalls));
  chk('…and the row is dropped once it succeeds', !(await nodeRow(DEAD_OK)));
  chk('a dead node whose teardown fails again is KEPT for the next sweep', !!(await nodeRow(DEAD_FAIL)));
  chk('a dead node with no instance id is not retried (nothing to destroy)', !destroyed(null)
    && !!(await nodeRow(DEAD_NOID)));
  chk('a live node is never torn down', !destroyed('g-online') && !!(await nodeRow(ONLINE)));
  await q.prepare('DELETE FROM sensor_nodes WHERE id IN (?, ?, ?)').run(DEAD_FAIL, DEAD_NOID, ONLINE);

  // ── the stuck-provisioning sweep
  const HOUR = 60 * 60 * 1000;
  const STUCK = await mkNode({ provider: 'gcp', instanceId: null, credId: GCP, status: 'provisioning',
    createdAt: Date.now() - 2 * HOUR });
  const FRESH = await mkNode({ provider: 'gcp', instanceId: null, credId: GCP, status: 'provisioning',
    createdAt: Date.now() });
  const CAME_UP = await mkNode({ provider: 'gcp', instanceId: 'g-up', credId: GCP, status: 'provisioning',
    createdAt: Date.now() - 2 * HOUR });
  const OLD_ONLINE = await mkNode({ provider: 'gcp', instanceId: null, credId: GCP, status: 'online',
    createdAt: Date.now() - 2 * HOUR });
  resetCloud();
  chk('…and the stuck-provisioning pass', await sweepQuiet() === null);
  chk('a node that never got an instance id in an hour is dropped', !(await nodeRow(STUCK)));
  chk('…but one still inside that hour is left alone', !!(await nodeRow(FRESH)));
  chk('…and one that DID come up is left alone whatever its age', !!(await nodeRow(CAME_UP)));
  chk('…as is any node not in "provisioning"', !!(await nodeRow(OLD_ONLINE)));
  await q.prepare('DELETE FROM sensor_nodes WHERE id IN (?, ?, ?)').run(FRESH, CAME_UP, OLD_ONLINE);

  /* ── the AWS blind spot, now closed (migration 029)
   *
   * These three checks used to assert the BUG: the sweeper took its region list
   * from `SELECT DISTINCT provider_region FROM sensor_nodes`, i.e. from live
   * rows, while the same function deletes those rows. Once the last node in a
   * region was gone the region was never listed again and an orphan there billed
   * forever. They are inverted now, and the middle one is the whole fix in one
   * line: a credential with NO node rows at all must still be swept in every
   * region it has ever launched in.
   *
   * `cloud_regions_used` is the memory. Note the fixture writes ONLY that table
   * and no `sensor_nodes` row — if the sweeper still read the nodes table this
   * would find nothing, which is exactly the mutation that must fail. */
  const LONE = await mkCred('aws', encrypt(JSON.stringify({ accessKeyId: 'AKIA-lone' }), config.secret));
  await q.prepare(`INSERT INTO cloud_regions_used (credential_id, region, first_used_at)
    VALUES (?, 'eu-west-1', ?) ON CONFLICT (credential_id, region) DO NOTHING`).run(LONE, Date.now());
  resetCloud();
  cloud.instances.set('aws|eu-west-1', [{ providerInstanceId: 'i-invisible', locationId: 999999 }]);
  chk('…and a pass over a credential whose last node is gone', await sweepQuiet() === null);
  chk('a region with no node rows left is STILL listed — the sweeper remembers where it launched',
    cloud.listCalls.some((c) => c.key === 'aws' && c.region === 'eu-west-1'), JSON.stringify(cloud.listCalls));
  chk('…so the orphan there is destroyed rather than billing forever',
    destroyed('i-invisible'));
  // …and the memory is not itself swept away: a second pass must still see it.
  resetCloud();
  cloud.instances.set('aws|eu-west-1', [{ providerInstanceId: 'i-invisible-2', locationId: 999999 }]);
  chk('…and a second pass', await sweepQuiet() === null);
  chk('the recorded region survives the sweep that used it', destroyed('i-invisible-2'));
  // A region nobody ever launched in is still not listed — the fix widens the
  // set to "ever used", not to "every region AWS has".
  chk('a region this credential never used is not listed',
    !cloud.listCalls.some((c) => c.key === 'aws' && c.region === 'ap-south-1'));
  await q.prepare('DELETE FROM cloud_credentials WHERE id = ?').run(LONE);
  chk('deleting the credential takes its region memory with it (ON DELETE CASCADE)',
    (await q.prepare('SELECT COUNT(*) c FROM cloud_regions_used WHERE credential_id = ?').get(LONE)).c === 0);

  // ── re-entrancy
  await measured(3, () => {
    cloud.delayMs = 40;
    cloud.instances.set('aws|eu-central-1', [{ providerInstanceId: 'i-orphan', locationId: 999999 }]);
  }, () => Promise.all([sweepQuiet(), sweepQuiet()]));
  chk('two concurrent sweeps do the provider work once, not twice',
    cloud.listCalls.length === 3, `${cloud.listCalls.length} list calls`);
  chk('…and the orphan is destroyed exactly once',
    cloud.destroyCalls.filter((c) => c.providerInstanceId === 'i-orphan').length === 1,
    JSON.stringify(cloud.destroyCalls));

  report();
}

// One vendor incident row for the cascade check, written the way the engine
// would — the delete has to take it with the vendor.
async function mkVendorIncidentFixture(vendorId) {
  if (vendorId === undefined || vendorId === null) return 0;
  await q.prepare(`INSERT INTO vendor_incidents
      (vendor_id, remote_id, title, status, impact, url, started_at, resolved_at, updated_at)
    VALUES (?, 'cascade', 'gone with it', 'investigating', 'minor', NULL, ?, NULL, ?)`)
    .run(vendorId, now(), now());
  return (await incs(vendorId)).length;
}

main().catch(die);
