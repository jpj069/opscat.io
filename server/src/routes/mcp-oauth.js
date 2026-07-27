'use strict';
// OAuth 2.1 authorization server + RFC 9728 resource metadata for the MCP
// endpoint. Mounted at the app root (see index.js) because the `.well-known`
// documents must live there.
//
// Separate from routes/oauth.js, which is the EE-licensed SSO module for
// signing IN to OpsCat (Google/Microsoft). This file is the opposite direction:
// letting an external MCP client act on OpsCat's behalf. It is core
// (Apache-2.0) — a self-hosted instance gets the agent integration too.
//
// The distinguishing piece is the ORGANIZATION PICKER on the consent screen: a
// user who belongs to several organizations chooses which one this connection
// acts in, and the token is bound to it. The org is therefore resolved
// server-side from a verified membership, and can never arrive as a tool
// argument an agent could be talked into changing.

const crypto = require('crypto');
const { Router } = require('express');
const config = require('../config');
const { db, getMembership, listMemberships } = require('../db');
const sec = require('../security');
const oauth = require('../lib/oauth');
const { now, httpError, RateLimiter } = require('../util');

const router = Router();

const MCP_RESOURCE = `${config.baseUrl}/mcp`;
const registerLimiter = new RateLimiter({ perMinute: 5, burst: 10 });
const authorizeLimiter = new RateLimiter({ perMinute: 20, burst: 30 });
const tokenLimiter = new RateLimiter({ perMinute: 60, burst: 60 });

const getSessionRow = db.prepare('SELECT * FROM sessions WHERE id = ?');
const getUserRow = db.prepare('SELECT id, org_id, email, name, active FROM users WHERE id = ?');

// Resolve the browser session WITHOUT answering the request — the authorize
// endpoint has to redirect an anonymous visitor to the login page, not hand a
// browser the JSON 401 that sec.requireSession correctly returns for the API.
function softSession(req) {
  const sid = sec.parseCookies(req).opscat_sid;
  if (!sid) return null;
  const sess = getSessionRow.get(sid);
  if (!sess) return null;
  const t = now();
  if (t - sess.last_used_at > config.sessionIdleMs || t - sess.created_at > config.sessionMaxMs) return null;
  const user = getUserRow.get(sess.user_id);
  if (!user || !user.active) return null;
  return { sid, sess, user };
}

// ── consent ticket ─────────────────────────────────────────────────────────
// Carries the authorize parameters across the consent POST without server-side
// state. Signed with the app secret AND bound to the session id: a site the user
// happens to have open cannot mint one for their session, which is what makes
// the form POST CSRF-safe (a plain HTML form cannot send our x-opscat-csrf
// header, so the binding carries that job).

function signTicket(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', config.secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verifyTicket(ticket) {
  const [body, mac] = String(ticket || '').split('.');
  if (!body || !mac) return null;
  const expect = crypto.createHmac('sha256', config.secret).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < now()) return null;
    return payload;
  } catch { return null; }
}

// ── discovery ──────────────────────────────────────────────────────────────

// RFC 9728 §3.1: a resource identifier WITH a path publishes its metadata at
// `/.well-known/oauth-protected-resource<path>` — the well-known segment is
// inserted between host and path, not appended. Serve that AND the root form:
// MCP 2025-11-25 (SEP-985) made the WWW-Authenticate header optional, with this
// derivation as the fallback, so serving only the root form 404s a compliant
// client that derives the URL itself.
function protectedResourceMetadataPaths(resourceIdentifier) {
  const root = '/.well-known/oauth-protected-resource';
  const suffix = new URL(resourceIdentifier).pathname.replace(/\/+$/, '');
  return suffix ? [root, `${root}${suffix}`] : [root];
}

// RFC 8414 — authorization server metadata.
router.get('/.well-known/oauth-authorization-server', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({
    issuer: config.baseUrl,
    authorization_endpoint: `${config.baseUrl}/oauth/authorize`,
    token_endpoint: `${config.baseUrl}/oauth/token`,
    registration_endpoint: `${config.baseUrl}/oauth/register`,
    revocation_endpoint: `${config.baseUrl}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: oauth.AVAILABLE_SCOPES,
  });
});

router.get(protectedResourceMetadataPaths(MCP_RESOURCE), (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({
    resource: MCP_RESOURCE,
    authorization_servers: [config.baseUrl],
    scopes_supported: oauth.AVAILABLE_SCOPES,
    bearer_methods_supported: ['header'],
    resource_documentation: `${config.baseUrl}/mcp/llms.txt`,
  });
});

// ── RFC 7591: dynamic client registration ──────────────────────────────────

router.post('/oauth/register', (req, res) => {
  if (!registerLimiter.allow(sec.clientIp(req))) return httpError(res, 429, 'rate limit exceeded');
  const b = req.body || {};
  try {
    const client = oauth.registerClient({
      name: b.client_name,
      redirectUris: b.redirect_uris,
      scopes: b.scope,
    });
    res.status(201).json({
      client_id: client.client_id,
      client_name: client.name,
      redirect_uris: client.redirect_uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: client.scopes.join(' '),
      client_id_issued_at: Math.floor(client.created_at / 1000),
    });
  } catch (e) {
    res.status(400).json({ error: 'invalid_client_metadata', error_description: e.message });
  }
});

// ── consent screen ─────────────────────────────────────────────────────────

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderPage(res, status, title, bodyHtml) {
  res.status(status).type('html').send(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} — OpsCat</title><style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;background:#0b0e14;color:#c9d1d9;font:14px/1.55 Inter,system-ui,-apple-system,sans-serif;
    display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
  .card{width:100%;max-width:420px;background:#0d1117;border:1px solid #21262d;border-radius:12px;padding:28px}
  h1{font-size:17px;margin:0 0 6px;color:#f0f6fc}
  p{margin:0 0 16px;color:#8b949e;font-size:13px}
  .who{font-size:12px;color:#8b949e;border-bottom:1px solid #21262d;padding-bottom:14px;margin-bottom:18px}
  .who b{color:#c9d1d9;font-weight:600}
  label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#8b949e;margin-bottom:6px}
  select{width:100%;background:#0b0e14;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;
    padding:9px 10px;font:14px Inter,system-ui,sans-serif;margin-bottom:18px}
  ul.scopes{list-style:none;padding:0;margin:0 0 20px}
  ul.scopes li{padding:7px 0;border-bottom:1px solid #161b22;font-size:13px;display:flex;gap:9px;align-items:baseline}
  ul.scopes li:last-child{border-bottom:none}
  ul.scopes code{font:11px 'JetBrains Mono',monospace;color:#58a6ff;background:rgba(88,166,255,.1);
    padding:1px 6px;border-radius:4px;flex:none}
  .row{display:flex;gap:10px}
  button{flex:1;border:none;border-radius:6px;padding:10px 16px;font:600 13px Inter,system-ui,sans-serif;cursor:pointer}
  button.ok{background:#238636;color:#fff}
  button.no{background:#21262d;color:#c9d1d9}
  .err{color:#f85149}
</style></head><body><div class="card">${bodyHtml}</div></body></html>`);
}

const SCOPE_COPY = {
  read: 'Read your events, cases, logs, checks, incidents and infrastructure',
  write: 'Acknowledge cases, publish incidents and run checks on your behalf',
};

router.get('/oauth/authorize', (req, res) => {
  if (!authorizeLimiter.allow(sec.clientIp(req))) return httpError(res, 429, 'rate limit exceeded');
  const q = req.query || {};
  const client = oauth.getClient(q.client_id);

  // Errors that cannot be safely redirected (unknown client, unregistered
  // redirect_uri) are shown to the user — never bounced to an unverified URI.
  if (!client) {
    return renderPage(res, 400, 'Unknown application',
      '<h1>Unknown application</h1><p class="err">This client is not registered with OpsCat.</p>');
  }
  const redirectUri = String(q.redirect_uri || '');
  if (!client.redirect_uris.includes(redirectUri)) {
    return renderPage(res, 400, 'Invalid redirect',
      '<h1>Invalid redirect</h1><p class="err">The redirect URI is not registered for this application.</p>');
  }

  const bounce = (error, description) => {
    const u = new URL(redirectUri);
    u.searchParams.set('error', error);
    if (description) u.searchParams.set('error_description', description);
    if (q.state) u.searchParams.set('state', String(q.state));
    res.redirect(302, u.toString());
  };

  if (q.response_type !== 'code') return bounce('unsupported_response_type', 'Only response_type=code is supported');
  if (q.code_challenge_method !== 'S256') return bounce('invalid_request', 'PKCE code_challenge_method=S256 is required');
  if (!q.code_challenge) return bounce('invalid_request', 'code_challenge is required');
  // RFC 8707: never mint a token for a resource that is not ours.
  const resource = q.resource ? String(q.resource) : MCP_RESOURCE;
  if (resource !== MCP_RESOURCE) return bounce('invalid_target', 'Unknown resource');

  const requested = String(q.scope || 'read').split(/[\s,+]+/).filter(Boolean);
  const scopes = requested.filter((s) => client.scopes.includes(s) && oauth.AVAILABLE_SCOPES.includes(s));
  if (!scopes.length) return bounce('invalid_scope', 'No grantable scope requested');

  // Not logged in → through the app's own login, then back here.
  const ctx = softSession(req);
  if (!ctx) return res.redirect(302, `/app/?next=${encodeURIComponent(req.originalUrl)}`);

  const memberships = listMemberships(ctx.user.id);
  if (!memberships.length) {
    return renderPage(res, 403, 'No organization',
      '<h1>No organization</h1><p class="err">Your account is not a member of any organization, so there is nothing to connect.</p>');
  }

  const ticket = signTicket({
    c: client.client_id, r: redirectUri, ch: String(q.code_challenge),
    s: scopes, res: resource, st: q.state ? String(q.state) : null,
    sid: ctx.sid, exp: now() + 10 * 60 * 1000,
  });

  // One membership: no picker, but still name the organization — the user should
  // never have to guess what the connection will be able to see.
  const orgBlock = memberships.length > 1
    ? `<label for="org">Organization</label><select id="org" name="org_id">${memberships.map((m) =>
        `<option value="${m.org_id}">${esc(m.name)} — ${esc(m.role)}</option>`).join('')}</select>`
    : `<input type="hidden" name="org_id" value="${memberships[0].org_id}">
       <p>Connecting <b style="color:#c9d1d9">${esc(memberships[0].name)}</b> as
       <b style="color:#c9d1d9">${esc(memberships[0].role)}</b>.</p>`;

  renderPage(res, 200, 'Authorize', `
    <h1>Connect ${esc(client.name)}</h1>
    <p>${esc(client.name)} wants to access OpsCat on your behalf.</p>
    <div class="who">Signed in as <b>${esc(ctx.user.email)}</b></div>
    <form method="post" action="/oauth/authorize/consent">
      <input type="hidden" name="ticket" value="${esc(ticket)}">
      ${orgBlock}
      <label>Permissions</label>
      <ul class="scopes">${scopes.map((s) =>
        `<li><code>${esc(s)}</code><span>${esc(SCOPE_COPY[s] || s)}</span></li>`).join('')}</ul>
      <div class="row">
        <button class="no" type="submit" name="decision" value="deny">Cancel</button>
        <button class="ok" type="submit" name="decision" value="allow">Authorize</button>
      </div>
    </form>`);
});

router.post('/oauth/authorize/consent', (req, res) => {
  const b = req.body || {};
  const t = verifyTicket(b.ticket);
  if (!t) {
    return renderPage(res, 400, 'Expired',
      '<h1>Request expired</h1><p class="err">This authorization request is no longer valid. Start the connection again from your client.</p>');
  }
  const ctx = softSession(req);
  if (!ctx || ctx.sid !== t.sid) {
    return renderPage(res, 403, 'Session mismatch',
      '<h1>Session mismatch</h1><p class="err">Sign in again and restart the connection from your client.</p>');
  }

  const u = new URL(t.r);
  if (t.st) u.searchParams.set('state', t.st);

  if (b.decision !== 'allow') {
    u.searchParams.set('error', 'access_denied');
    return res.redirect(302, u.toString());
  }

  // Membership is re-checked here rather than trusted from the ticket: it may
  // have been revoked between rendering the consent screen and submitting it.
  const orgId = parseInt(b.org_id, 10);
  const membership = Number.isInteger(orgId) ? getMembership(ctx.user.id, orgId) : null;
  if (!membership) {
    return renderPage(res, 403, 'Not a member',
      '<h1>Not a member</h1><p class="err">You are not a member of the selected organization.</p>');
  }

  const code = oauth.issueCode({
    clientId: t.c, userId: ctx.user.id, orgId, redirectUri: t.r,
    codeChallenge: t.ch, scopes: t.s, resource: t.res,
  });
  sec.audit(ctx.user.id, 'mcp.authorize', `client=${t.c} scopes=${t.s.join('+')}`, orgId);
  u.searchParams.set('code', code);
  res.redirect(302, u.toString());
});

// ── token ──────────────────────────────────────────────────────────────────

router.post('/oauth/token', (req, res) => {
  if (!tokenLimiter.allow(sec.clientIp(req))) return httpError(res, 429, 'rate limit exceeded');
  const b = req.body || {};
  const clientId = String(b.client_id || '');
  if (!oauth.getClient(clientId)) return res.status(401).json({ error: 'invalid_client' });

  if (b.grant_type === 'authorization_code') {
    const out = oauth.consumeCode(b.code, {
      clientId, redirectUri: String(b.redirect_uri || ''), codeVerifier: b.code_verifier,
    });
    if (out.error) return res.status(400).json({ error: out.error });
    return res.json(oauth.issueTokens({
      clientId, userId: out.row.user_id, orgId: out.row.org_id,
      scopes: out.row.scopes, resource: out.row.resource,
    }));
  }

  if (b.grant_type === 'refresh_token') {
    const out = oauth.consumeRefresh(b.refresh_token, clientId);
    if (out.error) return res.status(400).json({ error: out.error });
    // A membership revoked since the last refresh ends the grant.
    if (!getMembership(out.row.user_id, out.row.org_id)) {
      oauth.revokeGrant(clientId, out.row.user_id, out.row.org_id);
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Membership revoked' });
    }
    return res.json(oauth.issueTokens({
      clientId, userId: out.row.user_id, orgId: out.row.org_id,
      scopes: out.row.scopes, resource: out.row.resource,
    }));
  }

  res.status(400).json({ error: 'unsupported_grant_type' });
});

// RFC 7009 — always 200, so probing reveals nothing about token validity.
router.post('/oauth/revoke', (req, res) => {
  oauth.revokeToken((req.body || {}).token);
  res.status(200).json({ ok: true });
});

module.exports = router;
module.exports.MCP_RESOURCE = MCP_RESOURCE;
module.exports.protectedResourceMetadataPaths = protectedResourceMetadataPaths;
