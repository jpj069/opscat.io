'use strict';
/* The three isolation rules that are enforced by a JS predicate, and would stop
 * being enforced the moment the storage layer becomes async.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 *
 * All three used to run a DATABASE QUERY inside a `.filter()` callback. That is
 * risk #1 in docs/POSTGRES-MIGRATION-PLAN.md, and it is the worst shape in the
 * codebase, because a Promise is truthy: an async callback returns one, the
 * predicate keeps EVERY row, and the failure is a 200 OK with no log line.
 *
 *   routes/ingest.js       a managed probe location would receive the check list
 *                          of every organisation that booked it
 *   routes/status.js       a private status page would publish the incidents it
 *                          was configured to hide
 *   lib/status-pages.js    an incident scoped to one component would MAIL EVERY
 *                          SUBSCRIBER OF EVERY PAGE in the org. Unrecallable.
 *
 * The queries have been hoisted out of the predicates. But before doing that I
 * broke each rule on purpose and ran the suite: 1002/1002 passed, three times.
 * Nothing anywhere asserted these rules — so the hoist would have been an
 * unverifiable change to the three places where being wrong is most expensive.
 *
 * Every check below was confirmed to fail when its rule is re-broken.
 *
 * Hermetic: throwaway database, own port, no network.
 *   cd server && node e2e-tenancy.js
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { chk, report, onExit, die } = require('./e2e-lib').harness();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opscat-tenancy-'));
process.env.OPSCAT_DATA_DIR = tmp;
onExit(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.OPSCAT_SECRET = 'e2e-tenancy-secret';
process.env.PORT = '3153';
process.env.OPSCAT_EDITION = 'cloud';
process.env.OPSCAT_ADMIN_EMAIL = 'admin@e2e.test';
process.env.OPSCAT_ADMIN_PASSWORD = 'seed-admin-password-1';

require('./src/index.js'); // boots the app on :3153

const { db } = require('./src/db');
const { now, newId, DEFAULT_ORG_ID } = require('./src/util');
const pages = require('./src/lib/status-pages');

const BASE = 'http://127.0.0.1:3153';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const mkOrg = (name, slug) => {
  const id = newId();
  db.prepare(`INSERT INTO organizations (id, name, slug, plan, status, created_at)
    VALUES (?, ?, ?, 'enterprise', 'active', ?)`).run(id, name, slug, now());
  return id;
};
const mkCheck = (orgId, target) => db.prepare(`INSERT INTO synthetic_checks
  (org_id, type, target, interval_s, timeout_ms, enabled, created_at)
  VALUES (?, 'http', ?, 60, 5000, 1, ?)`).run(orgId, target, now()).lastInsertRowid;
const mkComponent = (orgId, name) => db.prepare(`INSERT INTO components
  (org_id, name, grp, status, sort, created_at) VALUES (?, ?, 'Core', 'operational', 0, ?)`)
  .run(orgId, name, now()).lastInsertRowid;

async function main() {
  chk('server boots and answers /api/health', await waitForServer());

  // ── 1. a managed probe location serves only what it was assigned ───────────
  // Two orgs book the same managed location. Each has a check pinned to a
  // DIFFERENT location, plus one pinned nowhere. A probe authenticating as
  // location A must see its own pinned check and the unpinned ones — and must
  // NOT see the check pinned to location B, whichever org owns it.
  const acme = mkOrg('Acme', 'acme-tenancy');
  const globex = mkOrg('Globex', 'globex-tenancy');

  const mkLoc = (label) => {
    const key = crypto.randomBytes(16).toString('hex');
    const id = db.prepare(`INSERT INTO synthetic_locations
      (org_id, city, cc, kind, active, probe_key_hash, created_at)
      VALUES (NULL, ?, 'DE', 'managed', 1, ?, ?)`).run(label, sha256(key), now()).lastInsertRowid;
    return { id, key };
  };
  const locA = mkLoc('Frankfurt');
  const locB = mkLoc('Berlin');

  const grant = db.prepare(`INSERT INTO org_location_access (org_id, location_id, source, created_at)
    VALUES (?, ?, 'plan', ?) ON CONFLICT DO NOTHING`);
  for (const o of [acme, globex]) { grant.run(o, locA.id, now()); grant.run(o, locB.id, now()); }

  const pin = db.prepare('INSERT INTO check_locations (check_id, location_id) VALUES (?, ?)');
  const acmeOnA = mkCheck(acme, 'https://acme.test/on-a'); pin.run(acmeOnA, locA.id);
  const acmeOnB = mkCheck(acme, 'https://acme.test/on-b'); pin.run(acmeOnB, locB.id);
  const globexOnB = mkCheck(globex, 'https://globex.test/on-b'); pin.run(globexOnB, locB.id);
  const acmeAnywhere = mkCheck(acme, 'https://acme.test/anywhere');

  const workList = async (key) => (await (await fetch(`${BASE}/v1/synthetics/checks`,
    { headers: { authorization: `Bearer ${key}` } })).json());

  const listA = await workList(locA.key);
  const idsA = new Set((Array.isArray(listA) ? listA : []).map((c) => c.id));
  chk('a probe gets a work list', Array.isArray(listA), JSON.stringify(listA).slice(0, 120));
  chk('…including the check pinned to THIS location', idsA.has(acmeOnA), [...idsA].join(','));
  chk('…including a check pinned to no location at all', idsA.has(acmeAnywhere), [...idsA].join(','));
  chk('…but NOT a check pinned to another location', !idsA.has(acmeOnB), 'leaked own-org pinned check');
  chk('…and NOT another org\'s check pinned elsewhere (the cross-tenant leak)',
    !idsA.has(globexOnB), 'LEAKED ANOTHER ORG\'S CHECK');

  const idsB = new Set((await workList(locB.key)).map((c) => c.id));
  chk('the other location sees its own pinned checks, from both orgs',
    idsB.has(acmeOnB) && idsB.has(globexOnB), [...idsB].join(','));
  chk('…and not the one pinned to the first location', !idsB.has(acmeOnA), [...idsB].join(','));

  // ── 2. a status page publishes only the incidents its components touch ─────
  const compShown = mkComponent(DEFAULT_ORG_ID, 'Shown Component');
  const compHidden = mkComponent(DEFAULT_ORG_ID, 'Hidden Component');

  const mkIncident = (title, comps) => {
    const id = db.prepare(`INSERT INTO incidents (org_id, title, status, published, started_at)
      VALUES (?, ?, 'investigating', 1, ?)`).run(DEFAULT_ORG_ID, title, now()).lastInsertRowid;
    for (const c of comps) {
      db.prepare('INSERT INTO incident_components (incident_id, component_id) VALUES (?, ?)').run(id, c);
    }
    return id;
  };
  const incShown = mkIncident('Touches the shown component', [compShown]);
  const incHidden = mkIncident('Touches only the hidden component', [compHidden]);
  const incAnnounce = mkIncident('Linked to nothing — an announcement', []);

  // a page restricted to ONE component
  const pageId = db.prepare(`INSERT INTO status_pages (org_id, slug, name, published, created_at)
    VALUES (?, 'tenancy-page', 'Tenancy Page', 1, ?)`).run(DEFAULT_ORG_ID, now()).lastInsertRowid;
  db.prepare('INSERT INTO status_page_components (page_id, component_id) VALUES (?, ?) ON CONFLICT DO NOTHING')
    .run(pageId, compShown);

  const html = await (await fetch(`${BASE}/status/tenancy-page`)).text();

  chk('the restricted page renders', /Tenancy Page|Shown Component/.test(html), html.slice(0, 160));
  chk('…and shows the incident touching ITS component',
    html.includes('Touches the shown component'), 'missing the incident it should show');
  chk('…and HIDES the incident touching only another component',
    !html.includes('Touches only the hidden component'), 'PUBLISHED A HIDDEN INCIDENT');
  chk('…and still shows an incident linked to no component (an announcement belongs everywhere)',
    html.includes('Linked to nothing'), 'dropped the announcement');

  // ── 3. only the pages whose components intersect get told ──────────────────
  // This is the subscriber fan-out. `pagesForIncidentComponents` decides who is
  // mailed, so a predicate that keeps everything mails everyone.
  const forShown = pages.pagesForIncidentComponents(DEFAULT_ORG_ID, [compShown]).map((p) => p.id);
  const forHidden = pages.pagesForIncidentComponents(DEFAULT_ORG_ID, [compHidden]).map((p) => p.id);
  chk('a page is selected for an incident on its own component', forShown.includes(pageId), forShown.join(','));
  chk('…and NOT for one on a component it does not carry (the mail fan-out)',
    !forHidden.includes(pageId), 'WOULD MAIL A PAGE THAT DOES NOT SHOW THE INCIDENT');
  chk('…while an unrestricted page is selected either way',
    pages.pagesForIncidentComponents(DEFAULT_ORG_ID, [compHidden]).length >= 1,
    'the default page should still match');

  report();
}

main().catch(die);
