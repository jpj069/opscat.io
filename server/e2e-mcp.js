'use strict';
/* End-to-end check for the MCP server: DCR → authorize → consent → token →
 * initialize → tools/list → tools/call, plus the negative cases.
 * Run against a server already listening on :3000.  node e2e-mcp.js           */
const crypto = require('crypto');
const Database = require('better-sqlite3');
const config = require('./src/config');

const B = 'http://127.0.0.1:3000';
const R = [];
const chk = (name, pass, detail = '') => R.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : ` — ${detail}`}`);

const db = new Database(config.dbFile);

async function main() {
  // ── a real browser session for the seeded admin ──────────────────────────
  const user = db.prepare('SELECT id, email FROM users ORDER BY id LIMIT 1').get();
  const org = db.prepare('SELECT id, name FROM organizations ORDER BY id LIMIT 1').get();
  const sid = crypto.randomBytes(32).toString('hex');
  const t = Date.now();
  db.prepare(`INSERT INTO sessions (id, user_id, active_org_id, csrf, created_at, last_used_at, ip, user_agent)
    VALUES (?,?,?,?,?,?,?,?)`).run(sid, user.id, org.id, crypto.randomBytes(16).toString('hex'), t, t, '127.0.0.1', 'e2e');
  const cookie = `opscat_sid=${sid}`;

  // ── 1. dynamic client registration (RFC 7591) ────────────────────────────
  const reg = await fetch(`${B}/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'E2E Client', redirect_uris: ['http://127.0.0.1:9999/cb'], scope: 'read write' }),
  });
  const client = await reg.json();
  chk('DCR returns 201 + client_id', reg.status === 201 && !!client.client_id, `${reg.status} ${JSON.stringify(client)}`);
  chk('DCR client is public (no secret)', !client.client_secret && client.token_endpoint_auth_method === 'none', JSON.stringify(client));

  const badUri = await fetch(`${B}/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'bad', redirect_uris: ['http://evil.example/cb'] }),
  });
  chk('DCR rejects non-loopback http redirect', badUri.status === 400, `got ${badUri.status}`);

  // ── 2. authorize (PKCE S256) ─────────────────────────────────────────────
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authUrl = (over = {}) => {
    const u = new URL(`${B}/oauth/authorize`);
    const p = {
      response_type: 'code', client_id: client.client_id, redirect_uri: 'http://127.0.0.1:9999/cb',
      code_challenge: challenge, code_challenge_method: 'S256', scope: 'read write',
      state: 'xyz', resource: `${config.baseUrl}/mcp`, ...over,
    };
    for (const [k, v] of Object.entries(p)) if (v !== null) u.searchParams.set(k, v);
    return u.toString();
  };

  const anon = await fetch(authUrl(), { redirect: 'manual' });
  chk('authorize without session → redirect to login with ?next',
    anon.status === 302 && (anon.headers.get('location') || '').startsWith('/app/?next='),
    `${anon.status} ${anon.headers.get('location')}`);

  const plainPkce = await fetch(authUrl({ code_challenge_method: 'plain' }), { redirect: 'manual' });
  const plainLoc = plainPkce.headers.get('location') || '';
  chk('authorize rejects PKCE plain', plainLoc.includes('error=invalid_request'), plainLoc);

  const badRes = await fetch(authUrl({ resource: 'https://evil.example/mcp' }), { redirect: 'manual' });
  chk('authorize rejects foreign resource (RFC 8707)',
    (badRes.headers.get('location') || '').includes('error=invalid_target'), badRes.headers.get('location'));

  const badRedirect = await fetch(authUrl({ redirect_uri: 'http://127.0.0.1:1/nope' }), { redirect: 'manual' });
  chk('authorize refuses unregistered redirect_uri (no bounce)', badRedirect.status === 400, `got ${badRedirect.status}`);

  const page = await fetch(authUrl(), { headers: { cookie } });
  const html = await page.text();
  chk('consent screen renders for a logged-in user', page.status === 200 && html.includes('Authorize'), `status ${page.status}`);
  chk('consent screen names the organization', html.includes(org.name), 'org name missing');
  chk('consent screen lists requested scopes', html.includes('>read<') && html.includes('>write<'), 'scopes missing');
  const ticket = /name="ticket" value="([^"]+)"/.exec(html)?.[1];
  chk('consent screen carries a signed ticket', !!ticket, 'no ticket in form');

  // ── 3. consent → code ────────────────────────────────────────────────────
  const noSession = await fetch(`${B}/oauth/authorize/consent`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ticket, org_id: String(org.id), decision: 'allow' }), redirect: 'manual',
  });
  chk('consent POST without the bound session → 403 (CSRF defence)', noSession.status === 403, `got ${noSession.status}`);

  const consent = await fetch(`${B}/oauth/authorize/consent`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ ticket, org_id: String(org.id), decision: 'allow' }), redirect: 'manual',
  });
  const cbUrl = new URL(consent.headers.get('location'));
  const code = cbUrl.searchParams.get('code');
  chk('consent redirects to the client with a code', consent.status === 302 && !!code, consent.headers.get('location'));
  chk('state is echoed back', cbUrl.searchParams.get('state') === 'xyz', cbUrl.searchParams.get('state'));

  // ── 4. token ─────────────────────────────────────────────────────────────
  const tokenReq = (body) => fetch(`${B}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  const wrongVerifier = await tokenReq({
    grant_type: 'authorization_code', client_id: client.client_id, code,
    redirect_uri: 'http://127.0.0.1:9999/cb', code_verifier: 'wrong-verifier',
  });
  chk('token rejects a wrong PKCE verifier', wrongVerifier.status === 400, `got ${wrongVerifier.status}`);

  // the failed attempt must have consumed the code (single use)
  const replay = await tokenReq({
    grant_type: 'authorization_code', client_id: client.client_id, code,
    redirect_uri: 'http://127.0.0.1:9999/cb', code_verifier: verifier,
  });
  chk('authorization code is single-use even after a failed exchange', replay.status === 400, `got ${replay.status}`);

  // fresh code for the happy path
  const page2 = await fetch(authUrl(), { headers: { cookie } });
  const ticket2 = /name="ticket" value="([^"]+)"/.exec(await page2.text())?.[1];
  const consent2 = await fetch(`${B}/oauth/authorize/consent`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ ticket: ticket2, org_id: String(org.id), decision: 'allow' }), redirect: 'manual',
  });
  const code2 = new URL(consent2.headers.get('location')).searchParams.get('code');
  const tok = await tokenReq({
    grant_type: 'authorization_code', client_id: client.client_id, code: code2,
    redirect_uri: 'http://127.0.0.1:9999/cb', code_verifier: verifier,
  });
  const tokens = await tok.json();
  chk('token exchange returns an access + refresh token',
    tok.status === 200 && !!tokens.access_token && !!tokens.refresh_token, JSON.stringify(tokens));

  const refreshed = await tokenReq({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token });
  const rt = await refreshed.json();
  chk('refresh token rotates', refreshed.status === 200 && rt.access_token !== tokens.access_token, JSON.stringify(rt));
  const reuse = await tokenReq({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token });
  chk('a rotated refresh token cannot be reused', reuse.status === 400, `got ${reuse.status}`);

  const AT = rt.access_token;

  // ── 5. MCP transport ─────────────────────────────────────────────────────
  const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const mcp = (body, extra = {}) => fetch(`${B}/mcp`, {
    method: 'POST', headers: { ...H, authorization: `Bearer ${AT}`, ...extra }, body: JSON.stringify(body),
  });

  const badOrigin = await fetch(`${B}/mcp`, {
    method: 'POST', headers: { ...H, authorization: `Bearer ${AT}`, origin: 'https://evil.example' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
  });
  chk('MCP rejects a foreign Origin with 403', badOrigin.status === 403, `got ${badOrigin.status}`);

  const noAuth = await fetch(`${B}/mcp`, { method: 'POST', headers: H, body: JSON.stringify({}) });
  chk('MCP without a token → 401 + WWW-Authenticate resource_metadata',
    noAuth.status === 401 && (noAuth.headers.get('www-authenticate') || '').includes('resource_metadata'),
    noAuth.headers.get('www-authenticate'));

  const noSess = await mcp({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
  chk('MCP non-initialize without a session → 404 (no transport allocated)', noSess.status === 404, `got ${noSess.status}`);

  const init = await mcp({
    jsonrpc: '2.0', method: 'initialize', id: 1,
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } },
  });
  const mcpSid = init.headers.get('mcp-session-id');
  const initBody = await init.text();
  chk('initialize → 200 + session id', init.status === 200 && !!mcpSid, `${init.status} sid=${mcpSid}`);
  chk('initialize advertises the server instructions', initBody.includes('OpsCat is an infrastructure ops platform'), initBody.slice(0, 160));

  const S = { 'mcp-session-id': mcpSid };
  const parse = async (r) => {
    const txt = await r.text();
    const line = txt.split('\n').find((l) => l.startsWith('data: '));
    return JSON.parse(line ? line.slice(6) : txt);
  };

  const listed = await parse(await mcp({ jsonrpc: '2.0', method: 'tools/list', id: 2 }, S));
  const tools = listed.result?.tools || [];
  chk('tools/list returns the read tools', tools.length >= 8, `got ${tools.length}`);
  chk('every tool carries annotations', tools.every((t) => t.annotations && typeof t.annotations.readOnlyHint === 'boolean'),
    JSON.stringify(tools.find((t) => !t.annotations)?.name));
  chk('every tool carries an outputSchema', tools.every((t) => !!t.outputSchema),
    JSON.stringify(tools.find((t) => !t.outputSchema)?.name));

  const dash = await parse(await mcp({
    jsonrpc: '2.0', method: 'tools/call', id: 3, params: { name: 'opscat_get_dashboard', arguments: {} },
  }, S));
  const sc = dash.result?.structuredContent;
  chk('tools/call opscat_get_dashboard returns structuredContent', !!sc, JSON.stringify(dash).slice(0, 200));
  chk('dashboard is scoped to the authorized organization', sc && sc.organization === org.name, JSON.stringify(sc));

  const checks = await parse(await mcp({
    jsonrpc: '2.0', method: 'tools/call', id: 4, params: { name: 'opscat_list_checks', arguments: {} },
  }, S));
  chk('tools/call opscat_list_checks returns checks',
    Array.isArray(checks.result?.structuredContent?.checks), JSON.stringify(checks).slice(0, 200));

  const stale = await mcp({ jsonrpc: '2.0', method: 'tools/list', id: 5 }, { 'mcp-session-id': 'does-not-exist' });
  chk('a stale session id → 404', stale.status === 404, `got ${stale.status}`);

  // ── 6. revocation ────────────────────────────────────────────────────────
  await fetch(`${B}/oauth/revoke`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: AT }),
  });
  const afterRevoke = await mcp({ jsonrpc: '2.0', method: 'tools/list', id: 6 }, S);
  chk('a revoked token can no longer drive /mcp', afterRevoke.status === 401, `got ${afterRevoke.status}`);

  db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
  console.log(R.join('\n'));
  const failed = R.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\n${R.length - failed}/${R.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('harness error:', e); process.exit(1); });
