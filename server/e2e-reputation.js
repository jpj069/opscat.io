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

  // ── 6. schema: the type CHECK accepts reputation ─────────────────────────
  const { db } = require('./src/db');
  const org = db.prepare('SELECT id FROM organizations ORDER BY id LIMIT 1').get();
  chk('a bootstrapped org exists', !!org);
  const ins = db.prepare(`INSERT INTO synthetic_checks
      (org_id, type, target, interval_s, timeout_ms, enabled, assertions, created_at)
    VALUES (?, 'reputation', ?, 21600, 3000, 1, NULL, ?)`);
  let repId = null;
  try { repId = ins.run(org.id, '203.0.113.9', Date.now()).lastInsertRowid; } catch (e) { /* reported below */ }
  chk('a reputation check row inserts', !!repId);
  let rejected = false;
  try {
    db.prepare(`INSERT INTO synthetic_checks (org_id, type, target, interval_s, timeout_ms, enabled, created_at)
      VALUES (?, 'bogus', 'x', 60, 1000, 1, ?)`).run(org.id, Date.now());
  } catch { rejected = true; }
  chk('an unknown check type is still rejected by the CHECK constraint', rejected);

  const httpId = db.prepare(`INSERT INTO synthetic_checks
      (org_id, type, target, interval_s, timeout_ms, enabled, assertions, created_at)
    VALUES (?, 'http', 'https://example.com', 60, 3000, 1, NULL, ?)`)
    .run(org.id, Date.now()).lastInsertRowid;

  // ── 7. the trust boundary: probe-supplied meta must not forge an event ───
  // recordResult reads `meta` that can arrive from POST /v1/synthetics/report.
  // A listing event may only be raised for a check whose OWN type is reputation.
  const synth = require('./src/engine/synthetics');
  const loc = db.prepare(
    "INSERT INTO synthetic_locations (org_id, city, cc, kind, created_at) VALUES (?, 'e2e', 'XX', 'local', ?)")
    .run(org.id, Date.now()).lastInsertRowid;
  const evCount = () => db.prepare("SELECT COUNT(*) c FROM events WHERE name = 'reputation_listed'").get().c;

  const forged = {
    kind: 'ip', zonesQueried: 32, listedCount: 1, worstTier: 'critical',
    listed: [{ name: 'Spamhaus ZEN', zone: 'zen.spamhaus.org', tier: 'critical', codes: ['127.0.0.2'] }],
  };
  const before = evCount();
  synth.recordResult(httpId, loc, { ok: true, latency: 12, meta: forged });
  chk('a forged listing on an http check raises no event', evCount() === before,
    `events went ${before} -> ${evCount()}`);

  synth.recordResult(repId, loc, { ok: false, latency: 40, meta: forged });
  chk('a real listing on a reputation check raises the event', evCount() === before + 1,
    `events went ${before} -> ${evCount()}`);
  const ev = db.prepare("SELECT * FROM events WHERE name = 'reputation_listed' ORDER BY id DESC LIMIT 1").get();
  chk('the event carries the critical severity', ev && ev.severity === reputation.TIER_SEVERITY.critical,
    ev ? String(ev.severity) : 'no event');
  chk('the event names the asset, not a probe', ev && ev.device === '203.0.113.9', ev ? ev.device : '');

  // informational-only findings are recorded but never alert
  const infoMeta = {
    kind: 'ip', zonesQueried: 32, listedCount: 1, worstTier: 'informational',
    listed: [{ name: 'UCEPROTECT L3', zone: 'dnsbl-3.uceprotect.net', tier: 'informational', codes: ['127.0.0.2'] }],
  };
  const beforeInfo = evCount();
  synth.recordResult(repId, loc, { ok: true, latency: 30, meta: infoMeta });
  chk('an informational-only listing raises no event', evCount() === beforeInfo);

  // The headline count must be the ACTIONABLE count over the full result, not
  // something reconstructed from the truncated top-10. The shape that matters is
  // the ordinary one: `listed` is built in zone order (criticals, standards,
  // then informationals), so informational entries are exactly what slice(0,10)
  // drops — 8 actionable + 4 informational, of which only 2 informational are
  // still visible. Deriving from listedCount here would say 10.
  const manyMeta = {
    kind: 'ip', zonesQueried: 31, listedCount: 12, actionableCount: 8, worstTier: 'standard',
    listed: [
      ...Array.from({ length: 8 }, (_, i) => ({
        name: `Std ${i}`, zone: `s${i}.example`, tier: 'standard', codes: ['127.0.0.2'],
      })),
      ...Array.from({ length: 2 }, (_, i) => ({
        name: `Info ${i}`, zone: `i${i}.example`, tier: 'informational', codes: ['127.0.0.2'],
      })),
    ],
  };
  synth.recordResult(repId, loc, { ok: false, latency: 30, meta: manyMeta });
  const many = db.prepare("SELECT * FROM events WHERE name = 'reputation_listed' ORDER BY id DESC LIMIT 1").get();
  chk('the headline count is the actionable count over the FULL result',
    many && / on 8 blocklist/.test(many.description), many ? many.description : '');
  chk('informational listings never inflate the headline count',
    many && !/ on (10|12) blocklist/.test(many.description), many ? many.description : '');

  // …and checkReputation must actually emit it, or the above only proves the
  // consumer works on a hand-made fixture.
  const repSrcEngine = fs.readFileSync(path.join(__dirname, 'src', 'engine', 'synthetics.js'), 'utf8');
  chk('checkReputation emits actionableCount from the full list',
    /actionableCount: actionable\.length/.test(repSrcEngine));

  // ── 8. reputation never fans out from the "run everything" button ────────
  const ran = await synth.runAllNow(org.id);
  chk('runAllNow skips reputation assets', ran.every((r) => r.check_id !== repId),
    JSON.stringify(ran.map((r) => r.check_id)));

  // ── 9. reputation stays out of the synthetics + MCP surfaces ─────────────
  // Reads the SQL out of the shipped source rather than re-stating it here: a
  // hand-written copy of the clause under test asserts only that SQLite can
  // count rows, and passes even when the fix is reverted.
  const srcOf = (f) => fs.readFileSync(path.join(__dirname, 'src', f), 'utf8');
  const synthSrc = srcOf('routes/synthetics.js');
  const mcpSrc = srcOf('mcp/tools.js');
  const guard = /type\s*!=\s*'reputation'|c\.type\s*!=\s*'reputation'/g;
  chk('routes/synthetics.js guards every result surface',
    (synthSrc.match(guard) || []).length >= 5, `${(synthSrc.match(guard) || []).length} guards`);
  chk('mcp/tools.js guards list_checks + the dashboard count',
    (mcpSrc.match(guard) || []).length >= 2, `${(mcpSrc.match(guard) || []).length} guards`);

  // ── 10. the probe cannot submit a reputation result at all ───────────────
  // The forged-event test above covers recordResult; this covers the OTHER half
  // of the boundary — /v1/synthetics/report must drop the row before it lands.
  const ingestSrc = srcOf('routes/ingest.js');
  chk('the probe work list never hands out reputation',
    /\.filter\(\(c\) => c\.type !== 'reputation'\)/.test(ingestSrc));
  chk('the report endpoint refuses reputation results',
    /chk\.type === 'reputation'\) continue;/.test(ingestSrc)
    && /SELECT id, org_id, type FROM synthetic_checks/.test(ingestSrc), 'no type-gated skip found');

  // ── 11. the 1h interval floor is the feature's own, not the plan's ───────
  const repSrc = srcOf('routes/reputation.js');
  chk('the interval floor is 3600s', /MIN_INTERVAL_S = 3600/.test(repSrc));
  chk('the floor is never below the plan floor and is used at both write sites',
    /Math\.max\(MIN_INTERVAL_S, plans\.minIntervalFor\(plan\)\)/.test(repSrc)
    && (repSrc.match(/floorFor\(req\.org\.plan\)/g) || []).length === 2,
    `${(repSrc.match(/floorFor\(req\.org\.plan\)/g) || []).length} call sites`);
  chk('the latest-result query breaks ts ties on id',
    /ORDER BY ts DESC, id DESC/.test(repSrc));
  chk('coverage is reported per kind', /coverage: \{ ip: ipCov, domain: domainCov \}/.test(repSrc));

  // ── 12. an incomplete run is never rendered as a listing ────────────────
  const opsSrc = srcOf('routes/ops.js');
  chk('/api/assets distinguishes unknown from listed',
    /status = listed\.length \? 'listed' : 'unknown'/.test(opsSrc));

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
