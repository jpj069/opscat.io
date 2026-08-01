'use strict';
/* End-to-end check for Reputation (blocklist monitoring).
 *
 * Deliberately hermetic: the DNS resolver is stubbed and the database is a
 * throwaway file, so this runs in CI without network access and without a
 * server on :3000. It covers the three mechanisms the feature actually rests on
 * — DNSBL classification, the RFC 5782 canary, and the trust boundary around
 * probe-supplied results — plus the schema migration.
 *
 *   cd server && node e2e-reputation.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const R = [];
const chk = (name, pass, detail = '') => R.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : ` — ${detail}`}`);

// A DB of its own, created before anything requires src/db.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opscat-rep-'));
process.env.OPSCAT_DATA_DIR = tmp;
process.env.OPSCAT_SECRET = 'e2e-reputation-secret';

const reputation = require('./src/engine/reputation');

// ── a resolver that answers from a table, so verdicts are deterministic ──────
// Keys are full query names ("2.0.0.127.zen.spamhaus.org"); a missing key is
// NXDOMAIN, which is what "not listed" looks like on the wire.
function stubResolver(table) {
  return {
    resolve4: async (name) => {
      const v = table[name];
      if (v === 'timeout') return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 50));
      if (!v) { const e = new Error('queryA ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; }
      return v;
    },
  };
}
// Answer each zone's canary. Domain zones may carry their own (dbltest.com),
// which is exactly the distinction the `defaultCanary` parameter exists for —
// probing an RHSBL with the IP canary would mark it unavailable forever.
const canaries = (zones, extra = {}) => {
  const t = { ...extra };
  for (const z of zones) {
    if (z.canary) t[`${z.canary}.${z.zone}`] = ['127.0.0.2'];
    else t[`2.0.0.127.${z.zone}`] = ['127.0.0.2'];
  }
  return t;
};


// Build a v10-shaped database and load db.js against it in a CHILD process —
// db.js is a singleton, so the migration cannot be re-run in this one. Verifies
// the part that would silently lose data: an open critical listing must survive
// the move out of synthetic_results.
async function migrationCarriesOver() {
  const { execFileSync } = require('child_process');
  const Database = require('better-sqlite3');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opscat-mig-'));
  const d = new Database(path.join(dir, 'opscat.db'));
  d.exec(fs.readFileSync(path.join(__dirname, 'src', 'schema.sql'), 'utf8'));
  // v10 had no reputation tables at all
  d.exec('DROP TABLE reputation_listings; DROP TABLE reputation_runs; DROP TABLE reputation_assets;');
  d.prepare(`INSERT INTO organizations (id, name, slug, plan, status, created_at)
    VALUES (1, 'e2e', 'e2e', 'enterprise', 'active', ?)`).run(Date.now());
  const cid = d.prepare(`INSERT INTO synthetic_checks
      (org_id, type, target, interval_s, timeout_ms, enabled, assertions, created_at)
    VALUES (1, 'reputation', '198.51.100.7', 21600, 3000, 1, NULL, ?)`).run(Date.now()).lastInsertRowid;
  const loc = d.prepare(`INSERT INTO synthetic_locations (org_id, city, cc, kind, created_at)
    VALUES (1, 'x', 'XX', 'local', ?)`).run(Date.now()).lastInsertRowid;
  d.prepare(`INSERT INTO synthetic_results (check_id, location_id, ts, ok, latency_ms, meta)
    VALUES (?, ?, ?, 0, 50, ?)`).run(cid, loc, 1700000000000, JSON.stringify({
      kind: 'ip', rdns: 'mail.example.net', zonesQueried: 30, worstTier: 'critical',
      listed: [{ name: 'Spamhaus ZEN', zone: 'zen.spamhaus.org', tier: 'critical',
        codes: ['127.0.0.2'], url: 'https://check.spamhaus.org/' }],
    }));
  d.pragma('user_version = 10');
  d.close();

  const probe = `
    const { db } = require(${JSON.stringify(path.join(__dirname, 'src', 'db.js'))});
    console.log(JSON.stringify({
      v: db.pragma('user_version', { simple: true }),
      assets: db.prepare('SELECT * FROM reputation_assets').all(),
      listings: db.prepare('SELECT * FROM reputation_listings').all(),
      runs: db.prepare('SELECT * FROM reputation_runs').all(),
      leftover: db.prepare("SELECT COUNT(*) c FROM synthetic_checks WHERE type = 'reputation'").get().c,
      orphanResults: db.prepare('SELECT COUNT(*) c FROM synthetic_results WHERE check_id = ' + ${cid}).get().c,
    }));`;
  let out;
  try {
    out = execFileSync(process.execPath, ['-e', probe], {
      env: { ...process.env, OPSCAT_DATA_DIR: dir, OPSCAT_SECRET: 'mig' }, encoding: 'utf8',
    });
  } catch (e) { return false; }
  let r;
  try { r = JSON.parse(String(out).trim().split('\n').pop()); } catch { return false; }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }

  return r.v === 12
    && r.assets.length === 1 && r.assets[0].target === '198.51.100.7'
    && r.assets[0].kind === 'ip' && r.assets[0].rdns === 'mail.example.net'
    && r.listings.length === 1 && r.listings[0].zone === 'zen.spamhaus.org'
    && r.listings[0].resolved_at === null && r.listings[0].first_seen === 1700000000000
    && r.runs.length === 1 && r.runs[0].status === 'listed'
    && r.leftover === 0 && r.orphanResults === 0;
}

async function main() {
  const IP = reputation.IP_ZONES;
  const CRIT = IP.filter((z) => z.tier === 'critical');

  // ── 1. classify: listing vs policy vs resolver refusal ────────────────────
  chk('127.0.0.2 is a listing', reputation.classify(IP[0].zone, ['127.0.0.2']).listed === true);
  chk('127.255.255.254 is not a listing (resolver refused)',
    reputation.classify(IP[0].zone, ['127.255.255.254']).listed === false);
  chk('127.255.255.252 is not a listing (rate limited)',
    reputation.classify(IP[0].zone, ['127.255.255.252']).listed === false);
  const pbl = IP.find((z) => z.zone === 'zen.spamhaus.org');
  const pblV = reputation.classify(pbl.zone, ['127.0.0.10']);
  chk('Spamhaus PBL 127.0.0.10 is policy, not abuse', pblV.listed === false && pblV.policy === true,
    JSON.stringify(pblV));
  chk('Spamhaus ZEN 127.0.0.4 (XBL) is a listing',
    reputation.classify(pbl.zone, ['127.0.0.4']).listed === true);

  // ── 2. target parsing + canonical identity ───────────────────────────────
  chk('IPv4 reverses low-order first', reputation.reverseIPv4('1.2.3.4') === '4.3.2.1');
  chk('IPv4 rejects out-of-range octets', reputation.reverseIPv4('1.2.3.999') === null);
  chk('IPv6 expands to 32 nibbles', reputation.expandIPv6('2001:db8::1')
    === '20010db8000000000000000000000001');
  chk('IPv6 rejects an embedded-v4 form', reputation.expandIPv6('::ffff:127.0.0.1') === null);
  chk('IPv6 rejects a zone-id suffix', reputation.expandIPv6('fe80::1%eth0') === null);
  chk('a domain parses as a domain', reputation.parseTarget('mail.example.com').kind === 'domain');
  chk('a URL is rejected', reputation.parseTarget('https://example.com/x') === null);
  chk('normalizeTarget strips case and the root dot',
    reputation.normalizeTarget(' MAIL.Example.COM. ') === 'mail.example.com');
  chk('targetKey collapses IPv6 spellings',
    reputation.targetKey('2001:0db8::1') === reputation.targetKey('2001:db8::1'));
  chk('targetKey separates a domain from an IP',
    reputation.targetKey('example.com') !== reputation.targetKey('1.2.3.4'));

  // ── 3. RFC 5782 canary: the guard against a silently-lying resolver ──────
  // A conforming DNSBL MUST list 127.0.0.2 and MUST NOT list 127.0.0.1.
  reputation.resetCanaryCache();
  const dark = await reputation.lookup('1.2.3.4', 500, stubResolver({}));
  chk('no canary answers -> zero zones queried', dark.zonesQueried === 0, JSON.stringify(dark.zonesQueried));
  chk('no canary answers -> criticalCovered false', dark.criticalCovered === false);
  chk('no canary answers -> nothing reported as listed', dark.listed.length === 0);

  reputation.resetCanaryCache();
  // A wildcard resolver answers EVERYTHING, including the negative control.
  const wildcard = { resolve4: async () => ['127.0.0.2'] };
  const hijack = await reputation.lookup('1.2.3.4', 500, wildcard);
  chk('a wildcard resolver fails the negative control (ip)', hijack.listed.length === 0,
    `listed ${hijack.listed.length}, worstTier ${hijack.worstTier}`);
  chk('a wildcard resolver leaves criticalCovered false (ip)', hijack.criticalCovered === false);

  // The SAME must hold for domains. RHSBLs have no standardised test entry, so
  // the IP pair cannot serve as their negative control — without one of their
  // own, a hijacking resolver reports every monitored sending DOMAIN as
  // critically listed (severity 85 + an auto-opened case each). Shipped that way
  // once; this is the regression test.
  reputation.resetCanaryCache();
  const hijackDom = await reputation.lookup('mail.example.com', 500, wildcard);
  chk('a wildcard resolver fails the negative control (domain)', hijackDom.listed.length === 0,
    `listed ${hijackDom.listed.length}, worstTier ${hijackDom.worstTier}`);
  chk('a wildcard resolver leaves criticalCovered false (domain)',
    hijackDom.criticalCovered === false);
  chk('a wildcard resolver reports zero domain zones as queried',
    hijackDom.zonesQueried === 0, String(hijackDom.zonesQueried));

  // ── 4. a real listing, on a resolver that passes both canary halves ──────
  reputation.resetCanaryCache();
  const zen = CRIT.find((z) => z.zone === 'zen.spamhaus.org') || CRIT[0];
  const listedRes = await reputation.lookup('1.2.3.4', 500,
    stubResolver(canaries(IP, { [`4.3.2.1.${zen.zone}`]: ['127.0.0.2'] })));
  chk('the listing is reported', listedRes.listed.length === 1, JSON.stringify(listedRes.listed));
  chk('the listing carries its zone', listedRes.listed[0].zone === zen.zone);
  chk('a critical listing sets worstTier=critical', listedRes.worstTier === 'critical');
  chk('every zone counted as queried', listedRes.zonesQueried === IP.length,
    `${listedRes.zonesQueried} of ${IP.length}`);
  chk('criticalCovered is true', listedRes.criticalCovered === true);

  reputation.resetCanaryCache();
  const infoZone = IP.find((z) => z.tier === 'informational');
  const infoRes = await reputation.lookup('1.2.3.4', 500,
    stubResolver(canaries(IP, { [`4.3.2.1.${infoZone.zone}`]: ['127.0.0.2'] })));
  chk('an informational-only listing sets worstTier=informational',
    infoRes.worstTier === 'informational', String(infoRes.worstTier));

  // Domain zones must NOT be probed with the IP canary — they cannot list it.
  reputation.resetCanaryCache();
  const dom = await reputation.lookup('example.com', 500,
    stubResolver(canaries(reputation.DOMAIN_ZONES)));
  chk('domain zones are all usable with their own canary rules',
    dom.zonesQueried === reputation.DOMAIN_ZONES.length,
    `${dom.zonesQueried} of ${reputation.DOMAIN_ZONES.length}`);

  // ── 5. severity mapping ──────────────────────────────────────────────────
  chk('critical maps above the paging floor', reputation.TIER_SEVERITY.critical >= 80);
  chk('standard maps to major', reputation.TIER_SEVERITY.standard >= 60 && reputation.TIER_SEVERITY.standard < 80);
  chk('informational stays below the alerting floor', reputation.TIER_SEVERITY.informational < 40);

  // ── 6. storage: assets, runs and listings are their own tables ───────────
  const { db } = require('./src/db');
  const org = db.prepare('SELECT id FROM organizations ORDER BY id LIMIT 1').get();
  chk('a bootstrapped org exists', !!org);
  chk('the database is at schema v12', db.pragma('user_version', { simple: true }) === 12,
    String(db.pragma('user_version', { simple: true })));

  const assetId = db.prepare(`INSERT INTO reputation_assets
      (org_id, target, kind, rdns, interval_s, enabled, created_at)
    VALUES (?, '203.0.113.9', 'ip', NULL, 21600, 1, ?)`).run(org.id, Date.now()).lastInsertRowid;
  chk('a reputation asset inserts', !!assetId);

  let badKind = false;
  try {
    db.prepare(`INSERT INTO reputation_assets (org_id, target, kind, interval_s, enabled, created_at)
      VALUES (?, 'x', 'bogus', 3600, 1, ?)`).run(org.id, Date.now());
  } catch { badKind = true; }
  chk('kind is constrained to ip|domain', badKind);

  // ── 7. the listing lifecycle ─────────────────────────────────────────────
  // This is what the model change bought: a listing is an episode with a start
  // and an end, not a field on the newest sample.
  const t0 = Date.now();
  const fZen = { name: 'Spamhaus ZEN', zone: 'zen.spamhaus.org', tier: 'critical', codes: ['127.0.0.2'], url: null };
  // answeredKeys are (subject, zone) pairs — '' subject = the asset itself. The
  // subject dimension exists because a domain's MX hosts are checked too, and a
  // listed mail server is a different fact from a listed domain.
  const K = (zone, subject = '') => `${subject}\u0000${zone}`;

  let sync = reputation.syncListings(assetId, [fZen], [K('zen.spamhaus.org'), K('bl.spamcop.net')], t0);
  chk('a new finding opens a listing', sync.opened.length === 1 && sync.resolved.length === 0);
  const openNow = () => db.prepare(
    'SELECT * FROM reputation_listings WHERE asset_id = ? AND resolved_at IS NULL ORDER BY zone').all(assetId);
  chk('the listing records when it started', openNow().length === 1 && openNow()[0].first_seen === t0);

  // Same finding again: the episode continues, first_seen must NOT move.
  sync = reputation.syncListings(assetId, [fZen], [K('zen.spamhaus.org'), K('bl.spamcop.net')], t0 + 60000);
  chk('a continuing listing is not reopened', sync.opened.length === 0 && openNow().length === 1);
  chk('first_seen stays put while last_seen advances',
    openNow()[0].first_seen === t0 && openNow()[0].last_seen === t0 + 60000);

  // THE load-bearing rule: a zone that did not answer must not clear a listing.
  // Without this a resolver having a bad day silently erases a live critical
  // finding — the same failure the RFC 5782 canary exists to prevent, one level up.
  sync = reputation.syncListings(assetId, [], [K('bl.spamcop.net')], t0 + 120000);
  chk('a SILENT zone never resolves a listing',
    sync.resolved.length === 0 && openNow().length === 1,
    `resolved ${sync.resolved.length}, still open ${openNow().length}`);

  // …but a zone that answered and no longer lists it does.
  sync = reputation.syncListings(assetId, [], [K('zen.spamhaus.org'), K('bl.spamcop.net')], t0 + 180000);
  chk('an ANSWERING zone resolves the listing',
    sync.resolved.length === 1 && openNow().length === 0);
  const episodes = db.prepare('SELECT * FROM reputation_listings WHERE asset_id = ? ORDER BY id').all(assetId);
  chk('the resolved episode keeps its full span',
    episodes.length === 1 && episodes[0].first_seen === t0 && episodes[0].resolved_at === t0 + 180000);

  // A re-listing after a delisting is a NEW episode, not a revived one — so the
  // history reads as distinct incidents rather than one smear.
  reputation.syncListings(assetId, [fZen], [K('zen.spamhaus.org')], t0 + 240000);
  const all = db.prepare('SELECT * FROM reputation_listings WHERE asset_id = ? ORDER BY id').all(assetId);
  chk('a re-listing opens a second episode',
    all.length === 2 && all[1].first_seen === t0 + 240000 && all[1].resolved_at === null);
  chk('at most one episode per zone is open at a time',
    all.filter((l) => l.zone === fZen.zone && l.resolved_at === null).length === 1);

  // The partial unique index enforces that at the storage layer too.
  let dupOpen = false;
  try {
    db.prepare(`INSERT INTO reputation_listings
      (asset_id, zone, name, tier, codes, url, first_seen, last_seen, resolved_at)
      VALUES (?, 'zen.spamhaus.org', 'Spamhaus ZEN', 'critical', NULL, NULL, ?, ?, NULL)`)
      .run(assetId, Date.now(), Date.now());
  } catch { dupOpen = true; }
  chk('the schema refuses a second open episode for the same zone', dupOpen);
  db.prepare('DELETE FROM reputation_listings WHERE asset_id = ?').run(assetId);

  // ── 8. events come from the engine, on evidence it gathered itself ───────
  const evCount = (name) => db.prepare('SELECT COUNT(*) c FROM events WHERE name = ?').get(name).c;
  const asset = db.prepare('SELECT * FROM reputation_assets WHERE id = ?').get(assetId);

  reputation.resetCanaryCache();
  const listedTable = canaries(IP, { [`9.113.0.203.${CRIT[0].zone}`]: ['127.0.0.2'] });
  // runAsset calls the real lookup; point it at the stub for the duration.
  const beforeListed = evCount('reputation_listed');
  await reputation.runAsset(asset, 500, stubResolver(listedTable));
  chk('a critical listing raises reputation_listed', evCount('reputation_listed') === beforeListed + 1,
    `${beforeListed} -> ${evCount('reputation_listed')}`);
  const ev = db.prepare("SELECT * FROM events WHERE name = 'reputation_listed' ORDER BY id DESC LIMIT 1").get();
  chk('the event carries the critical severity', ev && ev.severity === reputation.TIER_SEVERITY.critical,
    ev ? String(ev.severity) : 'no event');
  chk('the event names the asset', ev && ev.device === '203.0.113.9', ev ? ev.device : '');
  chk('the run is stored as listed',
    db.prepare('SELECT status FROM reputation_runs WHERE asset_id = ? ORDER BY id DESC LIMIT 1')
      .get(assetId).status === 'listed');
  chk('the listing episode was opened by the run',
    db.prepare('SELECT COUNT(*) c FROM reputation_listings WHERE asset_id = ? AND resolved_at IS NULL')
      .get(assetId).c === 1);

  // Delisting is now observable — the sample model could not tell "gone" from
  // "never there", so this event could not exist before.
  const beforeCleared = evCount('reputation_cleared');
  await reputation.runAsset(asset, 500, stubResolver(canaries(IP)));
  chk('delisting raises reputation_cleared', evCount('reputation_cleared') === beforeCleared + 1,
    `${beforeCleared} -> ${evCount('reputation_cleared')}`);
  chk('reputation_cleared stays below the alerting floor',
    db.prepare("SELECT severity FROM events WHERE name = 'reputation_cleared' ORDER BY id DESC LIMIT 1")
      .get().severity < 40);
  chk('the episode is closed with a resolved_at',
    db.prepare('SELECT COUNT(*) c FROM reputation_listings WHERE asset_id = ? AND resolved_at IS NOT NULL')
      .get(assetId).c >= 1);

  // Informational-only findings are recorded but never alert.
  reputation.resetCanaryCache();
  const infoZ = IP.find((z) => z.tier === 'informational');
  const beforeInfoEv = evCount('reputation_listed');
  await reputation.runAsset(asset, 500,
    stubResolver(canaries(IP, { [`9.113.0.203.${infoZ.zone}`]: ['127.0.0.2'] })));
  chk('an informational-only listing raises no event', evCount('reputation_listed') === beforeInfoEv);
  chk('…but is still recorded as an episode',
    db.prepare('SELECT COUNT(*) c FROM reputation_listings WHERE asset_id = ? AND zone = ?')
      .get(assetId, infoZ.zone).c === 1);
  chk('…and the run status is informational, not listed',
    db.prepare('SELECT status FROM reputation_runs WHERE asset_id = ? ORDER BY id DESC LIMIT 1')
      .get(assetId).status === 'informational');

  // ── 9. the forged-event path is GONE, not guarded ────────────────────────
  // v10 gated the event on the check row's type because `meta` arrived from
  // POST /v1/synthetics/report. The listing decision now lives entirely inside
  // the engine, so there is no input to gate — which is the point of the rewrite.
  const srcOf = (f) => fs.readFileSync(path.join(__dirname, 'src', f), 'utf8');
  const synth = require('./src/engine/synthetics');
  chk('synthetics no longer knows about reputation at all',
    !/reputation/i.test(srcOf('engine/synthetics.js')));
  chk('recordResult cannot raise a listing event',
    !/reputation_listed/.test(srcOf('engine/synthetics.js')));
  chk('only the reputation engine writes listing events',
    /reputation_listed/.test(srcOf('engine/reputation.js')));

  // A probe posting a hand-made "listing" now lands in synthetic_results and is
  // simply meaningless there — no event, no listing, nothing to gate.
  const httpId = db.prepare(`INSERT INTO synthetic_checks
      (org_id, type, target, interval_s, timeout_ms, enabled, assertions, created_at)
    VALUES (?, 'http', 'https://example.com', 60, 3000, 1, NULL, ?)`)
    .run(org.id, Date.now()).lastInsertRowid;
  const loc = db.prepare(
    "INSERT INTO synthetic_locations (org_id, city, cc, kind, created_at) VALUES (?, 'e2e', 'XX', 'local', ?)")
    .run(org.id, Date.now()).lastInsertRowid;
  const beforeForge = evCount('reputation_listed');
  synth.recordResult(httpId, loc, { ok: true, latency: 12, meta: {
    kind: 'ip', worstTier: 'critical',
    listed: [{ name: 'Spamhaus ZEN', zone: 'zen.spamhaus.org', tier: 'critical', codes: ['127.0.0.2'] }],
  } });
  chk('a probe cannot forge a listing event', evCount('reputation_listed') === beforeForge);
  chk('…nor an episode in the listing history',
    db.prepare('SELECT COUNT(*) c FROM reputation_listings WHERE zone = ? AND asset_id != ?')
      .get('zen.spamhaus.org', assetId).c === 0);

  // ── 10. the guards are gone, because the separation is structural now ────
  const guard = /type\s*!=\s*'reputation'|type\s*!==\s*'reputation'|type\s*===\s*'reputation'/g;
  for (const f of ['routes/synthetics.js', 'routes/ingest.js', 'mcp/tools.js', 'routes/ops.js']) {
    chk(`${f} needs no reputation guard`, (srcOf(f).match(guard) || []).length === 0,
      `${(srcOf(f).match(guard) || []).length} left`);
  }
  // v10 needed an explicit filter here: "run all checks" is analyst-reachable
  // (POST /api/synthetics/run, MCP opscat_run_checks) and one asset is ~40
  // queries against lists that rate-limit per source IP, so the button was a way
  // to get the host refused by Spamhaus. Now the assets are not in that table at
  // all — measured by the only thing that matters, whether a run happened.
  const runsBefore = db.prepare('SELECT COUNT(*) c FROM reputation_runs').get().c;
  await synth.runAllNow(org.id);
  chk('"run all checks" cannot trigger a reputation lookup',
    db.prepare('SELECT COUNT(*) c FROM reputation_runs').get().c === runsBefore);

  // ── 11. the 1h interval floor is the feature's own, not the plan's ───────
  const repSrc = srcOf('routes/reputation.js');
  chk('the interval floor is 3600s', /MIN_INTERVAL_S = 3600/.test(repSrc));
  // Counted, not hard-coded: every site that writes an interval must derive its
  // floor. A new route that clamps to the plan floor alone would slip a 15s
  // cadence past the feature's 1h minimum and flood the blocklists.
  const intervalWrites = (repSrc.match(/clampInt\([^)]*MAX_INTERVAL_S/g) || []).length;
  const floorUses = (repSrc.match(/floorFor\(req\.org\.plan\)/g) || []).length;
  chk('the floor is never below the plan floor',
    /Math\.max\(MIN_INTERVAL_S, plans\.minIntervalFor\(plan\)\)/.test(repSrc));
  chk('every interval write site derives that floor',
    intervalWrites > 0 && floorUses === intervalWrites,
    `${floorUses} floors for ${intervalWrites} interval writes`);
  chk('the latest-run query breaks ts ties on id', /ORDER BY ts DESC, id DESC/.test(repSrc));
  chk('reputation assets count against the plan check budget',
    /FROM reputation_assets WHERE org_id/.test(srcOf('plans.js')));

  // ── 12. retention keeps the record and drops the samples ────────────────
  const retSrc = srcOf('engine/retention.js');
  chk('reputation_runs is pruned', /DELETE FROM reputation_runs WHERE ts </.test(retSrc));
  chk('reputation_listings is NOT pruned', !/DELETE FROM reputation_listings/.test(retSrc));

  // ── 12b. MX findings ride on the domain asset, keyed by subject ──────────
  // A domain's RHSBL verdict says nothing about the hosts its MX points at, and a
  // listed mail server is a different problem with a different fix — so the two
  // must never merge into one episode.
  const domAsset = db.prepare(`INSERT INTO reputation_assets
      (org_id, target, kind, interval_s, enabled, created_at)
    VALUES (?, 'mx-e2e.example', 'domain', 21600, 1, ?)`).run(org.id, Date.now()).lastInsertRowid;
  const zenF = { name: 'Spamhaus ZEN', zone: 'zen.spamhaus.org', tier: 'critical', codes: ['127.0.0.2'], url: null };
  const dblF = { name: 'Spamhaus DBL', zone: 'dbl.spamhaus.org', tier: 'critical', codes: ['127.0.1.2'], url: null };
  const MX_SUBJ = 'mail.mx-e2e.example [198.51.100.9]';
  const t1 = Date.now();

  reputation.syncListings(domAsset, [
    { ...dblF, subject: '' },            // the domain itself
    { ...zenF, subject: MX_SUBJ },       // its mail server
  ], [`\u0000dbl.spamhaus.org`, `${MX_SUBJ}\u0000zen.spamhaus.org`], t1);
  const domOpen = () => db.prepare(
    'SELECT * FROM reputation_listings WHERE asset_id = ? AND resolved_at IS NULL ORDER BY id').all(domAsset);
  chk('domain and MX findings are separate episodes', domOpen().length === 2,
    JSON.stringify(domOpen().map((l) => [l.zone, l.subject])));
  chk('the MX episode records which host it is about',
    domOpen().some((l) => l.subject === MX_SUBJ && l.zone === 'zen.spamhaus.org'));
  chk('the domain episode carries an empty subject',
    domOpen().some((l) => l.subject === '' && l.zone === 'dbl.spamhaus.org'));

  // The same zone can list the domain AND its mail server at once — one open
  // episode each, which a (asset, zone) index would have refused.
  reputation.syncListings(domAsset, [
    { ...zenF, subject: '' }, { ...zenF, subject: MX_SUBJ }, { ...dblF, subject: '' },
  ], [`\u0000zen.spamhaus.org`, `\u0000dbl.spamhaus.org`, `${MX_SUBJ}\u0000zen.spamhaus.org`], t1 + 1000);
  chk('one zone can list the asset and its MX simultaneously',
    domOpen().filter((l) => l.zone === 'zen.spamhaus.org').length === 2,
    JSON.stringify(domOpen().map((l) => [l.zone, l.subject])));

  // Resolving is per (subject, zone): the MX clearing must not clear the domain's.
  reputation.syncListings(domAsset, [{ ...zenF, subject: '' }, { ...dblF, subject: '' }],
    [`\u0000zen.spamhaus.org`, `\u0000dbl.spamhaus.org`, `${MX_SUBJ}\u0000zen.spamhaus.org`], t1 + 2000);
  chk('the MX episode resolves without touching the domain\'s',
    domOpen().length === 2 && !domOpen().some((l) => l.subject === MX_SUBJ),
    JSON.stringify(domOpen().map((l) => [l.zone, l.subject])));

  // And the silent-zone rule holds per subject too.
  reputation.syncListings(domAsset, [{ ...dblF, subject: '' }], [`\u0000dbl.spamhaus.org`], t1 + 3000);
  chk('a silent zone does not resolve the asset\'s own episode either',
    domOpen().some((l) => l.zone === 'zen.spamhaus.org' && l.subject === ''));

  // checkMxHosts: MX -> addresses -> a full lookup each, deduplicated and capped.
  reputation.resetCanaryCache();
  const mxTable = canaries(IP, { [`9.100.51.198.${CRIT[0].zone}`]: ['127.0.0.2'] });
  const mxResolver = {
    ...stubResolver(mxTable),
    resolveMx: async (n) => (n === 'mx-e2e.example'
      ? [{ exchange: 'mail.mx-e2e.example', priority: 10 },
        { exchange: 'mail2.mx-e2e.example', priority: 20 }]
      : (() => { const e = new Error('NXDOMAIN'); e.code = 'ENOTFOUND'; throw e; })()),
  };
  // both MX names resolve to the SAME address — the dedupe must collapse them
  const withA = {
    ...mxResolver,
    resolve4: async (n) => {
      if (n === 'mail.mx-e2e.example' || n === 'mail2.mx-e2e.example') return ['198.51.100.9'];
      return stubResolver(mxTable).resolve4(n);
    },
  };
  const mxRes = await reputation.checkMxHosts(
    { target: 'mx-e2e.example', kind: 'domain' }, 300, withA);
  chk('checkMxHosts resolves MX names to addresses and checks them',
    mxRes.hosts.length === 1 && mxRes.hosts[0].ip === '198.51.100.9',
    JSON.stringify(mxRes.hosts));
  chk('two MX names on one address are checked once',
    mxRes.hosts.filter((h) => h.ip === '198.51.100.9').length === 1);
  chk('an MX listing is tagged with the host it belongs to',
    mxRes.found.some((f) => f.subject.includes('mail.mx-e2e.example') && f.subject.includes('198.51.100.9')),
    JSON.stringify(mxRes.found.map((f) => f.subject)));
  chk('an IP asset gets no MX lookup at all',
    (await reputation.checkMxHosts({ target: '1.2.3.4', kind: 'ip' }, 300,
      { ...withA, resolveMx: async () => { const e = new Error('nx'); e.code = 'ENOTFOUND'; throw e; } })
    ).hosts.length === 0);

  // ── 12b-2. a provider's MX is named, not queried ─────────────────────────
  // The reason is precise and the first version got it wrong: a DNSBL is consulted
  // by the RECEIVING server against the SENDING address. A cloud MX only accepts —
  // outbound leaves an entirely different range — so a listing there is neither
  // actionable nor meaningful, while querying it burns the address budget the
  // org's own relays need. A self-hosted server usually accepts AND sends on one
  // address, which is exactly the case worth checking.
  chk('Microsoft 365 MX is recognised as delegated',
    reputation.mxProviderOf('link11-com.mail.protection.outlook.com') === 'Microsoft 365');
  chk('Google Workspace MX is recognised',
    reputation.mxProviderOf('aspmx.l.google.com') === 'Google Workspace');
  chk('a trailing root dot does not defeat recognition',
    reputation.mxProviderOf('ALT1.ASPMX.L.GOOGLE.COM.') === 'Google Workspace');
  chk('a self-hosted MX is not treated as delegated',
    reputation.mxProviderOf('mail4.link11.com') === null);
  // A lookalike must not match on a substring — only on a real suffix boundary.
  chk('a lookalike hostname is not mistaken for a provider',
    reputation.mxProviderOf('mail.protection.outlook.com.evil.example') === null,
    String(reputation.mxProviderOf('mail.protection.outlook.com.evil.example')));
  // Suffix matching has to respect label boundaries, or a host that very much
  // wants checking gets waved through as somebody else's problem.
  chk('a name merely ENDING in a provider string is not delegated',
    reputation.mxProviderOf('evil-aspmx.l.google.com') === null,
    String(reputation.mxProviderOf('evil-aspmx.l.google.com')));
  chk('the bare provider name itself still matches',
    reputation.mxProviderOf('aspmx.l.google.com') === 'Google Workspace');

  reputation.resetCanaryCache();
  let queriedProviderAddress = false;
  const provResolver = {
    resolve4: async (n) => {
      // If the provider's MX were resolved, this fires — the budget waste we removed.
      if (n === 'x.mail.protection.outlook.com') { queriedProviderAddress = true; }
      const t = canaries(IP, { [`9.100.51.198.${CRIT[0].zone}`]: ['127.0.0.2'] });
      if (n === 'relay.own.example') return ['198.51.100.9'];
      const v = t[n];
      if (!v) { const e = new Error('nx'); e.code = 'ENOTFOUND'; throw e; }
      return v;
    },
    resolveMx: async () => [
      { exchange: 'x.mail.protection.outlook.com', priority: 5 },
      { exchange: 'relay.own.example', priority: 10 },
    ],
  };
  const mixed = await reputation.checkMxHosts(
    { target: 'mixed.example', kind: 'domain' }, 300, provResolver);
  chk('the provider MX is never resolved to an address', !queriedProviderAddress);
  chk('…but it is reported, so the delegation is visible',
    mixed.hosts.some((h) => h.provider === 'Microsoft 365' && h.ip === null),
    JSON.stringify(mixed.hosts));
  chk('the org\'s own relay still gets a full check',
    mixed.hosts.some((h) => h.ip === '198.51.100.9' && h.provider === null && h.listed > 0),
    JSON.stringify(mixed.hosts));
  chk('a delegated host contributes no listing findings',
    mixed.found.every((f) => !f.subject.includes('outlook.com')));

  // ── 12c. the configured resolver must actually be used ───────────────────
  // Shipped once with OPSCAT_REPUTATION_DNS=unbound (a compose service NAME).
  // Node's setServers() takes addresses only, so every call threw
  // ERR_INVALID_IP_ADDRESS, a bare catch swallowed it, and every lookup quietly
  // went back to the host resolver the blocklists refuse. The feature then
  // reported "Spamhaus unavailable" — correct, for entirely the wrong reason.
  const savedDns = process.env.OPSCAT_REPUTATION_DNS;

  process.env.OPSCAT_REPUTATION_DNS = '9.9.9.9, 149.112.112.112';
  chk('plain addresses are passed through',
    JSON.stringify(await reputation.resolveConfiguredServers()) === '["9.9.9.9","149.112.112.112"]');

  // A NAME has to survive: this is the shape a compose sidecar takes, and its
  // container IP is not stable enough to hard-code.
  process.env.OPSCAT_REPUTATION_DNS = 'localhost';
  const named = await reputation.resolveConfiguredServers();
  chk('a hostname is resolved to an address, not passed through',
    named.length === 1 && /^\d+\.\d+\.\d+\.\d+$/.test(named[0]) && named[0] !== 'localhost',
    JSON.stringify(named));

  // …and a resolvable name must not merely survive — it must reach setServers
  // without throwing, which is precisely what the shipped bug did not do.
  let setServersThrew = false;
  try {
    const dnsMod = require('dns');
    const r = new dnsMod.promises.Resolver({ timeout: 200, tries: 1 });
    r.setServers(named);
  } catch { setServersThrew = true; }
  chk('the resolved servers are acceptable to setServers', !setServersThrew,
    JSON.stringify(named));

  process.env.OPSCAT_REPUTATION_DNS = 'this-host-does-not-exist.invalid';
  chk('an unresolvable entry is dropped rather than crashing',
    JSON.stringify(await reputation.resolveConfiguredServers()) === '[]');

  process.env.OPSCAT_REPUTATION_DNS = '';
  chk('blank means the system resolver',
    JSON.stringify(await reputation.resolveConfiguredServers()) === '[]');

  const repEngineSrc = fs.readFileSync(path.join(__dirname, 'src', 'engine', 'reputation.js'), 'utf8');
  chk('setServers failures are no longer swallowed silently',
    /setServers rejected/.test(repEngineSrc) && !/catch \{ \/\* keep the system resolver \*\/ \}/.test(repEngineSrc));

  if (savedDns === undefined) delete process.env.OPSCAT_REPUTATION_DNS;
  else process.env.OPSCAT_REPUTATION_DNS = savedDns;

  // ── 13. SPF discovery ────────────────────────────────────────────────────
  // The real link11.com tree, which is the case the feature exists for: eight
  // senders written directly into the record (one of them the forgotten relay on
  // a budget hoster), five third-party pools, and 11 lookups against a limit of 10.
  const SPF_TXT = {
    'link11.com': [['v=spf1 a:mail01.emkick.eu ip6:2a06:2380:0:1::44f ip4:185.102.93.53/32 '
      + 'ip4:85.131.131.20/32 ip4:85.131.136.235/32 ip4:64.31.63.144/32 '
      + 'include:spf.protection.outlook.com include:aspmx.pardot.com include:stspg-customer.com '
      + 'include:spf-de.emailsignatures365.com include:mailgun.org -all']],
    'spf.protection.outlook.com': [['v=spf1 ip4:40.92.0.0/15 -all']],
    'stspg-customer.com': [['v=spf1 ip4:23.253.182.103 -all']],
    'spf-de.emailsignatures365.com': [['v=spf1 ip4:20.79.220.33 -all']],
    'aspmx.pardot.com': [['v=spf1 include:et._spf.pardot.com -all']],
    'et._spf.pardot.com': [['v=spf1 ip4:198.245.81.0/24 -all']],
    'mailgun.org': [['v=spf1 include:_spf.mailgun.org include:_spf.eu.mailgun.org -all']],
    '_spf.mailgun.org': [['v=spf1 include:_spf1.mailgun.org include:_spf2.mailgun.org ~all']],
    '_spf1.mailgun.org': [['v=spf1 ip4:209.61.151.0/24 ~all']],
    '_spf2.mailgun.org': [['v=spf1 ip4:104.130.122.0/23 ~all']],
    '_spf.eu.mailgun.org': [['v=spf1 ip4:141.193.32.0/23 ~all']],
  };
  const nx = () => { const e = new Error('NXDOMAIN'); e.code = 'ENOTFOUND'; throw e; };
  const spfStub = (txt = SPF_TXT, a = { 'mail01.emkick.eu': ['185.102.93.53'] }, mx = null) => ({
    resolveTxt: async (n) => txt[n] || nx(),
    resolve4: async (n) => a[n] || nx(),
    resolve6: async () => { const e = new Error('NODATA'); e.code = 'ENODATA'; throw e; },
    resolveMx: async (n) => (mx && mx[n]) || nx(),
  });

  const disc = await reputation.discoverSpf('link11.com', 200, spfStub());
  const targets = disc.candidates.map((c) => c.target);
  chk('discovery finds the addresses written directly in the record',
    ['185.102.93.53', '2a06:2380:0:1::44f', '85.131.131.20', '85.131.136.235', '64.31.63.144']
      .every((t) => targets.includes(t)), targets.join(', '));
  chk('the forgotten relay is among them', targets.includes('64.31.63.144'));
  chk('the sending domain itself is a candidate',
    disc.candidates.some((c) => c.target === 'link11.com' && c.kind === 'domain'));
  chk('an `a:` mechanism is resolved to its address',
    disc.candidates.some((c) => c.target === '185.102.93.53' && c.source.startsWith('a:')));

  // The load-bearing separation: a provider's shared pool is not the customer's
  // asset. Without this the eight addresses that matter drown in thousands.
  // Both shapes matter. A CIDR block inside an include is filtered twice over
  // (wrong scope AND too wide), so testing only those proves nothing: 23.253.182.103
  // and 20.79.220.33 are SINGLE addresses inside third-party includes, and they are
  // the ones that slip through if the include/own distinction breaks.
  chk('single addresses inside a third-party include are NOT offered as assets',
    !targets.includes('23.253.182.103') && !targets.includes('20.79.220.33'),
    targets.join(', '));
  chk('provider CIDR blocks are not offered either',
    !targets.some((t) => t.startsWith('40.92') || t.startsWith('198.245') || t.startsWith('209.61')),
    targets.join(', '));
  chk('…but they are reported as pools',
    disc.pools.length === 5
    && ['spf.protection.outlook.com', 'aspmx.pardot.com', 'mailgun.org']
      .every((i) => disc.pools.some((p) => p.include === i)),
    disc.pools.map((p) => p.include).join(', '));
  chk('nested includes stay out of the pool list',
    !disc.pools.some((p) => p.include.startsWith('_spf')),
    disc.pools.map((p) => p.include).join(', '));
  chk('a pool carries the lookup cost it rolls up to',
    (disc.pools.find((p) => p.include === 'mailgun.org') || {}).lookups === 5,
    JSON.stringify(disc.pools.map((p) => [p.include, p.lookups])));

  // The lookup budget falls out of the same walk, and it is the finding that
  // outranks every blocklist verdict: a PermError means SPF fails outright.
  chk('the RFC 7208 lookup budget is counted across the whole tree',
    disc.lookups.used === 11, String(disc.lookups.used));
  chk('exceeding it is reported as a PermError', disc.lookups.permerror === true);
  chk('the PermError is spelled out in the warnings',
    disc.warnings.some((w) => /11 DNS lookups/.test(w) && /PermError/.test(w)),
    disc.warnings.join(' | '));

  // A record that fits stays quiet about it.
  const okDisc = await reputation.discoverSpf('small.example', 200,
    spfStub({ 'small.example': [['v=spf1 ip4:198.51.100.7 -all']] }, {}));
  chk('a record inside the budget is not flagged',
    okDisc.lookups.used === 0 && okDisc.lookups.permerror === false);
  chk('a bare ip4 with no prefix is a candidate',
    okDisc.candidates.some((c) => c.target === '198.51.100.7'));

  // Ranges are not assets: blocklists answer about addresses, not networks.
  const rangeDisc = await reputation.discoverSpf('range.example', 200,
    spfStub({ 'range.example': [['v=spf1 ip4:203.0.113.0/24 ip4:203.0.113.9/32 -all']] }, {}));
  chk('a /24 is reported as a range, not an asset',
    rangeDisc.ranges.some((r) => r.range === '203.0.113.0/24')
    && !rangeDisc.candidates.some((c) => c.target.startsWith('203.0.113.0')));
  chk('…while the /32 beside it still is an asset',
    rangeDisc.candidates.some((c) => c.target === '203.0.113.9'));

  // redirect= REPLACES the record (RFC 7208 §6.1), so its mechanisms are ours —
  // unlike include:, which delegates.
  const redir = await reputation.discoverSpf('redir.example', 200,
    spfStub({
      'redir.example': [['v=spf1 redirect=_spf.redir.example']],
      '_spf.redir.example': [['v=spf1 ip4:192.0.2.10 -all']],
    }, {}));
  chk('redirect= contributes its addresses as the domain\'s own',
    redir.candidates.some((c) => c.target === '192.0.2.10'), redir.candidates.map((c) => c.target).join(', '));

  // Two SPF records is a PermError in its own right and a real misconfiguration.
  const dup = await reputation.discoverSpf('dup.example', 200,
    spfStub({ 'dup.example': [['v=spf1 ip4:198.51.100.1 -all'], ['v=spf1 ip4:198.51.100.2 -all']] }, {}));
  chk('two SPF records are reported as a PermError',
    dup.warnings.some((w) => /2 SPF records/.test(w) && /PermError/.test(w)), dup.warnings.join(' | '));

  // A domain with no SPF at all must say so rather than look like "nothing to do".
  const noSpf = await reputation.discoverSpf('nospf.example', 200, spfStub({}, {}));
  chk('a domain without SPF is reported, not silently empty',
    noSpf.warnings.some((w) => /no SPF record|could not read/.test(w)), noSpf.warnings.join(' | '));

  chk('an IP is refused as a discovery target', await (async () => {
    try { await reputation.discoverSpf('1.2.3.4', 200, spfStub()); return false; } catch { return true; }
  })());

  // mx: resolves through the MX names to their addresses.
  const mxDisc = await reputation.discoverSpf('mx.example', 200,
    spfStub({ 'mx.example': [['v=spf1 mx -all']] },
      { 'mail.mx.example': ['198.51.100.44'] },
      { 'mx.example': [{ exchange: 'mail.mx.example', priority: 10 }] }));
  chk('an `mx` mechanism resolves to its addresses',
    mxDisc.candidates.some((c) => c.target === '198.51.100.44' && c.source.startsWith('mx:')),
    mxDisc.candidates.map((c) => c.target + '/' + c.source).join(', '));

  // ── 13. migration v10 -> v11 carries an open listing across ─────────────
  // db.js is a singleton, so the migration cannot re-run in this process: build
  // a v10-shaped database and load db.js against it in a child.
  chk('migration v10 -> v12 preserves the asset and its open listing', await migrationCarriesOver());

  console.log(R.join('\n'));
  const failed = R.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\n${R.length - failed}/${R.length} checks passed`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('harness error:', e);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(1);
});
