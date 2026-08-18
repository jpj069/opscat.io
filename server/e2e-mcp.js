'use strict';
/* End-to-end check for the MCP server: DCR → authorize → consent → token →
 * initialize → tools/list → tools/call, plus the negative cases.
 *
 * Hermetic: throwaway database, own port, no network.  cd server && node e2e-mcp.js
 *
 * It was the one harness that was not. It opened `config.dbFile` — the
 * DEVELOPER'S REAL DATABASE — took whichever user and organization happened to
 * be first, inserted a session row, minted three API keys and an OAuth client,
 * and cleaned up exactly one of those things. Pointed at a production config it
 * would have written to production. Nothing about running it said so.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { chk, report, onExit, die } = require('./e2e-lib').harness();

/* `until` (e2e-lib.js) throws on a thenable by design — a Promise is truthy, so
 * `while (!fn())` would be satisfied on the first poll and the wait would be no
 * wait at all. That guard also means it cannot take an async predicate, and the
 * effect waited for below is a database row. This variant AWAITS its predicate,
 * so the value is resolved before it is tested and can never be mistaken for
 * `true`. Returns the value, or null once the deadline passes — a timeout must
 * fail the check that asked, not throw past it. */
const untilAsync = async (fn, ms = 4000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await new Promise((r) => setTimeout(r, 25));
  }
};

// Environment BEFORE any src/ require — config.js and db.js are singletons, so
// the first require freezes the data directory for the whole process.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opscat-mcp-'));
process.env.OPSCAT_DATA_DIR = tmp;
onExit(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.OPSCAT_SECRET = 'e2e-mcp-secret';
process.env.PORT = '3133';
process.env.OPSCAT_BASE_URL = 'http://127.0.0.1:3133';
process.env.OPSCAT_ADMIN_EMAIL = 'admin@e2e.test';
process.env.OPSCAT_ADMIN_PASSWORD = 'seed-admin-password-1';

require('./src/index.js'); // boots the app on :3133

const config = require('./src/config');
// Fixtures and read-back go through the SHIM, so they land in the database
// `run-e2e.js` handed this process in DATABASE_URL — the same one the code under
// test reads. A connection the harness opened for itself would be a different
// session, and a fixture written there surfaces as a foreign-key violation
// several calls later, pointing at the wrong thing entirely.
const q = require('./src/db/shim');
const { DEFAULT_ORG_ID } = require('./src/util');

const B = 'http://127.0.0.1:3133';

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${B}/api/health`)).ok) return true; } catch { /* not yet */ }
    await new Promise((res) => setTimeout(res, 100));
  }
  return false;
}

async function main() {
  chk('server boots and answers /api/health', await waitForServer());

  // ── a real browser session for the seeded admin ──────────────────────────
  // A user and an org that actually belong together. `ORDER BY id LIMIT 1` on each
  // was fine while ids were integers — user 1 and org 1 were the seeded pair. Since
  // migration 21 they are uuids, so that ordering is effectively random and the two
  // queries pair an arbitrary user with an arbitrary org: on any instance with more
  // than one of either, /oauth/authorize bounces to login and the harness fails 40
  // checks that have nothing wrong with them. Join through memberships instead, and
  // prefer the platform org so the pair is the seeded admin wherever one exists.
  const seat = await q.prepare(`SELECT u.id AS user_id, u.email, o.id AS org_id, o.name
    FROM memberships m JOIN users u ON u.id = m.user_id JOIN organizations o ON o.id = m.org_id
    WHERE u.active = 1 AND u.pass_hash != ''
    ORDER BY (o.id = ?) DESC, u.created_at LIMIT 1`).get(DEFAULT_ORG_ID);
  if (!seat) throw new Error('no active user with a membership — seed an instance first');
  const user = { id: seat.user_id, email: seat.email };
  const org = { id: seat.org_id, name: seat.name };
  const sid = crypto.randomBytes(32).toString('hex');
  const t = Date.now();
  await q.prepare(`INSERT INTO sessions (id, user_id, active_org_id, csrf, created_at, last_used_at, ip, user_agent)
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

  /* A membership revoked since the last refresh ends the grant.
   *
   * The token deliberately carries no role — it is read from `memberships` on
   * every request — but a REFRESH is the one moment where the membership is the
   * only thing standing between a removed colleague and another hour of access.
   * The guard is `if (!(await getMembership(...)))`, and that shape is the one
   * nothing else can see: unawaited it is `!Promise`, i.e. `false`, so a person
   * removed from the organization keeps minting fresh tokens indefinitely, with
   * a 200 and no log line. Measured: the whole suite stayed green at 1593/1593
   * with the await dropped, which is why this check exists.
   */
  const kept = await q.prepare('SELECT role FROM memberships WHERE user_id = ? AND org_id = ?')
    .get(user.id, org.id);
  await q.prepare('DELETE FROM memberships WHERE user_id = ? AND org_id = ?').run(user.id, org.id);
  const orphanRefresh = await tokenReq({
    grant_type: 'refresh_token', client_id: client.client_id, refresh_token: rt.refresh_token,
  });
  const orphanBody = await orphanRefresh.json();
  chk('a refresh after the membership is revoked is refused',
    orphanRefresh.status === 400, `got ${orphanRefresh.status}`);
  chk('…as invalid_grant, naming the revocation', orphanBody.error === 'invalid_grant'
    && /Membership revoked/.test(String(orphanBody.error_description)), JSON.stringify(orphanBody));
  await q.prepare(`INSERT INTO memberships (user_id, org_id, role, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, org_id) DO UPDATE SET role = excluded.role`)
    .run(user.id, org.id, kept.role, Date.now());
  // …and the grant really is gone: RFC 7009 semantics, the whole (client, user,
  // org) grant is dropped, so restoring the membership must NOT resurrect it.
  const afterRestore = await tokenReq({
    grant_type: 'refresh_token', client_id: client.client_id, refresh_token: rt.refresh_token,
  });
  chk('…and restoring the membership does not resurrect the dropped grant',
    afterRestore.status === 400, `got ${afterRestore.status}`);

  // Re-authorize for the rest of the file: the grant above was deliberately
  // destroyed, so a fresh code exchange is what supplies the access token below.
  const page3 = await fetch(authUrl(), { headers: { cookie } });
  const ticket3 = /name="ticket" value="([^"]+)"/.exec(await page3.text())?.[1];
  const consent3 = await fetch(`${B}/oauth/authorize/consent`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ ticket: ticket3, org_id: String(org.id), decision: 'allow' }), redirect: 'manual',
  });
  const code3 = new URL(consent3.headers.get('location')).searchParams.get('code');
  const tok3 = await tokenReq({
    grant_type: 'authorization_code', client_id: client.client_id, code: code3,
    redirect_uri: 'http://127.0.0.1:9999/cb', code_verifier: verifier,
  });
  const rt3 = await tok3.json();
  chk('a fresh authorization still works after the grant was dropped',
    tok3.status === 200 && !!rt3.access_token, JSON.stringify(rt3).slice(0, 120));

  const AT = rt3.access_token;

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

  // ── 5b. M2 write tools ───────────────────────────────────────────────────
  const writeNames = tools.filter((t) => t.name.match(/update|action|create|delete|run|poll/)).map((t) => t.name);
  chk('write tools are listed for a read+write token', writeNames.length >= 8, writeNames.join(','));
  chk('destructive tool is annotated destructiveHint:true',
    tools.find((t) => t.name === 'opscat_delete_maintenance')?.annotations?.destructiveHint === true, 'missing');
  chk('outward-reaching tool is annotated openWorldHint:true',
    tools.find((t) => t.name === 'opscat_run_checks')?.annotations?.openWorldHint === true, 'missing');

  // a real case to act on
  const anyCase = await q.prepare('SELECT id FROM cases WHERE org_id = ? LIMIT 1').get(org.id)
    || { id: await q.prepare(`INSERT INTO cases (org_id, event_id, name, device, severity, status, opened_at)
        VALUES (?,?,?,?,?,'open',?)`).insert(org.id, null, 'e2e case', 'e2e-host', 50, Date.now()) };
  const upd = await parse(await mcp({
    jsonrpc: '2.0', method: 'tools/call', id: 10,
    params: { name: 'opscat_update_case', arguments: { id: anyCase.id, note: 'set by e2e', status: 'assigned' } },
  }, S));
  chk('opscat_update_case writes', upd.result?.structuredContent?.status === 'assigned',
    JSON.stringify(upd).slice(0, 200));
  const noteRow = await q.prepare('SELECT note, status FROM cases WHERE id = ?').get(anyCase.id);
  chk('the write actually landed in the database', noteRow.note === 'set by e2e', JSON.stringify(noteRow));

  /* Condition-WAITED, not read straight after the call.
   *
   * `audit()` deliberately keeps a synchronous call shape with an internal
   * `.catch` — the write it describes has already happened, so failing the
   * request because the audit row failed would report an error for work that
   * succeeded. That means the write is NOT awaited by the handler.
   *
   * On better-sqlite3 that was invisible: the insert completed in the same
   * microtask drain, so a read on the next line always saw it. Under
   * node-postgres it is a network round trip, and the response can reach the
   * client first — which made this check fail intermittently on Postgres and
   * pass on a rerun. The row still lands; the harness was simply asking too
   * early, and asserting "not yet" as "never".
   */
  const auditRow = await untilAsync(async () => q.prepare(`SELECT user_id, action, detail FROM audit_log
    WHERE org_id = ? AND action = 'case_update' ORDER BY id DESC LIMIT 1`).get(org.id));
  chk('the mutation is audited against the authorizing human',
    auditRow && auditRow.user_id === user.id, JSON.stringify(auditRow));
  chk('the audit entry names the MCP client',
    auditRow && auditRow.detail.includes('mcp client='), auditRow && auditRow.detail);

  // destructive tool must not act without confirmation
  const win = { id: await q.prepare(
    'INSERT INTO maintenance_windows (org_id, name, starts_at, ends_at, created_at) VALUES (?,?,?,?,?)')
    .insert(org.id, 'e2e window', Date.now(), Date.now() + 3600000, Date.now()) };
  const noConfirm = await parse(await mcp({
    jsonrpc: '2.0', method: 'tools/call', id: 11,
    params: { name: 'opscat_delete_maintenance', arguments: { id: win.id } },
  }, S));
  chk('destructive tool refuses without confirmation', noConfirm.result?.isError === true,
    JSON.stringify(noConfirm).slice(0, 200));
  chk('maintenance window still exists after the refusal',
    !!await q.prepare('SELECT id FROM maintenance_windows WHERE id = ?').get(win.id), 'row was deleted anyway');
  const confirmed = await parse(await mcp({
    jsonrpc: '2.0', method: 'tools/call', id: 12,
    params: { name: 'opscat_delete_maintenance', arguments: { id: win.id, confirm: true } },
  }, S));
  chk('destructive tool proceeds with confirm:true', confirmed.result?.structuredContent?.deleted === true,
    JSON.stringify(confirmed).slice(0, 200));
  chk('maintenance window is gone',
    !await q.prepare('SELECT id FROM maintenance_windows WHERE id = ?').get(win.id), 'still there');

  // ── 5c. M4 resources + icons ─────────────────────────────────────────────
  const resList = await parse(await mcp({ jsonrpc: '2.0', method: 'resources/list', id: 13 }, S));
  const resources = resList.result?.resources || [];
  chk('resources/list exposes the status page and open incidents', resources.length >= 2,
    JSON.stringify(resources.map((r) => r.name)));
  const statusRes = resources.find((r) => r.name === 'status-page');
  const readRes = await parse(await mcp({
    jsonrpc: '2.0', method: 'resources/read', id: 14, params: { uri: statusRes.uri },
  }, S));
  const body = readRes.result?.contents?.[0]?.text;
  chk('resources/read returns the status payload', !!body && body.includes('overallLabel'), String(body).slice(0, 120));

  chk('initialize advertises a server icon (SEP-973)', initBody.includes('/mcp/icon.svg'), 'no icon in InitializeResult');
  const icon = await fetch(`${B}/mcp/icon.svg`);
  chk('the advertised icon URL resolves', icon.status === 200 && (icon.headers.get('content-type') || '').includes('svg'),
    `${icon.status} ${icon.headers.get('content-type')}`);

  // ── 5d. scope gating: a read-only token sees no write tools ──────────────
  const roClient = await (await fetch(`${B}/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'RO', redirect_uris: ['http://127.0.0.1:9999/cb'], scope: 'read' }),
  })).json();
  const roVerifier = crypto.randomBytes(32).toString('base64url');
  const roChallenge = crypto.createHash('sha256').update(roVerifier).digest('base64url');
  const roUrl = new URL(`${B}/oauth/authorize`);
  for (const [k, v] of Object.entries({
    response_type: 'code', client_id: roClient.client_id, redirect_uri: 'http://127.0.0.1:9999/cb',
    code_challenge: roChallenge, code_challenge_method: 'S256', scope: 'read', resource: `${config.baseUrl}/mcp`,
  })) roUrl.searchParams.set(k, v);
  const roTicket = /name="ticket" value="([^"]+)"/.exec(await (await fetch(roUrl, { headers: { cookie } })).text())?.[1];
  const roConsent = await fetch(`${B}/oauth/authorize/consent`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ ticket: roTicket, org_id: String(org.id), decision: 'allow' }), redirect: 'manual',
  });
  const roCode = new URL(roConsent.headers.get('location')).searchParams.get('code');
  const roTok = await (await tokenReq({
    grant_type: 'authorization_code', client_id: roClient.client_id, code: roCode,
    redirect_uri: 'http://127.0.0.1:9999/cb', code_verifier: roVerifier,
  })).json();
  const roMcp = (body2, extra = {}) => fetch(`${B}/mcp`, {
    method: 'POST', headers: { ...H, authorization: `Bearer ${roTok.access_token}`, ...extra },
    body: JSON.stringify(body2),
  });
  const roInit = await roMcp({
    jsonrpc: '2.0', method: 'initialize', id: 1,
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ro', version: '1' } },
  });
  const roSid = { 'mcp-session-id': roInit.headers.get('mcp-session-id') };
  const roTools = (await parse(await roMcp({ jsonrpc: '2.0', method: 'tools/list', id: 2 }, roSid))).result?.tools || [];
  chk('a read-only token sees ZERO write tools',
    roTools.every((t) => !t.name.match(/update|action|create|delete|run_checks|poll/)),
    roTools.map((t) => t.name).filter((n) => n.match(/update|action|create|delete|run_checks|poll/)).join(','));
  chk('a read-only token still sees the read tools', roTools.length >= 8, `${roTools.length}`);

  // ── 5e. M3 generic REST API via token ────────────────────────────────────
  const restRead = await fetch(`${B}/api/events`, { headers: { authorization: `Bearer ${AT}` } });
  chk('REST /api/events with an OAuth token → 200', restRead.status === 200, `got ${restRead.status}`);
  const restReadRo = await fetch(`${B}/api/events`, { headers: { authorization: `Bearer ${roTok.access_token}` } });
  chk('REST read works with a read-only token', restReadRo.status === 200, `got ${restReadRo.status}`);
  const restWriteRo = await fetch(`${B}/api/cases/${anyCase.id}`, {
    method: 'PATCH', headers: { authorization: `Bearer ${roTok.access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ note: 'should not work' }),
  });
  chk('REST write with a read-only token → 403', restWriteRo.status === 403, `got ${restWriteRo.status}`);
  const restWrite = await fetch(`${B}/api/cases/${anyCase.id}`, {
    method: 'PATCH', headers: { authorization: `Bearer ${AT}`, 'content-type': 'application/json' },
    body: JSON.stringify({ note: 'via rest token' }),
  });
  chk('REST write with a write-scoped token → 200 (no CSRF header needed)', restWrite.status === 200, `got ${restWrite.status}`);
  const adminViaToken = await fetch(`${B}/api/admin/apikeys`, { headers: { authorization: `Bearer ${AT}` } });
  chk('admin routes stay session-only (token → 401)', adminViaToken.status === 401, `got ${adminViaToken.status}`);

  // API key with / without the `api` scope
  const mkKey = async (scopes, role) => {
    const raw = `ock_${crypto.randomBytes(24).toString('hex')}`;
    await q.prepare(`INSERT INTO api_keys (org_id, name, prefix, key_hash, scopes, role, active, created_by, created_at)
      VALUES (?,?,?,?,?,?,1,?,?)`).run(org.id, `e2e ${scopes}`, raw.slice(0, 12),
      crypto.createHash('sha256').update(raw).digest('hex'), scopes, role, user.id, Date.now());
    return raw;
  };
  const apiKey = await mkKey('ingest,api', 'lead');
  const ingestOnly = await mkKey('ingest', 'analyst');
  const keyRead = await fetch(`${B}/api/events`, { headers: { authorization: `Bearer ${apiKey}` } });
  chk('REST /api/events with an `api`-scoped key → 200', keyRead.status === 200, `got ${keyRead.status}`);
  const keyNoScope = await fetch(`${B}/api/events`, { headers: { authorization: `Bearer ${ingestOnly}` } });
  chk('an ingest-only key cannot drive the REST API → 403', keyNoScope.status === 403, `got ${keyNoScope.status}`);
  const keyRoleGate = await fetch(`${B}/api/rules`, {
    method: 'POST', headers: { authorization: `Bearer ${await mkKey('api', 'analyst')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'nope', channel: 'email' }),
  });
  chk("an analyst-role key is refused a lead-only route → 403", keyRoleGate.status === 403, `got ${keyRoleGate.status}`);

  // ── 6. revocation ────────────────────────────────────────────────────────
  await fetch(`${B}/oauth/revoke`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: AT }),
  });
  const afterRevoke = await mcp({ jsonrpc: '2.0', method: 'tools/list', id: 6 }, S);
  chk('a revoked token can no longer drive /mcp', afterRevoke.status === 401, `got ${afterRevoke.status}`);

  // (no row cleanup: the whole database goes with the temp directory)
  report();
}

main().catch(die);
