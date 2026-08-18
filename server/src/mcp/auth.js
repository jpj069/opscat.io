'use strict';
// Resolve a Bearer access token into the same principal shape the session path
// produces, so downstream code never has to care how the request authenticated.
//
// The token carries (user, org, scopes). It does NOT carry a role — the role is
// read from `memberships` here, on every request, which is the same row
// requireRole() reads for a browser session. A role change or a revoked
// membership therefore takes effect immediately instead of living on in a token
// until it expires.

const config = require('../config');
const { getMembership } = require('../db');
const q = require('../db/shim');
const sec = require('../security');
const oauth = require('../lib/oauth');
const { RateLimiter } = require('../util');

const MCP_RESOURCE = `${config.baseUrl}/mcp`;
const RESOURCE_METADATA_URL = `${config.baseUrl}/.well-known/oauth-protected-resource`;

// Per-token limiter, separate from the per-session apiLimiter and the
// ingest-sized ingestLimiter. Abuse control, not a plan quota — the app enforces
// no per-user call limit, so neither does this (docs/MCP-PLAN.md §0).
const mcpLimiter = new RateLimiter({ perMinute: 300, burst: 60 });

const getUserRow = q.prepare(`SELECT id, org_id, email, name, is_super_admin, color, active
  FROM users WHERE id = ?`);
const getOrgRow = q.prepare('SELECT id, name, slug, plan, status FROM organizations WHERE id = ?');

function challenge(res, status, error, description) {
  res.set('WWW-Authenticate',
    `Bearer realm="opscat-mcp", error="${error}", resource_metadata="${RESOURCE_METADATA_URL}"`);
  res.status(status).json({ error, error_description: description });
}

async function requireMcpAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return challenge(res, 401, 'invalid_request', 'A Bearer access token is required.');

  const token = await oauth.verifyAccessToken(m[1]);
  if (!token) return challenge(res, 401, 'invalid_token', 'The access token is invalid or expired.');

  // RFC 8707 audience binding. Unlike a server that predates binding, this one
  // has never issued a token without `resource`, so there is no legacy case to
  // tolerate: a token with no audience is rejected outright.
  if (token.resource !== MCP_RESOURCE) {
    return challenge(res, 401, 'invalid_token', 'Token is not bound to this resource.');
  }

  const user = await getUserRow.get(token.user_id);
  if (!user || !user.active) return challenge(res, 401, 'invalid_token', 'Account is disabled.');

  const membership = await getMembership(user.id, token.org_id);
  if (!membership) {
    return challenge(res, 403, 'insufficient_scope', 'You are no longer a member of this organization.');
  }

  const org = await getOrgRow.get(token.org_id);
  if (!org) return challenge(res, 401, 'invalid_token', 'Organization missing.');
  if (org.status === 'suspended') {
    return challenge(res, 403, 'insufficient_scope', 'Organization suspended.');
  }

  if (!mcpLimiter.allow(`mcp:${token.id}`)) {
    return res.status(429).json({ error: 'rate_limit_exceeded' });
  }

  user.role = membership.role;
  req.mcp = {
    user,
    org,
    orgId: org.id,
    role: membership.role,
    scopes: new Set(String(token.scopes || '').split(',').filter(Boolean)),
    clientId: token.client_id,
    tokenId: token.id,
  };
  next();
}

module.exports = { requireMcpAuth, MCP_RESOURCE, RESOURCE_METADATA_URL };
