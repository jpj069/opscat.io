'use strict';
/* End-to-end check for the REPUTATION HTTP API — all eight route handlers,
 * driven over HTTP the way the browser drives them.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 *
 * `src/routes/reputation.js` was the first subsystem converted onto the async
 * storage shim (Phase 4). Afterwards: `grep -l "api/reputation" e2e-*.js`
 * returned NOTHING. Reputation looked like the best-covered feature in the repo
 * at 124 checks — and every one of them drives the ENGINE directly, from a file
 * that boots no server and never issues a request. So 289 lines of freshly
 * rewritten handlers were covered by nothing: every org filter, every plan gate,
 * every role gate and the one `lastInsertRowid` -> `insert()` swap in the
 * feature. Breaking any of them left all 1031 other checks green.
 *
 * ── Why it is NOT part of e2e-reputation.js ──────────────────────────────────
 *
 * That file's first promise is that it is hermetic, and it keeps it by booting
 * no server: it requires the engine, hands it a stub resolver and asserts
 * against the database. Booting the real app there would start the reputation
 * scheduler — a 30s interval that calls the engine's OWN internal reference to
 * runAsset, which no test seam can reach — plus the synthetic, SNMP and alert
 * engines beside it, i.e. real DNS queries against real blocklists from the one
 * file that claims to make none. Two files, two claims: that one owns the
 * engine, this one owns the API.
 *
 * ── The resolver seam, stated plainly ────────────────────────────────────────
 *
 * `POST /assets/:id/run` and `POST /discover` call into the engine, and the
 * ROUTE passes no resolver — production resolves through `buildResolver()` and
 * the host's DNS. The engine documents an `injectedResolver` parameter for
 * exactly this reason (it is how e2e-reputation.js works), so this harness wraps
 * `reputation.runAsset` / `reputation.discoverSpf` ON THE MODULE OBJECT and
 * threads a stub through. The route's code path is untouched: it still calls the
 * same module function, still awaits it, still re-reads and re-renders the asset
 * afterwards. What is NOT covered by that, honestly: the production resolver
 * construction itself (`buildResolver`, OPSCAT_REPUTATION_DNS) — no HTTP test
 * can exercise it without querying a real blocklist.
 *
 * Belt and braces on top: the process's own resolver AND OPSCAT_REPUTATION_DNS
 * are pointed at loopback before anything is required, so a code path this file
 * did not stub cannot reach the network even by accident.
 *
 * ── Edition ──────────────────────────────────────────────────────────────────
 *
 * Runs in the **cloud** edition on purpose: `edition.js` sets `enforce=false` in
 * community, so a community harness cannot tell a working plan limit from a
 * missing one. The one check that asserts the self-hosted converse toggles
 * `plans.setEnforce(false)` around itself and says so where the claim is made.
 *
 * Hermetic: throwaway database, own port (3159), no network.
 *   cd server && node e2e-repapi.js
 */
const dns = require('dns');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { chk, untilAsync, report, onExit, die } = require('./e2e-lib').harness();

// Environment BEFORE any src/ require — config.js and db.js are singletons.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opscat-repapi-'));
process.env.OPSCAT_DATA_DIR = tmp;
onExit(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.OPSCAT_SECRET = 'e2e-repapi-secret';
process.env.PORT = '3159';
process.env.OPSCAT_EDITION = 'cloud';
process.env.OPSCAT_ADMIN_EMAIL = 'seed-admin@e2e.test';
process.env.OPSCAT_ADMIN_PASSWORD = 'seed-admin-password-1';
// Nothing here may query a blocklist. The engine's own resolver is configured to
// loopback (`net.isIP` accepts it, so it is used verbatim and never looked up),
// and the PROCESS resolver is too — `runAsset` reverse-resolves an IP asset
// through the global `dns.promises` when no resolver is injected.
process.env.OPSCAT_REPUTATION_DNS = '127.0.0.1';
dns.setServers(['127.0.0.1']);

require('./src/index.js'); // boots the app on :3159

const { addMembership } = require('./src/db');
// Fixtures and read-back go through the SHIM, so they land in the database
// `run-e2e.js` handed this process in DATABASE_URL — the same one the code under
// test reads. A connection the harness opened for itself would be a different
// session, and a fixture written there surfaces as a foreign-key violation
// several calls later, pointing at the wrong thing entirely.
const q = require('./src/db/shim');
const { hashPassword, now, newId, DEFAULT_ORG_ID } = require('./src/util');
const plans = require('./src/plans');
const rep = require('./src/engine/reputation');

const BASE = 'http://127.0.0.1:3159';
const PASS = 'e2e-user-password-1';

// ── the resolver seam ────────────────────────────────────────────────────────
// See the header. `RESOLVER` is set immediately before each call that reaches
// the engine; the wrappers are the only patch this file makes.
let RESOLVER = null;
const realRunAsset = rep.runAsset;
const realDiscover = rep.discoverSpf;
rep.runAsset = (asset, timeoutMs = 200) => realRunAsset(asset, timeoutMs, RESOLVER);
rep.discoverSpf = (domain, timeoutMs = 200) => realDiscover(domain, timeoutMs, RESOLVER);

// Keys are full query names ("2.0.0.127.zen.spamhaus.org"); a missing key is
// NXDOMAIN, which is what "not listed" looks like on the wire.
function stubResolver(table, extra = {}) {
  return {
    resolve4: async (name) => {
      const v = table[name];
      if (!v) { const e = new Error('queryA ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; }
      return v;
    },
    // A PTR the route can only report if it re-read the row AFTER the run.
    reverse: async () => ['mail.e2e.test'],
    ...extra,
  };
}
// Answer every zone's canary, so each one counts as usable (RFC 5782 §5).
const canaries = (zones, extra = {}) => {
  const t = { ...extra };
  for (const z of zones) {
    if (z.canary) t[`${z.canary}.${z.zone}`] = ['127.0.0.2'];
    else t[`2.0.0.127.${z.zone}`] = ['127.0.0.2'];
  }
  return t;
};

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
// `insert()` (RETURNING id) rather than lastInsertRowid: the shim refuses the
// latter, and node-postgres has no such field at all.
const mkAsset = async (orgId, target, kind, interval = 21600) => Number(await q.prepare(
  `INSERT INTO reputation_assets (org_id, target, kind, rdns, interval_s, enabled, created_at)
   VALUES (?, ?, ?, NULL, ?, 1, ?)`).insert(orgId, target, kind, interval, now()));
const mkRun = (assetId, o) => q.prepare(`INSERT INTO reputation_runs
    (asset_id, ts, status, zones_queried, zones_total, worst_tier, duration_ms,
     unavailable, errored, policy, error, mx_hosts)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .run(assetId, o.ts, o.status, o.queried ?? 0, o.total ?? 0, o.worst ?? null, o.ms ?? 12,
    o.unavailable ? JSON.stringify(o.unavailable) : null,
    o.errored ? JSON.stringify(o.errored) : null,
    o.policy ? JSON.stringify(o.policy) : null,
    o.error ?? null, o.mx ? JSON.stringify(o.mx) : null);
const mkListing = async (assetId, o) => Number(await q.prepare(`INSERT INTO reputation_listings
    (asset_id, zone, name, tier, codes, url, subject, first_seen, last_seen, resolved_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .insert(assetId, o.zone, o.name, o.tier, JSON.stringify(o.codes || ['127.0.0.2']),
    o.url ?? null, o.subject ?? '', o.firstSeen, o.lastSeen ?? o.firstSeen,
    o.resolvedAt ?? null));
const mkCheck = (orgId, target) => q.prepare(`INSERT INTO synthetic_checks
    (org_id, type, target, interval_s, timeout_ms, enabled, created_at)
  VALUES (?, 'http', ?, 60, 5000, 1, ?)`).run(orgId, target, now());

const assetRow = async (id) => (Number.isInteger(id)
  ? q.prepare('SELECT * FROM reputation_assets WHERE id = ?').get(id) : undefined);
// Fixtures address an asset by TARGET, never by the id the API just returned —
// that id is a thing under test, and wiring the fixtures to it would turn one
// wrong answer into a stack trace instead of one FAIL.
const idOf = async (orgId, target) => (await q.prepare(
  'SELECT id FROM reputation_assets WHERE org_id = ? AND target = ?').get(orgId, target))?.id;
const assetCount = async (orgId) => (await q.prepare(
  'SELECT COUNT(*) c FROM reputation_assets WHERE org_id = ?').get(orgId)).c;
const runCount = async (assetId) => (await q.prepare(
  'SELECT COUNT(*) c FROM reputation_runs WHERE asset_id = ?').get(assetId)).c;
const listingCount = async (assetId) => (await q.prepare(
  'SELECT COUNT(*) c FROM reputation_listings WHERE asset_id = ?').get(assetId)).c;
const audits = (action) => q.prepare(
  'SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action);

/* Wait for the audit trail to reach a row count, then return the rows.
 *
 * `audit()` keeps a SYNCHRONOUS call shape with an internal `.catch` — a
 * deliberate decision (CLAUDE.md § audit): the write it describes has already
 * happened, so failing the request because the audit row failed would report an
 * error for work that succeeded. The consequence for a harness is that the row
 * lands AFTER the response, and reading `audit_log` on the next line is a race.
 *
 * It is not a theoretical one. Under CPU load this file failed roughly one run
 * in six — "a bulk add is audited once, with the count" reporting the PREVIOUS
 * row's detail, and the count check that follows it seeing the late row and
 * disagreeing with a total taken a moment earlier. It went red on CI the first
 * time the runner had a second service container competing for the same cores.
 *
 * Same shape as e2e-incidents' alert-delivery assertions and for the same
 * reason. The deadline is what keeps a genuine regression a FAIL rather than a
 * hang: if the row never arrives, `until` gives up and the check fails on the
 * count it was always going to fail on.
 */
/* `untilAsync` (e2e-lib.js) rather than a loop of our own: the plain `until`
 * throws on a thenable by design, and this condition needs a database read. */
const auditsAtLeast = async (action, n) => {
  await untilAsync(async () => (await audits(action)).length >= n);
  return audits(action);
};

// ── HTTP ─────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function login(email) {
  for (let i = 0; i < 40; i++) {
    let r;
    // eslint-disable-next-line no-await-in-loop
    try { r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASS }),
    }); } catch { await sleep(50); continue; } // see `call` — a reset keep-alive socket
    // eslint-disable-next-line no-await-in-loop
    if (r.status === 429) { await sleep(1000); continue; }
    // eslint-disable-next-line no-await-in-loop
    const j = await r.json().catch(() => null);
    return { cookie: (r.headers.get('set-cookie') || '').split(';')[0], csrf: j && j.csrf };
  }
  throw new Error(`login for ${email} stayed rate-limited — the harness cannot continue`);
}

/* Two transient conditions are retried here, and neither is a claim this file
 * makes — a check that asserted on either would be asserting on the harness.
 *
 * 429: the API limiter is a 60-token burst refilling at 5/s PER SESSION, and
 * this file makes more requests than that against one session. A 429 is the
 * limiter working.
 *
 * ECONNRESET: `fetch` keeps connections alive, Node's server closes an idle one
 * after 5s, and a request written into that closing socket is reset. It only
 * shows up after a rate-limit sleep — i.e. exactly when a mutation makes the
 * suite slower — so left unhandled it turns a would-be FAIL into a stack trace
 * and no report at all. Retried on a fresh connection, never swallowed: a
 * server that is really gone still ends the harness.
 */
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
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch { /* not yet */ }
    await new Promise((res) => setTimeout(res, 100));
  }
  return false;
}

const arr = (v) => (Array.isArray(v) ? v : []);
// A 500 answers an object, not a list, so every map/some over a response body
// goes through arr() — otherwise a broken route ends the harness with a stack
// trace instead of a FAIL naming what broke.
const byTarget = (list, target) => (Array.isArray(list) ? list : []).find((a) => a.target === target);

async function main() {
  chk('server boots and answers /api/health', await waitForServer());

  const ACME = await mkOrg('Acme-repapi', 'enterprise');
  const GLOBEX = await mkOrg('Globex-repapi', 'enterprise');
  const TINY = await mkOrg('Tiny-repapi', 'free');
  const lead = await login(await mkUser('lead@acme.repapi', 'lead', ACME));
  const analyst = await login(await mkUser('analyst@acme.repapi', 'analyst', ACME));
  const other = await login(await mkUser('lead@globex.repapi', 'lead', GLOBEX));
  const tiny = await login(await mkUser('lead@tiny.repapi', 'lead', TINY));
  chk('the four tenant sessions are established',
    !!(lead.csrf && analyst.csrf && other.csrf && tiny.csrf));

  // ── GET /zones ─────────────────────────────────────────────────────────────
  const zones = await call(lead, 'GET', '/api/reputation/zones');
  chk('GET /zones answers 200', zones.status === 200, String(zones.status));
  chk('…with every IP zone', zones.j?.ip?.length === rep.IP_ZONES.length,
    `${zones.j?.ip?.length} of ${rep.IP_ZONES.length}`);
  chk('…and every domain zone', zones.j?.domain?.length === rep.DOMAIN_ZONES.length,
    `${zones.j?.domain?.length} of ${rep.DOMAIN_ZONES.length}`);
  chk('…shaped as {name, zone, tier} and nothing else',
    Array.isArray(zones.j?.ip) && zones.j.ip.every((z) => Object.keys(z).join(',') === 'name,zone,tier'
      && typeof z.zone === 'string' && typeof z.tier === 'string'));
  chk('/zones is readable below lead — it is a read',
    (await call(analyst, 'GET', '/api/reputation/zones')).status === 200);

  // ── auth ───────────────────────────────────────────────────────────────────
  chk('GET /assets without a session is 401',
    (await call(null, 'GET', '/api/reputation/assets')).status === 401);
  chk('POST /assets without a session is 401',
    (await call(null, 'POST', '/api/reputation/assets', { target: '198.51.100.1' })).status === 401);

  // ── POST /assets — creation ────────────────────────────────────────────────
  const create = (sess, body) => call(sess, 'POST', '/api/reputation/assets', body);

  const c1 = await create(lead, { target: ' 203.0.113.9 ' });
  chk('a lead creates an IP asset', c1.status === 200, `${c1.status} ${JSON.stringify(c1.j)}`);
  chk('…and gets an id back', Number.isInteger(c1.j?.id), JSON.stringify(c1.j));
  // The id comes from stmt.insert() (RETURNING id) now, not lastInsertRowid: it
  // must name the row that was actually written, not merely be a number.
  chk('the returned id IS the row that was inserted',
    (await assetRow(c1.j?.id))?.target === '203.0.113.9' && (await assetRow(c1.j?.id))?.org_id === ACME,
    JSON.stringify((await assetRow(c1.j?.id))));
  chk('…stored normalised (trimmed) and classified as an ip',
    (await assetRow(c1.j?.id))?.kind === 'ip');
  chk('…enabled, at the 6h default interval', (await assetRow(c1.j?.id))?.enabled === 1
    && (await assetRow(c1.j?.id))?.interval_s === 21600, String((await assetRow(c1.j?.id))?.interval_s));

  const c2 = await create(lead, { target: ' MAIL.Example.COM. ' });
  chk('a domain target is lower-cased and loses its root dot',
    c2.status === 200 && (await assetRow(c2.j?.id))?.target === 'mail.example.com',
    (await assetRow(c2.j?.id))?.target);
  chk('…and is classified as a domain', (await assetRow(c2.j?.id))?.kind === 'domain');

  const bad = await create(lead, { target: 'https://example.com/x' });
  chk('a URL is refused with 400', bad.status === 400, String(bad.status));
  chk('…and the message says what a target is', /IP address or a domain name/.test(bad.j?.error || ''),
    bad.j?.error);
  // The message matters, not just the status: without the isStr guard the empty
  // string falls through to normalizeTarget and 400s anyway, with the WRONG
  // reason — so a check on the status alone would not notice the guard leaving.
  const noTarget = await create(lead, {});
  chk('a missing target is refused as such',
    noTarget.status === 400 && noTarget.j?.error === 'target required',
    `${noTarget.status} ${noTarget.j?.error}`);
  const emptyTarget = await create(lead, { target: '' });
  chk('an empty target is refused as such',
    emptyTarget.status === 400 && emptyTarget.j?.error === 'target required',
    );

  chk('the same target twice is 409', (await create(lead, { target: '203.0.113.9' })).status === 409);
  const dup6a = await create(lead, { target: '2001:db8::1' });
  chk('an IPv6 asset is created, and stored as an ip',
    dup6a.status === 200 && (await assetRow(dup6a.j?.id))?.kind === 'ip',
    JSON.stringify([dup6a.status, (await assetRow(dup6a.j?.id))]));
  const dup6b = await create(lead, { target: '2001:0DB8:0000:0000:0000:0000:0000:0001' });
  chk('a second SPELLING of the same IPv6 is 409, not a second row',
    dup6b.status === 409 && (await assetCount(ACME)) === 3, `${dup6b.status}, ${(await assetCount(ACME))} assets`);

  const gate = await create(analyst, { target: '198.51.100.77' });
  chk('an analyst may not create (lead+)', gate.status === 403, String(gate.status));
  chk('…and nothing was written', (await assetCount(ACME)) === 3);

  // The floor is this feature's own 1h, never the plan's synthetic-check floor.
  const fast = await create(lead, { target: '198.51.100.11', intervalS: 60 });
  chk('an interval under 1h is raised to the floor', (await assetRow(fast.j?.id))?.interval_s === 3600,
    String((await assetRow(fast.j?.id))?.interval_s));
  const slow = await create(lead, { target: '198.51.100.12', intervalS: 999999 });
  chk('an interval over 24h is clamped down', (await assetRow(slow.j?.id))?.interval_s === 86400,
    String((await assetRow(slow.j?.id))?.interval_s));

  const created = await auditsAtLeast('reputation_asset_create', 5);
  chk('creating an asset writes one audit row naming the target',
    created.length === 5 && created[0]?.detail === '203.0.113.9', JSON.stringify(created.map((a) => a.detail)));
  chk('…in the acting org, not the default one',
    created.every((a) => a.org_id === ACME), created.map((a) => a.org_id).join(','));

  // ── GET /assets — the list, and the org filter ─────────────────────────────
  const foreign = await mkAsset(GLOBEX, '192.0.2.200', 'ip');
  const list = await call(lead, 'GET', '/api/reputation/assets');
  chk('GET /assets lists the org\'s assets', list.status === 200 && list.j?.length === 5,
    `${list.status}, ${list.j?.length} rows`);
  const fresh = byTarget(list.j, '203.0.113.9');
  chk('an asset that never ran reads as pending, with no listings',
    fresh?.status === 'pending' && fresh?.listings?.length === 0
    && fresh?.lastCheckedAt === null, JSON.stringify(fresh));
  // Tenant isolation is risk #1 of the whole port: the filter is a WHERE, and a
  // Promise is truthy, so a filter that stops filtering answers 200 with another
  // customer's estate in it.
  chk('another org\'s asset is not in the list', !byTarget(list.j, '192.0.2.200'),
    JSON.stringify(arr(list.j).map((a) => a.target)));
  const otherList = await call(other, 'GET', '/api/reputation/assets');
  chk('…and the filter holds in the other direction',
    otherList.j?.length === 1 && otherList.j?.[0]?.target === '192.0.2.200',
    JSON.stringify(otherList.j));

  // ── toAsset: the newest run, the open listings, the JSON columns ───────────
  const T = now();
  const rich = (await idOf(ACME, '203.0.113.9'));
  // The NEWER run is inserted FIRST, so a statement ordering by id instead of ts
  // returns the older one — the "latest result" bug e2e-pipeline.js names.
  await mkRun(rich, { ts: T - 1000, status: 'listed', queried: 28, total: 31, worst: 'critical',
    unavailable: [{ name: 'SORBS', zone: 'dnsbl.sorbs.net', tier: 'standard' }],
    errored: [{ name: 'PSBL', zone: 'psbl.surriel.com', tier: 'critical', error: 'timeout' }],
    policy: [{ name: 'Spamhaus ZEN', zone: 'zen.spamhaus.org', codes: ['127.0.0.10'] }],
    mx: [{ host: 'mx1.e2e.test', ip: '198.51.100.5', listed: 1, covered: true }] });
  await mkRun(rich, { ts: T - 9000, status: 'clean', queried: 31, total: 31 });
  await mkListing(rich, { zone: 'z.mailspike.net', name: 'Mailspike Z', tier: 'informational',
    firstSeen: T - 8000 });
  await mkListing(rich, { zone: 'zen.spamhaus.org', name: 'Spamhaus ZEN', tier: 'critical',
    codes: ['127.0.0.2', '127.0.0.4'], url: 'https://check.spamhaus.org/', firstSeen: T - 5000 });
  await mkListing(rich, { zone: 'bl.spamcop.net', name: 'SpamCop', tier: 'critical',
    firstSeen: T - 20000, resolvedAt: T - 10000 });

  const one = byTarget((await call(lead, 'GET', '/api/reputation/assets')).j, '203.0.113.9');
  chk('the asset renders the NEWEST run, not the newest row',
    one?.status === 'listed' && one?.lastCheckedAt === T - 1000, `${one?.status} @${one?.lastCheckedAt}`);
  chk('…with its tier and coverage', one?.worstTier === 'critical' && one?.zonesQueried === 28
    && one?.zonesTotal === 31, JSON.stringify([one?.worstTier, one?.zonesQueried, one?.zonesTotal]));
  chk('…the JSON zone columns surfaced as names',
    one?.policy?.join() === 'Spamhaus ZEN' && one?.unavailable?.join() === 'SORBS'
    && one?.errored?.join() === 'PSBL', JSON.stringify([one?.policy, one?.unavailable, one?.errored]));
  chk('…and mxHosts parsed as objects', one?.mxHosts?.[0]?.host === 'mx1.e2e.test',
    JSON.stringify(one?.mxHosts));
  chk('only OPEN listings ride along', one?.listings?.length === 2,
    JSON.stringify(one?.listings?.map((l) => l.zone)));
  chk('…critical first', one?.listings?.[0]?.zone === 'zen.spamhaus.org', one?.listings?.[0]?.zone);
  chk('…with the codes parsed and firstSeen carried',
    one?.listings?.[0]?.codes?.join() === '127.0.0.2,127.0.0.4'
    && one?.listings?.[0]?.firstSeen === T - 5000 && one?.listings?.[0]?.resolvedAt === null,
    JSON.stringify(one?.listings?.[0]));

  // ── GET /overview ──────────────────────────────────────────────────────────
  // Measured in GLOBEX, whose asset set is known exactly: one listed, one clean,
  // one domain that never ran.
  const gClean = await mkAsset(GLOBEX, '192.0.2.201', 'ip');
  const gPending = await mkAsset(GLOBEX, 'globex.test', 'domain');
  await mkRun(foreign, { ts: T - 2000, status: 'listed', queried: 29, total: 31, worst: 'standard',
    unavailable: [{ name: 'SORBS' }, { name: 'PSBL' }] });
  await mkRun(gClean, { ts: T - 2000, status: 'clean', queried: 31, total: 31 });
  const ov = await call(other, 'GET', '/api/reputation/overview');
  chk('GET /overview counts the org\'s assets by kind',
    ov.status === 200 && ov.j?.total === 3 && ov.j?.ip === 2 && ov.j?.domain === 1,
    JSON.stringify(ov.j));
  chk('…and by status', ov.j?.listed === 1 && ov.j?.clean === 1 && ov.j?.pending === 1
    && ov.j?.unknown === 0 && ov.j?.informational === 0, JSON.stringify(ov.j));
  chk('coverage reports the best-covered run and the real denominator',
    ov.j?.coverage?.ip?.queried === 31 && ov.j?.coverage?.ip?.total === rep.IP_ZONES.length,
    JSON.stringify(ov.j?.coverage?.ip));
  chk('…the worst unavailable count', ov.j?.coverage?.ip?.unavailable === 2,
    JSON.stringify(ov.j?.coverage?.ip));
  chk('…and null (not zero) for a kind that has never run',
    ov.j?.coverage?.domain?.queried === null && ov.j?.coverage?.domain?.total === null,
    JSON.stringify(ov.j?.coverage?.domain));
  chk('the overview counts nothing from another org',
    (await call(lead, 'GET', '/api/reputation/overview')).j?.total === 5,
    String((await call(lead, 'GET', '/api/reputation/overview')).j?.total));
  chk('/overview is readable below lead',
    (await call(analyst, 'GET', '/api/reputation/overview')).status === 200);

  // ── PATCH /assets/:id ──────────────────────────────────────────────────────
  const target = (await idOf(ACME, 'mail.example.com'));
  const patch = (sess, id, body) => call(sess, 'PATCH', `/api/reputation/assets/${id}`, body);

  chk('an analyst may not patch', (await patch(analyst, target, { enabled: false })).status === 403);
  const off = await patch(lead, target, { enabled: false });
  chk('a lead disables an asset', off.status === 200 && (await assetRow(target)).enabled === 0,
    `${off.status} enabled=${(await assetRow(target)).enabled}`);
  // COALESCE(?, col): sending ONE field must not null the other. Both halves are
  // asserted, because a broken COALESCE looks like a working PATCH from the side
  // you are testing.
  const iv = await patch(lead, target, { intervalS: 7200 });
  chk('patching only the interval leaves `enabled` alone',
    iv.status === 200 && (await assetRow(target)).interval_s === 7200 && (await assetRow(target)).enabled === 0,
    `interval=${(await assetRow(target)).interval_s} enabled=${(await assetRow(target)).enabled}`);
  const on = await patch(lead, target, { enabled: true });
  chk('patching only `enabled` leaves the interval alone',
    on.status === 200 && (await assetRow(target)).enabled === 1 && (await assetRow(target)).interval_s === 7200,
    `interval=${(await assetRow(target)).interval_s} enabled=${(await assetRow(target)).enabled}`);
  await patch(lead, target, { intervalS: 30 });
  chk('a patched interval is clamped to the 1h floor', (await assetRow(target)).interval_s === 3600,
    String((await assetRow(target)).interval_s));
  await patch(lead, target, { intervalS: 'nonsense' });
  chk('a non-numeric interval changes nothing', (await assetRow(target)).interval_s === 3600,
    String((await assetRow(target)).interval_s));

  const crossPatch = await patch(other, target, { enabled: false });
  chk('another org\'s asset is 404, not 403', crossPatch.status === 404, String(crossPatch.status));
  chk('…and it was not modified', (await assetRow(target)).enabled === 1);
  chk('an id that does not exist is 404', (await patch(lead, 999999, { enabled: false })).status === 404);
  const updated = await auditsAtLeast('reputation_asset_update', 1);
  chk('a patch is audited in the acting org, naming the target',
    updated.length >= 1 && updated[0]?.detail === 'mail.example.com' && updated[0]?.org_id === ACME,
    JSON.stringify(updated[0]));

  // ── GET /assets/:id/history ────────────────────────────────────────────────
  // Ordering is COALESCE(resolved_at, first_seen) DESC — an episode that ENDED
  // recently outranks one that STARTED longer ago. Ordering on first_seen alone
  // would put these in a different order, which is why the fixtures disagree.
  const hist = await mkAsset(ACME, '198.51.100.30', 'ip');
  await mkListing(hist, { zone: 'open.example', name: 'Open', tier: 'critical', firstSeen: T - 3000 });
  await mkListing(hist, { zone: 'recent.example', name: 'Recent', tier: 'standard',
    codes: ['127.0.0.2'], firstSeen: T - 9000, resolvedAt: T - 1000, subject: 'mx1 [1.2.3.4]' });
  await mkListing(hist, { zone: 'older.example', name: 'Older', tier: 'informational',
    firstSeen: T - 8000, resolvedAt: T - 5000 });

  const h = await call(lead, 'GET', `/api/reputation/assets/${hist}/history`);
  chk('GET /history answers 200 with every episode', h.status === 200 && h.j?.length === 3,
    `${h.status}, ${h.j?.length} rows`);
  chk('…newest first, by when the episode ENDED',
    arr(h.j).map((l) => l.zone).join() === 'recent.example,open.example,older.example',
    JSON.stringify(h.j));
  chk('…an open episode carries a null resolvedAt', h.j?.[1]?.resolvedAt === null, JSON.stringify(h.j?.[1]));
  chk('…a subject is carried through, and \'\' reads as null',
    h.j?.[0]?.subject === 'mx1 [1.2.3.4]' && h.j?.[1]?.subject === null,
    JSON.stringify([h.j?.[0]?.subject, h.j?.[1]?.subject]));
  const h2 = await call(lead, 'GET', `/api/reputation/assets/${hist}/history?limit=2`);
  chk('the limit is honoured', h2.j?.length === 2, String(h2.j?.length));
  const h0 = await call(lead, 'GET', `/api/reputation/assets/${hist}/history?limit=0`);
  chk('limit=0 clamps to 1 rather than returning nothing', h0.j?.length === 1, String(h0.j?.length));
  const hj = await call(lead, 'GET', `/api/reputation/assets/${hist}/history?limit=abc`);
  chk('a junk limit falls back to the default', hj.j?.length === 3, String(hj.j?.length));
  chk('history for another org\'s asset is 404',
    (await call(other, 'GET', `/api/reputation/assets/${hist}/history`)).status === 404);
  chk('history is readable below lead',
    (await call(analyst, 'GET', `/api/reputation/assets/${hist}/history`)).status === 200);

  // ── POST /assets/:id/run ───────────────────────────────────────────────────
  const runner = (await idOf(ACME, '203.0.113.9')); // 203.0.113.9 -> queried as 9.113.0.203.<zone>
  const runs0 = (await runCount(runner));
  rep.resetCanaryCache();
  RESOLVER = stubResolver(canaries(rep.IP_ZONES));
  const clean = await call(lead, 'POST', `/api/reputation/assets/${runner}/run`);
  chk('a lead runs an asset now', clean.status === 200 && clean.j?.ok === true,
    `${clean.status} ${JSON.stringify(clean.j?.error)}`);
  chk('…a run row is written', (await runCount(runner)) === runs0 + 1,
    `${runs0} -> ${(await runCount(runner))}`);
  chk('…and the response reports the fresh verdict',
    clean.j?.result?.status === 'clean' && clean.j?.result?.zonesQueried === rep.IP_ZONES.length,
    JSON.stringify([clean.j.result?.status, clean.j.result?.zonesQueried]));
  // rdns is written by runAsset INTO the row. It can only appear in the response
  // if the handler re-read the asset after the run rather than rendering the
  // copy it fetched before.
  chk('…re-read after the run: the new PTR is in the response',
    clean.j?.result?.rdns === 'mail.e2e.test', JSON.stringify(clean.j?.result?.rdns));

  rep.resetCanaryCache();
  RESOLVER = stubResolver(canaries(rep.IP_ZONES,
    { '9.113.0.203.zen.spamhaus.org': ['127.0.0.2'] }));
  const listedRun = await call(lead, 'POST', `/api/reputation/assets/${runner}/run`);
  chk('a listing is reported by the same call',
    listedRun.j?.result?.status === 'listed' && listedRun.j?.result?.worstTier === 'critical',
    JSON.stringify([listedRun.j?.result?.status, listedRun.j?.result?.worstTier]));
  chk('…and the episode it opened is in the response',
    arr(listedRun.j?.result?.listings).some((l) => l.zone === 'zen.spamhaus.org'),
    JSON.stringify(listedRun.j?.result?.listings));

  const runsBefore = (await runCount(runner));
  chk('running another org\'s asset is 404',
    (await call(other, 'POST', `/api/reputation/assets/${runner}/run`)).status === 404);
  chk('…and no run was recorded for it', (await runCount(runner)) === runsBefore);
  chk('an analyst may not run', (await call(analyst, 'POST', `/api/reputation/assets/${runner}/run`)).status === 403);

  rep.runAsset = async () => { throw new Error('resolver exploded'); };
  const boom = await call(lead, 'POST', `/api/reputation/assets/${runner}/run`);
  chk('an engine failure is a 502, not a 500', boom.status === 502, String(boom.status));
  chk('…carrying the reason', /lookup failed: resolver exploded/.test(boom.j?.error || ''), boom.j?.error);
  rep.runAsset = (asset, timeoutMs = 200) => realRunAsset(asset, timeoutMs, RESOLVER);

  // ── DELETE /assets/:id ─────────────────────────────────────────────────────
  const doomed = await mkAsset(ACME, '198.51.100.40', 'ip');
  await mkRun(doomed, { ts: T - 100, status: 'clean', queried: 31, total: 31 });
  await mkListing(doomed, { zone: 'gone.example', name: 'Gone', tier: 'critical', firstSeen: T - 100 });
  chk('an analyst may not delete',
    (await call(analyst, 'DELETE', `/api/reputation/assets/${doomed}`)).status === 403);
  // The org filter on DELETE is the one whose failure is destructive: without it
  // a lead in ANY org could delete this row by guessing its id.
  chk('deleting another org\'s asset is 404',
    (await call(other, 'DELETE', `/api/reputation/assets/${doomed}`)).status === 404);
  chk('…and the asset is still there', !!(await assetRow(doomed)));
  const del = await call(lead, 'DELETE', `/api/reputation/assets/${doomed}`);
  chk('a lead deletes its own asset', del.status === 200 && !(await assetRow(doomed)), String(del.status));
  chk('…and its runs and listings cascade with it',
    (await runCount(doomed)) === 0 && (await listingCount(doomed)) === 0,
    `${(await runCount(doomed))} runs, ${(await listingCount(doomed))} listings`);
  chk('…it is gone from the list',
    !byTarget((await call(lead, 'GET', '/api/reputation/assets')).j, '198.51.100.40'));
  const deleted = await auditsAtLeast('reputation_asset_delete', 1);
  chk('the deletion is audited by target in the acting org',
    deleted.length === 1 && deleted[0]?.detail === '198.51.100.40' && deleted[0]?.org_id === ACME,
    JSON.stringify(deleted[0]));
  chk('deleting an id that does not exist is 404',
    (await call(lead, 'DELETE', '/api/reputation/assets/999999')).status === 404);

  // ── POST /discover ─────────────────────────────────────────────────────────
  const SPF = {
    'acme.repapi.test': [['v=spf1 ip4:198.51.100.20 ip4:198.51.100.0/24 include:_spf.provider.test ~all']],
    '_spf.provider.test': [['v=spf1 ip4:203.0.113.77 -all']],
  };
  const txtResolver = {
    resolveTxt: async (name) => {
      const v = SPF[name];
      if (!v) { const e = new Error('queryTxt ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; }
      return v;
    },
  };
  const known = await create(lead, { target: '198.51.100.20' });
  chk('a discovered sender is monitored first, to test the diff', known.status === 200);

  RESOLVER = txtResolver;
  const assetsBefore = (await assetCount(ACME));
  const disc = await call(lead, 'POST', '/api/reputation/discover', { domain: 'acme.repapi.test' });
  chk('POST /discover answers 200', disc.status === 200, `${disc.status} ${JSON.stringify(disc.j)}`);
  chk('…proposing the record\'s own senders and the domain itself',
    !!byTarget(disc.j?.candidates, '198.51.100.20') && !!byTarget(disc.j?.candidates, 'acme.repapi.test'),
    JSON.stringify(disc.j?.candidates?.map((c) => c.target)));
  chk('…but not an include\'s addresses (that is the provider\'s pool)',
    !byTarget(disc.j?.candidates, '203.0.113.77') && disc.j?.pools?.[0]?.include === '_spf.provider.test',
    JSON.stringify(disc.j?.pools));
  chk('…a real range is reported as a range, not an asset',
    disc.j?.ranges?.[0]?.range === '198.51.100.0/24', JSON.stringify(disc.j?.ranges));
  chk('an already-monitored candidate is marked',
    byTarget(disc.j?.candidates, '198.51.100.20')?.alreadyMonitored === true,
    JSON.stringify(disc.j?.candidates));
  chk('…and an unmonitored one is not',
    byTarget(disc.j?.candidates, 'acme.repapi.test')?.alreadyMonitored === false,
    JSON.stringify(disc.j?.candidates));
  chk('discover writes nothing', (await assetCount(ACME)) === assetsBefore, String((await assetCount(ACME))));

  // The same record, asked for by the OTHER tenant: what Acme monitors is none
  // of Globex's business, and a lost org filter here leaks Acme's estate one
  // boolean at a time.
  RESOLVER = txtResolver;
  const discOther = await call(other, 'POST', '/api/reputation/discover', { domain: 'acme.repapi.test' });
  chk('alreadyMonitored is org-scoped',
    byTarget(discOther.j?.candidates, '198.51.100.20')?.alreadyMonitored === false,
    JSON.stringify(discOther.j?.candidates));

  const noDomain = await call(lead, 'POST', '/api/reputation/discover', {});
  chk('discover without a domain is 400, by its own guard',
    noDomain.status === 400 && noDomain.j?.error === 'domain required',
    `${noDomain.status} ${noDomain.j?.error}`);
  RESOLVER = txtResolver;
  const notDomain = await call(lead, 'POST', '/api/reputation/discover', { domain: 'https://x/y' });
  chk('a target that is not a domain is 400 with the engine\'s reason',
    notDomain.status === 400 && /a domain name is required/.test(notDomain.j?.error || ''),
    `${notDomain.status} ${notDomain.j?.error}`);
  chk('an analyst may not discover',
    (await call(analyst, 'POST', '/api/reputation/discover', { domain: 'acme.repapi.test' })).status === 403);

  // ── POST /assets/bulk ──────────────────────────────────────────────────────
  const bulk = (sess, body) => call(sess, 'POST', '/api/reputation/assets/bulk', body);
  const noList = await bulk(lead, {});
  chk('bulk with no targets is 400, naming the shape it wants',
    noList.status === 400 && noList.j?.error === 'expected {targets:[...]}',
    `${noList.status} ${noList.j?.error}`);
  chk('bulk with an empty list is 400', (await bulk(lead, { targets: [] })).status === 400);
  chk('an analyst may not bulk-create',
    (await bulk(analyst, { targets: ['198.51.100.90'] })).status === 403);

  const auditsBefore = (await audits('reputation_asset_create')).length;
  const b = await bulk(lead, {
    targets: [
      '203.0.113.9',                                  // already an asset
      '2001:db8::2',                                  // new
      '2001:0DB8:0000:0000:0000:0000:0000:0002',      // the SAME target, other spelling
      'not a target!!',                               // unusable
      '198.51.100.60',                                // new
    ],
    intervalS: 60,
  });
  chk('bulk answers 200 with a per-row verdict', b.status === 200, String(b.status));
  chk('…adding the two genuinely new targets',
    b.j?.added?.length === 2 && b.j?.added?.includes('198.51.100.60'), JSON.stringify(b.j?.added));
  chk('…skipping one already monitored',
    arr(b.j?.skipped).some((s) => s.target === '203.0.113.9' && s.reason === 'already monitored'),
    JSON.stringify(b.j?.skipped));
  // The re-read inside the loop is the whole reason this case exists: the first
  // spelling is already in the table by the time the second is considered, and
  // only a re-read sees it.
  chk('…and the second spelling of a target added EARLIER IN THE SAME BATCH',
    arr(b.j?.skipped).some((s) => /^2001:0db8/.test(s.target) && s.reason === 'already monitored'),
    JSON.stringify(b.j?.skipped));
  chk('…an unusable entry is skipped with a reason, not fatal to the batch',
    arr(b.j?.skipped).some((s) => s.reason === 'not an IP or domain'), JSON.stringify(b.j?.skipped));
  chk('…the batch interval is clamped to the floor',
    (await q.prepare('SELECT interval_s FROM reputation_assets WHERE org_id = ? AND target = ?')
      .get(ACME, '198.51.100.60'))?.interval_s === 3600);
  const afterBulk = await auditsAtLeast('reputation_asset_create', auditsBefore + 1);
  chk('a bulk add is audited once, with the count',
    afterBulk.length === auditsBefore + 1 && /^2 from SPF: /.test(afterBulk[afterBulk.length - 1]?.detail || ''),
    afterBulk[afterBulk.length - 1]?.detail);
  const allSkipped = await bulk(lead, { targets: ['203.0.113.9', 'nope!'] });
  /* The NEGATIVE of the same race, and it cannot be condition-waited: "no row
   * appears" is only ever provable by looking and finding none. What makes it
   * sound is that the previous line already waited for this action's trail to
   * settle, so a row arriving now would be this batch's — which is exactly what
   * the check forbids. Re-read once rather than twice: calling audits() in both
   * the assertion and the detail string used to report a count taken after the
   * one it compared. */
  const afterEmpty = await audits('reputation_asset_create');
  chk('a batch that adds nothing writes no audit row',
    allSkipped.j?.added?.length === 0 && afterEmpty.length === afterBulk.length,
    `${afterEmpty.length} vs ${afterBulk.length}`);

  // ── the plan limit (cloud edition) ─────────────────────────────────────────
  // `checks` is ONE budget spanning synthetic_checks and reputation_assets, so a
  // Free org with one HTTP check has two of its three slots left.
  await mkCheck(TINY, 'https://tiny.test/health');
  const tb = await bulk(tiny, {
    targets: ['198.51.100.71', '198.51.100.72', '198.51.100.73', '198.51.100.74'],
  });
  chk('a bulk add stops AT the plan limit rather than sailing past it',
    tb.j?.added?.length === 2 && (await assetCount(TINY)) === 2, JSON.stringify(tb.j?.added));
  chk('…and says so per row, with the right numbers',
    tb.j?.skipped?.length === 2 && tb.j.skipped.every((s) => s.reason === 'plan limit reached (3/3)'),
    JSON.stringify(tb.j?.skipped));
  const over = await create(tiny, { target: '198.51.100.75' });
  chk('creating one more asset is 402', over.status === 402, String(over.status));
  chk('…quoting the shared check budget', /plan limit reached \(3\/3 checks\)/.test(over.j?.error || ''),
    over.j?.error);
  chk('…and nothing was written', (await assetCount(TINY)) === 2, String((await assetCount(TINY))));

  // The converse, and the reason this file runs in the cloud edition at all:
  // with enforcement off (the community edition's setting) the same request is
  // accepted. Narrowed to these two lines rather than a second harness.
  plans.setEnforce(false);
  const ce = await create(tiny, { target: '198.51.100.75' });
  chk('the community edition applies no check ceiling',
    ce.status === 200 && (await assetCount(TINY)) === 3, `${ce.status} ${JSON.stringify(ce.j)}`);
  plans.setEnforce(true);
  chk('…and the ceiling is back once enforcement is on',
    (await create(tiny, { target: '198.51.100.76' })).status === 402);

  report();
}

main().catch(die);
