'use strict';
// The ONE guard for outbound HTTP the product makes on a user's behalf.
//
// The rule: a URL a user can type must never be able to reach the host's own
// network. Cloud metadata (169.254.169.254), the compose sidecars, the database
// container, a neighbouring tenant's internal service — all of it sits behind
// addresses that a `fetch()` will happily connect to unless something refuses
// first. On a multi-tenant instance that is a tenant-boundary crossing; on a
// self-hosted one it is still the difference between "posts to my endpoint" and
// "reads my metadata service".
//
// Two properties do the actual work, and BOTH are needed:
//
//   1. Resolve the host and refuse private space. Checking the literal string
//      is not enough — `http://internal.attacker.com` can resolve to 127.0.0.1.
//   2. Follow redirects MANUALLY and re-check every hop. `fetch` follows 3xx by
//      itself, so a public URL that 302s to 169.254.169.254 walks straight past
//      a guard applied only to the URL the user typed.
//
// Known and accepted limit: between our DNS lookup and the connection the name
// can resolve differently (a rebinding attack). Closing that needs pinning the
// resolved address into the connection, which Node's fetch does not expose.
// The guard raises the cost from "type a URL" to "run a rebinding server", and
// the rest of the product does not treat outbound POSTs as trusted anyway.
//
// One escape hatch, and it is edition-gated: a self-hoster whose webhook
// receiver genuinely lives on the LAN has no tenant boundary to cross — the
// "attacker" would be the admin themselves — and refusing them would break a
// legitimate setup on upgrade with no way back. `OPSCAT_ALLOW_PRIVATE_TARGETS=1`
// lifts the address check for outbound webhooks, and it is IGNORED in the cloud
// edition, where the boundary is real. It is also what lets a hermetic test
// drive delivery against a loopback stub.
const net = require('net');
const dns = require('dns');

// Read lazily: edition.js pulls in plans.js -> db.js, and this module is
// required from engines that db.js does not depend on. A getter keeps the
// import graph acyclic and lets a test flip the env var.
function privateTargetsAllowed() {
  if (process.env.OPSCAT_ALLOW_PRIVATE_TARGETS !== '1') return false;
  return require('../edition').isCommunity();
}

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

// Private / loopback / link-local / CGNAT space, v4 and v6.
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10) return true;
    if (p[0] === 127) return true;
    if (p[0] === 0) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 169 && p[1] === 254) return true; // link-local incl. metadata
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    return false;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (l.startsWith('fe80') || l.startsWith('fc') || l.startsWith('fd')) return true;
    if (l.startsWith('::ffff:')) return isPrivateAddress(l.slice(7)); // IPv4-mapped
    return false;
  }
  return false;
}

// Throws unless `host` (a literal IP or a name) lands on a public address.
// `allowPrivate` is only ever passed by safeFetch, and only when the escape
// hatch above applies — synthetic checks and vendor feeds are never exempt.
async function assertPublicHost(host, allowPrivate = false) {
  if (allowPrivate) return;
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('target resolves to a private address');
    return;
  }
  const { address } = await dns.promises.lookup(host);
  if (isPrivateAddress(address)) throw new Error('target resolves to a private address');
}

// Guarded fetch: scheme check, per-hop SSRF guard, timeout, redirect cap.
// The response body is NOT returned — every caller here posts and only cares
// whether the receiver accepted it — but it is drained and size-capped so a
// hostile endpoint cannot stream forever into an open socket.
async function safeFetch(rawUrl, {
  method = 'GET', headers = {}, body,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  allowHttp = true,
} = {}) {
  const allowPrivate = privateTargetsAllowed();
  let url = rawUrl;
  for (let hop = 0; ; hop++) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('invalid URL'); }
    if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) {
      throw new Error(allowHttp ? 'url must be http(s)' : 'url must be https');
    }
    // strip the brackets an IPv6 URL carries before the address is inspected
    await assertPublicHost(parsed.hostname.replace(/^\[|\]$/g, ''), allowPrivate);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        method, headers, body, signal: ctrl.signal, redirect: 'manual',
      });
      if (resp.status >= 300 && resp.status < 400 && resp.status !== 304) {
        const loc = resp.headers.get('location');
        await resp.arrayBuffer().catch(() => {});
        if (!loc) throw new Error(`redirect ${resp.status} without a location`);
        if (hop >= maxRedirects) throw new Error('too many redirects');
        url = new URL(loc, url).href;   // re-enters the loop → guarded again
        continue;
      }
      // Drain (capped) so the connection can be reused and cannot be held open.
      let text = '';
      try {
        const buf = Buffer.from(await resp.arrayBuffer());
        text = buf.subarray(0, maxBodyBytes).toString('utf8');
      } catch { /* body unreadable — the status is what we act on */ }
      return { status: resp.status, ok: resp.ok, text };
    } finally { clearTimeout(timer); }
  }
}

module.exports = { isPrivateAddress, assertPublicHost, safeFetch };
