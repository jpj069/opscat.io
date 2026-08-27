'use strict';
/**
 * The User-Agent a synthetic HTTP check sends.
 *
 * Three levels, most specific first: the check's own, the org's default, ours.
 * `OpsCat-Synthetics/1.0` stays the fallback on purpose — a monitor that says
 * what it is can be allow-listed at a WAF, recognised in an access log and
 * excluded from analytics, and none of that is possible once it pretends to be
 * Chrome. The override exists because a check pointed at a site behind bot
 * protection is refused for precisely that reason, and "red because the WAF
 * blocked the monitor" is not a signal anyone can act on.
 *
 * Worth knowing before reaching for a browser string: it gets you past a
 * User-Agent rule and nothing else. TLS fingerprinting (JA3) and JS challenges
 * see a Node client either way, and to those a "Chrome" that speaks Node TLS
 * and runs no JavaScript looks more like a scraper than an honest bot does.
 */
const DEFAULT_UA = 'OpsCat-Synthetics/1.0 (+https://opscat.io/bot)';

// One line, printable ASCII, and short. It goes into an HTTP header, so a
// newline is header injection — the same reasoning as the SSH key in cloud-init,
// one layer up the stack.
function validateUserAgent(raw) {
  const ua = String(raw == null ? '' : raw).trim();
  if (!ua) return null;                       // cleared = fall back
  if (ua.length > 200) throw new Error('user agent too long (max 200 characters)');
  if (!/^[\x20-\x7e]+$/.test(ua)) {
    throw new Error('user agent must be a single line of printable ASCII');
  }
  return ua;
}

/** check → org → ours. Both arguments may be null/undefined. */
const resolveUserAgent = (checkUa, orgUa) =>
  (checkUa && String(checkUa).trim()) || (orgUa && String(orgUa).trim()) || DEFAULT_UA;

module.exports = { DEFAULT_UA, validateUserAgent, resolveUserAgent };
