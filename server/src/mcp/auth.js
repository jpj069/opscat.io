'use strict';
// Resolve a Bearer access token into the same principal shape the session path
// produces, so downstream code never has to care how the request authenticated.
//
// The token carries (user, orgs, scopes). It does NOT carry a role — the role is
// read from `memberships` here, on every request, which is the same row
// requireRole() reads for a browser session. A role change or a revoked
// membership therefore takes effect immediately instead of living on in a token
// until it expires.
//
// A connection may cover SEVERAL organizations (migration 037), and the same
// sentence is what makes that safe: the grant's org set is an upper bound and
// `oauth.resolveOrgs` intersects it with the memberships that exist right now.
// The role is per org — admin in one, analyst in another — so `principal.orgs`
// carries a role each, and `principal.role` is the BEST of them, used only to
// decide which tools are worth listing. What a tool may actually do is checked
// again, per call, against the organization that call resolved to.

const config = require('../config');
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

  // A suspended org is dropped from the set rather than failing the request:
  // with three orgs in a connection, one suspended account must not take the
  // other two offline. All of them suspended reads the same as no membership,
  // which is the answer below.
  const usable = (await oauth.resolveOrgs(user.id, token)).filter((m) => m.status !== 'suspended');
  if (!usable.length) {
    return challenge(res, 403, 'insufficient_scope', 'You are no longer a member of this organization.');
  }

  if (!mcpLimiter.allow(`mcp:${token.id}`)) {
    return res.status(429).json({ error: 'rate_limit_exceeded' });
  }

  // The primary org, and what a single-org connection has always been. It is the
  // token's `org_id` when that is still usable — a connection does not silently
  // change which org it defaults to because a membership elsewhere changed.
  const primary = usable.find((m) => m.org_id === token.org_id) || usable[0];
  const orgs = usable.map((m) => ({
    id: m.org_id, name: m.name, slug: m.slug, plan: m.plan, status: m.status, role: m.role,
  }));
  const best = orgs.reduce((a, o) => (sec.ROLE_RANK[o.role] > sec.ROLE_RANK[a.role] ? o : a), orgs[0]);

  user.role = primary.role;
  req.mcp = {
    user,
    org: { id: primary.org_id, name: primary.name, slug: primary.slug, plan: primary.plan, status: primary.status },
    orgId: primary.org_id,
    role: primary.role,
    orgs,
    // Listing is gated on the best role held anywhere; DOING is gated per call
    // on the resolved org's own role (mcp/server.js). Gating the list on the
    // lowest instead would hide a tool an admin genuinely has in the org they
    // are asking about, because they are an analyst somewhere else.
    listRole: best.role,
    scopes: new Set(String(token.scopes || '').split(',').filter(Boolean)),
    clientId: token.client_id,
    tokenId: token.id,
  };
  next();
}

module.exports = { requireMcpAuth, MCP_RESOURCE, RESOURCE_METADATA_URL };
