'use strict';
/* Every schema-first route answers what its schema says it answers.
 *
 * ── Why this harness exists ─────────────────────────────────────────────────
 *
 * lib/route-schema.js validates the RESPONSE against the declared schema and
 * throws in test, so a wrong schema is a failing test — but only for a route
 * something actually calls. That was measured rather than assumed: instrumenting
 * the registrar and running the whole suite showed 20 of 43 registered routes
 * exercised. The other 23 had schemas nothing had ever compared to a real
 * response, which is a written promise with no evidence behind it.
 *
 * So this harness DISCOVERS the routes instead of listing them. It walks
 * `registeredRoutes()` and calls every session-authenticated GET that takes no
 * path parameter, then covers the create/update/delete verbs and the one big
 * parameterised read (`/api/events/:id`) by hand. A route added later is swept
 * up automatically; nobody has to remember this file exists.
 *
 * The empty state is the point of the sweep. A list endpoint is at its most
 * dangerous with no rows — that is where a `.nullable()` nobody needed and a
 * missing one nobody noticed look identical — so the sweep runs before the
 * fixtures, then again after them.
 *
 * `expectedCovered` is a floor, not a list. A harness that silently covers
 * nothing (registry empty because a route module moved) would otherwise print
 * "N/N checks passed" while testing nothing at all — the permanently-green
 * failure e2e-lib.js exists to prevent.
 *
 * Hermetic: throwaway database, own port, no network.
 *   cd server && node e2e-contract.js
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { chk, report, onExit, die } = require('./e2e-lib').harness();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opscat-contract-'));
process.env.OPSCAT_DATA_DIR = tmp;
onExit(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.OPSCAT_SECRET = 'e2e-contract-secret';
process.env.PORT = '3167';
process.env.OPSCAT_BASE_URL = 'http://127.0.0.1:3167';
process.env.OPSCAT_EDITION = 'cloud';
process.env.OPSCAT_ADMIN_EMAIL = 'seed-admin@e2e.test';
process.env.OPSCAT_ADMIN_PASSWORD = 'seed-admin-password-1';

require('./src/index.js'); // boots the app on :3167 and registers every route

const q = require('./src/db/shim');
const { now, DEFAULT_ORG_ID } = require('./src/util');
const { registeredRoutes } = require('./src/lib/route-schema');

const BASE = 'http://127.0.0.1:3167';

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function login() {
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'seed-admin@e2e.test', password: 'seed-admin-password-1' }),
    });
    if (r.status === 429) { await new Promise((res) => setTimeout(res, 1000)); continue; }
    const j = await r.json().catch(() => null);
    return { cookie: (r.headers.get('set-cookie') || '').split(';')[0], csrf: j && j.csrf };
  }
  throw new Error('login stayed rate-limited');
}

/* Which registered route a concrete URL belongs to. The alternative — a
 * hand-kept list of "routes this harness reaches" — is a second description of
 * the harness that goes stale the first time somebody adds a check and forgets
 * it, which is the exact failure this whole exercise is about. */
const touched = new Set();
function note(method, concretePath) {
  const p = concretePath.split('?')[0];
  const hit = registeredRoutes().find((r) => {
    if (r.method !== method.toLowerCase()) return false;
    const re = new RegExp(`^${r.fullPath.replace(/:[A-Za-z0-9_]+/g, '[^/]+')}$`);
    return re.test(p);
  });
  if (hit) touched.add(`${hit.method} ${hit.fullPath}`);
}

async function call(sess, method, p, body) {
  note(method, p);
  const headers = { cookie: sess.cookie };
  if (method !== 'GET') { headers['X-OpsCat-CSRF'] = sess.csrf; headers['Content-Type'] = 'application/json'; }
  const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  return { status: r.status, j };
}

/* The sweep. GETs with no ':' in the path that a signed-in admin can reach —
 * session-authenticated and public alike. Everything else needs a fixture, and
 * guessing one is how a harness starts asserting its own idea of the API rather
 * than the API. */
const sweepable = () => registeredRoutes().filter(
  (r) => r.method === 'get' && (r.auth === 'session' || r.auth === 'none') && !r.path.includes(':'));

async function sweep(sess, label) {
  for (const r of sweepable()) {
    const { status, j } = await call(sess, 'GET', r.fullPath);
    // A 500 here IS the schema failing: the registrar throws on a mismatch in
    // test, so the status alone carries the verdict. Parsing again client-side
    // catches the other direction — response validation quietly turned off.
    const schema = r.responses[200];
    const parsed = schema ? schema.safeParse(j) : { success: false, error: { issues: [{ message: 'no 200 schema' }] } };
    chk(`${label}: GET ${r.fullPath} answers its schema`, status === 200 && parsed.success,
      `status ${status}` + (parsed.success ? '' : ` — ${JSON.stringify(parsed.error.issues && parsed.error.issues[0])}`));
  }
}

async function main() {
  chk('server boots and answers /api/health', await waitForServer());
  const sess = await login();
  chk('admin session established', !!sess.cookie);
  const me = await q.prepare('SELECT id FROM users WHERE email = ?').get('seed-admin@e2e.test');

  // ── 1. every sweepable route, on an EMPTY org ─────────────────────────────
  await sweep(sess, 'empty');
  const covered = sweepable().length;
  chk(`the sweep discovered routes to cover (${covered})`, covered >= 10,
    'the registry looks empty — did a route module stop being required?');

  // ── 2. the write verbs, as lifecycles ─────────────────────────────────────
  const hb = await call(sess, 'POST', '/api/heartbeats', { name: 'contract-hb', intervalS: 60, graceS: 30 });
  chk('POST /api/heartbeats answers its schema', hb.status === 200 && typeof hb.j.id === 'number', `status ${hb.status}`);
  chk('the ping URL is returned once, not the token', hb.status === 200 && /\/v1\/heartbeat\/och_/.test(hb.j.pingUrl || ''));
  chk('PATCH /api/heartbeats/:id answers its schema',
    (await call(sess, 'PATCH', `/api/heartbeats/${hb.j.id}`, { name: 'renamed' })).status === 200);

  const win = await call(sess, 'POST', '/api/maintenance',
    { name: 'contract-window', startsAt: now() + 3600000, endsAt: now() + 7200000 });
  chk('POST /api/maintenance answers its schema', win.status === 200 && typeof win.j.id === 'number', `status ${win.status}`);

  const rule = await call(sess, 'POST', '/api/rules',
    { name: 'contract-rule', channel: 'webhook', severityMin: 90, cooldownM: 5, recipients: ['http://127.0.0.1:1/none'] });
  chk('POST /api/rules answers its schema', rule.status === 200 && typeof rule.j.id === 'number', `status ${rule.status}`);
  chk('PATCH /api/rules/:id answers its schema',
    (await call(sess, 'PATCH', `/api/rules/${rule.j.id}`, { severityMin: 80 })).status === 200);

  // ── 3. the parameterised read with the biggest shape ──────────────────────
  const eventId = Number(await q.prepare(`INSERT INTO events
      (org_id, dedupe_key, name, device, ip, target, description, severity, hits, status, first_seen, last_seen)
    VALUES (?, ?, 'contract_event', 'core-01', '10.0.0.1', NULL,
            'seeded by e2e-contract', 70, 3, 'active', ?, ?)`)
    .insert(DEFAULT_ORG_ID, `contract:${crypto.randomBytes(6).toString('hex')}`, now() - 60000, now()));
  const detail = await call(sess, 'GET', `/api/events/${eventId}`);
  const detailSchema = registeredRoutes().find((r) => r.fullPath === '/api/events/:id' && r.method === 'get').responses[200];
  chk('GET /api/events/:id answers its schema',
    detail.status === 200 && detailSchema.safeParse(detail.j).success, `status ${detail.status}`);
  chk('the detail carries a derived "detected" timeline entry',
    detail.status === 200 && Array.isArray(detail.j.timeline)
      && detail.j.timeline[0] && detail.j.timeline[0].action === 'detected');

  // ── 3b. the /v1 ingest surface ────────────────────────────────────────────
  // These are the routes an SDK, an Alertmanager or an OTel collector talks to,
  // and nothing in the suite had ever compared their responses to a schema.
  // They authenticate three different ways, so each family gets its fixture.
  const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const rawKey = `ock_${crypto.randomBytes(24).toString('hex')}`;
  await q.prepare(`INSERT INTO api_keys (org_id, name, prefix, key_hash, scopes, active, created_at)
    VALUES (?, 'e2e-contract', ?, ?, 'ingest', 1, ?)`)
    .run(DEFAULT_ORG_ID, rawKey.slice(0, 12), sha256(rawKey), now());

  const agentToken = `oca_${crypto.randomBytes(24).toString('hex')}`;
  await q.prepare(`INSERT INTO agents (org_id, name, token_hash, active, created_at)
    VALUES (?, 'contract-agent', ?, 1, ?)`).insert(DEFAULT_ORG_ID, sha256(agentToken), now());

  const post = async (p, body, token) => {
    note('post', p);
    const r = await fetch(BASE + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: r.status, j: await r.json().catch(() => null) };
  };
  const otlpLog = {
    resourceLogs: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'contract' } }] },
      scopeLogs: [{ logRecords: [{ body: { stringValue: 'otlp line' }, severityNumber: 9 }] }],
    }],
  };
  const ingestCalls = [
    ['/v1/ingest/logs', { logs: [{ device: 'core-01', line: 'contract log' }] }, rawKey],
    ['/v1/ingest/events', { name: 'contract_direct', device: 'core-01', severity: 55 }, rawKey],
    ['/v1/ingest/webhook', { alertname: 'ContractFiring', host: 'core-01', message: 'from a webhook' }, rawKey],
    ['/v1/integrations/sentry', { project_name: 'contract', message: 'boom', level: 'error' }, rawKey],
    ['/v1/otlp/v1/logs', otlpLog, rawKey],
    ['/v1/otlp/v1/traces', { resourceSpans: [] }, rawKey],
    ['/v1/otlp/v1/metrics', { resourceMetrics: [] }, rawKey],
    ['/v1/agents/heartbeat', { hostname: 'core-01', platform: 'linux', version: '0.0.1' }, agentToken],
    ['/v1/agents/metrics', { cpuPct: 12, load1: 0.4, memUsed: 100, memTotal: 1000 }, agentToken],
    ['/v1/agents/logs', { logs: [{ device: 'core-01', line: 'agent log' }] }, agentToken],
  ];
  for (const [p, body, token] of ingestCalls) {
    const { status, j } = await post(p, body, token);
    const spec = registeredRoutes().find((r) => r.method === 'post' && r.fullPath === p);
    const parsed = spec.responses[200].safeParse(j);
    chk(`POST ${p} answers its schema`, status === 200 && parsed.success,
      `status ${status}` + (parsed.success ? '' : ` — ${JSON.stringify(parsed.error.issues && parsed.error.issues[0])}`));
  }

  // A probe key reaches the last two /v1 routes. An empty result batch is
  // enough — the schema is what is under test, not the recording engine.
  const probeKey = crypto.randomBytes(16).toString('hex');
  const locId = await q.prepare(`INSERT INTO synthetic_locations
      (org_id, city, cc, kind, active, probe_key_hash, created_at)
    VALUES (NULL, 'Contract', 'DE', 'managed', 1, ?, ?)`).insert(sha256(probeKey), now());
  await q.prepare(`INSERT INTO org_location_access (org_id, location_id, source, created_at)
    VALUES (?, ?, 'plan', ?) ON CONFLICT DO NOTHING`).run(DEFAULT_ORG_ID, locId, now());

  note('get', '/v1/synthetics/checks');
  const checksRes = await fetch(`${BASE}/v1/synthetics/checks`, { headers: { authorization: `Bearer ${probeKey}` } });
  const checksBody = await checksRes.json().catch(() => null);
  const checksSpec = registeredRoutes().find((r) => r.fullPath === '/v1/synthetics/checks');
  chk('GET /v1/synthetics/checks answers its schema',
    checksRes.status === 200 && checksSpec.responses[200].safeParse(checksBody).success, `status ${checksRes.status}`);

  const rep = await post('/v1/synthetics/report', { results: [] }, probeKey);
  const repSpec = registeredRoutes().find((r) => r.fullPath === '/v1/synthetics/report');
  chk('POST /v1/synthetics/report answers its schema',
    rep.status === 200 && repSpec.responses[200].safeParse(rep.j).success, `status ${rep.status}`);

  // ── 3c. the On-Call routes that need a fixture to reach ───────────────────
  const sched = await call(sess, 'POST', '/api/oncall/schedules', { name: 'contract-sched', timezone: 'Europe/Berlin' });
  chk('POST /api/oncall/schedules answers 201 and its schema', sched.status === 201, `status ${sched.status}`);
  chk('GET /api/oncall/schedules/:id answers its schema',
    (await call(sess, 'GET', `/api/oncall/schedules/${sched.j.id}`)).status === 200);
  chk('PATCH /api/oncall/schedules/:id answers its schema',
    (await call(sess, 'PATCH', `/api/oncall/schedules/${sched.j.id}`, { name: 'contract-sched-2' })).status === 200);

  const pol = await call(sess, 'POST', '/api/oncall/policies', {
    name: 'contract-policy',
    steps: [{ timeoutM: 5, targets: [{ kind: 'user', refId: me.id }] }],
  });
  chk('POST /api/oncall/policies answers 201 and its schema', pol.status === 201, `status ${pol.status}`);
  chk('PATCH /api/oncall/policies/:id answers its schema',
    (await call(sess, 'PATCH', `/api/oncall/policies/${pol.j.id}`, { repeatN: 1 })).status === 200);

  // A live escalation, so cancel has something to cancel. Raising it is what
  // exercises the three-way success — 201 new, 200 already, 202 suppressed —
  // that the registrar had to grow a `withStatus` for.
  const caseId = Number(await q.prepare(`INSERT INTO cases (org_id, event_id, name, device, severity, status, opened_at)
    VALUES (?, NULL, 'contract_case', 'core-01', 90, 'open', ?)`).insert(DEFAULT_ORG_ID, now()));
  const raised = await call(sess, 'POST', '/api/oncall/alerts',
    { subjectKind: 'case', subjectId: caseId, policyId: pol.j.id, message: 'contract' });
  chk('POST /api/oncall/alerts answers 201 for a new alert', raised.status === 201, `status ${raised.status}`);
  const again = await call(sess, 'POST', '/api/oncall/alerts',
    { subjectKind: 'case', subjectId: caseId, policyId: pol.j.id });
  chk('…and 200 with the live one rather than a twin', again.status === 200, `status ${again.status}`);
  chk('POST /api/oncall/alerts/:id/cancel answers its schema',
    (await call(sess, 'POST', `/api/oncall/alerts/${raised.j.id}/cancel`)).status === 200);

  const method = await call(sess, 'POST', '/api/oncall/me/methods', { kind: 'email', address: 'contract@e2e.test' });
  chk('POST /api/oncall/me/methods answers 201 and its schema', method.status === 201, `status ${method.status}`);
  // The one route whose 2xx cannot be produced hermetically: sending a real test
  // notification needs a real transport, and this suite deliberately has none
  // (e2e-alerts clears RESEND_API_KEY for exactly that reason). So what is
  // asserted is the DECLARED error — the route runs, the gate refuses, and the
  // envelope is the one the spec promises. Saying that is better than a green
  // check implying the success path was tested.
  const test = await call(sess, 'POST', `/api/oncall/me/methods/${method.j.id}/test`);
  const testSpec = registeredRoutes().find((r) => r.fullPath === '/api/oncall/me/methods/:id/test');
  chk('POST …/me/methods/:id/test answers a DECLARED error without a transport',
    !!testSpec.responses[test.status] && testSpec.responses[test.status].safeParse(test.j).success,
    `status ${test.status} — ${JSON.stringify(test.j)}`);

  chk('DELETE /api/oncall/me/methods/:id answers its schema',
    (await call(sess, 'DELETE', `/api/oncall/me/methods/${method.j.id}`)).status === 200);

  // ── 3d. the public status page ────────────────────────────────────────────
  // The JSON a customer's monitoring polls. The parameterless reads are swept
  // above; these two need the page's slug and a body.
  const page = await q.prepare('SELECT slug FROM status_pages WHERE org_id = ? ORDER BY is_default DESC, id LIMIT 1')
    .get(DEFAULT_ORG_ID);
  if (page && page.slug) {
    const bySlug = await fetch(`${BASE}/status/${encodeURIComponent(page.slug)}.json`);
    note('get', '/status/x.json');
    const slugSpec = registeredRoutes().find((r) => r.fullPath === '/status/:slug.json');
    chk('GET /status/:slug.json answers its schema',
      bySlug.status === 200 && slugSpec.responses[200].safeParse(await bySlug.json().catch(() => null)).success,
      `status ${bySlug.status}`);
  } else {
    chk('a default status page exists to read', false, 'no status_pages row for the default org');
  }

  // Uniform by design: honeypot, rate limit and a real report all answer the
  // same, so the check is that the ONE declared shape comes back.
  const reported = await fetch(`${BASE}/api/status/report`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'contract harness' }),
  });
  note('post', '/api/status/report');
  const repSpec2 = registeredRoutes().find((r) => r.fullPath === '/api/status/report');
  chk('POST /api/status/report answers its schema',
    reported.status === 200 && repSpec2.responses[200].safeParse(await reported.json().catch(() => null)).success,
    `status ${reported.status}`);

  // ── 4. the same sweep with rows in the tables ─────────────────────────────
  // An empty list hides a wrong element schema completely.
  await sweep(sess, 'populated');

  // ── 5. the deletes, last ──────────────────────────────────────────────────
  //
  // A FRESH session first, and the reason is structural rather than cosmetic:
  // the sweep above walks EVERY registered GET, twice (empty and populated), so
  // its cost grows with each route converted to schema-first. The per-session
  // API limiter is 300 a minute with a burst of 60, and the whole file runs in
  // under two seconds — so the bucket is spent by the time these deletes run,
  // and they answered 429. That failure is indistinguishable from a broken
  // route, and it arrives for whoever converts the NEXT three endpoints rather
  // than for whoever wrote the sweep. The limiter keys on the session id, so
  // signing in again is the honest fix; turning the limiter down would test a
  // configuration nobody runs.
  const delSess = await login();
  chk('a second session signs in for the deletes', !!delSess.cookie);
  chk('DELETE /api/rules/:id answers its schema',
    (await call(delSess, 'DELETE', `/api/rules/${rule.j.id}`)).status === 200);
  chk('DELETE /api/maintenance/:id answers its schema',
    (await call(delSess, 'DELETE', `/api/maintenance/${win.j.id}`)).status === 200);
  chk('DELETE /api/heartbeats/:id answers its schema',
    (await call(delSess, 'DELETE', `/api/heartbeats/${hb.j.id}`)).status === 200);

  // ── 6. the document describes exactly what is registered ──────────────────
  const doc = await (await fetch(`${BASE}/openapi.json`)).json();
  const inDoc = new Set();
  for (const [p, methods] of Object.entries(doc.paths || {})) {
    for (const m of Object.keys(methods)) inDoc.add(`${m} ${p}`);
  }
  const expected = registeredRoutes().filter((r) => !r.internal)
    .map((r) => `${r.method} ${r.fullPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`);
  const missing = expected.filter((e) => !inDoc.has(e));
  chk('every public registered route is in /openapi.json', missing.length === 0, missing.join(', '));
  chk('/openapi.json contains nothing that is not registered',
    inDoc.size === expected.length, `${inDoc.size} in doc vs ${expected.length} registered`);

  // The rendered reference walks every operation's schemas. It is the one place
  // a shape the renderer has not seen before would throw, and a 500 there is
  // invisible from the spec alone.
  const docsRes = await fetch(`${BASE}/docs`);
  const html = await docsRes.text();
  chk('/docs renders', docsRes.status === 200 && html.includes('<h1>'), `status ${docsRes.status}`);
  chk('/docs shows every registered path', expected.every((e) => html.includes(e.split(' ')[1])),
    'a path in the spec is missing from the rendered page');

  // Informational, not a check: what this harness did NOT reach. Other
  // harnesses cover most of it (measured by instrumenting the registrar and
  // running the suite); printing it is what keeps the gap from being assumed
  // shut rather than known.
  const rest = registeredRoutes().map((r) => `${r.method} ${r.fullPath}`).filter((r) => !touched.has(r));
  console.log(`\n[contract] reached here: ${touched.size}/${registeredRoutes().length}`
    + (rest.length ? `\n[contract] not reached here: ${rest.join(', ')}` : '') + '\n');

  report();
}

main().catch(die);
