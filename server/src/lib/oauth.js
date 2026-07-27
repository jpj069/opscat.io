'use strict';
// OAuth 2.1 authorization server for the MCP endpoint.
//
// Shape (all mandated or strongly recommended by MCP revision 2025-11-25):
//   • public clients only — no client_secret, PKCE S256 mandatory (`plain` rejected)
//   • dynamic client registration, RFC 7591
//   • authorization codes: single-use, 10 min, stored hashed
//   • access tokens 1 h, refresh tokens 30 d with rotation
//   • RFC 8707 audience binding — a token carries the resource it may drive
//
// A token binds (user, org, scopes). It deliberately does NOT carry a role:
// the role is read from `memberships` on every request, so a role change or a
// revoked membership takes effect at once rather than living on in the token.

const crypto = require('crypto');
const { db } = require('../db');
const { now, sha256, randHex } = require('../util');

const CODE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// The scopes a client may ask for. `read` is everything the UI can display;
// `write` covers the mutating tools. Deliberately coarse — OpsCat has one tool
// family, so per-family scopes would be noise (see docs/MCP-PLAN.md).
const AVAILABLE_SCOPES = ['read', 'write'];

const insClient = db.prepare(
  'INSERT INTO oauth_clients (client_id, name, redirect_uris, scopes, created_at) VALUES (?,?,?,?,?)');
const getClientStmt = db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?');

const insCode = db.prepare(`INSERT INTO oauth_codes
  (code_hash, client_id, user_id, org_id, redirect_uri, code_challenge, scopes, resource, expires_at, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?)`);
const getCode = db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?');
const delCode = db.prepare('DELETE FROM oauth_codes WHERE code_hash = ?');

const insToken = db.prepare(`INSERT INTO oauth_tokens
  (token_hash, kind, client_id, user_id, org_id, scopes, resource, expires_at, created_at)
  VALUES (?,?,?,?,?,?,?,?,?)`);
const getToken = db.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = ?");
const delToken = db.prepare('DELETE FROM oauth_tokens WHERE token_hash = ?');
const touchToken = db.prepare('UPDATE oauth_tokens SET last_used_at = ? WHERE id = ?');
const delTokensForClientUser = db.prepare(
  'DELETE FROM oauth_tokens WHERE client_id = ? AND user_id = ? AND org_id = ?');
const listTokensForUser = db.prepare(`SELECT client_id, org_id, scopes, MAX(created_at) created_at,
  MAX(last_used_at) last_used_at, COUNT(*) n
  FROM oauth_tokens WHERE user_id = ? AND kind = 'access' AND expires_at > ?
  GROUP BY client_id, org_id`);

// ── clients ────────────────────────────────────────────────────────────────

// RFC 7591 §2: a redirect URI must be absolute and carry no fragment. We accept
// https, http on loopback only (the desktop-client convention), and custom
// schemes (cursor://, vscode://) which native clients register.
function validRedirectUri(uri) {
  let u;
  try { u = new URL(uri); } catch { return false; }
  if (u.hash) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol); // custom scheme
}

function registerClient({ name, redirectUris, scopes }) {
  const uris = Array.isArray(redirectUris) ? redirectUris.filter((u) => typeof u === 'string') : [];
  if (!uris.length) throw new Error('redirect_uris required');
  for (const u of uris) if (!validRedirectUri(u)) throw new Error(`invalid redirect_uri: ${u}`);
  const granted = (Array.isArray(scopes) ? scopes : String(scopes || '').split(/\s+/))
    .filter((s) => AVAILABLE_SCOPES.includes(s));
  const clientId = `ocm_${randHex(16)}`;
  insClient.run(clientId, String(name || 'MCP client').slice(0, 120), JSON.stringify(uris),
    (granted.length ? granted : AVAILABLE_SCOPES).join(','), now());
  return getClient(clientId);
}

function getClient(clientId) {
  const row = getClientStmt.get(String(clientId || ''));
  if (!row) return null;
  return { ...row, redirect_uris: JSON.parse(row.redirect_uris), scopes: row.scopes.split(',') };
}

// ── authorization codes ────────────────────────────────────────────────────

function issueCode({ clientId, userId, orgId, redirectUri, codeChallenge, scopes, resource }) {
  const code = randHex(32);
  const t = now();
  insCode.run(sha256(code), clientId, userId, orgId, redirectUri, codeChallenge,
    scopes.join(','), resource || null, t + CODE_TTL_MS, t);
  return code;
}

// Single-use: the row is deleted whether or not verification succeeds, so a
// leaked code cannot be retried against a different verifier.
function consumeCode(code, { clientId, redirectUri, codeVerifier }) {
  const hash = sha256(String(code || ''));
  const row = getCode.get(hash);
  if (!row) return { error: 'invalid_grant' };
  delCode.run(hash);
  if (row.expires_at < now()) return { error: 'invalid_grant' };
  if (row.client_id !== clientId) return { error: 'invalid_grant' };
  if (row.redirect_uri !== redirectUri) return { error: 'invalid_grant' };
  // PKCE S256 — the only method we accept (see the metadata document).
  const challenge = crypto.createHash('sha256').update(String(codeVerifier || '')).digest('base64url');
  if (challenge !== row.code_challenge) return { error: 'invalid_grant' };
  return { row };
}

// ── tokens ─────────────────────────────────────────────────────────────────

function issueTokens({ clientId, userId, orgId, scopes, resource }) {
  const access = `ocm_at_${randHex(32)}`;
  const refresh = `ocm_rt_${randHex(32)}`;
  const t = now();
  const s = Array.isArray(scopes) ? scopes.join(',') : String(scopes);
  insToken.run(sha256(access), 'access', clientId, userId, orgId, s, resource || null, t + ACCESS_TTL_MS, t);
  insToken.run(sha256(refresh), 'refresh', clientId, userId, orgId, s, resource || null, t + REFRESH_TTL_MS, t);
  return {
    access_token: access,
    refresh_token: refresh,
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    scope: s.split(',').join(' '),
  };
}

// Rotation: the presented refresh token is consumed and a fresh pair issued.
function consumeRefresh(token, clientId) {
  const hash = sha256(String(token || ''));
  const row = getToken.get(hash, 'refresh');
  if (!row) return { error: 'invalid_grant' };
  delToken.run(hash);
  if (row.expires_at < now() || row.client_id !== clientId) return { error: 'invalid_grant' };
  return { row };
}

// Resolve a Bearer access token. Returns null for unknown/expired — the caller
// turns that into a 401 challenge.
function verifyAccessToken(token) {
  const row = getToken.get(sha256(String(token || '')), 'access');
  if (!row) return null;
  if (row.expires_at < now()) { delToken.run(row.token_hash); return null; }
  touchToken.run(now(), row.id);
  return row;
}

function revokeToken(token) {
  const hash = sha256(String(token || ''));
  const row = db.prepare('SELECT client_id, user_id, org_id FROM oauth_tokens WHERE token_hash = ?').get(hash);
  if (!row) return false;
  // RFC 7009: revoking one token of a grant revokes the grant. Drop every token
  // this client holds for this (user, org) so a stale refresh can't resurrect it.
  delTokensForClientUser.run(row.client_id, row.user_id, row.org_id);
  return true;
}

function revokeGrant(clientId, userId, orgId) {
  const info = delTokensForClientUser.run(clientId, userId, orgId);
  return info.changes > 0;
}

function listGrants(userId) {
  return listTokensForUser.all(userId, now()).map((r) => ({
    clientId: r.client_id,
    orgId: r.org_id,
    scopes: r.scopes.split(','),
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    client: getClient(r.client_id),
  }));
}

// Housekeeping: expired rows are dead weight and a refresh token that outlived
// its window must not linger in a table someone might query loosely.
function purgeExpired() {
  const t = now();
  db.prepare('DELETE FROM oauth_tokens WHERE expires_at < ?').run(t);
  db.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').run(t);
}

module.exports = {
  AVAILABLE_SCOPES, ACCESS_TTL_MS, REFRESH_TTL_MS,
  registerClient, getClient, validRedirectUri,
  issueCode, consumeCode,
  issueTokens, consumeRefresh, verifyAccessToken, revokeToken, revokeGrant, listGrants,
  purgeExpired,
};
