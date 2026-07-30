'use strict';
const crypto = require('crypto');
// Reputation — DNSBL / RHSBL blocklist monitoring for an org's sending assets.
//
// This asks "is this asset on a blocklist?" — NOT "is it up?". A listed mail
// server answers perfectly well; it has simply stopped being delivered. So a
// listing raises its own event (`reputation_listed`), never
// `synthetic_check_failed`, which would send whoever is on call hunting an
// outage that is not happening.
//
// Two query shapes, picked from the target:
//   IPv4/IPv6  -> reversed address + IP zone      (e.g. 2.0.0.127.zen.spamhaus.org)
//   domain     -> domain + RHSBL zone             (e.g. example.com.dbl.spamhaus.org)
// The target is checked verbatim; a domain is NOT resolved to its A record first.
// That would silently check the website instead of the mail sender, which is the
// opposite of what anyone configuring a reputation check wants.
//
// STORAGE. Two tables, because they answer different questions and deserve
// different lifetimes:
//   reputation_runs     — one row per lookup. A time series; pruned like every
//                         other sample table.
//   reputation_listings — one row per episode of being listed, with
//                         first_seen / resolved_at. Kept, because "since when
//                         are we on Spamhaus?" is the first question asked after
//                         a listing, and it is the evidence a delisting request
//                         is argued with.
// Storing verdicts as samples (which is what the first version did, in
// synthetic_results.meta) can express neither.

const dns = require('dns');
const net = require('net');
const { db } = require('../db');
const { now } = require('../util');
const pipeline = require('./pipeline');

// ---- zones -----------------------------------------------------------------
//
// tier drives severity, and severity is the whole game here: a naive
// "any listing = alarm" implementation produces so much noise that the feature
// gets muted within a fortnight. The tiers:
//
//   critical      widely enforced by real receivers; mail actually bounces
//   standard      real listings with moderate enforcement
//   informational ASN-wide or vanity lists. UCEPROTECT L3 lists entire
//                 autonomous systems ("bad neighbourhood"), so a clean sender
//                 gets caught by a noisy peer. Recorded and shown, never alerted.
//
// Zones marked `policy: true` are not accusations at all — Spamhaus PBL means
// "this range should not be delivering mail directly". Handled separately.

const IP_ZONES = [
  // critical — enforced broadly
  { zone: 'zen.spamhaus.org', name: 'Spamhaus ZEN', tier: 'critical' },
  { zone: 'bl.spamcop.net', name: 'SpamCop', tier: 'critical' },
  { zone: 'b.barracudacentral.org', name: 'Barracuda', tier: 'critical' },
  { zone: 'psbl.surriel.com', name: 'PSBL', tier: 'critical' },
  { zone: 'bl.mailspike.net', name: 'Mailspike BL', tier: 'critical' },
  { zone: 'truncate.gbudb.net', name: 'TRUNCATE', tier: 'critical' },

  // standard — real, less universally enforced
  { zone: 'dnsbl.sorbs.net', name: 'SORBS', tier: 'standard' },
  { zone: 'spam.dnsbl.sorbs.net', name: 'SORBS Spam', tier: 'standard' },
  { zone: 'bl.blocklist.de', name: 'BLOCKLIST.DE', tier: 'standard' },
  { zone: 'spam.spamrats.com', name: 'SpamRATS Spam', tier: 'standard' },
  { zone: 'bl.spameatingmonkey.net', name: 'SEM BLACK', tier: 'standard' },
  { zone: 'backscatter.spameatingmonkey.net', name: 'SEM Backscatter', tier: 'standard' },
  { zone: 'bl.nordspam.com', name: 'Nordspam BL', tier: 'standard' },
  { zone: 'dnsbl.spfbl.net', name: 'SPFBL', tier: 'standard' },
  { zone: 'rbl.interserver.net', name: 'InterServer', tier: 'standard' },
  { zone: 'dnsbl.dronebl.org', name: 'DroneBL', tier: 'standard' },
  { zone: 'all.s5h.net', name: 's5h.net', tier: 'standard' },
  { zone: 'dnsbl.zapbl.net', name: 'ZapBL', tier: 'standard' },
  { zone: 'ips.backscatterer.org', name: 'Backscatterer', tier: 'standard' },
  { zone: 'bl.score.senderscore.com', name: 'Sender Score', tier: 'standard' },
  { zone: 'dnsbl-1.uceprotect.net', name: 'UCEPROTECT L1', tier: 'standard' },

  // informational — ASN/range-wide or low enforcement; never alerts
  { zone: 'dnsbl-2.uceprotect.net', name: 'UCEPROTECT L2', tier: 'informational' },
  { zone: 'dnsbl-3.uceprotect.net', name: 'UCEPROTECT L3', tier: 'informational' },
  { zone: 'noptr.spamrats.com', name: 'SpamRATS NoPtr', tier: 'informational' },
  { zone: 'dyna.spamrats.com', name: 'SpamRATS Dyna', tier: 'informational' },
  { zone: 'z.mailspike.net', name: 'Mailspike Z', tier: 'informational' },
  { zone: 'badnets.spameatingmonkey.net', name: 'SEM BADNETS', tier: 'informational' },
  { zone: 'ban.zebl.zoneedit.com', name: 'ZoneEdit ZEBL', tier: 'informational' },
  { zone: 'rbl.abuse.ro', name: 'abuse.ro', tier: 'informational' },
  { zone: 'bl.nosolicitado.org', name: 'NoSolicitado', tier: 'informational' },
  { zone: 'spam.rbl.msrbl.net', name: 'MSRBL Spam', tier: 'informational' },
];

const DOMAIN_ZONES = [
  { zone: 'dbl.spamhaus.org', name: 'Spamhaus DBL', tier: 'critical', canary: 'dbltest.com' },
  { zone: 'multi.surbl.org', name: 'SURBL', tier: 'critical', canary: 'test.surbl.org' },
  { zone: 'dbl.nordspam.com', name: 'Nordspam DBL', tier: 'standard' },
  { zone: 'uri.spameatingmonkey.net', name: 'SEM URI', tier: 'standard' },
  { zone: 'urired.spameatingmonkey.net', name: 'SEM URIRED', tier: 'standard' },
  { zone: 'fresh.spameatingmonkey.net', name: 'SEM FRESH', tier: 'informational' },
  { zone: 'rhsbl.sorbs.net', name: 'SORBS RHSBL', tier: 'standard' },
  { zone: 'badconf.rhsbl.sorbs.net', name: 'SORBS RHSBL BADCONF', tier: 'informational' },
];

// Delisting / lookup pages, surfaced on the finding so the case carries the
// removal path instead of just the bad news. {q} is the original target.
const INFO_URLS = {
  'zen.spamhaus.org': 'https://check.spamhaus.org/listed/?searchterm={q}',
  'dbl.spamhaus.org': 'https://check.spamhaus.org/listed/?searchterm={q}',
  'bl.spamcop.net': 'https://www.spamcop.net/w3m?action=checkblock&ip={q}',
  'b.barracudacentral.org': 'https://www.barracudacentral.org/lookups/lookup-reputation?lookup_entry={q}',
  'psbl.surriel.com': 'https://psbl.org/listing?ip={q}',
  'dnsbl.sorbs.net': 'https://www.sorbs.net/lookup.shtml?{q}',
  'spam.dnsbl.sorbs.net': 'https://www.sorbs.net/lookup.shtml?{q}',
  'bl.blocklist.de': 'https://www.blocklist.de/en/search.html?ip={q}',
  'dnsbl.dronebl.org': 'https://dronebl.org/lookup?ip={q}',
  'dnsbl-1.uceprotect.net': 'https://www.uceprotect.net/en/rblcheck.php?ipr={q}',
  'dnsbl-2.uceprotect.net': 'https://www.uceprotect.net/en/rblcheck.php?ipr={q}',
  'dnsbl-3.uceprotect.net': 'https://www.uceprotect.net/en/rblcheck.php?ipr={q}',
  'multi.surbl.org': 'https://www.surbl.org/surbl-analysis?domain={q}',
  'truncate.gbudb.net': 'https://www.gbudb.com/truncate/index.jsp',
  'bl.mailspike.net': 'https://mailspike.org/iplookup.html?ip={q}',
  'z.mailspike.net': 'https://mailspike.org/iplookup.html?ip={q}',
  'all.s5h.net': 'https://www.usenix.org.uk/content/blacklist.html',
  'ips.backscatterer.org': 'https://www.backscatterer.org/?target=test&ip={q}',
  'dnsbl.spfbl.net': 'https://matrix.spfbl.net/{q}',
  'rbl.interserver.net': 'https://rbldb.interserver.net/index.php?ip={q}',
  'bl.spameatingmonkey.net': 'https://spameatingmonkey.com/lookup?q={q}',
  'backscatter.spameatingmonkey.net': 'https://spameatingmonkey.com/lookup?q={q}',
  'badnets.spameatingmonkey.net': 'https://spameatingmonkey.com/lookup?q={q}',
  'uri.spameatingmonkey.net': 'https://spameatingmonkey.com/lookup?q={q}',
  'urired.spameatingmonkey.net': 'https://spameatingmonkey.com/lookup?q={q}',
  'fresh.spameatingmonkey.net': 'https://spameatingmonkey.com/lookup?q={q}',
  'bl.nordspam.com': 'https://www.nordspam.com/lookup/',
  'dbl.nordspam.com': 'https://www.nordspam.com/lookup/',
  'bl.score.senderscore.com': 'https://senderscore.org/act/blocklist-remediation/',
  'spam.spamrats.com': 'https://www.spamrats.com/lookup.php?ip={q}',
  'noptr.spamrats.com': 'https://www.spamrats.com/lookup.php?ip={q}',
  'dyna.spamrats.com': 'https://www.spamrats.com/lookup.php?ip={q}',
  'rbl.abuse.ro': 'https://abuse.ro/',
  'dnsbl.zapbl.net': 'https://zapbl.net/lookup?q={q}',
  'rhsbl.sorbs.net': 'https://www.sorbs.net/lookup.shtml?{q}',
};

// ---- response-code classification ------------------------------------------

// The 127.255.255.x range is not a listing. DNSBLs return it for rate limiting,
// open-resolver refusal and test queries — Spamhaus in particular answers this
// way to anything coming from a public resolver. Treating it as a hit is the
// single most common way these integrations produce phantom alerts.
const isErrorCode = (addr) => addr.startsWith('127.255.255.');

// Spamhaus PBL: "this range should not send mail directly" — a policy statement
// about the address block, not evidence of abuse.
const SPAMHAUS_POLICY = new Set(['127.0.0.10', '127.0.0.11']);
// Spamhaus DBL returns this when queried with an IP instead of a domain.
const SPAMHAUS_DBL_ERROR = new Set(['127.0.1.255']);
// DroneBL 127.0.0.7 = dynamic-DNS host; informational rather than an accusation.
const DRONEBL_POLICY = new Set(['127.0.0.7']);

function classify(zone, addresses) {
  const real = (addresses || []).filter((a) => !isErrorCode(a));
  if (real.length === 0) return { listed: false, policy: false, codes: [] };

  if (zone === 'zen.spamhaus.org') {
    const threat = real.filter((a) => !SPAMHAUS_POLICY.has(a));
    return { listed: threat.length > 0, policy: threat.length < real.length, codes: real };
  }
  if (zone === 'dbl.spamhaus.org') {
    const valid = real.filter((a) => !SPAMHAUS_DBL_ERROR.has(a));
    return { listed: valid.length > 0, policy: false, codes: valid };
  }
  if (zone === 'dnsbl.dronebl.org') {
    const threat = real.filter((a) => !DRONEBL_POLICY.has(a));
    return { listed: threat.length > 0, policy: threat.length < real.length, codes: real };
  }
  return { listed: true, policy: false, codes: real };
}

// ---- target parsing ---------------------------------------------------------

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function reverseIPv4(ip) {
  const m = IPV4_RE.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return parts.reverse().join('.');
}

// IPv6 reverses to nibbles, low-order first (RFC 5782 §2.4). Most zones do not
// carry IPv6 data — those simply answer NXDOMAIN, which reads as "not listed".
function reverseIPv6(ip) {
  if (!net.isIPv6(ip)) return null;
  const full = expandIPv6(ip);
  if (!full) return null;
  return full.split('').reverse().join('.');
}

function expandIPv6(ip) {
  // "::1" -> 32 hex nibbles, no separators
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const full = groups.map((g) => g.padStart(4, '0')).join('').toLowerCase();
  // "::ffff:127.0.0.1" and "fe80::1%eth0" both survive the group split; without
  // this they become a malformed query name, the resolver answers EBADNAME on
  // every zone, and the asset reports "no critical blocklist reachable" forever
  // — sending the operator after the resolver instead of the target.
  return /^[0-9a-f]{32}$/.test(full) ? full : null;
}

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

/**
 * Decide how a reputation target is queried.
 * @returns {{kind:'ip'|'domain', query:string, zones:Array}|null} null = unusable target
 */
function parseTarget(raw) {
  const t = String(raw || '').trim().toLowerCase().replace(/\.$/, '');
  if (!t) return null;
  const v4 = reverseIPv4(t);
  if (v4) return { kind: 'ip', query: v4, zones: IP_ZONES };
  if (net.isIPv6(t)) {
    const v6 = reverseIPv6(t);
    return v6 ? { kind: 'ip', query: v6, zones: IP_ZONES } : null;
  }
  if (DOMAIN_RE.test(t)) return { kind: 'domain', query: t, zones: DOMAIN_ZONES };
  return null;
}

// ---- lookup -----------------------------------------------------------------

const CONCURRENCY = 15;
const DEFAULT_TIMEOUT_MS = 3000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), ms);
      if (t.unref) t.unref();
    }),
  ]);
}

// The resolver deliberately defaults to the host's own DNS rather than a public
// one. Spamhaus and others refuse queries arriving from Google/Cloudflare
// resolvers (answering 127.255.255.x), so a probe using its local resolver gets
// real answers where a centralised SaaS scraper gets rate limited. Override with
// OPSCAT_REPUTATION_DNS="9.9.9.9,149.112.112.112" if the host resolver is unfit.
// `tries` defaults to 1: across 31 zones a retry storm costs more than the one
// zone it might recover, and the canary reports the gap honestly. SPF discovery
// passes a higher value — see discoverSpf.
function buildResolver(timeoutMs, tries = 1) {
  const resolver = new dns.promises.Resolver({ timeout: timeoutMs, tries });
  const override = String(process.env.OPSCAT_REPUTATION_DNS || '').trim();
  if (override) {
    const servers = override.split(',').map((s) => s.trim()).filter(Boolean);
    if (servers.length) { try { resolver.setServers(servers); } catch { /* keep system resolver */ } }
  }
  return resolver;
}

// ---- zone availability canary ----------------------------------------------
//
// RFC 5782 §5 requires a conforming DNSBL to list 127.0.0.2 and to NOT list
// 127.0.0.1. We use that mandated entry as a canary, because "no answer" from a
// blocklist is dangerously ambiguous: it means either "not listed" or "this zone
// refused us". Spamhaus answers plain NXDOMAIN to queries arriving via large
// public resolvers — indistinguishable from a clean verdict, on the single most
// consequential list there is. SpamRATS and Mailspike time out for the same
// reason, and a retired list (SORBS was shut down in 2024) answers NXDOMAIN
// forever, reporting every asset as clean until someone notices.
//
// So: a zone that cannot return its own canary is reported as UNAVAILABLE, never
// as clean. Same principle as the intel API's null-means-not-checked contract.
// RFC 5782 §5 mandates BOTH halves, and they catch opposite failures:
//   positive (127.0.0.2 IS listed)     -> the zone is alive and answering us
//   negative (127.0.0.1 is NOT listed) -> its answers actually mean something
// Skipping the negative half is not a rounding error: a wildcard or
// NXDOMAIN-hijacking resolver (captive portal, some ISPs, an internal catch-all
// zone, a mistyped OPSCAT_REPUTATION_DNS) answers every query, so every zone
// "lists" every target — reporting the org's entire mail estate as critically
// listed, severity 85, one case each. One extra query per zone per hour.
//
// The negative control applies to BOTH kinds. RHSBLs have no standardised test
// entry, so the IP pair is useless there — but a name under `.invalid` works
// universally: RFC 2606 reserves that TLD, so it can never be registered and no
// conforming list can legitimately have an opinion about it. The label is random
// per lookup so a poisoned cache cannot be primed against a known probe.
const IP_CANARY = '2.0.0.127';       // must be listed
const IP_ANTI_CANARY = '1.0.0.127';  // must NOT be listed
const domainAntiCanary = () => `nx-${crypto.randomBytes(8).toString('hex')}.invalid`;
const CANARY_TTL_MS = 60 * 60 * 1000;
const canaryCache = new Map(); // zone -> { usable: boolean, at: number }

const answers = (addrs) => (addrs || []).some((a) => !isErrorCode(a));

// A zone that answers about the anti-canary is wildcarding. `classify` rather
// than a raw answer check, so a zone politely reporting "you queried me wrong"
// (Spamhaus DBL's 127.0.1.255) is not mistaken for one.
function assertsAnything(zone, addrs) {
  const v = classify(zone, addrs || []);
  return v.listed || v.policy;
}

// A zone with no positive canary (most RHSBLs — test entries there are per-zone,
// not standardised) still gets the negative control: we cannot prove it is
// alive, but we can prove it is lying.
async function zoneUsable(z, resolver, timeoutMs, defaultCanary, antiCanary) {
  const probe = z.canary || defaultCanary;
  const cached = canaryCache.get(z.zone);
  if (cached && Date.now() - cached.at < CANARY_TTL_MS) return cached.usable;

  let usable = true;
  if (probe) {
    try {
      usable = answers(await withTimeout(resolver.resolve4(`${probe}.${z.zone}`), timeoutMs));
    } catch { usable = false; }
  }

  // A zone that also "lists" what cannot be listed is not answering about our
  // target at all — trust nothing it says rather than one verdict of it.
  if (usable && antiCanary) {
    try {
      const addrs = await withTimeout(resolver.resolve4(`${antiCanary}.${z.zone}`), timeoutMs);
      if (assertsAnything(z.zone, addrs)) usable = false;
    } catch { /* NXDOMAIN here is exactly the expected answer */ }
  }

  canaryCache.set(z.zone, { usable, at: Date.now() });
  return usable;
}

/** Drop cached canary verdicts (tests / forced re-probe). */
function resetCanaryCache() { canaryCache.clear(); }

/**
 * Query every zone for a target.
 * @returns {Promise<{kind, target, zonesQueried, listed:[], policy:[], unavailable:[],
 *   errors:number, worstTier:string|null, criticalCovered:boolean}>}
 */
// `injectedResolver` exists so the canary logic is testable without network
// access — see server/e2e-reputation.js. Nothing in the app passes it.
async function lookup(target, timeoutMs = DEFAULT_TIMEOUT_MS, injectedResolver = null) {
  const parsed = parseTarget(target);
  if (!parsed) throw new Error('target must be an IP address or a domain name');

  const resolver = injectedResolver || buildResolver(timeoutMs);
  const defaultCanary = parsed.kind === 'ip' ? IP_CANARY : null;
  // Both kinds get a negative control — see the canary block above for why the
  // domain one is a random .invalid name rather than the RFC 5782 IP pair.
  const antiCanary = parsed.kind === 'ip' ? IP_ANTI_CANARY : domainAntiCanary();
  const listed = [];
  const policy = [];
  const unavailable = [];
  const errored = [];
  const answered = [];
  let errors = 0;
  let criticalCovered = false;

  for (let i = 0; i < parsed.zones.length; i += CONCURRENCY) {
    const batch = parsed.zones.slice(i, i + CONCURRENCY);
    // eslint-disable-next-line no-await-in-loop
    const results = await Promise.allSettled(batch.map(async (z) => {
      if (!await zoneUsable(z, resolver, timeoutMs, defaultCanary, antiCanary)) return { z, unusable: true };
      const name = `${parsed.query}.${z.zone}`;
      try {
        const addresses = await withTimeout(resolver.resolve4(name), timeoutMs);
        return { z, addresses };
      } catch (e) {
        // NXDOMAIN is the overwhelmingly common answer: not listed.
        if (e && (e.code === 'ENOTFOUND' || e.code === 'ENODATA')) return { z, addresses: [] };
        // Anything else (SERVFAIL, timeout, …) is a zone we did NOT get an
        // answer from. Name it rather than counting it: an unnamed error is
        // indistinguishable from "clean" in every surface downstream.
        return { z, error: String((e && (e.code || e.message)) || 'error').slice(0, 40) };
      }
    }));
    for (const r of results) {
      if (r.status !== 'fulfilled') { errors++; continue; }
      const { z, addresses, unusable, error } = r.value;
      if (unusable) { unavailable.push({ name: z.name, zone: z.zone, tier: z.tier }); continue; }
      if (error) { errors++; errored.push({ name: z.name, zone: z.zone, tier: z.tier, error }); continue; }
      // This zone gave us a real answer. Recorded by name because resolving an
      // open listing is only defensible against a zone that actually replied —
      // see syncListings.
      answered.push(z.zone);
      if (z.tier === 'critical') criticalCovered = true;
      const verdict = classify(z.zone, addresses);
      const url = INFO_URLS[z.zone] ? INFO_URLS[z.zone].replace('{q}', encodeURIComponent(target)) : null;
      if (verdict.listed) listed.push({ name: z.name, zone: z.zone, tier: z.tier, codes: verdict.codes, url });
      if (verdict.policy) policy.push({ name: z.name, zone: z.zone, codes: verdict.codes, url });
    }
  }

  const worstTier = listed.some((l) => l.tier === 'critical') ? 'critical'
    : listed.some((l) => l.tier === 'standard') ? 'standard'
      : listed.length ? 'informational' : null;

  return {
    kind: parsed.kind,
    target,
    zonesQueried: parsed.zones.length - unavailable.length - errors,
    zonesTotal: parsed.zones.length,
    listed,
    policy,
    unavailable,
    errored,
    answered,        // zone names that replied — the only ones a verdict covers
    errors,
    worstTier,
    criticalCovered,
  };
}

// Severity on OpsCat's 0-100 scale (>=80 critical, >=60 major, >=40 minor).
// Informational listings never reach the alerting floor by design.
const TIER_SEVERITY = { critical: 85, standard: 65, informational: 30 };

// The form a target is stored in: trimmed, lower-cased, no trailing root dot.
// Returns null for anything parseTarget would reject.
function normalizeTarget(raw) {
  // `\.+$` not `\.$`: parseTarget strips one trailing dot itself, so stripping
  // only one here let "example.com.." through as "example.com." — stored,
  // displayed and baked into the delist URL with a stray dot.
  const t = String(raw || '').trim().toLowerCase().replace(/\.+$/, '');
  return parseTarget(t) ? t : null;
}

// Identity for de-duplication. `query` is already canonical for both kinds —
// a domain is the lower-cased name, an IP is its reversed nibble/octet form, so
// 2001:0db8::1 and 2001:db8::1 collapse to the same key the way an operator
// expects. Do NOT dedupe on the raw string.
function targetKey(raw) {
  const parsed = parseTarget(raw);
  return parsed ? `${parsed.kind}:${parsed.query}` : null;
}

// ---- persistence -------------------------------------------------------------

const insRun = db.prepare(`INSERT INTO reputation_runs
  (asset_id, ts, status, zones_queried, zones_total, worst_tier, duration_ms,
   unavailable, errored, policy, error, mx_hosts)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const openListingsFor = db.prepare(
  'SELECT * FROM reputation_listings WHERE asset_id = ? AND resolved_at IS NULL');
const touchListing = db.prepare(`UPDATE reputation_listings
  SET last_seen = ?, codes = ?, url = ?, tier = ?, name = ? WHERE id = ?`);
const openListing = db.prepare(`INSERT INTO reputation_listings
  (asset_id, zone, name, tier, codes, url, subject, first_seen, last_seen, resolved_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`);
const resolveListing = db.prepare('UPDATE reputation_listings SET resolved_at = ? WHERE id = ?');
const setRdns = db.prepare('UPDATE reputation_assets SET rdns = ? WHERE id = ?');
const enabledAssets = db.prepare('SELECT * FROM reputation_assets WHERE enabled = 1');

const jsonOrNull = (v) => (v && v.length ? JSON.stringify(v) : null);

/**
 * Fold one lookup's findings into the open-listing state.
 *
 * The load-bearing rule is in the second loop: a listing may only be resolved by
 * a zone that ANSWERED this run. A zone that refused, timed out or failed its
 * canary has told us nothing, and reading its silence as a delisting would erase
 * a live critical finding every time the resolver has a bad day — the same
 * "no answer is not clean" principle the canary enforces one level down.
 *
 * @returns {{opened:Array, resolved:Array}} state transitions, for the events
 */
// Identity of a finding: WHAT is listed, on WHICH list. `subject` is '' for the
// asset itself and "mail.example.com [1.2.3.4]" for a host its MX points at —
// those are separate facts with separate lifecycles, so they get separate keys.
const listingKey = (subject, zone) => `${subject || ''}\u0000${zone}`;

function syncListings(assetId, found, answeredKeys, ts) {
  const answered = new Set(answeredKeys);
  const open = openListingsFor.all(assetId);
  const byKey = new Map(open.map((l) => [listingKey(l.subject, l.zone), l]));
  const foundKeys = new Set(found.map((f) => listingKey(f.subject, f.zone)));
  const opened = [];
  const resolved = [];

  for (const f of found) {
    const existing = byKey.get(listingKey(f.subject, f.zone));
    if (existing) {
      // Same episode continuing: extend it, and refresh the fields a list can
      // change under us (a new return code, a moved delisting page).
      touchListing.run(ts, jsonOrNull(f.codes), f.url || null, f.tier, f.name, existing.id);
    } else {
      openListing.run(assetId, f.zone, f.name, f.tier, jsonOrNull(f.codes), f.url || null,
        f.subject || '', ts, ts);
      opened.push(f);
    }
  }

  for (const l of open) {
    const key = listingKey(l.subject, l.zone);
    if (foundKeys.has(key)) continue;
    if (!answered.has(key)) continue; // silent zone — prove nothing, change nothing
    resolveListing.run(ts, l.id);
    resolved.push(l);
  }
  return { opened, resolved };
}

// A domain asset is checked against the RHSBLs, but that only covers the domain
// NAME. The hosts its MX records point at are separate addresses on separate
// lists, and for a self-hosted mail server they are the org's own problem — a
// listed MX means inbound mail is being refused, which the domain's own RHSBL
// verdict says nothing about.
//
// Bounded hard: at most this many DISTINCT addresses. Each one is a full ~31-zone
// lookup, so an unbounded fan-out over a domain with eight MX records would be
// ~250 queries against lists that rate-limit per source IP. Microsoft 365 and
// Google resolve their MX names to the same few addresses anyway, so the cap
// almost never bites in practice.
const MX_MAX_ADDRESSES = 3;

async function checkMxHosts(asset, timeoutMs, injectedResolver) {
  const resolver = injectedResolver || buildResolver(timeoutMs, 2);
  if (typeof resolver.resolveMx !== 'function') return { found: [], answered: [], hosts: [] };

  let mxs;
  try {
    mxs = await withTimeout(resolver.resolveMx(asset.target), timeoutMs);
  } catch { return { found: [], answered: [], hosts: [] }; }
  if (!mxs || !mxs.length) return { found: [], answered: [], hosts: [] };

  // Resolve MX names to addresses, deduplicated: several MX names sharing one
  // address is the norm, and checking it twice would waste the whole budget.
  const seen = new Set();
  const targets = [];
  for (const mx of mxs.sort((a, b) => a.priority - b.priority)) {
    if (targets.length >= MX_MAX_ADDRESSES) break;
    let addrs = [];
    try { addrs = await withTimeout(resolver.resolve4(mx.exchange), timeoutMs) || []; }
    catch { continue; }
    for (const ip of addrs) {
      if (seen.has(ip) || targets.length >= MX_MAX_ADDRESSES) continue;
      seen.add(ip);
      targets.push({ host: String(mx.exchange).replace(/\.$/, ''), ip });
    }
  }

  const found = [];
  const answered = [];
  const hosts = [];
  for (const t of targets) {
    let res;
    // eslint-disable-next-line no-await-in-loop
    try { res = await lookup(t.ip, timeoutMs, injectedResolver); } catch { continue; }
    const subject = `${t.host} [${t.ip}]`;
    hosts.push({ host: t.host, ip: t.ip, listed: res.listed.length, covered: res.criticalCovered });
    for (const z of res.answered) answered.push(listingKey(subject, z));
    for (const l of res.listed) found.push({ ...l, subject });
  }
  return { found, answered, hosts };
}

/**
 * Look one asset up, record the run, fold the findings into the listing history
 * and raise the events. This is the only writer — nothing outside this module
 * decides what a listing is, which is why no probe can forge one.
 */
// `injectedResolver` exists so the whole path — run, listing lifecycle, events —
// is testable without network access, the same contract lookup() offers. Nothing
// in the app passes it; see server/e2e-reputation.js.
async function runAsset(asset, timeoutMs = DEFAULT_TIMEOUT_MS, injectedResolver = null) {
  const started = process.hrtime.bigint();
  const ts = now();
  let res = null;
  let failure = null;
  try {
    res = await lookup(asset.target, timeoutMs, injectedResolver);
  } catch (e) {
    failure = String((e && e.message) || 'lookup failed').slice(0, 160);
  }
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;

  if (!res) {
    // An unusable target or a resolver that gave us nothing at all. Recorded as
    // `unknown`, never as clean, and the open listings stay open.
    insRun.run(asset.id, ts, 'unknown', 0, 0, null, durationMs, null, null, null, failure, null);
    return { status: 'unknown', error: failure, listed: [], opened: [], resolved: [] };
  }

  // Reverse DNS names the asset in operator terms — "mail4.link11.com" says far
  // more in a table than "85.131.131.20". Best-effort: a sender without a PTR is
  // a finding of its own, not a reason to fail the run.
  if (asset.kind === 'ip') {
    try {
      const names = await (injectedResolver || dns.promises).reverse(asset.target);
      const rdns = names && names.length ? String(names[0]).slice(0, 253) : null;
      if (rdns !== asset.rdns) setRdns.run(rdns, asset.id);
    } catch { /* no PTR, or the resolver refused — keep the last known value */ }
  }

  // For a domain, also check the hosts its MX records point at. Their findings
  // ride along on the same asset, distinguished by `subject`.
  let mx = { found: [], answered: [], hosts: [] };
  if (asset.kind === 'domain') {
    try { mx = await checkMxHosts(asset, timeoutMs, injectedResolver); }
    catch { /* the domain's own verdict stands on its own */ }
  }

  const allFound = [...res.listed.map((l) => ({ ...l, subject: '' })), ...mx.found];
  const actionable = allFound.filter((l) => l.tier !== 'informational');
  // A finding outranks a partial outage: if zones answered and one of them
  // listed the asset, that is a fact, and reporting `unknown` would contradict
  // the alert the on-call just received. The incompleteness still rides along in
  // `error` so the UI can say the run did not cover everything.
  // Worst tier across the domain AND its mail servers — a critical listing on an
  // MX outranks a clean domain verdict, because mail stops either way.
  const worstTier = allFound.some((l) => l.tier === 'critical') ? 'critical'
    : allFound.some((l) => l.tier === 'standard') ? 'standard'
      : allFound.length ? 'informational' : null;

  let status;
  if (actionable.length) status = 'listed';
  else if (!res.criticalCovered) status = 'unknown';
  else if (allFound.length) status = 'informational';
  else status = 'clean';

  const error = res.criticalCovered ? null
    : 'no critical blocklist reachable — check the resolver (OPSCAT_REPUTATION_DNS)';

  insRun.run(asset.id, ts, status, res.zonesQueried, res.zonesTotal,
    worstTier || null, durationMs,
    jsonOrNull(res.unavailable), jsonOrNull(res.errored), jsonOrNull(res.policy), error,
    jsonOrNull(mx.hosts));

  const answeredKeys = [
    ...res.answered.map((z) => listingKey('', z)),
    ...mx.answered,
  ];
  const { opened, resolved } = syncListings(asset.id, allFound, answeredKeys, ts);

  if (actionable.length) {
    // Name the mail server when that is what is listed. "link11.com listed on
    // Spamhaus ZEN" would send someone looking at the wrong thing entirely.
    const names = actionable.map((l) => (l.subject ? `${l.name} (${l.subject})` : l.name)).join(', ');
    pipeline.ingestEvent({
      name: 'reputation_listed', device: asset.target, target: asset.target,
      severity: TIER_SEVERITY[worstTier] || TIER_SEVERITY.standard,
      description: `reputation_listed ${asset.target} listed on ${actionable.length} blocklist(s): ${names}`.slice(0, 300),
    }, 'reputation', false, asset.org_id);
  } else if (resolved.some((l) => l.tier !== 'informational')) {
    // Delisted. Only reachable now that a listing has a lifecycle — the sample
    // model could not tell "gone" from "never there". Emitted as a clear event so
    // a close_event automation can finish the raise and close its case; kept
    // below the alerting floor so nobody is paged for good news.
    const names = resolved.filter((l) => l.tier !== 'informational').map((l) => l.name).join(', ');
    pipeline.ingestEvent({
      name: 'reputation_cleared', device: asset.target, target: asset.target,
      severity: 20,
      description: `reputation_cleared ${asset.target} delisted from ${names}`.slice(0, 300),
    }, 'reputation', false, asset.org_id);
  }

  return { status, error, listed: allFound, mx: mx.hosts, opened, resolved };
}

// ---- scheduler ---------------------------------------------------------------

const lastRun = new Map(); // assetId -> ts

async function tick() {
  const t = now();
  for (const asset of enabledAssets.all()) {
    const due = (lastRun.get(asset.id) || 0) + asset.interval_s * 1000;
    if (t < due) continue;
    lastRun.set(asset.id, t);
    // Sequential on purpose: one asset is ~40 DNS queries against lists that
    // rate-limit per source IP, and blocklist state does not move in seconds.
    // eslint-disable-next-line no-await-in-loop
    try { await runAsset(asset); } catch { /* recorded as a run above; never kill the tick */ }
  }
}

function start() {
  const iv = setInterval(() => { tick().catch(() => {}); }, 30000);
  iv.unref();
}

/** Forget the schedule (tests, and after an interval change). */
function resetSchedule(assetId = null) {
  if (assetId == null) lastRun.clear(); else lastRun.delete(assetId);
}

// ---- SPF discovery -----------------------------------------------------------
//
// Reads a domain's SPF record and turns it into a list of assets worth watching.
// This is the step that makes the feature usable: the finding that started it —
// a forgotten relay on a budget hoster, outside the company's own ASN — is only
// findable if something parses the SPF record, because nobody types that address
// into a lookup tool by hand. Asking the operator to enter it manually just moves
// the same problem one screen over.
//
// WHAT COUNTS AS OURS. Only mechanisms written directly in the record —
// `ip4`, `ip6`, `a`, `mx` — become candidates. An `include:` delegates to a third
// party (Microsoft 365, Pardot, Mailgun) whose shared pools are thousands of
// addresses that the provider monitors itself; listing them as the customer's
// assets would bury the eight addresses that actually are. Those are reported as
// pools instead, so the operator can see the delegation without drowning in it.
// `redirect=` is the exception: per RFC 7208 §6.1 it REPLACES the record rather
// than adding to it, so its mechanisms are the domain's own and recurse as
// top-level.
//
// The lookup budget falls out of the same walk for free, and it is worth more
// than it costs: link11.com's record needs 11 DNS lookups against a limit of 10,
// which is a PermError — every bit as fatal for delivery as a blocklist entry and
// far less visible.

const SPF_MAX_LOOKUPS = 10;   // RFC 7208 §4.6.4 — exceeded means PermError
const SPF_MAX_DEPTH = 8;      // include nesting; the lookup budget usually bites first
const SPF_MAX_QUERIES = 60;   // hard stop, so a looping or hostile record cannot fan out

const txtOf = async (resolver, name, timeoutMs) => {
  const rows = await withTimeout(resolver.resolveTxt(name), timeoutMs);
  // node returns each record as an array of strings that must be concatenated
  return (rows || []).map((r) => (Array.isArray(r) ? r.join('') : String(r)));
};

/**
 * Resolve a domain's SPF record into monitorable senders.
 * @returns {Promise<{domain, spf, lookups:{used,limit,permerror}, candidates:Array,
 *   pools:Array, ranges:Array, warnings:string[], queries:number}>}
 */
async function discoverSpf(domain, timeoutMs = DEFAULT_TIMEOUT_MS, injectedResolver = null) {
  const root = normalizeTarget(domain);
  if (!root || parseTarget(root).kind !== 'domain') throw new Error('a domain name is required');

  // Two retries here, unlike the blocklist path. There a lost packet costs one
  // zone out of 31 and the canary reports the gap; here a lost packet costs the
  // whole answer, and a TXT response is big enough to be the one that gets
  // dropped by a middlebox.
  const resolver = injectedResolver || buildResolver(timeoutMs, 3);
  const state = {
    lookups: 0, queries: 0, seen: new Set(), warnings: [],
    candidates: [], pools: [], ranges: [], rootSpf: null,
  };
  const addWarning = (w) => { if (!state.warnings.includes(w)) state.warnings.push(w); };

  // A single /32 or /128 is an address we can query a blocklist about. Anything
  // wider is a range: DNSBLs answer about addresses, not networks, and expanding
  // a /24 into 256 assets would be absurd.
  const asAddress = (spec) => {
    const [addr, prefix] = String(spec).split('/');
    const bare = addr.trim();
    if (!net.isIP(bare)) return null;
    if (prefix != null) {
      const p = Number(prefix);
      const full = net.isIPv4(bare) ? 32 : 128;
      if (!Number.isFinite(p) || p !== full) return null; // a real range
    }
    return bare;
  };

  const push = (target, source) => {
    const key = targetKey(target);
    if (!key || state.seen.has(key)) return;
    state.seen.add(key);
    state.candidates.push({ target: normalizeTarget(target) || target, kind: parseTarget(target).kind, source });
  };

  const resolveHostAddresses = async (host, source) => {
    for (const [fn, label] of [['resolve4', 'A'], ['resolve6', 'AAAA']]) {
      if (typeof resolver[fn] !== 'function') continue;
      state.queries++;
      try {
        const addrs = await withTimeout(resolver[fn](host), timeoutMs);
        for (const a of addrs || []) push(a, source);
      } catch { /* no record of that family, or refused — the other family may still answer */ }
      void label;
    }
  };

  // `own` = these mechanisms belong to the domain itself (top level, or reached
  // through a redirect). When false we are inside an include and only counting.
  async function walk(name, depth, own) {
    if (depth > SPF_MAX_DEPTH || state.queries >= SPF_MAX_QUERIES) return;
    state.queries++;
    let records;
    try {
      records = await txtOf(resolver, name, timeoutMs);
    } catch {
      if (own) addWarning(`could not read the SPF record of ${name}`);
      return;
    }
    const spfs = records.filter((r) => /^v=spf1(\s|$)/i.test(r.trim()));
    if (!spfs.length) {
      if (own) addWarning(`${name} publishes no SPF record`);
      return;
    }
    // More than one is a PermError in its own right (RFC 7208 §4.5) and a real
    // misconfiguration we should surface rather than silently pick one.
    if (spfs.length > 1) addWarning(`${name} publishes ${spfs.length} SPF records — that is a PermError`);
    const spf = spfs[0].trim();
    if (depth === 0) state.rootSpf = spf;

    for (const raw of spf.split(/\s+/).slice(1)) {
      if (state.queries >= SPF_MAX_QUERIES) { addWarning('stopped early: the record fans out too far'); return; }
      const tok = raw.replace(/^[+\-~?]/, ''); // qualifiers do not change what we resolve
      const lower = tok.toLowerCase();

      if (lower.startsWith('ip4:') || lower.startsWith('ip6:')) {
        const spec = tok.slice(4);
        const addr = asAddress(spec);
        if (!own) continue;                       // inside an include: pool detail
        if (addr) push(addr, lower.slice(0, 3));
        else state.ranges.push({ range: spec, via: name });
        continue;
      }

      if (lower === 'a' || lower.startsWith('a:')) {
        state.lookups++;
        const host = lower === 'a' ? name : tok.slice(2).split('/')[0];
        if (own) await resolveHostAddresses(host, `a:${host}`);
        continue;
      }

      if (lower === 'mx' || lower.startsWith('mx:')) {
        state.lookups++;
        const host = lower === 'mx' ? name : tok.slice(3).split('/')[0];
        if (!own || typeof resolver.resolveMx !== 'function') continue;
        state.queries++;
        try {
          const mxs = await withTimeout(resolver.resolveMx(host), timeoutMs);
          for (const mx of (mxs || []).slice(0, 10)) {
            state.lookups++;                      // each MX name costs its own lookup
            await resolveHostAddresses(mx.exchange, `mx:${mx.exchange}`);
          }
        } catch { addWarning(`could not resolve the MX of ${host}`); }
        continue;
      }

      if (lower.startsWith('include:')) {
        state.lookups++;
        const target = tok.slice(8);
        const before = state.lookups;
        // Walk it anyway — not for candidates, but because its nested includes
        // count against the same budget, which is exactly how records overflow.
        await walk(target, depth + 1, false);
        // Only top-level includes are reported. Nested ones are the provider's
        // internal structure — an operator needs "mailgun.org costs 5 lookups",
        // not the four sub-records it spends them on. The cost still rolls up.
        if (depth === 0) {
          state.pools.push({ include: target, via: name, lookups: state.lookups - before + 1 });
        }
        continue;
      }

      if (lower.startsWith('redirect=')) {
        state.lookups++;
        // Replaces the record rather than adding to it, so its mechanisms are ours.
        await walk(tok.slice(9), depth + 1, own);
        continue;
      }

      if (lower.startsWith('exists:') || lower === 'ptr' || lower.startsWith('ptr:')) {
        state.lookups++;                          // costs budget, yields no address
        if (lower.startsWith('ptr') && own) addWarning('the record uses `ptr`, which RFC 7208 deprecates');
      }
    }
  }

  await walk(root, 0, true);

  // The sending domain itself is an asset: RHSBLs answer about domains, and a
  // domain listing (Spamhaus DBL) is as fatal as an address listing.
  push(root, 'domain');

  const permerror = state.lookups > SPF_MAX_LOOKUPS;
  if (permerror) {
    addWarning(`the SPF record needs ${state.lookups} DNS lookups, above the limit of `
      + `${SPF_MAX_LOOKUPS} — receivers treat this as a PermError, so SPF fails`);
  }
  return {
    domain: root,
    spf: state.rootSpf,
    lookups: { used: state.lookups, limit: SPF_MAX_LOOKUPS, permerror },
    candidates: state.candidates,
    pools: state.pools,
    ranges: state.ranges,
    warnings: state.warnings,
    queries: state.queries,
  };
}

module.exports = {
  lookup, parseTarget, classify, reverseIPv4, reverseIPv6, expandIPv6, resetCanaryCache,
  normalizeTarget, targetKey,
  runAsset, syncListings, checkMxHosts, tick, start, resetSchedule,
  discoverSpf,
  IP_ZONES, DOMAIN_ZONES, TIER_SEVERITY, DEFAULT_TIMEOUT_MS, SPF_MAX_LOOKUPS,
};
