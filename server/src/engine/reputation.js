'use strict';
const crypto = require('crypto');
// DNSBL / RHSBL reputation lookups for the `reputation` synthetic check type.
//
// A reputation check answers "is this asset on a blocklist?" — NOT "is it up?".
// A listed mail server is usually perfectly reachable, so the check deliberately
// keeps its own event (`reputation_listed`) instead of `synthetic_check_failed`;
// see engine/synthetics.js.
//
// Two query shapes, picked from the target:
//   IPv4/IPv6  -> reversed address + IP zone      (e.g. 2.0.0.127.zen.spamhaus.org)
//   domain     -> domain + RHSBL zone             (e.g. example.com.dbl.spamhaus.org)
// The target is checked verbatim; a domain is NOT resolved to its A record first.
// That would silently check the website instead of the mail sender, which is the
// opposite of what anyone configuring a reputation check wants.

const dns = require('dns');
const net = require('net');

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
function buildResolver(timeoutMs) {
  const resolver = new dns.promises.Resolver({ timeout: timeoutMs, tries: 1 });
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
    listed,
    policy,
    unavailable,
    errored,
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

module.exports = {
  lookup, parseTarget, classify, reverseIPv4, reverseIPv6, expandIPv6, resetCanaryCache,
  normalizeTarget, targetKey,
  IP_ZONES, DOMAIN_ZONES, TIER_SEVERITY, DEFAULT_TIMEOUT_MS,
};
