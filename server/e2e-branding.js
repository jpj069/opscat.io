'use strict';
/* End-to-end check for status PAGES: branding, custom CSS, custom domains and
 * private audience pages.
 *
 * Hermetic: throwaway database, no network, no mail. Runs in the CLOUD edition
 * on purpose — the community edition unlocks every feature (edition.js sets
 * enforce=false), so a community harness could not tell a working plan gate
 * from a missing one. That is exactly the bug this file exists to catch: the
 * gate was verified against a community server once and looked green while
 * gating nothing.
 *
 * What it guards:
 *   - migration v18: status_pages, per-page assets, per-page subscribers;
 *   - the injection boundary: the accent lands in a <style> block and the links
 *     in href=, so a non-hex colour and a javascript: URL must be refused on
 *     the way IN and defaulted on the way OUT;
 *   - upload validation by MAGIC BYTES, not by the declared type — an SVG must
 *     be refused whatever it calls itself, since /status/logo is openable
 *     directly and would execute it on the status page's own origin;
 *   - asset serving: content type from the sniffed bytes, ETag + 304, nosniff,
 *     and 404 while the page is unpublished (an unpublished page must not leak
 *     its logo either);
 *   - the favicon falling back to the logo;
 *   - the public page actually rendering all of it;
 *   - the whitelabel plan gate in BOTH directions, including the downgrade
 *     rule: the stored intent survives, the footer comes back;
 *   - the statusSubscribers plan limit stopping NEW sign-ups while letting a
 *     visitor already holding a confirm mail finish;
 *   - custom CSS: the plan gate, the size cap, and the ONE thing it may never
 *     contain (a closing </style> tag, which would turn a stylesheet field into
 *     stored XSS on the status page's own origin);
 *   - custom domains: the DNS TXT proof (stubbed resolver, no network), that an
 *     UNVERIFIED domain neither serves the page nor lets Caddy mint a
 *     certificate, that our own hostnames cannot be claimed, and that a
 *     downgrade stops serving the domain without destroying it;
 *   - additional and PRIVATE pages: the Enterprise gate, the component subset,
 *     the link secret (and rotating it), noindex, and that a private page 404s
 *     rather than 403s so its existence is not confirmed.
 *
 *   cd server && node e2e-branding.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { chk, report, onExit, die } = require('./e2e-lib').harness();

// Environment BEFORE any src/ require — db.js and config.js are singletons.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opscat-brand-'));
process.env.OPSCAT_DATA_DIR = tmp;
onExit(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.OPSCAT_SECRET = 'e2e-brand-secret';
process.env.PORT = '3129';
process.env.OPSCAT_EDITION = 'cloud';           // the whole point — see header
process.env.OPSCAT_BASE_URL = 'https://ops.e2e.test';
// the dedicated status host: status.<domain>/<slug>. Set here so the whole file
// exercises the configured shape rather than only the /status fallback.
process.env.OPSCAT_STATUS_HOST = 'status.e2e.test';
process.env.OPSCAT_ADMIN_EMAIL = 'seed-admin@e2e.test';
process.env.OPSCAT_ADMIN_PASSWORD = 'seed-admin-password-1';

// A mail transport, because `subscribers.available()` requires one — without it
// subscribe() returns `unavailable` before it ever reaches the allowance check,
// and the three subscriber checks below tested a switched-off path (they failed
// for that reason, not for a product one). Only the PROVIDER call is stubbed, the
// invite-harness pattern, so everything up to the HTTP request runs for real.
process.env.RESEND_API_KEY = 're_e2e_stub';
process.env.MAIL_TRANSPORT = 'resend';
const realFetch = global.fetch;
global.fetch = (url, opts) => (String(url).startsWith('https://api.resend.com/')
  ? Promise.resolve(new Response('{"id":"stub"}', { status: 200 }))
  : realFetch(url, opts));

require('./src/index.js');

const { hashPassword, now, newId, DEFAULT_ORG_ID } = require('./src/util'); // boots the app on :3129

// Fixtures and read-back go through the SHIM, so they land in the database
// `run-e2e.js` handed this process in DATABASE_URL — the same one the code under
// test reads. A connection the harness opened for itself would be a different
// session, and a fixture written there surfaces as a foreign-key violation
// several calls later, pointing at the wrong thing entirely.
const q = require('./src/db/shim');
const { schemaVersion } = require('./src/db');
const branding = require('./src/lib/status-branding');
const statusDomains = require('./src/lib/status-domains');
const statusPages = require('./src/lib/status-pages');
const defaultPage = () => statusPages.defaultPage(DEFAULT_ORG_ID);   // async since Phase 4

const BASE = 'http://127.0.0.1:3129';

// --- a real, decodable PNG (4x4) so the sniffer is tested against bytes a
//     browser would also accept, not against a handcrafted 8-byte header ------
function crc(buf) {
  let c = ~0;
  for (const x of buf) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
  return Buffer.from([(~c >>> 24) & 255, (~c >>> 16) & 255, (~c >>> 8) & 255, ~c & 255]);
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  return Buffer.concat([len, body, crc(body)]);
}
function makePng(side = 4, noisy = false) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0); ihdr.writeUInt32BE(side, 4); ihdr[8] = 8; ihdr[9] = 2;
  // noisy: deflate cannot squeeze a pseudo-random sequence, so the encoded file
  // lands in the tens of kilobytes like a real logo. A flat colour compresses to a
  // few hundred bytes however many pixels it has, which is how the fixture stayed
  // small enough to sail under a 500-character length guard.
  let st = 1;
  const px = () => { st = (st * 1103515245 + 12345) & 0x7fffffff; return (st >>> 16) & 255; };
  const rows = Array.from({ length: side }, () => Buffer.concat([Buffer.from([0]),
    Buffer.from(Array.from({ length: side * 3 }, () => (noisy ? px() : 0x7a)))]));
  const raw = Buffer.concat(rows);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = makePng();
/**
 * A logo of a size somebody would actually upload.
 *
 * `PNG` above is 4x4 and base64-encodes to 96 characters — which is why every
 * check here passed while the route rejected every real file: the length guard
 * capped at 500 characters (`isStr`'s default) and a 96-character fixture sailed
 * under it. A test small enough to dodge the bug tests nothing. 160x160 of noise
 * does not compress, so this lands in the tens of kilobytes like a real logo.
 */
const BIG_PNG = makePng(160, true);

async function login(email, password) {
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (r.status === 429) { await new Promise((res) => setTimeout(res, 1000)); continue; }
    const j = await r.json().catch(() => null);
    return { cookie: (r.headers.get('set-cookie') || '').split(';')[0], csrf: j && j.csrf, status: r.status };
  }
  throw new Error('login stayed rate-limited');
}
async function call(sess, method, p, body) {
  const headers = { cookie: sess.cookie };
  if (method !== 'GET') { headers['X-OpsCat-CSRF'] = sess.csrf; headers['Content-Type'] = 'application/json'; }
  const r = await fetch(BASE + p, { method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  return { status: r.status, j };
}
async function raw(p, opts) {
  const r = await fetch(BASE + p, opts);
  return { status: r.status, headers: r.headers, text: r.status === 200 ? await r.text() : '' };
}
// `Host` is a FORBIDDEN header for fetch() — it silently drops it, which would
// make every custom-domain check below pass by testing the default page. The
// low-level client is the only way to actually exercise host-based routing.
const http = require('http');
function onHost(host, p) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: 3129, path: p, headers: { Host: host } }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: body }));
    });
    req.on('error', () => resolve({ status: 0, headers: {}, text: '' }));
    req.end();
  });
}
async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch { /* not yet */ }
    await new Promise((res) => setTimeout(res, 100));
  }
  return false;
}
const setPlan = (p) => q.prepare('UPDATE organizations SET plan = ? WHERE id = ?').run(p, DEFAULT_ORG_ID);
const upload = (sess, pageId, kind, buf) =>
  call(sess, 'PUT', `/api/admin/status-pages/${pageId}/asset/${kind}`, { data: buf.toString('base64') });
const patchPage = (sess, pageId, body) => call(sess, 'PATCH', `/api/admin/status-pages/${pageId}`, body);
const listPages = async (sess) => (await call(sess, 'GET', '/api/admin/status-pages')).j;
const reload = (id) => statusPages.pageById(id);   // async since Phase 4

// A DNS resolver that answers from a table, so domain verification is
// deterministic and the box never makes a real query about a customer's domain.
function stubResolver(table) {
  return {
    resolveTxt: async (name) => {
      const v = table[name];
      if (!v) { const e = new Error('queryTxt ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; }
      return v;
    },
  };
}


/* The migration checks below ask the SCHEMA, and the question has two spellings.
 * The shape is read from information_schema; the VERSION goes through db.js's
 * single accessor, which reads the `schema_migrations` row.
 */
const columnsOf = async (table) =>
  (await q.all('SELECT column_name FROM information_schema.columns WHERE table_name = ?', table))
    .map((c) => c.column_name);

async function main() {
  chk('server boots and answers /api/health', await waitForServer());
  chk('user_version is at least 18', await schemaVersion() >= 18, String(await schemaVersion()));
  chk('status_pages table exists', (await columnsOf('status_pages')).length === 19,
    String((await columnsOf('status_pages')).length));
  chk('status_assets is keyed by page', (await columnsOf('status_assets')).includes('page_id'));
  chk('status_subscribers is keyed by page',
    (await columnsOf('status_subscribers')).includes('page_id'));

  const admin = await login('seed-admin@e2e.test', 'seed-admin-password-1');
  chk('seeded admin can sign in', admin.status === 200, String(admin.status));
  await setPlan('enterprise'); // start at the top; each gate is walked DOWN individually

  const list0 = await listPages(admin);
  chk('the org has exactly one page, the default one',
    list0.pages.length === 1 && list0.pages[0].isDefault, JSON.stringify(list0.pages.map((p) => p.slug)));
  const MAIN = list0.pages[0].id;
  chk('the default page inherited the org slug', list0.pages[0].slug === 'default', list0.pages[0].slug);

  // ── the injection boundary ────────────────────────────────────────────────
  const badHex = await patchPage(admin, MAIN, { accent: 'red;}body{display:none' });
  chk('a non-hex accent is refused', badHex.status === 400, JSON.stringify(badHex.j));
  chk('…and the renderer would default it anyway',
    branding.accentOf({ accent: 'red;}body{' }) === branding.DEFAULT_ACCENT);
  chk('an unknown theme is refused', (await patchPage(admin, MAIN, { theme: 'neon' })).status === 400);
  for (const k of ['supportUrl', 'legalUrl']) {
    chk(`a javascript: ${k} is refused`,
      (await patchPage(admin, MAIN, { [k]: 'javascript:alert(1)' })).status === 400);
  }
  chk('safeUrl drops a scheme-relative URL too', branding.safeUrl('//evil.example') === '');
  chk('safeUrl keeps https', branding.safeUrl('https://acme.example/x') === 'https://acme.example/x');
  chk('a description over 300 chars is refused',
    (await patchPage(admin, MAIN, { description: 'x'.repeat(301) })).status === 400);

  // ── uploads are validated by their BYTES ──────────────────────────────────
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
  chk('an SVG is refused', (await upload(admin, MAIN, 'logo', svg)).status === 400);
  chk('…even when it claims to be a PNG in a data: URI',
    (await call(admin, 'PUT', `/api/admin/status-pages/${MAIN}/asset/logo`,
      { data: `data:image/png;base64,${svg.toString('base64')}` })).status === 400);
  chk('an HTML file is refused', (await upload(admin, MAIN, 'logo', Buffer.from('<html>hi'))).status === 400);
  chk('an empty upload is refused', (await upload(admin, MAIN, 'logo', Buffer.alloc(0))).status === 400);
  chk('an oversize image is refused',
    (await upload(admin, MAIN, 'logo', Buffer.concat([PNG, Buffer.alloc(branding.MAX_ASSET_BYTES)]))).status === 400);
  chk('an unknown asset kind is a 404',
    (await call(admin, 'PUT', `/api/admin/status-pages/${MAIN}/asset/banner`,
      { data: PNG.toString('base64') })).status === 404);

  const ok = await upload(admin, MAIN, 'logo', PNG);
  chk('a real PNG is accepted', ok.status === 200 && ok.j.mime === 'image/png', JSON.stringify(ok.j));
  // The check this file existed without: a logo of a size somebody would really
  // pick. Everything above passed for months while this failed with
  // "data (base64) required", because the length guard defaulted to 500 chars.
  const bigB64 = BIG_PNG.toString('base64');
  chk('the realistic fixture is actually big enough to matter',
    bigB64.length > 5000, `${bigB64.length} base64 chars`);
  const big = await upload(admin, MAIN, 'logo', BIG_PNG);
  chk('a logo of a realistic size is accepted (not just a 4x4 pixel fixture)',
    big.status === 200 && big.j.bytes === BIG_PNG.length,
    `${big.status} ${JSON.stringify(big.j)} for ${bigB64.length} base64 chars`);
  chk('…and as a data: URI, which is what the browser actually sends',
    (await call(admin, 'PUT', `/api/admin/status-pages/${MAIN}/asset/logo`,
      { data: `data:image/png;base64,${bigB64}` })).status === 200);
  chk('the sniffed type is stored, not the claimed one',
    (await q.prepare('SELECT mime FROM status_assets WHERE page_id = ? AND kind = ?')
      .get(MAIN, 'logo')).mime === 'image/png');

  // ── serving ───────────────────────────────────────────────────────────────
  const logo = await raw('/status/logo');
  chk('the logo is served', logo.status === 200);
  chk('…with the sniffed content type', logo.headers.get('content-type') === 'image/png');
  chk('…with nosniff', logo.headers.get('x-content-type-options') === 'nosniff');
  chk('…as an inline attachment, never a document',
    /^inline/.test(logo.headers.get('content-disposition') || ''));
  const etag = logo.headers.get('etag');
  chk('…carrying an ETag', !!etag, String(etag));
  chk('a conditional GET answers 304',
    (await fetch(`${BASE}/status/logo`, { headers: { 'If-None-Match': etag } })).status === 304);
  chk('the favicon falls back to the logo', (await raw('/status/favicon')).status === 200);
  await upload(admin, MAIN, 'favicon', makePng(8));
  chk('an uploaded favicon takes over',
    !!await q.prepare('SELECT 1 FROM status_assets WHERE page_id = ? AND kind = ?').get(MAIN, 'favicon'));

  // ── the page renders it ───────────────────────────────────────────────────
  await patchPage(admin, MAIN, {
    accent: '#e2571e', theme: 'light',
    description: 'Live status for the Acme platform.',
    supportUrl: 'https://acme.example/support',
  });
  const pg = await raw('/status');
  chk('the page carries the accent as a CSS variable', pg.text.includes('--accent:#e2571e'));
  chk('the page carries the light palette', pg.text.includes('--bg:#ffffff'));
  chk('…and declares the colour scheme to the browser',
    pg.text.includes('<meta name="color-scheme" content="light">'));
  chk('the logo replaces the placeholder square', /<img class="logo" src="\/status\/logo\?v=\d+"/.test(pg.text));
  chk('the favicon is linked', /<link rel="icon" type="image\/png" href="\/status\/favicon\?v=\d+">/.test(pg.text));
  chk('the description renders', pg.text.includes('Live status for the Acme platform.'));
  chk('the support link renders', pg.text.includes('>Support</a>'));
  chk('the legal link stays absent while unset', !pg.text.includes('>Legal</a>'));
  chk('the accent button gets readable ink', pg.text.includes('--accent-ink:#ffffff'));
  chk('the uptime strip uses the light-theme green', pg.text.includes('rgba(31,136,61,.45)'));

  // ── custom CSS ────────────────────────────────────────────────────────────
  chk('a closing </style> tag is refused',
    (await patchPage(admin, MAIN, { customCss: 'body{}</style><script>alert(1)</script>' })).status === 400);
  chk('…in any spelling', !!branding.cssProblem('a{}< / STYLE >'.replace(/ /g, '')));
  chk('CSS over the size cap is refused',
    (await patchPage(admin, MAIN, { customCss: 'a{}'.repeat(branding.MAX_CSS_BYTES) })).status === 400);
  chk('valid CSS is accepted',
    (await patchPage(admin, MAIN, { customCss: '.comp{border-radius:12px}' })).status === 200);
  chk('…and lands in the page stylesheet', (await raw('/status')).text.includes('.comp{border-radius:12px}'));

  // ── custom domain ─────────────────────────────────────────────────────────
  chk('our own hostname cannot be claimed',
    (await call(admin, 'POST', `/api/admin/status-pages/${MAIN}/domain`, { domain: 'ops.e2e.test' })).status === 400);
  chk('an IP with a port is not a hostname',
    (await call(admin, 'POST', `/api/admin/status-pages/${MAIN}/domain`, { domain: 'http://1.2.3.4:8080/x' })).status === 400);
  const claimed = await call(admin, 'POST', `/api/admin/status-pages/${MAIN}/domain`, { domain: 'Status.ACME.example.' });
  chk('a domain is normalised on the way in', claimed.status === 200 && claimed.j.domain === 'status.acme.example',
    JSON.stringify(claimed.j && claimed.j.domain));
  chk('…and comes back with both DNS records to create',
    claimed.j.dns.challenge.host === '_opscat-challenge.status.acme.example'
    && claimed.j.dns.routing.type === 'CNAME');
  chk('an unverified domain does NOT serve the page',
    !(await onHost('status.acme.example', '/')).text.includes('Systems Operational'));
  chk('…and Caddy is told NOT to mint a certificate for it',
    (await raw('/api/public/tls-check?domain=status.acme.example')).status === 404);

  const token = (await reload(MAIN)).domain_token;
  const wrong = await statusDomains.verifyDomain(await reload(MAIN), stubResolver({
    '_opscat-challenge.status.acme.example': [['some-other-value']],
  }));
  chk('a TXT record with the wrong value does not verify', wrong.ok === false, JSON.stringify(wrong));
  const missing = await statusDomains.verifyDomain(await reload(MAIN), stubResolver({}));
  chk('a missing TXT record says so in plain words', missing.ok === false && /no TXT record/.test(missing.error));
  // a real resolver splits long TXT values into 255-byte chunks
  const good = await statusDomains.verifyDomain(await reload(MAIN), stubResolver({
    '_opscat-challenge.status.acme.example': [[token.slice(0, 10), token.slice(10)]],
  }));
  chk('a chunked TXT record verifies (records split at 255 bytes)', good.ok === true, JSON.stringify(good));
  chk('…and the page is now served on that host',
    (await onHost('status.acme.example', '/')).text.includes('--accent:#e2571e'));
  chk('…with its links rooted at that host, not at opscat.io',
    (await onHost('status.acme.example', '/')).text.includes('href="/feed.xml"'));
  chk('…the summary alias answers at the root',
    (await onHost('status.acme.example', '/summary.json')).status === 200);
  chk('…and Caddy may now mint the certificate',
    (await raw('/api/public/tls-check?domain=status.acme.example')).status === 200);
  chk('opscat.io itself is untouched by all of this',
    (await raw('/status')).text.includes('Systems Operational'));
  chk('re-claiming the same domain drops the verification',
    (await call(admin, 'POST', `/api/admin/status-pages/${MAIN}/domain`,
      { domain: 'status.acme.example' })).j.domainVerifiedAt === null);

  // ── additional + private pages ────────────────────────────────────────────
  const created = await call(admin, 'POST', '/api/admin/status-pages',
    { name: 'Partner Portal', slug: 'partners', visibility: 'private' });
  chk('an additional page can be created', created.status === 200, JSON.stringify(created.j));
  const PARTNER = created.j.id;
  chk('…private, with a secret', created.j.visibility === 'private' && created.j.accessToken.length > 20);
  chk('a reserved slug is refused',
    (await call(admin, 'POST', '/api/admin/status-pages', { name: 'X', slug: 'confirm' })).status === 400);
  chk('a duplicate slug is refused',
    (await call(admin, 'POST', '/api/admin/status-pages', { name: 'X', slug: 'partners' })).status === 409);
  // Slugs that would shadow the APPLICATION once a status host is configured: there
  // the slug is the first path segment, so a page called "api" sits in front of the
  // API on that host. An unknown slug falls through, which is why this collision
  // would stay invisible until somebody created exactly that page.
  for (const shadow of ['api', 'app', 'assets', 'v1']) {
    chk(`a slug that would shadow /${shadow} is refused`,
      (await call(admin, 'POST', '/api/admin/status-pages', { name: 'X', slug: shadow })).status === 400);
  }

  // ── the slug check the create dialog asks while you type ──────────────────
  const slugCheck = async (v) =>
    (await call(admin, 'GET', `/api/admin/status-pages/slug-available?slug=${encodeURIComponent(v)}`)).j;
  chk('an unused slug is free', (await slugCheck('brand-new')).available === true);
  chk('a taken slug is not', (await slugCheck('partners')).available === false);
  chk('…and says why', (await slugCheck('partners')).reason === 'already taken');
  chk('a reserved slug is not free', (await slugCheck('api')).available === false);
  chk('a malformed slug is not free', (await slugCheck('Not A Slug!')).available === false);
  chk('an empty slug answers rather than 500ing', (await slugCheck('')).available === false);
  chk('the answer names the slug it is about, so a late reply can be discarded',
    (await slugCheck('brand-new')).slug === 'brand-new');

  const H = 'status.e2e.test';

  // ── the default page's slug is editable ───────────────────────────────────
  // It was frozen when it was invisible (seeded from the org slug, only ever
  // reached via /status). The status host puts it in the public URL, so an org
  // stuck at its seed value would be stuck at a name it never chose.
  const beforeSlug = (await reload(MAIN)).slug;
  chk('the default page can be renamed', (await patchPage(admin, MAIN, { slug: 'main-page' })).status === 200);
  chk('…and answers on the new slug', (await onHost(H, '/main-page')).status === 200);
  chk('…while /status keeps resolving it, whatever the slug', (await raw('/status')).status === 200);
  chk('…and the OLD slug no longer does', (await onHost(H, `/${beforeSlug}`)).status === 404);
  chk('a rename still refuses a reserved slug',
    (await patchPage(admin, MAIN, { slug: 'api' })).status === 400);
  chk('…and a slug another page holds', (await patchPage(admin, MAIN, { slug: 'partners' })).status === 409);
  chk('renaming back works', (await patchPage(admin, MAIN, { slug: beforeSlug })).status === 200);

  // ── the dedicated status host (OPSCAT_STATUS_HOST) ────────────────────────
  // Configured at the top of this file, so every URL the admin API prints is the
  // status-host shape. The /status paths must keep working regardless: a status
  // page URL ends up in runbooks, and a nicer name is not worth breaking one.
  const pageUrl = (id, l) => l.pages.find((x) => x.id === id).url;
  const listH = (await call(admin, 'GET', '/api/admin/status-pages')).j;
  chk('the admin API prints the status-host URL',
    pageUrl(MAIN, listH) === `https://${H}/default`, pageUrl(MAIN, listH));
  chk('…by slug for the DEFAULT page too, not a bare root',
    !pageUrl(MAIN, listH).endsWith(`${H}/`), pageUrl(MAIN, listH));
  chk('the page renders on the status host',
    (await onHost(H, '/default')).text.includes('Systems Operational'));
  chk('…and its own links stay on that host',
    (await onHost(H, '/default')).text.includes('/default/feed.xml'));
  chk('the JSON and the feed resolve there too',
    (await onHost(H, '/default/summary.json')).status === 200
    && (await onHost(H, '/default/feed.xml')).status === 200);
  chk('the old /status path still resolves — no shared link breaks',
    (await raw('/status')).status === 200);
  chk('…including /status/<slug>', (await onHost(H, '/status/partners')).status !== 500);
  chk('a bare root on the status host goes to the default page',
    (await onHost(H, '/')).status === 302);
  // The status host serves status pages and nothing else. It fell through to the
  // application at first, which put the admin console on a public status hostname —
  // measured on the deployed host, /app answered 200 before this check existed.
  chk('the status host does not serve the app', (await onHost(H, '/app/')).status === 404);
  chk('…nor the API', (await onHost(H, '/api/health')).status === 404);
  chk('…and the app host still does', (await raw('/api/health')).status === 200);
  chk('a private page still needs its secret on the status host',
    !(await onHost(H, '/partners')).text.includes('Systems Operational'));
  chk('the main page cannot be made private',
    (await patchPage(admin, MAIN, { visibility: 'private' })).status === 400);
  chk('the main page cannot be deleted',
    (await call(admin, 'DELETE', `/api/admin/status-pages/${MAIN}`)).status === 400);

  const secret = created.j.accessToken;
  chk('a private page 404s without the secret — never 403, which would confirm it exists',
    (await raw('/status/partners')).status === 404);
  chk('…and serves with it', (await raw(`/status/partners?k=${secret}`)).status === 200);
  const privPage = await raw(`/status/partners?k=${secret}`);
  chk('…carrying noindex in the markup', privPage.text.includes('content="noindex, nofollow"'));
  chk('…and in the header', privPage.headers.get('x-robots-tag') === 'noindex, nofollow');
  chk('…and remembering access in a cookie so links keep working',
    /sp\d+=/.test(privPage.headers.get('set-cookie') || ''));
  chk('a wrong secret is refused', (await raw('/status/partners?k=notthesecret')).status === 404);
  chk('the private page assets are gated too', (await raw('/status/partners/logo')).status === 404);

  const rotated = await call(admin, 'POST', `/api/admin/status-pages/${PARTNER}/rotate-token`);
  chk('rotating the link issues a new secret', rotated.j.accessToken !== secret);
  chk('…and the old one stops working', (await raw(`/status/partners?k=${secret}`)).status === 404);

  // component subset
  const comps = await q.prepare('SELECT id, name FROM components WHERE org_id = ? ORDER BY id').all(DEFAULT_ORG_ID);
  chk('the org has components to choose from', comps.length >= 2, String(comps.length));
  await patchPage(admin, PARTNER, { componentIds: [comps[0].id] });
  const partnerPg = await raw(`/status/partners?k=${rotated.j.accessToken}`);
  chk('a subset page shows the chosen component', partnerPg.text.includes(comps[0].name));
  chk('…and not the others', !partnerPg.text.includes(comps[1].name));
  chk('the main page still shows everything',
    (await raw('/status')).text.includes(comps[1].name));

  // ── plan gates, walked DOWN one tier at a time ────────────────────────────
  await setPlan('business');
  chk('business keeps custom CSS', (await patchPage(admin, MAIN, { customCss: '.x{}' })).status === 200);
  chk('…and whitelabel', (await patchPage(admin, MAIN, { hidePowered: true })).status === 200);
  chk('…and the footer drops the attribution', !(await raw('/status')).text.includes('Powered by OpsCat'));
  chk('…but no longer additional pages',
    (await call(admin, 'POST', '/api/admin/status-pages', { name: 'Y', slug: 'ypage' })).status === 403);

  await setPlan('pro');
  chk('pro loses custom CSS on write', (await patchPage(admin, MAIN, { customCss: '.y{}' })).status === 403);
  chk('…and the CSS stops being rendered', !(await raw('/status')).text.includes('.x{}'));
  chk('…and the footer comes back', (await raw('/status')).text.includes('Powered by OpsCat'));
  chk('…but the domain still serves', (await raw('/api/public/tls-check?domain=status.acme.example')).status === 404,
    're-claimed above, so unverified — verify again for the pro check');
  const reverify = await statusDomains.verifyDomain(await reload(MAIN), stubResolver({
    '_opscat-challenge.status.acme.example': [[(await reload(MAIN)).domain_token]],
  }));
  chk('…once re-verified', reverify.ok === true);
  chk('…pro serves the custom domain', (await raw('/api/public/tls-check?domain=status.acme.example')).status === 200);

  await setPlan('free');
  chk('free may not claim a domain',
    (await call(admin, 'POST', `/api/admin/status-pages/${MAIN}/domain`, { domain: 'x.acme.example' })).status === 403);
  chk('…the existing domain stops resolving',
    (await raw('/api/public/tls-check?domain=status.acme.example')).status === 404);
  chk('…and stops serving the page',
    !(await onHost('status.acme.example', '/')).text.includes('Systems Operational'));
  chk('…but the configuration survives the downgrade',
    (await reload(MAIN)).domain === 'status.acme.example' && !!(await reload(MAIN)).domain_verified_at);
  chk('…and identity itself stays free', (await raw('/status')).text.includes('--accent:#e2571e'));
  chk('…including the logo', (await raw('/status/logo')).status === 200);
  chk('…and uploading a new one', (await upload(admin, MAIN, 'logo', makePng(6))).status === 200);
  const freeLimits = (await listPages(admin)).limits;
  chk('…and the admin surface reports every locked bit',
    freeLimits.canWhitelabel === false && freeLimits.canCustomCss === false
    && freeLimits.canCustomDomain === false && freeLimits.canMultiPage === false);

  await setPlan('enterprise');
  chk('re-upgrading restores the domain without re-typing it',
    (await raw('/api/public/tls-check?domain=status.acme.example')).status === 200);
  chk('…and the whitelabel choice', !(await raw('/status')).text.includes('Powered by OpsCat'));

  // ── unpublished pages leak nothing ────────────────────────────────────────
  await patchPage(admin, MAIN, { published: false });
  chk('an unpublished page is a 404', (await raw('/status')).status === 404);
  chk('…and so is its logo', (await raw('/status/logo')).status === 404);
  chk('…and its favicon', (await raw('/status/favicon')).status === 404);
  chk('…and its custom domain', (await onHost('status.acme.example', '/')).status === 404);
  await patchPage(admin, MAIN, { published: true });
  chk('republishing brings the logo back', (await raw('/status/logo')).status === 200);
  chk('…and the settings endpoint agrees about the publish state',
    (await call(admin, 'GET', '/api/admin/settings')).j.status_published === '1');

  // ── role gating ───────────────────────────────────────────────────────────
  const { addMembership } = require('./src/db');
  const { salt, hash } = hashPassword('lead-password-1');
  const leadId = newId();
  await q.prepare(`INSERT INTO users (id, org_id, email, name, role, is_super_admin, pass_salt, pass_hash,
      color, active, must_change_password, created_at)
    VALUES (?, ?, 'lead@e2e.test', 'lead', 'lead', 0, ?, ?, '#388bfd', 1, 0, ?)`)
    .run(leadId, DEFAULT_ORG_ID, salt, hash, now());
  await addMembership(leadId, DEFAULT_ORG_ID, 'lead');
  const leadSess = await login('lead@e2e.test', 'lead-password-1');
  chk('a lead may READ the pages (they are public anyway)',
    (await call(leadSess, 'GET', '/api/admin/status-pages')).status === 200);
  chk('…but may not upload', (await upload(leadSess, MAIN, 'logo', PNG)).status === 403);
  chk('…nor change the accent', (await patchPage(leadSess, MAIN, { accent: '#000000' })).status === 403);
  chk('…nor create a page',
    (await call(leadSess, 'POST', '/api/admin/status-pages', { name: 'Z', slug: 'zpage' })).status === 403);
  chk('…nor ask whether a slug is free (same surface as creating one)',
    (await call(leadSess, 'GET', '/api/admin/status-pages/slug-available?slug=x')).status === 403);
  chk('…nor claim a domain',
    (await call(leadSess, 'POST', `/api/admin/status-pages/${MAIN}/domain`, { domain: 'z.acme.example' })).status === 403);

  // ── removal ───────────────────────────────────────────────────────────────
  chk('an admin can remove the logo',
    (await call(admin, 'DELETE', `/api/admin/status-pages/${MAIN}/asset/logo`)).status === 200);
  chk('…the placeholder square returns', (await raw('/status')).text.includes('<span class="logo">'));
  chk('…and the favicon no longer falls back to a deleted logo',
    (await call(admin, 'DELETE', `/api/admin/status-pages/${MAIN}/asset/favicon`)).status === 200
    && (await raw('/status/favicon')).status === 404);
  chk('deleting a page takes its subscribers with it',
    (await call(admin, 'DELETE', `/api/admin/status-pages/${PARTNER}`)).status === 200
    && !await q.prepare('SELECT 1 FROM status_subscribers WHERE page_id = ?').get(PARTNER));

  // ── the subscriber allowance ──────────────────────────────────────────────
  // Free is 50 confirmed. Fill it, then prove a NEW address is turned away while
  // an already-pending one can still complete.
  const subs = require('./src/lib/subscribers');
  await setPlan('free');
  await call(admin, 'PATCH', '/api/admin/settings', { status_subscribers_enabled: '1' });
  await subs.subscribe(await defaultPage(), 'pending-before-full@e2e.test');
  chk('a pending subscriber exists before the limit is hit',
    !!await q.prepare('SELECT * FROM status_subscribers WHERE email = ?').get('pending-before-full@e2e.test'));

  const ins = q.prepare(`INSERT INTO status_subscribers (org_id, page_id, email, token_hash, confirmed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  // eslint-disable-next-line no-await-in-loop
  for (let i = 0; i < 50; i++) await ins.run(DEFAULT_ORG_ID, MAIN, `filler${i}@e2e.test`, `hash${i}`, now(), now());
  chk('the org now sits at its free allowance',
    (await q.prepare('SELECT COUNT(*) c FROM status_subscribers WHERE org_id = ? AND confirmed_at IS NOT NULL')
      .get(DEFAULT_ORG_ID)).c >= 50);
  await subs.subscribe(await defaultPage(), 'too-late@e2e.test');
  chk('a NEW address is turned away once the plan is full',
    !await q.prepare('SELECT 1 FROM status_subscribers WHERE email = ?').get('too-late@e2e.test'));
  chk('…and the public answer stays uniform (no enumeration signal)',
    (await (await fetch(`${BASE}/api/status/subscribe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'also-too-late@e2e.test' }),
    })).json()).ok === true);
  await setPlan('business');
  await subs.subscribe(await defaultPage(), 'after-upgrade@e2e.test');
  chk('upgrading opens sign-ups again',
    !!await q.prepare('SELECT 1 FROM status_subscribers WHERE email = ?').get('after-upgrade@e2e.test'));

  // ── the OTHER server-rendered public pages still render ───────────────────
  // Added after a real production 500: pulling the status page out of
  // routes/public.js took the shared `esc()` helper with it, and the vendor grid
  // — which used it too and had no test of any kind — started throwing on every
  // request to radar.opscat.io. Nothing else in this repo renders that page, so
  // these two lines are the whole safety net for it.
  const { setSetting } = require('./src/db');
  await setSetting('vendor_grid_published', '1');
  // A vendor ROW is what makes the check real: the grid's per-vendor template is
  // where esc() is called, so an empty grid renders fine with esc undefined and
  // the check passes while testing nothing. (Verified by breaking esc on
  // purpose: empty grid = green, seeded grid = 500.)
  await q.prepare(`INSERT INTO vendors (org_id, slug, name, feed_type, feed_url, page_url, status, enabled, created_at)
    VALUES (?, 'github', 'GitHub', 'statuspage', 'https://x.example/api/v2/summary.json',
            'https://x.example', 'operational', 1, ?)`).run(DEFAULT_ORG_ID, now());
  const grid = await raw('/vendor-grid');
  chk('the vendor grid renders (it shares helpers with the status page)',
    grid.status === 200, `HTTP ${grid.status}`);
  chk('…and actually produced HTML, not an error body',
    grid.text.includes('</html>'), grid.text.slice(0, 120));
  chk('the grid JSON renders too', (await raw('/api/public/vendor-grid')).status === 200);
  await setSetting('vendor_grid_published', '0');

  // ── wrap up ───────────────────────────────────────────────────────────────
  report();
}

main().catch(die);
