'use strict';
/* Syslog collector endpoints: the credential, the scope, and the ingest path.
 *
 * Hermetic: throwaway database, own port (3169), no network — the collector
 * BINARY is not started here; what is under test is the server half, which is
 * the half that decides who may write into whose logs.
 *
 * ── Why the credential is an api_keys row, and what that has to be proven ────
 *
 * A collector authenticates with an ordinary `api_keys` row carrying the new
 * `collector` scope, rather than with a credential kind of its own. That reuses
 * the hash lookup, the per-key rate limit, `last_used_at`, revocation and the
 * org stamp — and `logs.source` already records the key NAME, so per-site
 * attribution costs nothing. The price of that reuse is that three properties
 * are now assumptions rather than separate code, and each gets a check here:
 *
 *   * a collector key must NOT be able to post anywhere an ingest key can;
 *   * it must NOT consume the org's API-key allowance;
 *   * and it must never exist without an endpoint — an api_keys row whose
 *     `syslog_endpoints` row was rolled back is a live credential belonging to
 *     nothing, which is the same shape as the orphaned `agents` row that
 *     e2e-sensors exists to catch.
 *
 * ── The refusals that have to be refusals ───────────────────────────────────
 *
 * Two checks assert on an ABSENCE rather than on a status code, and they are
 * the ones worth keeping when this file is edited. A disabled endpoint that
 * answers 403 while still writing the batch is not disabled, and a plan refusal
 * that answers 402 after minting the key has still minted the key. The status
 * code is the easy half; "and nothing happened" is the claim.
 *
 * ── Edition ─────────────────────────────────────────────────────────────────
 *
 * Cloud, on purpose: `edition.js` sets `enforce=false` in community, so a
 * community harness cannot tell a working plan ceiling from a missing one.
 *
 *   cd server && node run-e2e.js collector
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { chk, untilAsync, report, onExit, die } = require('./e2e-lib').harness();

// Environment BEFORE any src/ require — config.js and db.js are singletons.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opscat-collector-'));
process.env.OPSCAT_DATA_DIR = tmp;
onExit(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.OPSCAT_SECRET = 'e2e-collector-secret';
process.env.PORT = '3169';
process.env.OPSCAT_EDITION = 'cloud';
process.env.OPSCAT_BASE_URL = 'http://127.0.0.1:3169';
process.env.OPSCAT_ADMIN_EMAIL = 'seed-admin@e2e.test';
process.env.OPSCAT_ADMIN_PASSWORD = 'seed-admin-password-1';
// Creating a user mails an activation link; no transport may be configured here.
delete process.env.RESEND_API_KEY;
delete process.env.SMTP_HOST;

require('./src/index.js'); // boots the app on :3169

const { addMembership } = require('./src/db');
const q = require('./src/db/shim');
const { hashPassword, now, newId } = require('./src/util');
const logStore = require('./src/db/log-store');
const scout = require('./src/engine/scout');

const BASE = 'http://127.0.0.1:3169';
const PASS = 'e2e-user-password-1';
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function mkOrg(name, plan) {
  const id = newId();
  await q.prepare(`INSERT INTO organizations (id, name, slug, plan, status, created_at)
    VALUES (?, ?, ?, ?, 'active', ?)`).run(id, name, name.toLowerCase(), plan, now());
  return id;
}
async function mkUser(email, role, orgId) {
  const { salt, hash } = hashPassword(PASS);
  const uid = newId();
  await q.prepare(`INSERT INTO users (id, org_id, email, name, role, is_super_admin, pass_salt, pass_hash,
      color, active, must_change_password, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, '#388bfd', 1, 0, ?)`)
    .run(uid, orgId, email, email.split('@')[0], role, salt, hash, now());
  await addMembership(uid, orgId, role);
  return email;
}

async function login(email) {
  for (let i = 0; i < 40; i++) {
    let r;
    try {
      r = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: PASS }),
      });
    } catch { await sleep(50); continue; }
    if (r.status === 429) { await sleep(1000); continue; }
    const j = await r.json().catch(() => null);
    return { cookie: (r.headers.get('set-cookie') || '').split(';')[0], csrf: j && j.csrf };
  }
  throw new Error(`login for ${email} stayed rate-limited`);
}

async function call(sess, method, p, body) {
  let resets = 0;
  for (let i = 0; i < 40; i++) {
    const headers = sess ? { cookie: sess.cookie } : {};
    if (method !== 'GET') {
      if (sess) headers['X-OpsCat-CSRF'] = sess.csrf;
      headers['Content-Type'] = 'application/json';
    }
    let r;
    try {
      r = await fetch(BASE + p, {
        method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) { if (++resets > 3) throw e; await sleep(50); continue; }
    const j = await r.json().catch(() => null);
    if (r.status === 429) { await sleep(300); continue; }
    return { status: r.status, j };
  }
  throw new Error(`${method} ${p} stayed rate-limited`);
}

/** Post a batch as a collector would. `key` is the bearer credential. */
async function ship(key, p, logs) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ logs }),
  });
  return { status: r.status, j: await r.json().catch(() => null) };
}

const line = (msg) => ({ device: 'fw-fra-01', line: msg, sev: 4 });
const countKeys = async (orgId, scope) => (await q.prepare(
  `SELECT COUNT(*) AS c FROM api_keys WHERE org_id = ? AND active = 1 AND scopes = ?`)
  .get(orgId, scope)).c;
const linesWith = async (orgId, term) => (await logStore.search({
  orgId, since: 0, until: now() + 60000, term, limit: 50,
})).length;

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch { /* not yet */ }
    await sleep(100);
  }
  return false;
}

async function main() {
  chk('server boots and answers /api/health', await waitForServer());

  const ACME = await mkOrg('Acme-collector', 'business');
  const GLOBEX = await mkOrg('Globex-collector', 'business');
  const TINY = await mkOrg('Tiny-collector', 'free');   // syslogEndpoints: 1
  const lead = await login(await mkUser('lead@acme.collector', 'lead', ACME));
  const analyst = await login(await mkUser('analyst@acme.collector', 'analyst', ACME));
  const other = await login(await mkUser('lead@globex.collector', 'lead', GLOBEX));
  const tiny = await login(await mkUser('lead@tiny.collector', 'lead', TINY));
  chk('the four tenant sessions are established',
    !!(lead.csrf && analyst.csrf && other.csrf && tiny.csrf));

  // ── role gating ────────────────────────────────────────────────────────────
  chk('an analyst may not list endpoints',
    (await call(analyst, 'GET', '/api/syslog/endpoints')).status === 403);
  chk('an analyst may not create one',
    (await call(analyst, 'POST', '/api/syslog/endpoints', { name: 'nope' })).status === 403);
  chk('an anonymous caller may not either',
    (await call(null, 'GET', '/api/syslog/endpoints')).status === 401);

  // ── create ─────────────────────────────────────────────────────────────────
  const empty = await call(lead, 'GET', '/api/syslog/endpoints');
  chk('a fresh org has no endpoints', empty.status === 200 && Array.isArray(empty.j) && empty.j.length === 0);

  chk('a nameless endpoint is refused',
    (await call(lead, 'POST', '/api/syslog/endpoints', {})).status === 400);

  const made = await call(lead, 'POST', '/api/syslog/endpoints',
    { name: 'RZ Frankfurt', devicePrefix: 'fra-', collectorHost: '10.10.0.42' });
  chk('a lead can create an endpoint', made.status === 200, JSON.stringify(made.j));
  const KEY = made.j && made.j.key;
  chk('the response carries the key exactly once', typeof KEY === 'string' && KEY.startsWith('ocl_'),
    String(KEY).slice(0, 12));
  chk('the stored prefix matches the key', made.j.keyPrefix === KEY.slice(0, 12));
  chk('the endpoint is enabled on creation', made.j.enabled === true);
  chk('the device prefix is stored', made.j.devicePrefix === 'fra-');

  // The snippets are generated by the server so the three details that decide
  // whether a first attempt works cannot drift into documentation.
  const sn = made.j.snippets || {};
  chk('the snippets cover docker, systemd and both relay flavours',
    !!(sn.docker && sn.systemd && sn.rsyslog && sn['syslog-ng']));
  /* The snippet must name something that can actually be pulled. It said
   * `opscat/collector:latest` for two commits, which resolves to nothing —
   * Docker Hub has no such repository and nothing ever pushed one. A product
   * that PRINTS a command owns whether that command works. */
  chk('the docker snippet names the registry the image is published to',
    !!sn.docker && sn.docker[0].text.includes('ghcr.io/jpj069/opscat-collector'),
    !!sn.docker && sn.docker[0].text);

  chk('the install snippets carry the real key',
    !!sn.systemd && sn.systemd[0].text.includes(KEY));
  chk('the rsyslog block names the template that preserves the hostname',
    !!sn.rsyslog && sn.rsyslog[0].text.includes('RSYSLOG_SyslogProtocol23Format'));
  chk('the rsyslog block carries a disk-assisted queue',
    !!sn.rsyslog && sn.rsyslog[0].text.includes('queue.saveOnShutdown')
    && sn.rsyslog[0].text.includes('action.resumeRetryCount="-1"'));
  chk('the rsyslog block starts filtered rather than at *.*',
    !!sn.rsyslog && sn.rsyslog[0].text.includes("$syslogfacility-text == 'local7'"));
  chk('the relay block points at the address the caller gave',
    !!sn.rsyslog && sn.rsyslog[0].text.includes('10.10.0.42'));

  const list = await call(lead, 'GET', '/api/syslog/endpoints');
  chk('the endpoint appears in the list', list.j.length === 1 && list.j[0].name === 'RZ Frankfurt');
  chk('the list never carries the key itself', list.j[0].key === undefined);
  chk('the list carries the prefix so a credential can be matched to a screenshot',
    list.j[0].keyPrefix === KEY.slice(0, 12));

  const cfg = await call(lead, 'GET', `/api/syslog/endpoints/${made.j.id}/config`);
  chk('the config endpoint answers snippets', cfg.status === 200 && !!cfg.j.rsyslog);
  chk('… with a placeholder, NOT the key — a secret is retrievable only when minted',
    !JSON.stringify(cfg.j).includes(KEY) && JSON.stringify(cfg.j).includes('&lt;your collector key&gt;'.replace(/&lt;/g, '<').replace(/&gt;/g, '>')));

  /* ── the installer, and the parser it fetches ──────────────────────────────
   *
   * `/collector/syslog.js` is served straight out of src/lib rather than from a
   * copy under collector/, which is what makes "the parser in the customer's
   * network is the one e2e-syslog pins" a fact rather than an intention. The
   * route is pinned here; that the IMAGE also carries it is checked in ci.yml,
   * because only a built image can answer that. */
  const served = await fetch(`${BASE}/collector/syslog.js`);
  const servedBody = await served.text();
  const onDisk = fs.readFileSync(path.join(__dirname, 'src', 'lib', 'syslog.js'), 'utf8');
  chk('the collector parser is served for the installer to fetch', served.status === 200);
  chk('… and it is byte-identical to the file the harness pins', servedBody === onDisk,
    `${servedBody.length} vs ${onDisk.length} bytes`);
  chk('the install script is served too, or the generated command 404s',
    (await fetch(`${BASE}/collector/install.sh`)).status === 200);

  // ── the scope is the blast radius ──────────────────────────────────────────
  const wrongSurface = await ship(KEY, '/v1/ingest/logs', [line('should not be accepted')]);
  chk('a collector key is refused on the general ingest endpoint', wrongSurface.status === 403,
    JSON.stringify(wrongSurface.j));
  chk('… and that refusal wrote nothing', (await linesWith(ACME, 'should not be accepted')) === 0);

  const ev = await fetch(`${BASE}/v1/ingest/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'nope', device: 'x', severity: 90 }),
  });
  chk('a collector key cannot raise an event either', ev.status === 403);

  // ── the collector surface ──────────────────────────────────────────────────
  const conf = await fetch(`${BASE}/v1/collector/config`, { headers: { authorization: `Bearer ${KEY}` } });
  const confJ = await conf.json().catch(() => null);
  chk('the collector can fetch its configuration', conf.status === 200);
  chk('… naming its endpoint', !!confJ && confJ.name === 'RZ Frankfurt');
  chk('… carrying the device prefix the server decides', !!confJ && confJ.devicePrefix === 'fra-');
  chk('… and the batch cap, told rather than guessed', !!confJ && confJ.batchMax === 500);

  const ok = await ship(KEY, '/v1/collector/logs', [line('sshd: accepted publickey')]);
  chk('a collector key ingests through its own endpoint', ok.status === 200, JSON.stringify(ok.j));
  chk('… and the line lands', await untilAsync(async () => (await linesWith(ACME, 'accepted publickey')) === 1));

  // logs.source = the key name = the endpoint name. This is the whole reason a
  // dedicated key per site is worth having: "which site is sending too much"
  // is answerable without a new column anywhere.
  const rows = await logStore.search({ orgId: ACME, since: 0, until: now() + 60000, term: 'accepted publickey', limit: 5 });
  chk('the line is attributed to the endpoint by name',
    rows.length === 1 && rows[0].source === 'RZ Frankfurt', rows.length ? rows[0].source : 'no row');

  chk('an oversized batch is refused',
    (await ship(KEY, '/v1/collector/logs', Array.from({ length: 501 }, () => line('x')))).status === 413);
  chk('an empty batch is accepted and does nothing',
    (await ship(KEY, '/v1/collector/logs', [])).status === 200);
  chk('a bogus key is refused', (await ship('ocl_' + 'f'.repeat(48), '/v1/collector/logs', [line('x')])).status === 401);

  // ── disabled means nothing is written, not merely a 403 ────────────────────
  await call(lead, 'PATCH', `/api/syslog/endpoints/${made.j.id}`, { enabled: false });
  const off = await ship(KEY, '/v1/collector/logs', [line('while disabled zzz')]);
  chk('a disabled endpoint refuses its own key', off.status === 403);
  chk('… and a refusal is only a refusal if nothing was written',
    (await linesWith(ACME, 'while disabled zzz')) === 0);

  const patched = await call(lead, 'GET', '/api/syslog/endpoints');
  chk('disabling did not null the device prefix it was not sent (COALESCE)',
    patched.j[0].devicePrefix === 'fra-' && patched.j[0].enabled === false);

  await call(lead, 'PATCH', `/api/syslog/endpoints/${made.j.id}`, { enabled: true });
  chk('re-enabling restores ingest',
    (await ship(KEY, '/v1/collector/logs', [line('back again')])).status === 200);

  // A rename must reach the key, or the endpoint and its own log lines stop
  // agreeing about what this site is called.
  await call(lead, 'PATCH', `/api/syslog/endpoints/${made.j.id}`, { name: 'RZ Frankfurt II' });
  await ship(KEY, '/v1/collector/logs', [line('after the rename')]);
  const renamed = await untilAsync(async () => {
    const r = await logStore.search({ orgId: ACME, since: 0, until: now() + 60000, term: 'after the rename', limit: 5 });
    return r.length ? r[0].source : null;
  });
  chk('renaming the endpoint renames the key, so logs.source follows',
    renamed === 'RZ Frankfurt II', String(renamed));

  // ── rotation ───────────────────────────────────────────────────────────────
  const rot = await call(lead, 'POST', `/api/syslog/endpoints/${made.j.id}/rotate`, {});
  chk('rotation issues a new key', rot.status === 200 && typeof rot.j.key === 'string' && rot.j.key !== KEY);
  chk('the old key stops working immediately',
    (await ship(KEY, '/v1/collector/logs', [line('with the old key')])).status === 401);
  chk('… and wrote nothing on the way out', (await linesWith(ACME, 'with the old key')) === 0);
  chk('the new key works', (await ship(rot.j.key, '/v1/collector/logs', [line('with the new key')])).status === 200);
  chk('rotation leaves exactly one active collector key',
    (await countKeys(ACME, 'collector')) === 1);

  // The generic key route must refuse the scope: a collector key with no
  // endpoint row is a credential belonging to nothing.
  const sneaky = await call(lead, 'POST', '/api/admin/apikeys', { name: 'sneaky', scopes: ['collector'] });
  chk('the generic API-key route refuses the collector scope', sneaky.status === 400,
    JSON.stringify(sneaky.j));

  // ── org scoping ────────────────────────────────────────────────────────────
  chk("another org cannot see this org's endpoints",
    (await call(other, 'GET', '/api/syslog/endpoints')).j.length === 0);
  chk('a foreign endpoint answers 404, not 403 — the id itself is not confirmed',
    (await call(other, 'PATCH', `/api/syslog/endpoints/${made.j.id}`, { name: 'stolen' })).status === 404);
  chk('… and deleting one is 404 too',
    (await call(other, 'DELETE', `/api/syslog/endpoints/${made.j.id}`)).status === 404);
  chk('… and its config cannot be read across the tenant boundary',
    (await call(other, 'GET', `/api/syslog/endpoints/${made.j.id}/config`)).status === 404);

  // ── the plan ceiling, and the rollback behind it ───────────────────────────
  const first = await call(tiny, 'POST', '/api/syslog/endpoints', { name: 'tiny one' });
  chk('a free org may create its one endpoint', first.status === 200);
  const before = await countKeys(TINY, 'collector');
  const second = await call(tiny, 'POST', '/api/syslog/endpoints', { name: 'tiny two' });
  chk('the second is refused with 402', second.status === 402, JSON.stringify(second.j));
  chk('… quoting used and limit so the UI can say why',
    !!second.j && /1\/1/.test(String(second.j.error)), JSON.stringify(second.j));
  /* THE check of this section. The key is minted before the plan gate runs, so
   * a refusal that does not roll back leaves a live credential for an endpoint
   * that was never created — invisible in every screen, valid forever. */
  chk('a refused creation leaves no orphan credential behind',
    (await countKeys(TINY, 'collector')) === before, `${await countKeys(TINY, 'collector')} vs ${before}`);
  chk('… and no endpoint row either',
    (await call(tiny, 'GET', '/api/syslog/endpoints')).j.length === 1);

  /* ── the two budgets are disjoint ──────────────────────────────────────────
   *
   * Driven through the REAL plan gate, not by counting rows with SQL of the
   * harness's own. The first version of this check did the latter — it selected
   * `scopes NOT LIKE '%collector%'` itself and asserted the number — and it
   * passed happily when plans.js was mutated back to counting every key,
   * because it was testing a query written right here rather than the one the
   * gate uses. Measured: 62/62 under the mutation.
   *
   * TINY is on Free: apiKeys = 2, syslogEndpoints = 1, and it already has its
   * one collector key. So if collector keys were counted, the SECOND api key
   * would be refused — which is exactly the failure a customer with eight sites
   * would hit. */
  const k1 = await call(tiny, 'POST', '/api/admin/apikeys', { name: 'tiny key 1', scopes: ['ingest'] });
  const k2 = await call(tiny, 'POST', '/api/admin/apikeys', { name: 'tiny key 2', scopes: ['ingest'] });
  chk('a free org can still mint its first API key beside a collector key', k1.status === 200);
  chk('… and its second — the collector key did not consume the allowance', k2.status === 200,
    JSON.stringify(k2.j));
  const k3 = await call(tiny, 'POST', '/api/admin/apikeys', { name: 'tiny key 3', scopes: ['ingest'] });
  chk('… while the API-key ceiling itself still holds at the third', k3.status === 402,
    JSON.stringify(k3.j));
  const tinyEndpoint2 = await call(tiny, 'POST', '/api/syslog/endpoints', { name: 'tiny three' });
  chk('… and the endpoint ceiling is unaffected by those API keys', tinyEndpoint2.status === 402);

  // ── what the operator can SEE about an endpoint ───────────────────────────
  /* `logs.source` has held the key's name since the first collector shipped,
   * and the design note said "which site is sending too much is answerable with
   * no new column anywhere". It was answerable in principle and nowhere on
   * screen, which is the same distance as not answerable. */
  // An endpoint of ACME's OWN that nothing has ever connected to — `second`
  // belongs to the free org and is not visible from here at all.
  const idle = await call(lead, 'POST', '/api/syslog/endpoints', { name: 'Never connected' });
  const tp = await call(lead, 'GET', `/api/syslog/endpoints/${made.j.id}/throughput?days=7`);
  chk('an endpoint reports its own throughput', tp.status === 200);
  /* The CURRENT name, not the one it was created with — this endpoint was
   * renamed earlier in this file, and the PATCH carries the rename into the key
   * so `logs.source` keeps agreeing with it. The history therefore follows the
   * endpoint instead of splitting at the rename. */
  const current = (await call(lead, 'GET', '/api/syslog/endpoints')).j
    .find((x) => x.id === made.j.id).name;
  chk('...read under the endpoint\'s CURRENT name, which is what logs.source holds',
    tp.j.source === current, `${tp.j.source} vs ${current}`);
  chk('...counting the lines this endpoint actually ingested',
    tp.j.buckets.reduce((n, b) => n + b.lines, 0) > 0, JSON.stringify(tp.j.buckets));
  chk('...and only those: a second endpoint\'s history is its own',
    (await call(lead, 'GET', `/api/syslog/endpoints/${idle.j.id}/throughput`))
      .j.buckets.reduce((n, b) => n + b.lines, 0) === 0);
  chk('the day window is clamped rather than trusted',
    (await call(lead, 'GET', `/api/syslog/endpoints/${made.j.id}/throughput?days=9999`)).j.days === 90);
  chk('...including a garbage one, which falls back instead of emptying the chart',
    (await call(lead, 'GET', `/api/syslog/endpoints/${made.j.id}/throughput?days=abc`)).j.days === 14);
  chk('another org cannot read this endpoint\'s throughput',
    (await call(other, 'GET', `/api/syslog/endpoints/${made.j.id}/throughput`)).status === 404);

  /* An endpoint is a RECORD, so it belongs in the directory of things this org
   * has — with an id, so the row opens the flyout that already exists rather
   * than a second, thinner one. Without this the single thing an operator
   * configures in the whole syslog path was the one thing Assets did not list. */
  const assets = await call(lead, 'GET', '/api/assets');
  const mine = assets.j.filter((r) => r.kind === 'syslog');
  chk('a syslog endpoint appears in Assets', mine.length >= 1, JSON.stringify(mine));
  chk('...carrying the id its flyout is opened by',
    mine.every((r) => typeof r.id === 'number'));
  chk('...and saying which shape it is',
    mine.some((r) => r.detail.includes('own collector')), JSON.stringify(mine.map((r) => r.detail)));
  /* `waiting` and not `active`: an endpoint configured and never connected to is
   * the commonest support case here, and reading like a working one is how it
   * stays unnoticed. `second` has ingested nothing. */
  chk('an endpoint nothing has connected to reads as waiting, not active',
    mine.find((r) => r.id === idle.j.id)?.status === 'waiting',
    JSON.stringify(mine.map((r) => [r.id, r.status])));
  chk('...while one that has ingested reads as active',
    mine.find((r) => r.id === made.j.id)?.status === 'active');

  /* The device behind the relay says which endpoint it came through. "Which
   * site is that box behind?" is the first question anyone asks about a name
   * they do not recognise, and this column used to say `no agent` — which
   * explains why the row is not clickable and nothing about the device. */
  const dev = assets.j.find((r) => r.kind === 'log-source' && r.name === 'fw-fra-01');
  chk('the device behind the endpoint is listed as a log source', !!dev, JSON.stringify(dev));
  chk('...and names the endpoint it arrived through',
    !!dev && dev.detail.includes(`via ${made.j.name}`), dev && dev.detail);

  /* Scout needed NOTHING built for syslog: every path goes through
   * `pipeline.ingestLogs`, which emits `log`, which is what scout subscribes
   * to. That is a claim worth pinning rather than asserting in prose — it is
   * true by construction today and one refactor away from silently not being. */
  const odd = `zqx widget reconciler drift 4711 on shelf 92`;
  await ship(rot.j.key, '/v1/collector/logs', [line(odd)]);
  await scout.flush();
  const templates = await q.prepare(
    'SELECT template, count FROM scout_templates WHERE org_id = ?').all(ACME);
  /* `line()` carries sev 4, which is the whole point: the syslog FLOOR matches
   * every line at warning or worse, and treating that as "a classifier knows
   * this" made Scout blind to exactly the population it exists for. This check
   * fails outright if the floor is counted as a match again. */
  chk('a syslog WARNING nothing classifies reaches Scout, with nothing built for it',
    templates.some((t) => t.template.includes('widget reconciler drift')),
    JSON.stringify(templates.slice(0, 3)));
  /* And the numbers in it are masked, which is what makes it a TEMPLATE rather
   * than a line — Scout is the same code for syslog as for anything else, and
   * this is the cheapest proof that it really is the same code. */
  chk('...masked into a template rather than stored as the line',
    templates.some((t) => t.template.includes('widget reconciler drift')
      && !t.template.includes('4711')),
    JSON.stringify(templates.map((t) => t.template)));

  // ── deletion ───────────────────────────────────────────────────────────────
  const del = await call(lead, 'DELETE', `/api/syslog/endpoints/${made.j.id}`);
  chk('a lead can delete an endpoint', del.status === 200);
  chk('its key is revoked with it',
    (await ship(rot.j.key, '/v1/collector/logs', [line('after deletion')])).status === 401);
  chk('… and that wrote nothing', (await linesWith(ACME, 'after deletion')) === 0);
  chk('the endpoint is gone from the list',
    !(await call(lead, 'GET', '/api/syslog/endpoints')).j.some((x) => x.id === made.j.id));
  chk('deleting it twice is 404, not a 500',
    (await call(lead, 'DELETE', `/api/syslog/endpoints/${made.j.id}`)).status === 404);
}

main().then(report).catch(die);
