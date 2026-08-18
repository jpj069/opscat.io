'use strict';
/* End-to-end check for On-Call slice 2 — the alert chain (docs/ONCALL-V1.md).
 *
 * Hermetic: throwaway database, no mail, and the one delivery channel exercised
 * (`ntfy`) points at a local stub — so the ladder is proven to ride the REAL
 * delivery path, with the real SSRF guard, without a provider. That is why
 * OPSCAT_ALLOW_PRIVATE_TARGETS=1 is set below: the guard refuses loopback by
 * design, and a harness posting to a stub has to say so explicitly. If this file
 * ever fails with "target resolves to a private address", the guard is working
 * and the flag was dropped.
 *
 * The slice's bar is three sentences (§11), and they are the three headline
 * checks here:
 *
 *   1. **An alert survives a process restart.** Nothing lives in setTimeout. The
 *      restart check spawns a SECOND process against the same database and
 *      asserts that its boot sweep advanced an escalation whose timer fell due
 *      while nothing was running.
 *   2. **It escalates exactly once per step.** Steps advance on their own timer,
 *      resolve their targets LATE, and a repeat pass starts again at rung one
 *      until `repeat_n` is spent — then `alert_exhausted`, once.
 *   3. **It cancels when its subject closes.** Through every door: the case
 *      PATCH, the event `finish` action, and an incident resolving. That is what
 *      `lib/cases.js` and `lib/incidents.js` exist for.
 *
 * Time is driven, never waited on: `chain.sweep(at)` takes the instant to
 * evaluate, so a 5-minute step is tested in a millisecond and the test cannot
 * become flaky by being slow.
 *
 *   cd server && node e2e-alerts.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

/* The shared helpers, not a private copy of `chk`.
 *
 * This file had its own one-liner, which records a PASS for anything truthy —
 * and a Promise is truthy. With the fixtures on the async shim that is no longer
 * a hypothetical: every assertion below reads a row, and one missed `await`
 * would have turned its check permanently green. `e2e-lib`'s chk throws on a
 * thenable instead, which is the only outcome that cannot be mistaken for a
 * pass.
 */
const { chk, report, die } = require('./e2e-lib').harness();

// Environment BEFORE any src/ require — db.js and config.js are singletons.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opscat-alerts-'));
process.env.OPSCAT_DATA_DIR = tmp;
process.env.OPSCAT_SECRET = 'e2e-alerts-secret';
process.env.PORT = '3141';
process.env.OPSCAT_EDITION = 'community';
process.env.OPSCAT_BASE_URL = 'http://127.0.0.1:3141';
process.env.OPSCAT_ADMIN_EMAIL = 'seed-admin@e2e.test';
process.env.OPSCAT_ADMIN_PASSWORD = 'seed-admin-password-1';
process.env.OPSCAT_ALLOW_PRIVATE_TARGETS = '1';   // the ntfy stub is on loopback
// Hermetic means hermetic. A developer machine (and the deploy host) may well
// have RESEND_API_KEY exported, and the e-mail FALLBACK below would then send
// real mail from a test run — which it did, on the first attempt at this file:
// the checks failed not because the code was wrong but because a network round
// trip to Resend outlived the assertion. Cleared here, so "no mail transport
// configured" is the deterministic, instant answer.
delete process.env.RESEND_API_KEY;
delete process.env.SMTP_HOST;

require('./src/index.js');

const { addMembership, schemaVersion } = require('./src/db');
// Fixtures and read-back go through the SHIM, so they land in the database
// `run-e2e.js` handed this process in DATABASE_URL — the same one the code under
// test reads. A connection the harness opened for itself would be a different
// session, and a fixture written there surfaces as a foreign-key violation
// several calls later, pointing at the wrong thing entirely.
const q = require('./src/db/shim');
const { hashPassword, now, newId, DEFAULT_ORG_ID } = require('./src/util');
const chain = require('./src/engine/alert-chain');
const pipeline = require('./src/engine/pipeline');

const BASE = 'http://127.0.0.1:3141';
const STUB = 'http://127.0.0.1:3142';
const PASS = 'e2e-user-password-1';
const MIN = 60000;

// ---- the delivery stub ------------------------------------------------------
const delivered = [];
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    delivered.push({ url: req.url, title: req.headers.title || '', body });
    res.writeHead(req.url.startsWith('/fail') ? 500 : 200).end('ok');
  });
});

// ---- fixtures ---------------------------------------------------------------
async function mkOrg(name) {
  const id = newId();
  await q.prepare(`INSERT INTO organizations (id, name, slug, plan, status, created_at)
    VALUES (?, ?, ?, 'enterprise', 'active', ?)`).run(id, name, name.toLowerCase(), now());
  return id;
}
async function mkUser(email, role, orgId = DEFAULT_ORG_ID) {
  const { salt, hash } = hashPassword(PASS);
  const uid = newId();
  await q.prepare(`INSERT INTO users (id, org_id, email, name, role, is_super_admin, pass_salt, pass_hash,
      color, active, must_change_password, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, '#388bfd', 1, 0, ?)`)
    .run(uid, orgId, email, email.split('@')[0], role, salt, hash, now());
  await addMembership(uid, orgId, role);
  return { id: uid, email, name: email.split('@')[0] };
}
// `insert()` (RETURNING id), never lastInsertRowid — the shim refuses it, and
// node-postgres has no such field at all.
async function mkCase(severity = 85, orgId = DEFAULT_ORG_ID, name = 'disk_full') {
  return Number(await q.prepare(`INSERT INTO cases (org_id, event_id, name, device, severity, status, opened_at)
    VALUES (?, NULL, ?, 'core-01', ?, 'open', ?)`).insert(orgId, name, severity, now()));
}

async function login(email, password = PASS) {
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (r.status === 429) { await new Promise((res) => setTimeout(res, 1000)); continue; }
    let j = null; try { j = await r.json(); } catch { /* non-JSON */ }
    return { cookie: (r.headers.get('set-cookie') || '').split(';')[0], csrf: j && j.csrf, status: r.status };
  }
  throw new Error(`login for ${email} stayed rate-limited`);
}
async function call(sess, method, p, body) {
  const headers = { cookie: sess.cookie };
  if (method !== 'GET') { headers['X-OpsCat-CSRF'] = sess.csrf; headers['Content-Type'] = 'application/json'; }
  const r = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, j };
}
async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch { /* not yet */ }
    await new Promise((res) => setTimeout(res, 100));
  }
  return false;
}
const tick = () => new Promise((res) => setTimeout(res, 60));   // let a fire-and-forget send land

const alertRow = (id) => q.prepare('SELECT * FROM alerts WHERE id = ?').get(id);
const attemptsOf = (id) => q.prepare('SELECT * FROM alert_attempts WHERE alert_id = ? ORDER BY id').all(id);
const timersOf = (id) => q.prepare('SELECT * FROM alert_timers WHERE alert_id = ? AND canceled_at IS NULL').all(id);
const eventsNamed = (n) => q.prepare('SELECT * FROM events WHERE name = ? ORDER BY id').all(n);
const notifsFor = (id) => q.prepare('SELECT * FROM notifications WHERE alert_id = ? ORDER BY id').all(id);

/* Schema questions asked of whichever engine is underneath — see the same pair
 * in e2e-oncall.js. `PRAGMA` and `sqlite_master` are SQLite's; the portable form
 * of "does this exist" is a statement that NAMES the object, and the declared
 * type has an answer in `information_schema` on the other side.
 */
async function exists(sql) {
  try { await q.prepare(sql).all(); return true; } catch { return false; }
}
const tableExists = (t) => exists(`SELECT 1 FROM ${t} LIMIT 1`);
const columnExists = (t, c) => exists(`SELECT ${c} FROM ${t} LIMIT 1`);
async function colType(table, col) {
  const row = await q.prepare(`SELECT data_type FROM information_schema.columns
    WHERE table_name = ? AND column_name = ?`).get(table, col);
  return row ? row.data_type.toUpperCase() : null;
}
// A column that references users/organizations is `uuid`; BIGINT is the failure
// this guards against. TEXT is still accepted because `escalation_targets.ref_id`
// deliberately holds both a uuid and an integer id and must stay the wider type.
const UUIDISH = (t) => t === 'TEXT' || t === 'UUID';
const tokenFrom = (text) => (String(text).match(/\/a\/([0-9a-f]{64})/) || [])[1];

async function main() {
  await new Promise((res) => stub.listen(3142, '127.0.0.1', res));
  chk('server boots and answers /api/health', await waitForServer());

  // ---- migration ---------------------------------------------------------
  chk('migration reached version 24', await schemaVersion() >= 24);
  for (const t of ['escalation_policies', 'escalation_steps', 'escalation_targets',
    'contact_methods', 'notification_rules', 'alerts', 'alert_attempts', 'alert_tokens', 'alert_timers']) {
    // eslint-disable-next-line no-await-in-loop
    chk(`table ${t} exists`, await tableExists(t));
  }
  const alertOrg = await colType('alerts', 'org_id');
  chk('alerts.org_id is TEXT (uuid), not INTEGER', UUIDISH(alertOrg), alertOrg);
  const ackedBy = await colType('alerts', 'acked_by');
  chk('alerts.acked_by is TEXT (uuid)', UUIDISH(ackedBy), ackedBy);
  // One column holds a uuid (user) and an integer (schedule/team) — it has to be
  // the wider type, or every user target silently stops matching. TEXT exactly,
  // on both engines: `uuid` here would be the bug, not an equivalent spelling.
  const refId = await colType('escalation_targets', 'ref_id');
  chk('escalation_targets.ref_id is TEXT — it holds uuids AND integer ids', refId === 'TEXT', refId);
  chk('cases gained acked_at/acked_by', await columnExists('cases', 'acked_at')
    && await columnExists('cases', 'acked_by'));
  chk('notifications gained alert_id', await columnExists('notifications', 'alert_id'));
  // The DEFAULT is asked of the database rather than read out of its DDL: only
  // one engine has a PRAGMA, and both agree about what a row comes back as.
  const probeRule = await q.prepare(`INSERT INTO alert_rules (org_id, name, channel, enabled, created_at)
    VALUES (?, 'target_type default probe', 'email', 0, ?)`).insert(DEFAULT_ORG_ID, now());
  const probed = await q.prepare('SELECT target_type FROM alert_rules WHERE id = ?').get(probeRule);
  chk('alert_rules gained target_type defaulting to "channel"',
    probed.target_type === 'channel', probed.target_type);
  await q.prepare('DELETE FROM alert_rules WHERE id = ?').run(probeRule);

  // ---- users, schedule, policy -------------------------------------------
  const anna = await mkUser('anna@e2e.test', 'lead');
  const ben = await mkUser('ben@e2e.test', 'analyst');
  const cara = await mkUser('cara@e2e.test', 'analyst');
  const otherOrg = await mkOrg('Outsiders');
  const outsider = await mkUser('out@e2e.test', 'admin', otherOrg);

  const lead = await login(anna.email);
  const junior = await login(ben.email);
  const away = await login(outsider.email);
  chk('lead can sign in', lead.status === 200, `status ${lead.status}`);

  const sched = (await call(lead, 'POST', '/api/oncall/schedules',
    { name: 'Primary', timezone: 'UTC' })).j;
  await call(lead, 'PUT', `/api/oncall/schedules/${sched.id}/layers`, {
    layers: [{ rotation: 'weekly', handoffAt: now() - 86400000, participants: [anna.id] }],
  });
  chk('anna is on call on the schedule',
    (await call(lead, 'GET', '/api/oncall/now')).j.schedules[0].user.id === anna.id);

  // Two rungs: whoever is on call, then ben. One minute each, one repeat pass.
  const mkPolicy = async (body) => call(lead, 'POST', '/api/oncall/policies', body);
  const pol = (await mkPolicy({
    name: 'Standard', repeatN: 1, highMin: 80,
    steps: [
      { timeoutM: 5, targets: [{ kind: 'schedule', refId: String(sched.id) }] },
      { timeoutM: 5, targets: [{ kind: 'user', refId: ben.id }] },
    ],
  })).j;
  chk('policy created with two steps', pol.steps.length === 2);
  chk('policy step 0 targets the schedule by name',
    pol.steps[0].targets[0].label === 'Primary', JSON.stringify(pol.steps[0].targets));
  // The unit humans reason in: 2 steps x 5 min x 2 passes.
  chk('worst-case ring duration is computed, not counted by the reader',
    pol.worstCaseMinutes === 20, String(pol.worstCaseMinutes));

  const bad = await mkPolicy({ name: 'Foreign', steps: [{ timeoutM: 5,
    targets: [{ kind: 'user', refId: outsider.id }] }] });
  chk('a policy naming a user from another org is refused', bad.status === 400, `status ${bad.status}`);
  const junk = await mkPolicy({ name: 'Junk', steps: [{ timeoutM: 5, targets: [{ kind: 'nonsense', refId: '1' }] }] });
  chk('a target of unknown kind is refused', junk.status === 400);
  const asAnalyst = await call(junior, 'POST', '/api/oncall/policies', { name: 'Sneaky', steps: [] });
  chk('an analyst may not create a policy (configuration is lead+)', asAnalyst.status === 403,
    `status ${asAnalyst.status}`);

  // ---- contact methods ----------------------------------------------------
  const annaSess = lead;
  const m1 = await call(annaSess, 'POST', '/api/oncall/me/methods',
    { kind: 'ntfy', address: `${STUB}/anna`, label: 'phone' });
  chk('a contact method can be added', m1.status === 201, `status ${m1.status}`);
  // Slice 3 made sms storable. What must stay true is that it is never stored in
  // the CLEAR and never rung before it is verified — both are proven in detail by
  // e2e-loud.js; this is the boundary check that belongs beside the chain.
  const sms = await call(annaSess, 'POST', '/api/oncall/me/methods', { kind: 'sms', address: '+491700000000' });
  chk('an sms method can be added', sms.status === 201, `status ${sms.status}`);
  chk('...but the number is never in the clear',
    (await q.prepare("SELECT COUNT(*) c FROM contact_methods WHERE kind='sms' AND encrypted = 0").get()).c === 0);
  chk('...and it may not be rung until it is verified',
    (await require('./src/lib/contacts').usable(
      await q.prepare("SELECT * FROM contact_methods WHERE kind='sms'").get(), DEFAULT_ORG_ID)).ok === false);
  const badMail = await call(annaSess, 'POST', '/api/oncall/me/methods', { kind: 'email', address: 'not-an-address' });
  chk('a malformed e-mail address is refused', badMail.status === 400);

  const mine = (await call(annaSess, 'GET', '/api/oncall/me')).j;
  chk('my own methods come back WITH the address', mine.methods[0].address === `${STUB}/anna`);
  chk('the implicit e-mail fallback is stated, not hidden', mine.fallbackEmail === anna.email);
  const otherView = (await call(junior, 'GET', '/api/oncall/me')).j;
  chk('another person sees NONE of my contact methods', otherView.methods.length === 0,
    JSON.stringify(otherView.methods));

  const benM = await call(junior, 'POST', '/api/oncall/me/methods', { kind: 'ntfy', address: `${STUB}/ben` });
  chk('an analyst may configure their OWN contact methods (operation, not configuration)',
    benM.status === 201, `status ${benM.status}`);

  // ---- raise, notify, acknowledge ----------------------------------------
  delivered.length = 0;
  const caseA = await mkCase(85);
  const raised = await call(lead, 'POST', '/api/oncall/alerts',
    { subjectKind: 'case', subjectId: caseA, policyId: pol.id, message: 'the disk is full' });
  chk('an alert can be raised against a case', raised.status === 201, JSON.stringify(raised.j));
  const A = raised.j;
  chk('severity 85 against high_min 80 makes it HIGH urgency', A.urgency === 'high', A.urgency);
  chk('it starts at step 0, round 0', A.step === 0 && A.round === 0);
  chk('the person ON CALL was recorded as notified',
    A.attempts.length === 1 && A.attempts[0].user.id === anna.id, JSON.stringify(A.attempts));
  chk('the attempt records HOW she was reached', A.attempts[0].via === `schedule:${sched.id}`);
  chk('a step timer is armed', (await timersOf(A.id)).some((t) => t.kind === 'step'));

  await tick();
  chk('the message actually went out on her contact method', delivered.some((d) => d.url === '/anna'),
    JSON.stringify(delivered));
  const msg = delivered.find((d) => d.url === '/anna');
  chk('the delivery is recorded in the ONE notification log',
    (await notifsFor(A.id)).some((n) => n.ok === 1 && n.channel === 'ntfy'));
  chk('the message carries the case label', msg && msg.title.includes(`C-${1000 + caseA}`), msg && msg.title);
  const token = tokenFrom(msg && msg.body);
  chk('the message carries a single-use acknowledgement link', !!token);

  // A second raise for the same subject+policy must not ring anybody twice.
  const again = await call(lead, 'POST', '/api/oncall/alerts',
    { subjectKind: 'case', subjectId: caseA, policyId: pol.id });
  chk('raising the same alert twice returns the SAME alert', again.j.id === A.id);
  chk('and did not notify a second time', (await attemptsOf(A.id)).length === 1);

  // ---- the ack round trip -------------------------------------------------
  const getAck = await fetch(`${BASE}/a/${token}`);
  const ackHtml = await getAck.text();
  chk('GET /a/:token renders a confirmation screen', getAck.status === 200 && /<form/.test(ackHtml));
  // The whole reason the route is two-step: a mail scanner fetching every link
  // must not silence the alert before the human has looked at the phone.
  chk('...and a GET does NOT acknowledge — mail scanners fetch every link',
    (await alertRow(A.id)).status === 'active', (await alertRow(A.id)).status);

  const postAck = await fetch(`${BASE}/a/${token}`, { method: 'POST' });
  chk('POST /a/:token acknowledges', postAck.status === 200);
  const acked = await alertRow(A.id);
  chk('the alert is acked', acked.status === 'acked', acked.status);
  chk('it names WHO acknowledged', acked.acked_by === anna.id);
  chk('the escalation clock is dropped', (await timersOf(A.id)).length === 0);
  const caseAfter = await q.prepare('SELECT * FROM cases WHERE id = ?').get(caseA);
  chk('the ack is a fact on the CASE — this is what MTTA reads', !!caseAfter.acked_at);
  chk('acknowledging did NOT assign the case (§13.4)', caseAfter.assigned_user_id === null);

  const reuse = await fetch(`${BASE}/a/${token}`, { method: 'POST' });
  chk('the token is single use', reuse.status === 404, `status ${reuse.status}`);
  const forged = await fetch(`${BASE}/a/${'0'.repeat(64)}`, { method: 'POST' });
  chk('a forged token is refused', forged.status === 404);

  const ackTwice = await call(lead, 'POST', `/api/oncall/alerts/${A.id}/ack`);
  chk('an already-acked alert refuses a second ack with 409', ackTwice.status === 409, `status ${ackTwice.status}`);

  // ---- escalation ---------------------------------------------------------
  delivered.length = 0;
  const caseB = await mkCase(90);
  const B = (await call(lead, 'POST', '/api/oncall/alerts',
    { subjectKind: 'case', subjectId: caseB, policyId: pol.id })).j;
  await tick();
  chk('step 0 rings the on-call person', (await attemptsOf(B.id)).length === 1);

  await chain.sweep(now() + 4 * MIN);
  chk('a sweep BEFORE the timeout changes nothing', (await alertRow(B.id)).step_position === 0);

  await chain.sweep(now() + 6 * MIN);
  await tick();
  const b1 = await alertRow(B.id);
  chk('the step timeout escalates to rung two', b1.step_position === 1 && b1.round === 0,
    `step ${b1.step_position} round ${b1.round}`);
  const bAttempts = await attemptsOf(B.id);
  chk('rung two reaches the NEXT target, exactly once',
    bAttempts.length === 2 && bAttempts[1].user_id === ben.id);
  chk('and it went to ben\'s own contact method', delivered.some((d) => d.url === '/ben'));

  await chain.sweep(now() + 12 * MIN);
  await tick();
  const b2 = await alertRow(B.id);
  chk('the last rung of pass one starts pass TWO at rung one',
    b2.step_position === 0 && b2.round === 1, `step ${b2.step_position} round ${b2.round}`);

  await chain.sweep(now() + 18 * MIN);
  await chain.sweep(now() + 24 * MIN);
  await tick();
  const b3 = await alertRow(B.id);
  chk('with repeat_n spent, the policy is exhausted', b3.status === 'exhausted', b3.status);
  chk('exhausted is stamped with a reason', !!b3.ended_at && !!b3.end_reason);
  const exhausted = await eventsNamed('alert_exhausted');
  chk('"the policy reached nobody" is raised as an EVENT an org can route today',
    exhausted.length === 1, `${exhausted.length} events`);
  chk('the exhausted event is critical', exhausted[0] && exhausted[0].severity === 85);
  const bFinal = await attemptsOf(B.id);
  chk('every rung is in the attempt record', bFinal.length === 4,
    `${bFinal.length} attempts`);
  chk('an exhausted alert has no timers left', (await timersOf(B.id)).length === 0);

  // ---- cancellation, through every door -----------------------------------
  const caseC = await mkCase(90);
  const C = (await call(lead, 'POST', '/api/oncall/alerts',
    { subjectKind: 'case', subjectId: caseC, policyId: pol.id })).j;
  await call(lead, 'PATCH', `/api/cases/${caseC}`, { status: 'closed' });
  chk('closing the case through PATCH cancels the alert', (await alertRow(C.id)).status === 'canceled',
    (await alertRow(C.id)).status);
  chk('and drops its timers — nobody is woken about a problem that is over',
    (await timersOf(C.id)).length === 0);

  // The second door: finishing the EVENT, which closes the case underneath it.
  await pipeline.ingestEvent({ name: 'disk_full', device: 'core-02', target: null, severity: 90,
    description: 'disk full on core-02' }, 'e2e', false, DEFAULT_ORG_ID);
  const ev = await q.prepare("SELECT * FROM events WHERE device = 'core-02' ORDER BY id DESC LIMIT 1").get();
  const caseD = await q.prepare('SELECT * FROM cases WHERE event_id = ?').get(ev.id);
  chk('a severity-90 event opened a case', !!caseD);
  const D = (await call(lead, 'POST', '/api/oncall/alerts',
    { subjectKind: 'case', subjectId: caseD.id, policyId: pol.id })).j;
  await call(lead, 'POST', `/api/events/${ev.id}/action`, { action: 'finish' });
  chk('finishing the EVENT cancels the alert too (the other seven close sites)',
    (await alertRow(D.id)).status === 'canceled', (await alertRow(D.id)).status);

  // The third door: an incident resolving.
  const incId = Number(await q.prepare(`INSERT INTO incidents (org_id, title, severity, status, started_at, created_by)
    VALUES (?, 'Datacentre power', 90, 'investigating', ?, ?)`).insert(DEFAULT_ORG_ID, now(), anna.id));
  const E = (await call(lead, 'POST', '/api/oncall/alerts',
    { subjectKind: 'incident', subjectId: incId, policyId: pol.id })).j;
  chk('an alert may hang on an INCIDENT, not only a case (§13.5)', E && E.subjectKind === 'incident',
    JSON.stringify(E));
  await require('./src/lib/incidents').setStatus(DEFAULT_ORG_ID, anna.id, incId, 'resolved', 'power back');
  chk('resolving the incident cancels its alert', (await alertRow(E.id)).status === 'canceled');

  // An ACKNOWLEDGED alert whose subject then closes is resolved, not cancelled:
  // the escalation was already stopped, this is only the bookkeeping.
  const caseF = await mkCase(90);
  const F = (await call(lead, 'POST', '/api/oncall/alerts',
    { subjectKind: 'case', subjectId: caseF, policyId: pol.id })).j;
  await call(lead, 'POST', `/api/oncall/alerts/${F.id}/ack`);
  await call(lead, 'PATCH', `/api/cases/${caseF}`, { status: 'closed' });
  chk('an acknowledged alert whose case closes ends as RESOLVED, not canceled',
    (await alertRow(F.id)).status === 'resolved', (await alertRow(F.id)).status);

  // ---- acknowledging from the case ----------------------------------------
  const caseG = await mkCase(90);
  const G = (await call(lead, 'POST', '/api/oncall/alerts',
    { subjectKind: 'case', subjectId: caseG, policyId: pol.id })).j;
  const gAck = await call(junior, 'POST', `/api/cases/${caseG}/ack`);
  chk('an analyst may acknowledge — the alert reached them, so they can stop it',
    gAck.status === 200, `status ${gAck.status}`);
  chk('acknowledging the CASE acknowledges what is ringing about it',
    (await alertRow(G.id)).status === 'acked', (await alertRow(G.id)).status);
  const gAgain = await call(junior, 'POST', `/api/cases/${caseG}/ack`);
  chk('a second acknowledge on the same case answers 409', gAgain.status === 409, `status ${gAgain.status}`);

  // ---- urgency, hours, maintenance ----------------------------------------
  const lowPol = (await mkPolicy({
    name: 'Quiet', repeatN: 3, highMin: 95,
    steps: [{ timeoutM: 5, targets: [{ kind: 'schedule', refId: String(sched.id) }] }],
  })).j;
  const caseH = await mkCase(70);
  const H = (await call(lead, 'POST', '/api/oncall/alerts',
    { subjectKind: 'case', subjectId: caseH, policyId: lowPol.id })).j;
  chk('severity 70 under high_min 95 is a LOW-urgency alert', H.urgency === 'low', H.urgency);
  await chain.sweep(now() + 60 * MIN);
  const h = await alertRow(H.id);
  chk('a low-urgency alert notifies once and never escalates or repeats (§6)',
    h.status === 'active' && h.step_position === 0 && h.round === 0,
    `${h.status} step ${h.step_position} round ${h.round}`);
  chk('...and has no clock running at all', (await timersOf(H.id)).length === 0);

  // Support hours: a window that cannot contain now(), so LOW is held and HIGH goes.
  const nowMin = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  const shift = (m) => `${String(Math.floor(((nowMin + m) % 1440) / 60)).padStart(2, '0')}:${String(((nowMin + m) % 1440) % 60).padStart(2, '0')}`;
  const hoursPol = (await mkPolicy({
    name: 'Office hours', highMin: 80,
    hours: { days: [], from: shift(120), to: shift(240), tz: 'UTC' },
    steps: [{ timeoutM: 5, targets: [{ kind: 'schedule', refId: String(sched.id) }] }],
  })).j;
  const caseI = await mkCase(50);
  const outOfHours = await call(lead, 'POST', '/api/oncall/alerts',
    { subjectKind: 'case', subjectId: caseI, policyId: hoursPol.id });
  chk('outside support hours a LOW-urgency alert is not delivered',
    outOfHours.status === 202 && outOfHours.j.suppressed === 'hours', JSON.stringify(outOfHours.j));
  chk('...and the suppression is VISIBLE in the notification log, not silent',
    !!(await q.prepare("SELECT 1 x FROM notifications WHERE error LIKE '%outside support hours%'").get()));
  const caseJ = await mkCase(95);
  const high = await call(lead, 'POST', '/api/oncall/alerts',
    { subjectKind: 'case', subjectId: caseJ, policyId: hoursPol.id });
  chk('HIGH urgency goes out regardless of support hours', high.status === 201, JSON.stringify(high.j));

  const winId = await q.prepare(`INSERT INTO maintenance_windows (org_id, name, starts_at, ends_at, created_at)
    VALUES (?, 'Planned patching', ?, ?, ?)`).insert(DEFAULT_ORG_ID, now() - MIN, now() + 60 * MIN, now());
  const caseK = await mkCase(95);
  const held = await call(lead, 'POST', '/api/oncall/alerts',
    { subjectKind: 'case', subjectId: caseK, policyId: pol.id });
  chk('planned work holds EVERYTHING, high urgency included',
    held.status === 202 && held.j.suppressed === 'maintenance', JSON.stringify(held.j));
  chk('...with the same visible suppression line a channel rule writes',
    !!(await q.prepare("SELECT 1 x FROM notifications WHERE error LIKE '%maintenance window%'").get()));
  await q.prepare('DELETE FROM maintenance_windows WHERE id = ?').run(winId);

  // ---- a gap advances, it does not wait -----------------------------------
  const emptySched = (await call(lead, 'POST', '/api/oncall/schedules',
    { name: 'Nobody', timezone: 'UTC' })).j;
  const gapPol = (await mkPolicy({
    name: 'Gapped',
    steps: [
      { timeoutM: 30, targets: [{ kind: 'schedule', refId: String(emptySched.id) }] },
      { timeoutM: 30, targets: [{ kind: 'user', refId: ben.id }] },
    ],
  })).j;
  const caseL = await mkCase(90);
  const L = (await call(lead, 'POST', '/api/oncall/alerts',
    { subjectKind: 'case', subjectId: caseL, policyId: gapPol.id })).j;
  // The rule that matters: a rung nobody is on must not burn its 30-minute
  // timeout in silence, because silence is exactly what "not yet acknowledged"
  // looks like.
  chk('a step whose schedule resolves to NOBODY escalates immediately', L.step === 1, `step ${L.step}`);
  chk('...and it reached the next rung\'s target', (await attemptsOf(L.id)).some((a) => a.user_id === ben.id));
  chk('the gap itself is reported as an event', (await eventsNamed('oncall_gap')).length >= 1);
  chk('...and the reason is in the notification log',
    (await notifsFor(L.id)).some((n) => /escalating now/.test(n.error || '')));

  // ---- undeliverable ------------------------------------------------------
  const caraSess = await login(cara.email);
  await call(caraSess, 'POST', '/api/oncall/me/methods', { kind: 'ntfy', address: `${STUB}/fail-cara` });
  const deadPol = (await mkPolicy({
    name: 'Unreachable',
    steps: [{ timeoutM: 5, targets: [{ kind: 'user', refId: cara.id }] }],
  })).j;
  const caseM = await mkCase(90);
  const M = (await call(lead, 'POST', '/api/oncall/alerts',
    { subjectKind: 'case', subjectId: caseM, policyId: deadPol.id })).j;
  await tick(); await tick();
  const mNotifs = await notifsFor(M.id);
  chk('a channel that refuses is recorded as a FAILED delivery',
    mNotifs.some((n) => n.ok === 0 && /500/.test(n.error || '')), JSON.stringify(mNotifs));
  chk('a system that cannot reach anybody raises alert_undeliverable — it must not look like a quiet night',
    (await eventsNamed('alert_undeliverable')).length === 1,
    `${(await eventsNamed('alert_undeliverable')).length}`);

  // ---- the e-mail fallback ------------------------------------------------
  const dave = await mkUser('dave@e2e.test', 'analyst');
  const davePol = (await mkPolicy({
    name: 'Fallback', steps: [{ timeoutM: 5, targets: [{ kind: 'user', refId: dave.id }] }],
  })).j;
  const caseN = await mkCase(90);
  const N = (await call(lead, 'POST', '/api/oncall/alerts',
    { subjectKind: 'case', subjectId: caseN, policyId: davePol.id })).j;
  await tick();
  // No mail transport in the harness, so the send FAILS — but it must have been
  // attempted on the account address. A person with no configured method who is
  // simply skipped is the silent hole this fallback exists to close.
  const nNotifs = await notifsFor(N.id);
  chk('a person with no contact method is still tried, on their account e-mail',
    nNotifs.some((n) => n.channel === 'email'), JSON.stringify(nNotifs));

  // ---- notification rules -------------------------------------------------
  const annaMethods = (await call(annaSess, 'GET', '/api/oncall/me')).j.methods;
  const annaNtfy = annaMethods.find((m) => m.kind === 'ntfy').id;
  const rulesPut = await call(annaSess, 'PUT', '/api/oncall/me/rules', {
    rules: [
      { urgency: 'high', delayM: 0, methodId: annaNtfy },
      { urgency: 'high', delayM: 2, methodId: annaNtfy },
      { urgency: 'high', delayM: 90, methodId: annaNtfy },
    ],
  });
  chk('notification rules are stored as a set', rulesPut.status === 200 && rulesPut.j.count === 3);
  const foreignRule = await call(annaSess, 'PUT', '/api/oncall/me/rules',
    { rules: [{ urgency: 'high', delayM: 0, methodId: 999999 }] });
  chk('a rule naming somebody else\'s contact method is refused', foreignRule.status === 400);

  delivered.length = 0;
  const caseO = await mkCase(90);
  const O = (await call(lead, 'POST', '/api/oncall/alerts',
    { subjectKind: 'case', subjectId: caseO, policyId: pol.id })).j;
  await tick();
  chk('the zero-delay rule fires at once', delivered.filter((d) => d.url === '/anna').length === 1);
  const oNotifs = await notifsFor(O.id);
  chk('a rule that could not fire inside the step is SKIPPED and says so',
    oNotifs.some((n) => /exceeds|escalates after/.test(n.error || '')),
    JSON.stringify(oNotifs.map((n) => n.error)));
  chk('a delayed rule that fits inside the step becomes a timer',
    (await timersOf(O.id)).some((t) => t.kind === 'notify'));
  await chain.sweep(now() + 3 * MIN);
  await tick();
  chk('...and it fires when it comes due', delivered.filter((d) => d.url === '/anna').length === 2,
    `${delivered.filter((d) => d.url === '/anna').length} deliveries`);
  await call(annaSess, 'PUT', '/api/oncall/me/rules', { rules: [] });

  // ---- alert_rules with a policy target -----------------------------------
  const ruleResp = await call(lead, 'POST', '/api/rules', {
    name: 'Critical → on-call', channel: 'email', triggerName: 'db_down',
    severityMin: 60, cooldownM: 1, targetType: 'policy', policyId: pol.id,
  });
  chk('an alert rule can target an escalation policy', ruleResp.status === 200, JSON.stringify(ruleResp.j));
  const noPolicy = await call(lead, 'POST', '/api/rules', {
    name: 'Broken', channel: 'email', targetType: 'policy',
  });
  chk('a policy rule without a policy is refused rather than left silent', noPolicy.status === 400);

  delivered.length = 0;
  await pipeline.ingestEvent({ name: 'db_down', device: 'db-01', target: null, severity: 95,
    description: 'primary database unreachable' }, 'e2e', false, DEFAULT_ORG_ID);
  await tick(); await tick();
  const fromRule = await q.prepare("SELECT * FROM alerts WHERE source LIKE 'rule:%' ORDER BY id DESC LIMIT 1").get();
  chk('an event matching that rule raises an alert with NO flow involved', !!fromRule,
    'no alert was raised');
  chk('the alert names the rule that raised it', fromRule && /^rule:\d+$/.test(fromRule.source));
  chk('and the on-call person was rung', !!fromRule && (await attemptsOf(fromRule.id)).length === 1);

  // The self-referential guard: alert_exhausted is raised BY the chain.
  await call(lead, 'POST', '/api/rules', {
    name: 'Loop', channel: 'email', triggerName: 'alert_exhausted',
    severityMin: 0, cooldownM: 1, targetType: 'policy', policyId: pol.id,
  });
  const alertsBefore = (await q.prepare('SELECT COUNT(*) c FROM alerts').get()).c;
  await pipeline.ingestEvent({ name: 'alert_exhausted', device: 'C-1', target: null, severity: 85,
    description: 'x' }, 'e2e', false, DEFAULT_ORG_ID);
  await tick();
  chk('a policy rule on the chain\'s OWN signal is refused — no perpetual motion',
    (await q.prepare('SELECT COUNT(*) c FROM alerts').get()).c === alertsBefore);
  chk('...and the refusal is recorded, not silent',
    !!(await q.prepare("SELECT 1 x FROM notifications WHERE error LIKE '%raised BY the alert chain%'").get()));

  // ---- org scoping --------------------------------------------------------
  const foreignRead = await call(away, 'GET', '/api/oncall/policies');
  chk('another org sees none of these policies', Array.isArray(foreignRead.j) && foreignRead.j.length === 0);
  const foreignAlert = await call(away, 'GET', `/api/oncall/alerts/${A.id}`);
  chk('another org cannot read this org\'s alert', foreignAlert.status === 404, `status ${foreignAlert.status}`);
  const foreignAck = await call(away, 'POST', `/api/oncall/alerts/${B.id}/ack`);
  chk('another org cannot acknowledge it either', foreignAck.status === 404);

  // ---- a policy with no rungs --------------------------------------------
  const emptyPol = (await mkPolicy({ name: 'Empty', steps: [] })).j;
  const caseP = await mkCase(90);
  const refused = await call(lead, 'POST', '/api/oncall/alerts',
    { subjectKind: 'case', subjectId: caseP, policyId: emptyPol.id });
  chk('a ladder with no rungs is refused at raise time, not discovered at 03:00',
    refused.status === 400, `status ${refused.status}`);
  const closedCase = await mkCase(90);
  await call(lead, 'PATCH', `/api/cases/${closedCase}`, { status: 'closed' });
  const onClosed = await call(lead, 'POST', '/api/oncall/alerts',
    { subjectKind: 'case', subjectId: closedCase, policyId: pol.id });
  chk('an alert cannot be raised on an already-closed case', onClosed.status === 400);

  // ---- survives a process restart -----------------------------------------
  // The headline guarantee. An escalation that only exists in this process's
  // memory is not durable, and the failure would be invisible: everything green,
  // one alert quietly never escalating after a deploy.
  const caseQ = await mkCase(90);
  const Q = (await call(lead, 'POST', '/api/oncall/alerts',
    { subjectKind: 'case', subjectId: caseQ, policyId: pol.id })).j;
  chk('the escalation clock is a ROW, not a setTimeout',
    (await q.prepare("SELECT COUNT(*) c FROM alert_timers WHERE alert_id = ? AND kind = 'step'").get(Q.id)).c === 1);
  // Fall due in the past, as if the process had been down through the timeout.
  await q.prepare('UPDATE alert_timers SET resume_at = ? WHERE alert_id = ?').run(now() - MIN, Q.id);
  const child = spawn(process.execPath, [path.join(__dirname, 'src', 'index.js')], {
    env: { ...process.env, PORT: '3143' }, stdio: 'ignore',
  });
  await new Promise((res) => setTimeout(res, 2500));
  child.kill('SIGKILL');
  await new Promise((res) => setTimeout(res, 300));
  const q2 = await alertRow(Q.id);
  chk('a SECOND process picks the overdue escalation up on boot and advances it',
    q2.step_position === 1, `step ${q2.step_position}, status ${q2.status}`);

  // ---- read model ---------------------------------------------------------
  const live = (await call(lead, 'GET', '/api/oncall/alerts?status=live')).j;
  chk('the alert list defaults to what is still live',
    live.every((a) => ['active', 'acked'].includes(a.status)), JSON.stringify(live.map((a) => a.status)));
  const all = (await call(lead, 'GET', '/api/oncall/alerts?status=all')).j;
  chk('...and can be asked for everything', all.length > live.length);
  const detail = (await call(lead, 'GET', `/api/oncall/alerts/${B.id}`)).j;
  chk('an alert detail carries who was notified, when, and how',
    detail.attempts.length === 4 && detail.attempts.every((t) => t.via && t.notifiedAt));
  const caseList = (await call(lead, 'GET', '/api/cases')).j;
  chk('a case carries its live alert — the first column of a handover',
    caseList.some((c) => c.alert && c.alert.status), 'no case shows an alert');
  const withAck = caseList.find((c) => c.id === caseA);
  chk('a case shows that it was acknowledged and by whom', !!withAck.ackedAt && !!withAck.ackedBy);

  // ---- on-call analytics (slice 5) ----------------------------------------
  // Read model over everything raised above, so it needs no fixtures of its own.
  const ana = (await call(lead, 'GET', '/api/oncall/analytics?range=30d')).j;
  const ackedCases = (await q.prepare('SELECT COUNT(*) c FROM cases WHERE acked_at IS NOT NULL').get()).c;
  chk('MTTA is answerable at all — the number cases.acked_at exists for',
    ana.mtta.avgMs > 0 && ana.mtta.acked > 0, JSON.stringify(ana.mtta));
  chk('...and counts only cases that were ACTUALLY acknowledged',
    ana.mtta.acked === ackedCases, `${ana.mtta.acked} vs ${ackedCases}`);
  chk('cases nobody acknowledged are reported separately, not averaged in as zero',
    ana.mtta.unacked > 0, String(ana.mtta.unacked));
  chk('alerts raised in the window are counted', ana.escalation.raised > 0);
  chk('an alert that left rung one counts as escalated', ana.escalation.escalated > 0,
    JSON.stringify(ana.escalation));
  chk('"reached nobody" is its own number, not folded into the rest',
    ana.escalation.exhausted === 1, String(ana.escalation.exhausted));
  chk('the rates are percentages of what was raised',
    ana.escalation.rate === Math.round((ana.escalation.escalated / ana.escalation.raised) * 100));
  chk('per-person load names the people who were rung',
    ana.perPerson.some((p) => p.user.id === anna.id) && ana.perPerson.every((p) => p.total > 0),
    JSON.stringify(ana.perPerson.map((p) => [p.user.name, p.total])));
  chk('per-schedule load names the schedule and a per-week figure',
    ana.perSchedule.some((s) => s.name === 'Primary' && s.alerts > 0 && s.perWeek > 0),
    JSON.stringify(ana.perSchedule));

  // The MTTA trend buckets by UTC day. It used `strftime(…, 'unixepoch')`, which
  // is UTC in SQLite; Postgres has no strftime and its replacement renders in the
  // SESSION TimeZone, so a literal translation moves every point by the server's
  // offset — and the chart still looks plausible, which is why this is measured.
  // Nothing asserted this line at all until now; the same rewrite touched three
  // charts and only one of them was covered.
  const DAY = 86400000;
  const midnight = Math.floor((now() - 4 * DAY) / DAY) * DAY;       // 00:00 UTC
  const utc = (ms) => new Date(ms).toISOString().slice(0, 10);
  const insAcked = q.prepare(`INSERT INTO cases (org_id, name, device, severity, status, opened_at, acked_at)
    VALUES (?, 'mtta-clock', 'host-clock', 70, 'open', ?, ?)`);
  await insAcked.run(DEFAULT_ORG_ID, midnight - 30 * 60000 - 60000, midnight - 30 * 60000);  // 23:30, 60s
  await insAcked.run(DEFAULT_ORG_ID, midnight + 30 * 60000 - 60000, midnight + 30 * 60000);  // 00:30, 60s
  // Same UTC day as the second, acked after three times as long — so the day's
  // average is 120s only if both really landed in one group. Without this row a
  // bucket expression that does no bucketing at all passes every check here.
  await insAcked.run(DEFAULT_ORG_ID, midnight + 6 * 3600000 - 180000, midnight + 6 * 3600000);

  const anaDaily = (await call(lead, 'GET', '/api/oncall/analytics?range=30d')).j;
  const prev = (anaDaily.mtta.daily || []).filter((r) => r.d === utc(midnight - DAY));
  const day = (anaDaily.mtta.daily || []).filter((r) => r.d === utc(midnight));
  chk('an ack 30 min BEFORE midnight UTC lands on the previous UTC day',
    prev.length === 1 && prev[0].v === 60000, JSON.stringify(prev));
  chk('…one 30 min after lands on the new day, and the two are different days',
    day.length === 1 && utc(midnight - DAY) !== utc(midnight), JSON.stringify(day));
  chk('…and that day is ONE row averaging 60s and 180s to 120s — the day is the '
    + 'group key, not the timestamp',
    day.length === 1 && day[0].v === 120000, JSON.stringify(day));

  // The one piece of real arithmetic: out-of-hours is a question about LOCAL
  // time, and getting it wrong produces a number that is worse than none —
  // it is arguable. Two attempts for one person in Europe/Berlin, one at 03:00
  // local and one at 12:00 local, on a Wednesday.
  const tzUser = await mkUser('night@e2e.test', 'analyst');
  await q.prepare('UPDATE users SET timezone = ? WHERE id = ?').run('Europe/Berlin', tzUser.id);
  const berlin = (y, mo, d, hh) => {
    const want = `${String(d).padStart(2, '0')}.${String(mo).padStart(2, '0')}.${y}, ${String(hh).padStart(2, '0')}:00`;
    const f = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', year: 'numeric',
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    let ms = Date.UTC(y, mo - 1, d, hh) - 3 * 3600000;
    for (let i = 0; i < 8; i++) { if (f.format(new Date(ms)) === want) return ms; ms += 3600000; }
    throw new Error(`no Berlin instant for ${want}`);
  };
  const recent = new Date(now() - 3 * 86400000);
  // Walk back to a Wednesday so the weekend rule cannot decide the outcome.
  let probe = new Date(recent);
  while (probe.getUTCDay() !== 3) probe = new Date(probe.getTime() - 86400000);
  const nightAt = berlin(probe.getUTCFullYear(), probe.getUTCMonth() + 1, probe.getUTCDate(), 3);
  const dayAt = berlin(probe.getUTCFullYear(), probe.getUTCMonth() + 1, probe.getUTCDate(), 12);
  const anyAlert = (await q.prepare('SELECT id FROM alerts ORDER BY id LIMIT 1').get()).id;
  for (const at of [nightAt, dayAt]) {
    // eslint-disable-next-line no-await-in-loop
    await q.prepare(`INSERT INTO alert_attempts (alert_id, user_id, step_position, round, via, notified_at)
      VALUES (?, ?, 0, 0, 'user', ?)`).run(anyAlert, tzUser.id, at);
  }
  const ana2 = (await call(lead, 'GET', '/api/oncall/analytics?range=30d')).j;
  const row = ana2.perPerson.find((p) => p.user.id === tzUser.id);
  chk('a 03:00 local call counts as a night, a 12:00 local one does not',
    row && row.total === 2 && row.nights === 1 && row.outOfHours === 1,
    JSON.stringify(row));
  chk('...and the timezone it was counted in is reported',
    row && row.timezone === 'Europe/Berlin' && row.tzSource === 'user', JSON.stringify(row));
  const noTz = ana2.perPerson.find((p) => p.user.id === anna.id);
  chk('somebody without a timezone is counted in the SCHEDULE\'s zone, and says so',
    noTz && noTz.tzSource !== 'user' && !!noTz.timezone, JSON.stringify(noTz));

  const foreignAna = (await call(away, 'GET', '/api/oncall/analytics?range=30d')).j;
  chk('another org sees its own numbers, which are zero',
    foreignAna.escalation.raised === 0 && foreignAna.perPerson.length === 0,
    JSON.stringify(foreignAna.escalation));

  // ---- retention ----------------------------------------------------------
  // alert_attempts is a record of who was woken at 03:00 — personal data, and it
  // only disappears when its parent alert does.
  // `prune()` is async since Phase 4 converted engine/retention.js, so these are
  // awaited and the IIFEs are async — a synchronous IIFE would return a Promise
  // to chk(), which throws on a thenable for exactly this reason.
  await require('./src/engine/retention').prune();
  chk('an ENDED alert older than the window is pruned; its attempts cascade',
    await (async () => {
      const old = Number(await q.prepare(`INSERT INTO alerts (org_id, subject_kind, subject_id, urgency,
        status, source, created_at, ended_at, end_reason)
        VALUES (?, 'case', 999, 'high', 'canceled', 'test', ?, ?, 'old')`)
        .insert(DEFAULT_ORG_ID, now() - 400 * 86400000, now() - 400 * 86400000));
      await q.prepare(`INSERT INTO alert_attempts (alert_id, user_id, step_position, round, via, notified_at)
        VALUES (?, ?, 0, 0, 'user', ?)`).run(old, anna.id, now() - 400 * 86400000);
      await require('./src/engine/retention').prune();
      return !(await alertRow(old))
        && (await q.prepare('SELECT COUNT(*) c FROM alert_attempts WHERE alert_id = ?').get(old)).c === 0;
    })());
  chk('an ACTIVE alert is never pruned, however old — it is still ringing',
    await (async () => {
      const live = Number(await q.prepare(`INSERT INTO alerts (org_id, subject_kind, subject_id, urgency,
        status, source, created_at) VALUES (?, 'case', 998, 'high', 'active', 'test', ?)`)
        .insert(DEFAULT_ORG_ID, now() - 400 * 86400000));
      await require('./src/engine/retention').prune();
      return !!(await alertRow(live));
    })());

  // ---- policy deletion ----------------------------------------------------
  const delResp = await call(lead, 'DELETE', `/api/oncall/policies/${deadPol.id}`);
  chk('a policy can be deleted', delResp.status === 200);
  chk('its steps go with it',
    (await q.prepare('SELECT COUNT(*) c FROM escalation_steps WHERE policy_id = ?').get(deadPol.id)).c === 0);
  chk('an alert that outlived its policy keeps its history rather than vanishing',
    !!(await alertRow(M.id)), 'alert row disappeared');

  // ---- report --------------------------------------------------------------
  stub.close();
  report();
}

main().catch(die);
