'use strict';
/* End-to-end check for the incident primitives (docs/INCIDENTS-V2.md slice 1).
 *
 * Hermetic: throwaway database, no network — the one alert channel exercised is
 * `webhook`, pointed at a local stub server, so the synthetic lifecycle events
 * (`incident_created` / `incident_status_changed` / `incident_resolved`) are
 * proven to ride the REAL alert dispatch path without a provider.
 *
 * What it guards, in order:
 *   - migration v15 (assignee_id, incident_components, incident_links,
 *     component_owners) and the shared status scale (ONE ordering);
 *   - declare v2: components with impact, assignee, the timeline entries;
 *   - the derivation rule: component status IS the worst impact across open
 *     incidents — worst-wins with two incidents, back to operational on the
 *     last resolve, and a manual status is recomputed away on the next
 *     incident transition (the "resolved but page still red" failure mode);
 *   - lifecycle events through alert rules: name + severity_min matching, the
 *     notification log, and that NO pipeline event/case is created for them;
 *   - promote: case → incident with links, prefill, case note, idempotency,
 *     and the role gate;
 *   - component owners: set/clear/validate (feeds auto-assign later).
 *
 *   cd server && node e2e-incidents.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { chk, until, report, onExit, die } = require('./e2e-lib').harness();

// Environment BEFORE any src/ require — db.js and config.js are singletons.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opscat-incidents-'));
process.env.OPSCAT_DATA_DIR = tmp;
onExit(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.OPSCAT_SECRET = 'e2e-incidents-secret';
process.env.PORT = '3121';
process.env.OPSCAT_EDITION = 'community';
// The one alert channel this harness exercises points at a local stub, and
// lib/ssrf.js refuses private addresses for outbound webhooks. This is the
// edition-gated escape hatch (CE only, ignored in cloud) — without it the
// lifecycle-event assertions fail with "target resolves to a private address",
// which is the guard working, not the feature breaking.
process.env.OPSCAT_ALLOW_PRIVATE_TARGETS = '1';
process.env.OPSCAT_BASE_URL = 'https://ops.e2e.test';
process.env.OPSCAT_ADMIN_EMAIL = 'seed-admin@e2e.test';
process.env.OPSCAT_ADMIN_PASSWORD = 'seed-admin-password-1';

// --- webhook stub: records every alert delivery the rules fan out ------------
const HOOKS = [];
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    try { HOOKS.push(JSON.parse(body)); } catch { HOOKS.push({ raw: body }); }
    res.writeHead(200); res.end('ok');
  });
});

require('./src/index.js'); // boots the app on :3121

const { db, addMembership } = require('./src/db');
const { hashPassword, now, newId, DEFAULT_ORG_ID } = require('./src/util');
const scale = require('./src/lib/status-scale');

const BASE = 'http://127.0.0.1:3121';
const PASS = 'e2e-user-password-1';

function mkUser(email, role, orgId = DEFAULT_ORG_ID) {
  const { salt, hash } = hashPassword(PASS);
  const uid = newId();
  db.prepare(`INSERT INTO users (id, org_id, email, name, role, is_super_admin, pass_salt, pass_hash,
      color, active, must_change_password, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, '#388bfd', 1, 0, ?)`)
    .run(uid, orgId, email, email.split('@')[0], role, salt, hash, now());
  addMembership(uid, orgId, role);
  return { id: uid, email };
}

async function login(email, password = PASS) {
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (r.status === 429) { await new Promise((res) => setTimeout(res, 1000)); continue; }
    let j = null;
    try { j = await r.json(); } catch { /* non-JSON */ }
    return { cookie: (r.headers.get('set-cookie') || '').split(';')[0], csrf: j && j.csrf,
      user: j && j.user, status: r.status };
  }
  throw new Error(`login for ${email} stayed rate-limited — the harness cannot continue`);
}

async function call(sess, method, p, body) {
  const headers = { cookie: sess.cookie };
  if (method !== 'GET') { headers['X-OpsCat-CSRF'] = sess.csrf; headers['Content-Type'] = 'application/json'; }
  const r = await fetch(BASE + p, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let j = null;
  try { j = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, j };
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch { /* not yet */ }
    await new Promise((res) => setTimeout(res, 100));
  }
  return false;
}

// Alert dispatch is fire-and-forget from the mutation's point of view, and
// deliveries from DIFFERENT mutations can interleave — so never assert on
// counts of the global list: scope by device (the INC label) and wait for the
// condition itself (or time out and let the check fail).
const hooksFor = (label) => HOOKS.filter((h) => h.device === label);

const compStatus = (id) => db.prepare('SELECT status FROM components WHERE id = ?').get(id).status;

async function main() {
  await new Promise((res) => stub.listen(0, '127.0.0.1', res));
  const STUB_URL = `http://127.0.0.1:${stub.address().port}/hook`;

  chk('server boots and answers /api/health', await waitForServer());

  // ── migration ─────────────────────────────────────────────────────────────
  chk('user_version is at least 15', db.pragma('user_version', { simple: true }) >= 15);
  const incCols = db.pragma('table_info(incidents)').map((c) => c.name);
  chk('incidents carries assignee_id', incCols.includes('assignee_id'), incCols.join(','));
  for (const t of ['incident_components', 'incident_links', 'component_owners']) {
    chk(`table ${t} exists`, db.pragma(`table_info(${t})`).length > 0);
  }

  // ── the shared scale (ONE ordering) ───────────────────────────────────────
  chk('worst() picks major over degraded/partial', scale.worst(['degraded', 'major', 'partial']) === 'major');
  chk('worst() of nothing is operational', scale.worst([]) === 'operational');
  chk('maintenance ranks below every impact', scale.RANK.maintenance < scale.RANK.degraded);
  chk('impact levels are a subset of the scale', scale.IMPACTS.every((i) => i in scale.RANK));
  chk('rankCaseSql names every scale value', scale.ORDER.every((s) => scale.rankCaseSql('x').includes(`'${s}'`)));

  // ── setup: users, components, owner ───────────────────────────────────────
  const admin = await login('seed-admin@e2e.test', 'seed-admin-password-1');
  chk('seeded admin can sign in', admin.status === 200 && admin.user.role === 'admin', String(admin.status));
  mkUser('lead@e2e.test', 'lead');
  const analystU = mkUser('analyst@e2e.test', 'analyst');
  const lead = await login('lead@e2e.test');
  const analyst = await login('analyst@e2e.test');

  const cA = (await call(admin, 'POST', '/api/admin/components', { name: 'API Gateway', group: 'Core' })).j.id;
  const cB = (await call(admin, 'POST', '/api/admin/components', { name: 'Dashboard', group: 'Core' })).j.id;

  const own = await call(admin, 'PATCH', `/api/admin/components/${cA}`, { ownerId: analystU.id });
  chk('component owner can be set', own.status === 200, JSON.stringify(own.j));
  let comps = (await call(admin, 'GET', '/api/admin/components')).j;
  chk('components GET reports the owner', comps.find((c) => c.id === cA).ownerId === analystU.id);
  const badOwn = await call(admin, 'PATCH', `/api/admin/components/${cA}`, { ownerId: 99999 });
  chk('an owner outside the org is refused', badOwn.status === 400, String(badOwn.status));
  const clrOwn = await call(admin, 'PATCH', `/api/admin/components/${cA}`, { ownerId: null });
  chk('component owner can be cleared', clrOwn.status === 200
    && (await call(admin, 'GET', '/api/admin/components')).j.find((c) => c.id === cA).ownerId === null);

  // ── alert rules for the lifecycle events ──────────────────────────────────
  await call(lead, 'POST', '/api/rules', { name: 'any incident event', channel: 'webhook',
    triggerName: '', severityMin: 0, cooldownM: 1, recipients: [STUB_URL] });
  await call(lead, 'POST', '/api/rules', { name: 'resolve only', channel: 'webhook',
    triggerName: 'incident_resolved', severityMin: 0, cooldownM: 1, recipients: [STUB_URL] });
  await call(lead, 'POST', '/api/rules', { name: 'too high', channel: 'webhook',
    triggerName: '', severityMin: 90, cooldownM: 1, recipients: [STUB_URL] });

  // ── declare v2 ────────────────────────────────────────────────────────────
  const dec = await call(lead, 'POST', '/api/incidents', {
    title: 'API errors spiking', severity: 70, message: 'Looking into it.',
    assigneeId: analystU.id,
    components: [{ id: cA, impact: 'degraded' }, { id: cB, impact: 'major' }],
  });
  chk('declare v2 answers 200', dec.status === 200, JSON.stringify(dec.j));
  const inc1 = dec.j;
  chk('incident label is INC-2xxx', /^INC-2\d+$/.test(inc1.label), inc1.label);
  chk('view carries both components with names',
    inc1.components.length === 2 && inc1.components.every((c) => c.name), JSON.stringify(inc1.components));
  chk('view carries the assignee name', inc1.assignee === 'analyst', String(inc1.assignee));
  chk('timeline records the assignment', inc1.updates.some((u) => /Assigned to analyst/.test(u.message)));

  chk('derivation: component A is degraded', compStatus(cA) === 'degraded', compStatus(cA));
  chk('derivation: component B is major', compStatus(cB) === 'major', compStatus(cB));

  const badComp = await call(lead, 'POST', '/api/incidents',
    { title: 'x', components: [{ id: 99999, impact: 'major' }] });
  chk('a component outside the org is refused', badComp.status === 400, String(badComp.status));
  const badImpact = await call(lead, 'POST', '/api/incidents',
    { title: 'x', components: [{ id: cA, impact: 'partial_outage' }] });
  chk('a non-scale impact spelling is refused', badImpact.status === 400, String(badImpact.status));

  // ── lifecycle events rode the rules (and only the matching ones) ──────────
  chk('incident_created reached the catch-all webhook rule',
    await until(() => hooksFor(inc1.label).some((h) => h.event === 'incident_created')),
    JSON.stringify(HOOKS));
  chk('the resolve-only rule did not fire on create',
    !hooksFor(inc1.label).some((h) => h.event !== 'incident_created'));
  const notif = db.prepare(`SELECT * FROM notifications WHERE rule_name = 'any incident event'
    ORDER BY ts DESC LIMIT 1`).get();
  chk('the notification log attributes the delivery to the incident',
    notif && notif.ok === 1 && notif.case_label === inc1.label, JSON.stringify(notif));
  chk('severity_min still gates synthetic events',
    !db.prepare(`SELECT 1 FROM notifications WHERE rule_name = 'too high' LIMIT 1`).get());
  chk('no pipeline event was created for the lifecycle', // alert-rule-only, per AUTOMATION-V1 §4.5
    !db.prepare(`SELECT 1 FROM events WHERE name LIKE 'incident_%' LIMIT 1`).get());

  // ── worst-wins with a second incident ─────────────────────────────────────
  const dec2 = await call(lead, 'POST', '/api/incidents', {
    title: 'Gateway hard down', severity: 90, components: [{ id: cA, impact: 'major' }],
  });
  const inc2 = dec2.j;
  chk('worst-wins: A escalates to major under a second incident', compStatus(cA) === 'major', compStatus(cA));

  const res2 = await call(lead, 'POST', `/api/incidents/${inc2.id}/status`,
    { status: 'resolved', message: 'fixed' });
  chk('resolve answers with resolvedAt set', res2.status === 200 && res2.j.resolvedAt !== null);
  chk('worst-wins: A falls back to the still-open degraded', compStatus(cA) === 'degraded', compStatus(cA));

  // ── manual override is recomputed away on the next transition ─────────────
  await call(admin, 'PATCH', `/api/admin/components/${cA}`, { status: 'operational' });
  chk('manual override sticks until a transition', compStatus(cA) === 'operational');
  await call(lead, 'POST', `/api/incidents/${inc1.id}/status`, { status: 'identified' });
  chk('next incident transition recomputes the manual override away',
    compStatus(cA) === 'degraded', compStatus(cA));

  // ── resolve the last incident → everything operational ────────────────────
  await call(lead, 'POST', `/api/incidents/${inc1.id}/status`, { status: 'resolved' });
  chk('last resolve returns A to operational', compStatus(cA) === 'operational', compStatus(cA));
  chk('last resolve returns B to operational', compStatus(cB) === 'operational', compStatus(cB));
  // catch-all gets status_changed + resolved; resolve-only adds a second
  // resolved delivery — so ≥2 resolved hooks for this incident, plus the
  // status_changed, prove both emits and the trigger filter at once.
  chk('resolve fired status_changed AND resolved through the rules',
    await until(() => hooksFor(inc1.label).some((h) => h.event === 'incident_status_changed')
      && hooksFor(inc1.label).filter((h) => h.event === 'incident_resolved').length >= 2),
    JSON.stringify(hooksFor(inc1.label).map((h) => h.event)));
  chk('a resolved delivery names the incident in its description',
    hooksFor(inc1.label).some((h) => h.event === 'incident_resolved'
      && String(h.description).includes(inc1.label)));

  // ── assignee ──────────────────────────────────────────────────────────────
  const unas = await call(lead, 'PATCH', `/api/incidents/${inc1.id}`, { assigneeId: null });
  chk('unassign lands in the timeline', unas.status === 200
    && unas.j.updates.some((u) => u.message === 'Unassigned.'), JSON.stringify(unas.j.updates));
  const badAs = await call(lead, 'PATCH', `/api/incidents/${inc1.id}`, { assigneeId: 99999 });
  chk('an assignee outside the org is refused', badAs.status === 400, String(badAs.status));
  const roAs = await call(analyst, 'PATCH', `/api/incidents/${inc1.id}`, { assigneeId: analystU.id });
  chk('an analyst cannot mutate incidents', roAs.status === 403, String(roAs.status));

  // ── promote: case → incident ──────────────────────────────────────────────
  const pipeline = require('./src/engine/pipeline');
  pipeline.ingestEvent({ name: 'ddos', device: 'edge-01', severity: 85,
    description: 'volumetric attack' }, 'e2e', false, DEFAULT_ORG_ID);
  const kase = db.prepare('SELECT * FROM cases WHERE org_id = ? ORDER BY id DESC LIMIT 1').get(DEFAULT_ORG_ID);
  chk('a high-severity event opened a case to promote', !!kase, 'no case row');

  const roProm = await call(analyst, 'POST', `/api/cases/${kase.id}/promote`, {});
  chk('an analyst cannot promote', roProm.status === 403, String(roProm.status));

  const prom = await call(lead, 'POST', `/api/cases/${kase.id}/promote`, {});
  chk('promote answers 200', prom.status === 200 && prom.j.already === false, JSON.stringify(prom.j));
  const pInc = prom.j.incident;
  chk('promote prefills title from the case', pInc.title === 'ddos on edge-01', pInc.title);
  chk('promote prefills severity from the case', pInc.severity === kase.severity);
  chk('promote links the case AND its event',
    pInc.links.some((l) => l.kind === 'case' && l.refId === kase.id)
    && pInc.links.some((l) => l.kind === 'event' && l.refId === kase.event_id), JSON.stringify(pInc.links));
  chk('promote assigns the promoter by default', pInc.assignee === 'lead', String(pInc.assignee));
  chk('the case note records the promotion',
    /promoted to INC-/.test(db.prepare('SELECT note FROM cases WHERE id = ?').get(kase.id).note || ''));
  chk('the incident timeline names the case',
    pInc.updates.some((u) => u.message.includes(`C-${1000 + kase.id}`)));

  const again = await call(lead, 'POST', `/api/cases/${kase.id}/promote`, {});
  chk('a second promote returns the open incident instead of a twin',
    again.status === 200 && again.j.already === true && again.j.incident.id === pInc.id,
    JSON.stringify(again.j));
  const cases = (await call(lead, 'GET', '/api/cases')).j;
  chk('the case list carries the incident badge',
    cases.find((c) => c.id === kase.id).incident?.label === pInc.label);
  const noCase = await call(lead, 'POST', '/api/cases/99999/promote', {});
  chk('promoting a missing case is a 404', noCase.status === 404, String(noCase.status));

  // ── public page shows the derived status ──────────────────────────────────
  await call(admin, 'PATCH', '/api/admin/settings', { status_published: '1' });
  await call(lead, 'PATCH', `/api/incidents/${pInc.id}`,
    { components: [{ id: cB, impact: 'partial' }] });
  const html = await (await fetch(`${BASE}/status`)).text();
  chk('public status page renders the derived label', html.includes('Partial Outage'), 'label missing');

  // ── wrap up ───────────────────────────────────────────────────────────────
  stub.close();
  report();
}

main().catch(die);
