'use strict';
const { db, getMembership, anyMembership } = require('./db');
const config = require('./config');
const edition = require('./edition');
const { now, sha256, randHex, RateLimiter, httpError, isOrgId, DEFAULT_ORG_ID } = require('./util');

const ROLE_RANK = { analyst: 1, lead: 2, cto: 3, admin: 4 };

const authLimiter = new RateLimiter({ perMinute: 10, burst: 10 });
const apiLimiter = new RateLimiter({ perMinute: 300, burst: 60 });
const ingestLimiter = new RateLimiter({ perMinute: 600, burst: 200 });

const getSession = db.prepare('SELECT * FROM sessions WHERE id = ?');
const touchSession = db.prepare('UPDATE sessions SET last_used_at = ? WHERE id = ?');
// The request context deliberately never carries pass_salt/pass_hash — nothing
// downstream needs the credential, and not having it there is one fewer way to
// leak it into a log line. The UI does need to know WHETHER a password exists
// (an invited account has none), so that one bit is derived in SQL instead.
const getUser = db.prepare(`SELECT id, org_id, email, name, role, is_super_admin, color, active,
  must_change_password, (pass_hash != '') AS has_password FROM users WHERE id = ?`);
const getOrg = db.prepare('SELECT id, name, slug, plan, status FROM organizations WHERE id = ?');
const touchUser = db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?');
const delSession = db.prepare('DELETE FROM sessions WHERE id = ?');
const getKeyByHash = db.prepare('SELECT * FROM api_keys WHERE key_hash = ? AND active = 1');
const touchKey = db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?');
const setSessionOrg = db.prepare('UPDATE sessions SET active_org_id = ? WHERE id = ?');
const getUserHomeOrg = db.prepare('SELECT org_id FROM users WHERE id = ?');

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(res, sid) {
  const attrs = [`opscat_sid=${sid}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${Math.floor(config.sessionMaxMs / 1000)}`];
  if (config.cookieSecure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}
function clearSessionCookie(res) {
  const attrs = ['opscat_sid=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (config.cookieSecure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function createSession(userId, req, activeOrgId = null) {
  const sid = randHex(32);
  const csrf = randHex(16);
  if (!activeOrgId) {
    const u = getUserHomeOrg.get(userId);
    activeOrgId = u ? u.org_id : null;
  }
  db.prepare(`INSERT INTO sessions (id, user_id, active_org_id, csrf, created_at, last_used_at, ip, user_agent)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(sid, userId, activeOrgId, csrf, now(), now(), clientIp(req), String(req.headers['user-agent'] || '').slice(0, 300));
  return { sid, csrf };
}

function clientIp(req) {
  if (config.trustProxy) {
    // Exactly one trusted proxy (Caddy) sits in front and APPENDS the real
    // client IP, so the rightmost X-Forwarded-For entry is trustworthy. Taking
    // the leftmost would let a client spoof the header and defeat rate limits.
    const xf = req.headers['x-forwarded-for'];
    if (xf) {
      const parts = String(xf).split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
  }
  return req.socket.remoteAddress || '';
}

// Session auth for /api. Also enforces CSRF header on state-changing methods.
function requireSession(req, res, next) {
  const sid = parseCookies(req).opscat_sid;
  if (!sid) return httpError(res, 401, 'not authenticated');
  const sess = getSession.get(sid);
  const t = now();
  if (!sess || t - sess.last_used_at > config.sessionIdleMs || t - sess.created_at > config.sessionMaxMs) {
    if (sess) delSession.run(sid);
    clearSessionCookie(res);
    return httpError(res, 401, 'session expired');
  }
  const user = getUser.get(sess.user_id);
  if (!user || !user.active) return httpError(res, 401, 'account disabled');

  // Resolve the org this session is acting in (multi-org). Start from the
  // session's active org (default: the user's home org).
  let orgId = sess.active_org_id || user.org_id;

  // Super-admins (platform operators) may act within ANY org via ?org=<id> or the
  // X-OpsCat-Org header (platform console) — no membership required there.
  let superOverride = false;
  if (user.is_super_admin) {
    const requested = String(req.headers['x-opscat-org'] || req.query.org || '').trim();
    if (isOrgId(requested)) { orgId = requested; superOverride = true; }
  }

  // Everyone else must hold a membership in the active org. If the session's
  // active org is stale (membership revoked), fall back to the home org or any
  // remaining membership and persist that so later requests are consistent.
  let membership = getMembership(user.id, orgId);
  if (!membership && !superOverride) {
    membership = getMembership(user.id, user.org_id) || anyMembership(user.id);
    if (membership) { orgId = membership.org_id; setSessionOrg.run(orgId, sid); }
  }
  if (!membership && !user.is_super_admin) return httpError(res, 403, 'no organization membership');
  // A platform operator looking at a customer's data leaves a record. Writes
  // audit themselves; reads did not, so "who looked into org X, and when" had no
  // answer other than the web server's access log — which nobody keeps as an
  // access record and which the operator's own org cannot see at all.
  if (superOverride && !membership) noteCrossOrgAccess(user, orgId, sid, req);

  const org = getOrg.get(orgId);
  if (!org) return httpError(res, 401, 'organization missing');
  if (org.status === 'suspended' && !user.is_super_admin) {
    return httpError(res, 403, 'organization suspended');
  }
  if (!apiLimiter.allow(sid)) return httpError(res, 429, 'rate limit exceeded');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    if (req.headers['x-opscat-csrf'] !== sess.csrf) return httpError(res, 403, 'CSRF check failed');
  }
  touchSession.run(t, sid);
  touchUser.run(t, user.id);
  // Role is per-org: use the membership role for the active org. A super-admin
  // acting inside an org they don't belong to operates as an admin there.
  user.role = membership ? membership.role : 'admin';
  req.user = user;
  req.session = sess;
  req.org = org;
  req.orgId = orgId;
  next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.user || !req.user.is_super_admin) return httpError(res, 403, 'super-admin only');
  next();
}

function requireRole(minRole) {
  return (req, res, next) => {
    if (!req.user || ROLE_RANK[req.user.role] < ROLE_RANK[minRole]) {
      return httpError(res, 403, 'insufficient permissions');
    }
    next();
  };
}

// ── token auth for the REST API ────────────────────────────────────────────
// Lets the same /api endpoints the UI uses be driven by a script, a cron job or
// any HTTP client — not only from a browser session and not only through MCP.
//
// Two credentials resolve here, both presented as `Authorization: Bearer`:
//
//   • an API key with the `api` scope   → acts with the key's own `role`
//   • an MCP OAuth access token          → acts as its user, with that user's
//                                          membership role in the bound org
//
// Both produce exactly the request shape `requireSession` produces (req.user,
// req.org, req.orgId, req.user.role), so no route handler needs to know how the
// request authenticated.
//
// CSRF is deliberately NOT enforced for Bearer: CSRF exists to protect *cookie*
// auth, and a browser cannot be tricked into attaching someone else's
// Authorization header.
//
// Mounted only on the operational routers (ops, synthetics, vendors). Account,
// API-key, billing, org and super-admin administration stay session-only — a
// credential that can mint another credential is a privilege-escalation path.
const apiTokenLimiter = new RateLimiter({ perMinute: 300, burst: 60 });

function bearerPrincipal(req, res, next, token) {
  const { getMembership } = require('./db');
  const org = (id) => getOrg.get(id);

  // 1. OAuth access token (MCP). Same credential, wider surface.
  const oauth = require('./lib/oauth');
  const tok = oauth.verifyAccessToken(token);
  if (tok) {
    const needed = ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? 'read' : 'write';
    const scopes = String(tok.scopes || '').split(',').filter(Boolean);
    if (!scopes.includes(needed)) return httpError(res, 403, `token lacks scope '${needed}'`);
    const user = getUser.get(tok.user_id);
    if (!user || !user.active) return httpError(res, 401, 'account disabled');
    const membership = getMembership(user.id, tok.org_id);
    if (!membership) return httpError(res, 403, 'no organization membership');
    const o = org(tok.org_id);
    if (!o) return httpError(res, 401, 'organization missing');
    if (o.status === 'suspended' && !user.is_super_admin) return httpError(res, 403, 'organization suspended');
    if (!apiTokenLimiter.allow(`t${tok.id}`)) return httpError(res, 429, 'rate limit exceeded');
    user.role = membership.role;
    req.user = user;
    req.org = o;
    req.orgId = o.id;
    req.authKind = 'oauth';
    return next();
  }

  // 2. API key with the `api` scope.
  const row = getKeyByHash.get(sha256(token));
  if (!row) return httpError(res, 401, 'invalid token');
  if (!row.scopes.split(',').includes('api')) return httpError(res, 403, "key lacks scope 'api'");
  const o = org(row.org_id);
  if (!o) return httpError(res, 401, 'organization missing');
  if (o.status === 'suspended') return httpError(res, 403, 'organization suspended');
  if (!apiTokenLimiter.allow(`k${row.id}`)) return httpError(res, 429, 'rate limit exceeded');
  touchKey.run(now(), row.id);
  // A key is not a person. It acts as the user who created it, so audit entries
  // and assignments still name a human; the key's own role caps what it may do.
  req.user = {
    id: row.created_by ?? null,
    email: `apikey:${row.prefix}`,
    name: row.name,
    role: row.role || 'analyst',
    is_super_admin: 0,
    active: 1,
  };
  req.org = o;
  req.orgId = o.id;
  req.apiKey = row;
  req.authKind = 'apikey';
  return next();
}

function requireSessionOrToken(req, res, next) {
  const auth = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (m) return bearerPrincipal(req, res, next, m[1]);
  return requireSession(req, res, next);
}

// API-key auth for /v1 ingest surfaces. Key via Authorization: Bearer or X-Api-Key or ?key=
function requireApiKey(scope) {
  return (req, res, next) => {
    let key = null;
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) key = auth.slice(7).trim();
    if (!key && req.headers['x-api-key']) key = String(req.headers['x-api-key']).trim();
    if (!key && req.query.key) key = String(req.query.key);
    if (!key) return httpError(res, 401, 'missing API key');
    const row = getKeyByHash.get(sha256(key));
    if (!row) return httpError(res, 401, 'invalid API key');
    if (!row.scopes.split(',').includes(scope)) return httpError(res, 403, `key lacks scope '${scope}'`);
    if (!ingestLimiter.allow(`k${row.id}`)) return httpError(res, 429, 'rate limit exceeded');
    touchKey.run(now(), row.id);
    req.apiKey = row;
    req.orgId = row.org_id;   // ingest is stamped with the key's organization
    next();
  };
}

// CSP: the SPA is self-hosted and there is no inline JS; Google Fonts are the
// only external asset the community core touches.
//
// OpsCat Cloud additionally loads the Lynk Testify SDK from lynk.run for armed
// tester sessions (web/src/testify.ts) and lets it POST its events back, so the
// cloud policy names that origin in script-src AND connect-src. Both are needed:
// script-src to load it at all, connect-src for /api/testify/public. Nothing
// else — the SDK renders its DOM snapshot into a data: URI (already covered by
// img-src) and uses no worker, blob, WebSocket or eval.
//
// script-src used to be absent entirely, which silently falls back to
// default-src 'self'. That is how the loader shipped in #47 spent months
// blocked: the browser refused the script and nothing outside the console said
// so, so the in-app SDK never once ran in production.
//
// The community core keeps the strict policy — its loader is stubbed to a no-op
// at publish time and it contacts no external service (see docs/OPEN-CORE.md).
const TESTIFY_ORIGIN = 'https://lynk.run';
const cloudOnly = (origin) => (edition.isCloud() ? ` ${origin}` : '');

// OpsCat Bridge (docs/BRIDGE.md): the LiveKit signal endpoint is a sibling
// origin (wss://bridge.<domain>) — connect-src governs WebSockets too, so the
// browser needs it there, plus its https twin for livekit-client's
// /rtc/validate error probe. Config-driven, not edition-gated (the Bridge is
// community core): a deployment without OPSCAT_LIVEKIT_URL keeps the tight
// default. This shipped missing at first and died in the browser as "could
// not establish signal connection" while every server-side check was green —
// the exact #47 symptom class described above. e2e-bridge.js now asserts it.
const livekitOrigins = (() => {
  if (!config.livekit.url) return '';
  try {
    const { protocol, host } = new URL(config.livekit.url);
    const ws = protocol === 'ws:' ? 'ws' : 'wss';
    const http = protocol === 'ws:' ? 'http' : 'https';
    return ` ${ws}://${host} ${http}://${host}`;
  } catch { return ''; }
})();

const CSP = [
  "default-src 'self'",
  `script-src 'self'${cloudOnly(TESTIFY_ORIGIN)}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  `connect-src 'self'${cloudOnly(TESTIFY_ORIGIN)}${livekitOrigins}`,
  // Web Push (docs/ONCALL-V1.md §7) needs the service worker and the manifest.
  // Both are same-origin and would already be allowed by the `default-src`
  // fallback — they are named anyway, because "it works by falling back" is
  // exactly how the next directive that does NOT fall back the way somebody
  // assumed gets left out (CLAUDE.md § Content-Security-Policy). No new origin:
  // a push subscription is a browser-to-push-service conversation the page
  // never makes itself.
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

// The Bridge captures mic + screen on the SAME origin, so microphone must be
// (self) once LiveKit is configured — `microphone=()` is an empty allowlist
// that hard-disables getUserMedia even for ourselves. display-capture is not
// named on purpose: its default allowlist already is 'self'. Camera stays
// blocked until a Bridge phase actually ships video.
const PERMISSIONS_POLICY = `camera=(), microphone=(${config.livekit.url ? 'self' : ''}), geolocation=()`;

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
  res.setHeader('Content-Security-Policy', CSP);
  next();
}

/**
 * One audit row per (session, target org), not one per request.
 *
 * Per-request would be honest and useless: opening the Monitor fires a dozen
 * calls, so a single support look-in would bury the log it is supposed to make
 * readable. Entry is the event worth recording — and re-recorded after
 * CROSS_ORG_TTL_MS so a session left open for a day does not stand for a single
 * timestamp.
 *
 * The marker is in memory on purpose: it is a de-duplication hint, not the
 * record. Losing it on restart re-audits one access, which is the harmless
 * direction to fail in.
 */
const CROSS_ORG_TTL_MS = 30 * 60 * 1000;
const CROSS_ORG_MAX = 5000;
const crossOrgSeen = new Map();

function noteCrossOrgAccess(user, orgId, sid, req) {
  const key = `${sid}|${orgId}`;
  const t = now();
  const seen = crossOrgSeen.get(key);
  if (seen && t - seen < CROSS_ORG_TTL_MS) return;
  if (crossOrgSeen.size >= CROSS_ORG_MAX) {
    for (const [k, ts] of crossOrgSeen) if (t - ts >= CROSS_ORG_TTL_MS) crossOrgSeen.delete(k);
    if (crossOrgSeen.size >= CROSS_ORG_MAX) crossOrgSeen.clear();
  }
  crossOrgSeen.set(key, t);
  // baseUrl + path, never originalUrl: the query string carries log search terms
  // and filters, i.e. the customer's data, and an audit trail is the last place
  // that should quietly accumulate it. `req.path` alone is relative to the
  // router's mount point, so it would record `/events` for `/api/events`.
  const via = req.headers['x-opscat-org'] ? 'header' : 'link';
  const where = `${req.baseUrl || ''}${req.path}`;
  audit(user.id, 'superadmin_org_access', `${via} · ${req.method} ${where}`, orgId);
}

function audit(userId, action, detail, orgId = DEFAULT_ORG_ID) {
  db.prepare('INSERT INTO audit_log (org_id, ts, user_id, action, detail) VALUES (?, ?, ?, ?, ?)')
    .run(orgId || DEFAULT_ORG_ID, now(), userId || null, action,
      detail ? String(detail).slice(0, 1000) : null);
}

module.exports = {
  ROLE_RANK, authLimiter, parseCookies, setSessionCookie, clearSessionCookie,
  createSession, clientIp, requireSession, requireSessionOrToken, requireRole, requireSuperAdmin, requireApiKey,
  securityHeaders, audit,
};
