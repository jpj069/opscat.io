'use strict';
const { db, getMembership, anyMembership } = require('./db');
const config = require('./config');
const { now, sha256, randHex, RateLimiter, httpError } = require('./util');

const ROLE_RANK = { analyst: 1, lead: 2, cto: 3, admin: 4 };

const authLimiter = new RateLimiter({ perMinute: 10, burst: 10 });
const apiLimiter = new RateLimiter({ perMinute: 300, burst: 60 });
const ingestLimiter = new RateLimiter({ perMinute: 600, burst: 200 });

const getSession = db.prepare('SELECT * FROM sessions WHERE id = ?');
const touchSession = db.prepare('UPDATE sessions SET last_used_at = ? WHERE id = ?');
const getUser = db.prepare(`SELECT id, org_id, email, name, role, is_super_admin, color, active,
  must_change_password FROM users WHERE id = ?`);
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
    const requested = parseInt(req.headers['x-opscat-org'] || req.query.org, 10);
    if (Number.isInteger(requested) && requested > 0) { orgId = requested; superOverride = true; }
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

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // CSP: the SPA is self-hosted; only Google Fonts are external. No inline JS.
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data:; connect-src 'self'; " +
    "base-uri 'self'; frame-ancestors 'none'; object-src 'none'");
  next();
}

function audit(userId, action, detail, orgId = 1) {
  db.prepare('INSERT INTO audit_log (org_id, ts, user_id, action, detail) VALUES (?, ?, ?, ?, ?)')
    .run(orgId || 1, now(), userId || null, action, detail ? String(detail).slice(0, 1000) : null);
}

module.exports = {
  ROLE_RANK, authLimiter, parseCookies, setSessionCookie, clearSessionCookie,
  createSession, clientIp, requireSession, requireRole, requireSuperAdmin, requireApiKey,
  securityHeaders, audit,
};
