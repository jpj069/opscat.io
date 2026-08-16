'use strict';
// Custom domains for status pages (plan: status_domain, pro+).
//
// A customer points status.acme.com at us and the page answers there — logo,
// colours and all — with a certificate issued on demand. Two things have to be
// true before any of that happens, and they are the whole reason this module
// exists:
//
//   1. THE DOMAIN MUST BE PROVEN. Serving a hostname because somebody typed it
//      into a form would let any customer claim any name — including a
//      competitor's, or ours. Proof is a DNS TXT record only the domain's owner
//      can create. The CNAME that actually routes traffic is NOT proof: a
//      dangling CNAME left behind by a former owner would otherwise hand the
//      name to whoever asks next.
//   2. CERTIFICATE ISSUANCE MUST BE GATED. Caddy's on-demand TLS asks us before
//      it talks to Let's Encrypt. Answering "yes" to everything turns the
//      deployment into an open certificate mint and burns the ACME rate limit
//      within an hour of the first bot. routes/status.js answers that question
//      from `pageByDomain`, which is verified-only and plan-gated.
const dnsPromises = require('dns').promises;
const crypto = require('crypto');
const { db } = require('../db');
const { now } = require('../util');
const config = require('../config');

const CHALLENGE_PREFIX = '_opscat-challenge';
// Deliberately strict: labels of a-z0-9- separated by dots, at least two of
// them, no trailing dot, max 253 chars. Anything the browser would treat as an
// IP, a port or a path has no business here.
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function normalize(raw) {
  return String(raw || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
}

// Hostnames the platform serves itself. Letting a tenant claim one of these
// would let them take over the app, the marketing site or the vendor grid by
// filling in a form — the DNS proof would never even be reached, because the
// request never gets past our own vhost.
function reservedHosts() {
  const hosts = new Set();
  try { hosts.add(new URL(config.baseUrl).hostname.toLowerCase()); } catch { /* unparsable */ }
  if (config.gridHost) hosts.add(String(config.gridHost).toLowerCase());
  return hosts;
}

// -> null when acceptable, otherwise the reason to show the admin
function domainProblem(domain) {
  if (!domain) return 'domain required';
  if (!DOMAIN_RE.test(domain)) return 'not a valid hostname (use something like status.acme.com)';
  if (reservedHosts().has(domain)) return 'that hostname is served by the platform itself';
  return null;
}

const newToken = () => `opscat-verify-${crypto.randomBytes(16).toString('hex')}`;
const challengeHost = (domain) => `${CHALLENGE_PREFIX}.${domain}`;

const q = {
  byDomain: db.prepare('SELECT id, org_id FROM status_pages WHERE domain = ?'),
  set: db.prepare(`UPDATE status_pages SET domain = ?, domain_token = ?, domain_verified_at = NULL
    WHERE id = ?`),
  verified: db.prepare('UPDATE status_pages SET domain_verified_at = ? WHERE id = ?'),
  clear: db.prepare(`UPDATE status_pages SET domain = NULL, domain_token = NULL,
    domain_verified_at = NULL WHERE id = ?`),
};

// Claiming a domain is always unverified — even re-claiming the same one, and
// even for the page that already had it. Re-verification is cheap, and skipping
// it after an edit is how a stale proof outlives the DNS it was proving.
function setDomain(page, rawDomain) {
  const domain = normalize(rawDomain);
  const problem = domainProblem(domain);
  if (problem) return { ok: false, error: problem };
  const taken = q.byDomain.get(domain);
  if (taken && taken.id !== page.id) return { ok: false, error: 'that domain is already in use' };
  const token = newToken();
  q.set.run(domain, token, page.id);
  return { ok: true, domain, token, record: { host: challengeHost(domain), type: 'TXT', value: token } };
}

function clearDomain(page) { q.clear.run(page.id); }

// The resolver is injectable for the same reason it is in engine/reputation.js:
// a test must be able to answer DNS deterministically, and the CI box has no
// business making real queries about a customer's domain.
function buildResolver(timeoutMs = 5000) {
  const r = new dnsPromises.Resolver({ timeout: timeoutMs, tries: 1 });
  return { resolveTxt: (name) => r.resolveTxt(name) };
}

/**
 * Look for the challenge TXT and mark the page verified when it is there.
 *
 * A TXT answer is an array of chunk-arrays (a single record may be split at 255
 * bytes), so every record is joined before comparison — a token that happens to
 * straddle that boundary must not read as a mismatch.
 *
 * -> { ok:true } | { ok:false, error, found? }
 */
async function verifyDomain(page, resolver = null) {
  if (!page.domain || !page.domain_token) return { ok: false, error: 'no domain configured' };
  const host = challengeHost(page.domain);
  let records;
  try {
    records = await (resolver || buildResolver()).resolveTxt(host);
  } catch (e) {
    const missing = ['ENOTFOUND', 'ENODATA', 'NXDOMAIN'].includes(e.code);
    return { ok: false,
      error: missing
        ? `no TXT record at ${host} yet — DNS changes can take a few minutes`
        : `could not read DNS for ${host}: ${e.code || e.message}` };
  }
  const values = (records || []).map((r) => (Array.isArray(r) ? r.join('') : String(r)));
  if (!values.includes(page.domain_token)) {
    return { ok: false, error: `the TXT record at ${host} does not carry the expected value`,
      found: values.slice(0, 5) };
  }
  q.verified.run(now(), page.id);
  return { ok: true };
}

// What the admin has to put into their DNS: the proof record, and the CNAME
// that routes the traffic once the proof is in place.
function dnsInstructions(page) {
  if (!page.domain) return null;
  let target = 'opscat.io';
  try { target = new URL(config.baseUrl).hostname; } catch { /* keep default */ }
  return {
    challenge: { host: challengeHost(page.domain), type: 'TXT', value: page.domain_token || '' },
    routing: { host: page.domain, type: 'CNAME', value: target },
  };
}

module.exports = {
  DOMAIN_RE, CHALLENGE_PREFIX,
  normalize, domainProblem, setDomain, clearDomain, verifyDomain, dnsInstructions,
  challengeHost, buildResolver, reservedHosts,
};
