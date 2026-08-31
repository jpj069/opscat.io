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
const q = require('../db/shim');
const { now, sha256, randHex } = require('../util');
const tokens = require('./tokens');
const { listMemberships } = require('../db');

const CODE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// The scopes a client may ask for. `read` is everything the UI can display;
// `write` covers the mutating tools. Deliberately coarse — OpsCat has one tool
// family, so per-family scopes would be noise (see docs/MCP-PLAN.md).
const AVAILABLE_SCOPES = ['read', 'write'];

// How a grant names the organizations it covers. 'list' is the default and the
// only one the consent screen picks unless the person asks for the other.
const ORG_SCOPES = ['list', 'all'];

// The stored set, normalised. It is an UPPER BOUND and never an authority —
// every caller intersects it with `memberships`, which is what makes leaving an
// organization take effect on the next request rather than at token expiry.
//
// A row written before multi-org existed has org_scope 'list' and org_ids NULL,
// and answers [org_id]: the exact behaviour it had, with no branch anywhere that
// has to know it is a legacy row.
function grantOrgs(row) {
  if (row.org_scope === 'all') return { scope: 'all', ids: null };
  const ids = String(row.org_ids || '').split(',').map((x) => x.trim()).filter(Boolean);
  return { scope: 'list', ids: ids.length ? ids : [row.org_id] };
}

// The organizations a grant can actually act in, right now.
//
// This is THE function multi-org rests on, and the reason it is one function:
// the stored set is an upper bound and `memberships` is the authority, so the
// answer is an intersection that has to be recomputed per request. A snapshot
// held anywhere — in the token, in a session, in a principal built at connect
// time — would keep answering "yes" for an organization somebody was removed
// from, for as long as that snapshot lived.
//
// Returns membership rows ({ org_id, role, name, slug, plan, status }), so the
// role comes from the same place `requireRole` reads it and differs per org,
// which it genuinely can: admin in one, analyst in another.
async function resolveOrgs(userId, row) {
  const g = grantOrgs(row);
  const mine = await listMemberships(userId);
  return g.scope === 'all' ? mine : mine.filter((m) => g.ids.includes(m.org_id));
}

// Written form of the same thing, for the two INSERTs. `all` deliberately
// stores NO list: a snapshot taken at consent time would be a second answer to
// "which orgs?" that silently disagrees with the first one a month later.
function orgColumns(orgScope, orgIds) {
  return orgScope === 'all'
    ? ['all', null]
    : ['list', (Array.isArray(orgIds) ? orgIds : []).filter(Boolean).join(',') || null];
}

const insClient = q.prepare(
  'INSERT INTO oauth_clients (client_id, name, redirect_uris, scopes, created_at) VALUES (?,?,?,?,?)');
const getClientStmt = q.prepare('SELECT * FROM oauth_clients WHERE client_id = ?');

const insCode = q.prepare(`INSERT INTO oauth_codes
  (code_hash, client_id, user_id, org_id, redirect_uri, code_challenge, scopes, org_scope, org_ids,
   resource, expires_at, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
const getCode = q.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?');
const delCode = q.prepare('DELETE FROM oauth_codes WHERE code_hash = ?');

const insToken = q.prepare(`INSERT INTO oauth_tokens
  (token_hash, kind, client_id, user_id, org_id, scopes, org_scope, org_ids, resource,
   expires_at, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
const getToken = q.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = ?");
const delToken = q.prepare('DELETE FROM oauth_tokens WHERE token_hash = ?');
const touchToken = q.prepare('UPDATE oauth_tokens SET last_used_at = ? WHERE id = ?');
const delTokensForClientUser = q.prepare(
  'DELETE FROM oauth_tokens WHERE client_id = ? AND user_id = ? AND org_id = ?');
const listTokensForUser = q.prepare(`SELECT client_id, org_id, scopes, org_scope, org_ids,
  MAX(created_at) created_at, MAX(last_used_at) last_used_at, COUNT(*) n
  FROM oauth_tokens WHERE user_id = ? AND kind = 'access' AND expires_at > ?
  GROUP BY client_id, org_id, scopes, org_scope, org_ids`);

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

async function registerClient({ name, redirectUris, scopes }) {
  const uris = Array.isArray(redirectUris) ? redirectUris.filter((u) => typeof u === 'string') : [];
  if (!uris.length) throw new Error('redirect_uris required');
  for (const u of uris) if (!validRedirectUri(u)) throw new Error(`invalid redirect_uri: ${u}`);
  const granted = (Array.isArray(scopes) ? scopes : String(scopes || '').split(/\s+/))
    .filter((s) => AVAILABLE_SCOPES.includes(s));
  const clientId = tokens.mint('mcpClient', 16);
  await insClient.run(clientId, String(name || 'MCP client').slice(0, 120), JSON.stringify(uris),
    (granted.length ? granted : AVAILABLE_SCOPES).join(','), now());
  return getClient(clientId);
}

async function getClient(clientId) {
  const row = await getClientStmt.get(String(clientId || ''));
  if (!row) return null;
  return { ...row, redirect_uris: JSON.parse(row.redirect_uris), scopes: row.scopes.split(',') };
}

// ── authorization codes ────────────────────────────────────────────────────

async function issueCode({ clientId, userId, orgId, orgScope, orgIds, redirectUri,
  codeChallenge, scopes, resource }) {
  const code = randHex(32);
  const t = now();
  const [scope, ids] = orgColumns(orgScope, orgIds);
  await insCode.run(sha256(code), clientId, userId, orgId, redirectUri, codeChallenge,
    scopes.join(','), scope, ids, resource || null, t + CODE_TTL_MS, t);
  return code;
}

// Single-use: the row is deleted whether or not verification succeeds, so a
// leaked code cannot be retried against a different verifier.
async function consumeCode(code, { clientId, redirectUri, codeVerifier }) {
  const hash = sha256(String(code || ''));
  const row = await getCode.get(hash);
  if (!row) return { error: 'invalid_grant' };
  // The DELETE is the gate, not the SELECT above. With an await between the two,
  // two redemptions of one code both read the row and both reach the token issue
  // below — one authorization mints two independently-revocable token pairs.
  //
  // Be precise about what that costs, because the obvious claim is wrong: this
  // does NOT defeat PKCE. The S256 comparison further down is a pure function of
  // the verifier the caller presents, so an attacker who intercepted the code
  // and does not have the verifier gains nothing by racing. What is lost is the
  // single-use guarantee RFC 6749 §4.1.2 requires — and with it the only signal
  // that a code was used twice. If the code AND the verifier both leak (a
  // malicious app on the same device, a proxy, a log line), the legitimate
  // exchange today fails with `invalid_grant` and surfaces the theft; under the
  // race both succeed and nothing anywhere reports it.
  //
  // Exactly one caller gets `changes === 1`; the other is told invalid_grant,
  // the same answer a stale code already gets.
  if ((await delCode.run(hash)).changes !== 1) return { error: 'invalid_grant' };
  if (row.expires_at < now()) return { error: 'invalid_grant' };
  if (row.client_id !== clientId) return { error: 'invalid_grant' };
  if (row.redirect_uri !== redirectUri) return { error: 'invalid_grant' };
  // PKCE S256 — the only method we accept (see the metadata document).
  const challenge = crypto.createHash('sha256').update(String(codeVerifier || '')).digest('base64url');
  if (challenge !== row.code_challenge) return { error: 'invalid_grant' };
  return { row };
}

// ── tokens ─────────────────────────────────────────────────────────────────

async function issueTokens({ clientId, userId, orgId, orgScope, orgIds, scopes, resource }) {
  const access = tokens.mint('mcpAccess', 32);
  const refresh = tokens.mint('mcpRefresh', 32);
  const t = now();
  const s = Array.isArray(scopes) ? scopes.join(',') : String(scopes);
  // Carried through the rotation exactly like `scopes`: a refresh must not be a
  // way to widen or narrow what was consented to.
  const [oScope, oIds] = orgColumns(orgScope, orgIds);
  await insToken.run(sha256(access), 'access', clientId, userId, orgId, s, oScope, oIds,
    resource || null, t + ACCESS_TTL_MS, t);
  await insToken.run(sha256(refresh), 'refresh', clientId, userId, orgId, s, oScope, oIds,
    resource || null, t + REFRESH_TTL_MS, t);
  return {
    access_token: access,
    refresh_token: refresh,
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    scope: s.split(',').join(' '),
  };
}

// Rotation: the presented refresh token is consumed and a fresh pair issued.
async function consumeRefresh(token, clientId) {
  const hash = sha256(String(token || ''));
  const row = await getToken.get(hash, 'refresh');
  if (!row) return { error: 'invalid_grant' };
  // Same gate as consumeCode, and rotation is the whole point of it: two holders
  // of one refresh token would otherwise both be handed a fresh pair, so the
  // stolen copy keeps working and its use is never observed by anybody. The
  // DELETE names the one caller that rotated it.
  if ((await delToken.run(hash)).changes !== 1) return { error: 'invalid_grant' };
  if (row.expires_at < now() || row.client_id !== clientId) return { error: 'invalid_grant' };
  return { row };
}

// Resolve a Bearer access token. Returns null for unknown/expired — the caller
// turns that into a 401 challenge.
async function verifyAccessToken(token) {
  const row = await getToken.get(sha256(String(token || '')), 'access');
  if (!row) return null;
  if (row.expires_at < now()) { await delToken.run(row.token_hash); return null; }
  await touchToken.run(now(), row.id);
  return row;
}

async function revokeToken(token) {
  const hash = sha256(String(token || ''));
  const row = await q.prepare('SELECT client_id, user_id, org_id FROM oauth_tokens WHERE token_hash = ?').get(hash);
  if (!row) return false;
  // RFC 7009: revoking one token of a grant revokes the grant. Drop every token
  // this client holds for this (user, org) so a stale refresh can't resurrect it.
  await delTokensForClientUser.run(row.client_id, row.user_id, row.org_id);
  return true;
}

async function revokeGrant(clientId, userId, orgId) {
  const info = await delTokensForClientUser.run(clientId, userId, orgId);
  return info.changes > 0;
}

async function listGrants(userId) {
  const rows = await listTokensForUser.all(userId, now());
  const out = [];
  for (const r of rows) {
    const g = grantOrgs(r);
    out.push({
      clientId: r.client_id,
      orgId: r.org_id,
      orgScope: g.scope,
      orgIds: g.ids,
      scopes: r.scopes.split(','),
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      // eslint-disable-next-line no-await-in-loop
      client: await getClient(r.client_id),
    });
  }
  return out;
}

// Housekeeping: expired rows are dead weight and a refresh token that outlived
// its window must not linger in a table someone might query loosely.
async function purgeExpired() {
  const t = now();
  await q.prepare('DELETE FROM oauth_tokens WHERE expires_at < ?').run(t);
  await q.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').run(t);
}

module.exports = {
  AVAILABLE_SCOPES, ORG_SCOPES, ACCESS_TTL_MS, REFRESH_TTL_MS, grantOrgs, resolveOrgs,
  registerClient, getClient, validRedirectUri,
  issueCode, consumeCode,
  issueTokens, consumeRefresh, verifyAccessToken, revokeToken, revokeGrant, listGrants,
  purgeExpired,
};
