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

const { chk, untilAsync, report, onExit, die } = require('./e2e-lib').harness();

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

  /* Fixtures for the read-tool sweep further down, and they are the point of
   * it: a sweep over an EMPTY database validates nothing, because a schema
   * only disagrees with a handler once the handler has a row to return. The
   * `sev`-as-a-string bug lived for months precisely because no test ever put
   * a log line in front of a tool that returns one.
   *
   * The log line goes through the log STORE, not a direct INSERT, so it lands
   * in whichever engine this build is configured for. */
  const logs = require('./src/db/log-store');
  const nowMs = Date.now();
  await logs.insert([{
    orgId: org.id, ts: nowMs - 60000, device: 'mcp-probe-01',
    line: 'BGP neighbor 10.0.0.1 Down - hold time expired', sev: 3, source: 'e2e-mcp', meta: null,
  }]);
  const eventId = (await q.prepare(`INSERT INTO events
    (org_id, dedupe_key, name, device, description, severity, hits, status, first_seen, last_seen)
    VALUES (?, 'mcp-probe|mcp-probe-01|', 'bgp', 'mcp-probe-01', 'probe', 75, 1, 'active', ?, ?)`)
    .insert(org.id, nowMs - 60000, nowMs - 60000));

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

  /* ── every read tool is INVOKED, with data present ────────────────────────
   *
   * This harness had 62 checks and called five of twenty-one tools. What that
   * cost: `opscat_search_logs` and `opscat_get_event` both declared the log
   * line's `sev` as a STRING, and it has always been a number — better-sqlite3
   * returned INTEGER as one, and pg.js's int8 parser coerces it. So every
   * response carrying a log line failed the SDK's own output validation, from
   * the commit that introduced the MCP server (#44) until it was hit by hand
   * against production.
   *
   * The fix for the field is one word. The fix for the CLASS is this loop: the
   * SDK validates structuredContent against each tool's declared outputSchema,
   * so calling a tool with rows in the database is the whole check. A schema
   * that drifts from what the handler returns fails here rather than in
   * somebody's agent.
   *
   * Read tools only, and only those whose required inputs we can supply —
   * a write tool has side effects, and the existing section below covers those
   * deliberately. Tools needing an id are called with the fixtures seeded above
   * rather than skipped, because "returns a log line" is exactly the shape that
   * was broken. */
  const ARGS = { opscat_search_logs: { sinceMinutes: 10080, limit: 5 }, opscat_get_event: { id: eventId } };
  const readTools = tools.filter((t) => t.annotations?.readOnlyHint);
  chk('there are read tools to sweep', readTools.length >= 10, `${readTools.length}`);
  let swept = 0;
  const broken = [];
  for (const t of readTools) {
    // eslint-disable-next-line no-await-in-loop
    const r = await parse(await mcp({
      jsonrpc: '2.0', method: 'tools/call', id: 900 + swept, params: { name: t.name, arguments: ARGS[t.name] || {} },
    }, S));
    swept++;
    /* A JSON-RPC error, or `isError`, or a missing structuredContent on a tool
     * that declares an outputSchema — all three are the same failure from a
     * caller's point of view: the tool did not answer. Output-validation
     * failures surface as the first. */
    const bad = r.error || r.result?.isError || (t.outputSchema && !r.result?.structuredContent);
    if (bad) broken.push(`${t.name}: ${JSON.stringify(r.error || r.result?.content || r.result).slice(0, 160)}`);
  }
  chk(`every read tool answers with valid structured output (${swept} swept)`,
    broken.length === 0, broken.join(' | '));

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

  // ── 7. several organizations in ONE connection ───────────────────────────
  // Until migration 037 a connection was bound to a single org. What makes the
  // multi-org version safe is not the consent screen but the sentence the
  // single-org version already lived by: the grant's org set is an UPPER BOUND
  // and `memberships` is the authority, re-read on every request. These checks
  // are about the places where that could quietly stop being true.
  const { addMembership, removeMembership } = require('./src/db');
  const { newId } = require('./src/util');
  const mkOrg = async (name, plan = 'enterprise') => {
    const id = newId();
    await q.prepare(`INSERT INTO organizations (id, name, slug, plan, status, created_at)
      VALUES (?, ?, ?, ?, 'active', ?)`).run(id, name, name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), plan, Date.now());
    return { id, name };
  };
  const ORG_B = await mkOrg('Beta-mcp');       // admin  — in the grant
  const ORG_C = await mkOrg('Gamma-mcp');      // analyst — in the grant
  const ORG_D = await mkOrg('Delta-mcp');      // admin  — deliberately NOT picked
  await addMembership(user.id, ORG_B.id, 'admin');
  await addMembership(user.id, ORG_C.id, 'analyst');
  await addMembership(user.id, ORG_D.id, 'admin');

  // A full authorization of its own, so nothing here depends on the state the
  // sections above left behind.
  const mkClient = async (name) => (await (await fetch(`${B}/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: name, redirect_uris: ['http://127.0.0.1:9999/cb'], scope: 'read write' }),
  })).json());
  const authorize = async (cl, orgIds, future) => {
    const v = crypto.randomBytes(32).toString('base64url');
    const ch = crypto.createHash('sha256').update(v).digest('base64url');
    const u = new URL(`${B}/oauth/authorize`);
    for (const [k, val] of Object.entries({
      response_type: 'code', client_id: cl.client_id, redirect_uri: 'http://127.0.0.1:9999/cb',
      code_challenge: ch, code_challenge_method: 'S256', scope: 'read write', resource: `${config.baseUrl}/mcp`,
    })) u.searchParams.set(k, val);
    const html2 = await (await fetch(u, { headers: { cookie } })).text();
    const tk = /name="ticket" value="([^"]+)"/.exec(html2)?.[1];
    const form = new URLSearchParams({ ticket: tk, decision: 'allow' });
    for (const id of orgIds) form.append('org_id', id);
    if (future) form.append('org_future', '1');
    const cs = await fetch(`${B}/oauth/authorize/consent`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: form, redirect: 'manual',
    });
    if (cs.status !== 302) return { html: html2, consent: cs };
    const c = new URL(cs.headers.get('location')).searchParams.get('code');
    const tok = await (await tokenReq({
      grant_type: 'authorization_code', client_id: cl.client_id, code: c,
      redirect_uri: 'http://127.0.0.1:9999/cb', code_verifier: v,
    })).json();
    return { html: html2, consent: cs, tok };
  };

  // A consent that names an org the person is not in must be refused whole. The
  // tempting alternative — drop the unknown ones and grant the rest — issues a
  // credential for something OTHER than what the screen asked about, which is
  // the one answer a consent screen may never give.
  const ORG_F = await mkOrg('Zeta-mcp');   // no membership, deliberately
  const strayClient = await mkClient('Stray');
  const stray = await authorize(strayClient, [org.id, ORG_F.id]);
  chk('a consent naming an organization the user is not in is refused',
    stray.consent.status === 403, `got ${stray.consent.status}`);
  chk('…and mints no code at all — not even for the org that WAS valid',
    !stray.tok && !(stray.consent.headers.get('location') || '').includes('code='),
    stray.consent.headers.get('location') || '');
  chk('…and wrote no grant', (await q.prepare(
    'SELECT COUNT(*) c FROM oauth_codes WHERE client_id = ?').get(strayClient.client_id)).c === 0);

  const multiClient = await mkClient('Multi');
  const mGrant = await authorize(multiClient, [org.id, ORG_B.id, ORG_C.id]);
  chk('consent screen offers CHECKBOXES once there is more than one membership',
    mGrant.html.includes('type="checkbox" name="org_id"'), 'no checkbox list');
  chk('…every organization pre-ticked, so the default is "what I have"',
    (mGrant.html.match(/name="org_id"[^>]*checked/g) || []).length >= 4);
  chk('…and the future opt-in is present and NOT ticked',
    mGrant.html.includes('name="org_future"')
    && !/name="org_future"[^>]*checked/.test(mGrant.html), 'future box wrong');
  chk('a multi-org consent mints a token', !!mGrant.tok?.access_token, JSON.stringify(mGrant.tok));

  const mMcp = (body2, extra = {}) => fetch(`${B}/mcp`, {
    method: 'POST', headers: { ...H, authorization: `Bearer ${mGrant.tok.access_token}`, ...extra },
    body: JSON.stringify(body2),
  });
  const mInit = await mMcp({
    jsonrpc: '2.0', method: 'initialize', id: 1,
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mGrant', version: '1' } },
  });
  const mS = { 'mcp-session-id': mInit.headers.get('mcp-session-id') };
  const mCall = async (name, args, id = 20) => parse(await mMcp({
    jsonrpc: '2.0', method: 'tools/call', id, params: { name, arguments: args },
  }, mS));
  // A tool that answers an error — including the SDK's own output-VALIDATION
  // error, which is how the incidents bug below surfaced — must turn a check
  // red, never kill the run: a harness that throws reports nothing at all, so
  // the mutation that plants such a bug would look like a harness fault.
  const jsonOf = (r) => {
    try { return JSON.parse(r.result.content[0].text); } catch { return null; }
  };
  const mTools = (await parse(await mMcp({ jsonrpc: '2.0', method: 'tools/list', id: 2 }, mS))).result?.tools || [];

  const evTool = mTools.find((t) => t.name === 'opscat_list_events');
  chk('with several orgs EVERY tool takes `organization`',
    mTools.filter((t) => t.name !== 'opscat_list_organizations')
      .every((t) => t.inputSchema?.properties?.organization),
    mTools.find((t) => t.name !== 'opscat_list_organizations' && !t.inputSchema?.properties?.organization)?.name);
  chk('…and it is REQUIRED, so nothing is guessed',
    (evTool.inputSchema.required || []).includes('organization'), JSON.stringify(evTool.inputSchema.required));
  chk('the tool that answers WHICH organizations does not itself require one',
    !(mTools.find((t) => t.name === 'opscat_list_organizations').inputSchema?.properties?.organization));
  chk('a single-org connection is unchanged — no organization argument at all',
    !tools.find((t) => t.name === 'opscat_list_events').inputSchema?.properties?.organization);

  const orgList = jsonOf(await mCall('opscat_list_organizations', {})) || { organizations: [] };
  chk('list_organizations names exactly the granted orgs',
    orgList.count === 3 && orgList.organizations.map((o) => o.name).sort().join(',')
      === [org.name, ORG_B.name, ORG_C.name].sort().join(','), JSON.stringify(orgList));
  chk('…and says the argument is required', orgList.argumentRequired === true);
  chk('…reporting the role PER organization, which genuinely differs',
    orgList.organizations.find((o) => o.name === ORG_C.name).role === 'analyst'
    && orgList.organizations.find((o) => o.name === ORG_B.name).role === 'admin',
    JSON.stringify(orgList.organizations));

  // ── the resolver, on its own ─────────────────────────────────────────────
  // Driven directly, because over the wire the SDK refuses a missing
  // `organization` from the input schema first and the resolver is never
  // reached — so a resolver that quietly defaulted to `orgs[0]` would leave
  // every wire check green. Measured: it did. This is the last line between a
  // call that names no organization and a write into whichever one sorts first.
  const { resolveOrg } = require('./src/mcp/server');
  const threw = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
  const P3 = { orgs: [
    { id: 'id-a', name: 'Acme', slug: 'acme', role: 'admin' },
    { id: 'id-b', name: 'Beta', slug: 'beta', role: 'analyst' },
    { id: 'id-c', name: 'Acme', slug: 'acme-two', role: 'lead' },
  ] };
  const P1 = { orgs: [{ id: 'id-a', name: 'Acme', slug: 'acme', role: 'admin' }] };
  chk('resolver: no name with several organizations THROWS rather than picking one',
    /required/i.test(threw(() => resolveOrg(P3)) || ''), threw(() => resolveOrg(P3)));
  chk('resolver: …and the message names the choices',
    /Acme/.test(threw(() => resolveOrg(P3)) || '') && /Beta/.test(threw(() => resolveOrg(P3)) || ''));
  chk('resolver: no name with exactly one is that one — a single-org connection stays argument-free',
    resolveOrg(P1).id === 'id-a');
  chk('resolver: an exact name resolves, case-insensitively', resolveOrg(P3, 'beta').id === 'id-b');
  chk('resolver: an unknown name is refused, not guessed',
    /does not cover/.test(threw(() => resolveOrg(P3, 'Nope')) || ''));
  // organizations.name is NOT unique — only the slug is — so two orgs a person
  // belongs to can genuinely share one. Picking either would be a coin toss over
  // which tenant a write lands in.
  chk('resolver: an AMBIGUOUS name is refused and the slugs are offered',
    /acme, acme-two/.test(threw(() => resolveOrg(P3, 'Acme')) || ''), threw(() => resolveOrg(P3, 'Acme')));
  chk('resolver: …and the slug then resolves it', resolveOrg(P3, 'acme-two').id === 'id-c');
  chk('resolver: the id resolves too, for a model that read one off a resource URI',
    resolveOrg(P3, 'id-b').id === 'id-b');

  const incidentCount = async () => (await q.prepare('SELECT COUNT(*) c FROM incidents').get()).c;
  const beforeUnnamed = await incidentCount();
  const unnamed = await mCall('opscat_create_incident', { title: 'no org named' }, 21);
  chk('a write naming NO organization is refused',
    unnamed.result?.isError === true || /organization/i.test(JSON.stringify(unnamed)),
    JSON.stringify(unnamed).slice(0, 200));
  // The refusal is only a refusal if nothing happened — the same claim
  // e2e-retention makes about its caps. A 3-tenant connection that writes into
  // "the first one" on an unnamed call is the whole failure mode this guards.
  chk('…and it wrote no incident anywhere', (await incidentCount()) === beforeUnnamed);

  const foreign = await mCall('opscat_create_incident',
    { title: 'into an org outside the grant', organization: ORG_D.name }, 22);
  chk('an organization the grant does not cover is refused, even though the user IS a member',
    /does not cover/.test(JSON.stringify(foreign)), JSON.stringify(foreign).slice(0, 200));
  chk('…and wrote nothing', (await incidentCount()) === beforeUnnamed);

  // Role is per org: lead+ is required to open an incident, and the connection
  // holds admin in B and analyst in C. Listing is gated on the BEST role, so the
  // tool is visible — the refusal has to come from the per-call check.
  chk('the lead-only tool is LISTED (admin somewhere in the connection)',
    !!mTools.find((t) => t.name === 'opscat_create_incident'));
  const inB = await mCall('opscat_create_incident', { title: 'B incident', organization: ORG_B.name }, 23);
  chk('…and works in the organization where the role is admin',
    !inB.result?.isError, JSON.stringify(inB).slice(0, 200));
  const inC = await mCall('opscat_create_incident', { title: 'C incident', organization: ORG_C.name }, 24);
  chk('…and is refused in the one where it is analyst',
    /role in .* is analyst/.test(JSON.stringify(inC)), JSON.stringify(inC).slice(0, 200));
  chk('…having written exactly ONE incident, in B', (await q.prepare(
    'SELECT COUNT(*) c FROM incidents WHERE org_id = ?').get(ORG_B.id)).c === 1
    && (await q.prepare('SELECT COUNT(*) c FROM incidents WHERE org_id = ?').get(ORG_C.id)).c === 0);

  // Reads land in the named org and nowhere else.
  const readB = jsonOf(await mCall('opscat_list_incidents', { organization: ORG_B.name }, 25));
  const readC = jsonOf(await mCall('opscat_list_incidents', { organization: ORG_C.name }, 26));
  // Found here rather than designed for: `opscat_list_incidents` declared
  // `severity` as a string against a BIGINT column, so it returned an output
  // validation error for every org that HAD an incident and validated fine for
  // every org that did not. No check had ever listed incidents with data in
  // them, which is the only reason 64 green checks meant nothing here.
  chk('listing incidents with data in them validates at all',
    !!readB && typeof readB.incidents?.[0]?.severity === 'number', JSON.stringify(readB).slice(0, 200));
  chk('a read is answered from the organization it named',
    !!readB && !!readC && readB.incidents.some((i) => i.title === 'B incident')
      && !readC.incidents.some((i) => i.title === 'B incident'),
    `B=${readB && readB.count} C=${readC && readC.count}`);

  // ── the org set survives a refresh, and a lost membership shrinks it ──────
  const mRefreshed = await (await tokenReq({
    grant_type: 'refresh_token', client_id: multiClient.client_id, refresh_token: mGrant.tok.refresh_token,
  })).json();
  chk('a refresh keeps the connection alive', !!mRefreshed.access_token, JSON.stringify(mRefreshed));
  const rMcp = (body2, extra = {}) => fetch(`${B}/mcp`, {
    method: 'POST', headers: { ...H, authorization: `Bearer ${mRefreshed.access_token}`, ...extra },
    body: JSON.stringify(body2),
  });
  const rInit = await rMcp({
    jsonrpc: '2.0', method: 'initialize', id: 1,
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'r', version: '1' } },
  });
  const rS = { 'mcp-session-id': rInit.headers.get('mcp-session-id') };
  const rList = async () => jsonOf(await parse(await rMcp({
    jsonrpc: '2.0', method: 'tools/call', id: 30,
    params: { name: 'opscat_list_organizations', arguments: {} },
  }, rS))) || { organizations: [] };
  chk('…with the SAME organizations — a refresh may not widen or narrow the grant',
    (await rList()).count === 3);

  await removeMembership(user.id, ORG_B.id);
  const afterDrop = await rList();
  chk('losing ONE membership drops exactly that organization',
    afterDrop.count === 2 && !afterDrop.organizations.some((o) => o.name === ORG_B.name),
    JSON.stringify(afterDrop));
  const stillC = await parse(await rMcp({
    jsonrpc: '2.0', method: 'tools/call', id: 31,
    params: { name: 'opscat_list_incidents', arguments: { organization: ORG_C.name } },
  }, rS));
  chk('…and the others keep working — leaving one org must not cost the rest',
    !stillC.result?.isError, JSON.stringify(stillC).slice(0, 160));
  const goneB = await parse(await rMcp({
    jsonrpc: '2.0', method: 'tools/call', id: 32,
    params: { name: 'opscat_list_incidents', arguments: { organization: ORG_B.name } },
  }, rS));
  chk('…while the dropped one is refused with the SAME token that reached it a moment ago',
    /does not cover/.test(JSON.stringify(goneB)), JSON.stringify(goneB).slice(0, 160));

  // ── "include organizations I join later" ─────────────────────────────────
  const allClient = await mkClient('AllOrgs');
  const all = await authorize(allClient, [org.id], true);
  const aMcp = (body2, extra = {}) => fetch(`${B}/mcp`, {
    method: 'POST', headers: { ...H, authorization: `Bearer ${all.tok.access_token}`, ...extra },
    body: JSON.stringify(body2),
  });
  const aInit = await aMcp({
    jsonrpc: '2.0', method: 'initialize', id: 1,
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'a', version: '1' } },
  });
  const aS = { 'mcp-session-id': aInit.headers.get('mcp-session-id') };
  const aList = async () => jsonOf(await parse(await aMcp({
    jsonrpc: '2.0', method: 'tools/call', id: 40,
    params: { name: 'opscat_list_organizations', arguments: {} },
  }, aS))) || { organizations: [] };
  const allBefore = await aList();
  chk('an `all` grant covers every current membership, not just the box that was ticked',
    allBefore.count === 3 && allBefore.organizations.some((o) => o.name === ORG_D.name),
    JSON.stringify(allBefore));
  const ORG_E = await mkOrg('Epsilon-mcp');
  await addMembership(user.id, ORG_E.id, 'admin');
  chk('…and an organization joined AFTERWARDS appears with no re-authorization',
    (await aList()).organizations.some((o) => o.name === ORG_E.name));
  // The `list` grant from earlier must NOT have grown the same way — that is the
  // whole difference between the two modes, and it is one column apart.
  chk('…while a `list` grant does not grow', !(await rList()).organizations.some((o) => o.name === ORG_E.name));

  // ── nothing left to act in ends the grant ────────────────────────────────
  for (const o of [org.id, ORG_C.id]) await removeMembership(user.id, o);
  const deadRefresh = await (await tokenReq({
    grant_type: 'refresh_token', client_id: multiClient.client_id, refresh_token: mRefreshed.refresh_token,
  })).json();
  chk('when a grant can reach NO organization at all, the refresh dies',
    deadRefresh.error === 'invalid_grant', JSON.stringify(deadRefresh));
  // Put the seat back: later sections must not inherit a user with no org.
  await addMembership(user.id, org.id, 'admin');

  // (no row cleanup: the whole database goes with the temp directory)
  report();
}

main().catch(die);
