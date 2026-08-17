'use strict';
/* End-to-end check for the ingest engine's event path, and for three read paths
 * whose SQL was rewritten for Postgres portability.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 *
 * Phase 1 of docs/POSTGRES-MIGRATION-PLAN.md rewrites four statements that do
 * not parse under Postgres. Before changing them I checked whether the existing
 * harnesses would notice if a rewrite changed behaviour, by breaking each one on
 * purpose and running the suite:
 *
 *   severity escalation disabled on the hot path  → 717/717 passed
 *   the automation's case note dropped entirely   → 717/717 passed
 *   "latest synthetic result" returning the OLDEST → 717/717 passed
 *   the custom-vendor rollup returning nothing    → 717/717 passed
 *
 * Four for four. The plan's claim that Phase 1 items are "harness-verified" was
 * not true for these, and `MAX(severity, ?)` sits on the single hottest write
 * path in the product. A rewrite nothing can contradict is a rewrite nobody can
 * review, so the coverage comes first and the rewrite rides on it.
 *
 * Every check below fails if you re-break the corresponding statement — that was
 * measured, not assumed.
 *
 * Hermetic: throwaway database, own port, no network.
 *   cd server && node e2e-pipeline.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { chk, until, report, onExit, die } = require('./e2e-lib').harness();

// Environment BEFORE any src/ require — config.js and db.js are singletons.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opscat-pipeline-'));
process.env.OPSCAT_DATA_DIR = tmp;
onExit(() => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.OPSCAT_SECRET = 'e2e-pipeline-secret';
process.env.PORT = '3137';
process.env.OPSCAT_EDITION = 'cloud';
process.env.OPSCAT_ADMIN_EMAIL = 'admin@e2e.test';
process.env.OPSCAT_ADMIN_PASSWORD = 'seed-admin-password-1';

require('./src/index.js'); // boots the app on :3137

const { db } = require('./src/db');
const { now, newId, DEFAULT_ORG_ID } = require('./src/util');
const pipeline = require('./src/engine/pipeline');
const automations = require('./src/engine/automations');

const BASE = 'http://127.0.0.1:3137';

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch { /* not yet */ }
    await new Promise((res) => setTimeout(res, 100));
  }
  return false;
}

// Browser-shaped login, so the read paths are exercised through the real guards
// rather than by querying the database the endpoint is supposed to query.
async function login(email, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await r.json().catch(() => ({}));
  const cookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  return { cookie, csrf: body.csrf, status: r.status };
}

const ev = (dedupeName, device) => db.prepare(
  "SELECT * FROM events WHERE org_id = ? AND dedupe_key = ? AND status = 'active'")
  .get(DEFAULT_ORG_ID, `${dedupeName}|${device}|`);

async function main() {
  chk('server boots and answers /api/health', await waitForServer());
  const sess = await login('admin@e2e.test', 'seed-admin-password-1');
  chk('the seeded admin can log in', sess.status === 200 && !!sess.cookie, `status ${sess.status}`);

  // ── 1. severity escalation — `MAX(severity, ?)` was SQLite's 2-arg scalar max,
  //       which Postgres does not have at all (its MAX is aggregate-only).
  //       The behaviour it encodes: an event's severity RATCHETS UP and never
  //       comes back down on its own. That is what operators rely on — a flapping
  //       check must not quietly downgrade an incident that already went critical.
  const DEV = 'core-switch-01';
  const NAME = 'link_down';

  pipeline.ingestEvent({ name: NAME, device: DEV, severity: 40, description: 'first' },
    'e2e', false, DEFAULT_ORG_ID);
  let e = ev(NAME, DEV);
  chk('a new event is created at the severity it arrived with', e && e.severity === 40, `sev ${e && e.severity}`);
  chk('…with one hit', e && e.hits === 1, `hits ${e && e.hits}`);
  const eventId = e.id;

  pipeline.ingestEvent({ name: NAME, device: DEV, severity: 80, description: 'escalated' },
    'e2e', false, DEFAULT_ORG_ID);
  e = ev(NAME, DEV);
  chk('a higher severity ESCALATES the existing event', e.severity === 80, `sev ${e.severity}`);
  chk('…on the same row, not a new one', e.id === eventId, `id ${e.id} vs ${eventId}`);
  chk('…and counts a second hit', e.hits === 2, `hits ${e.hits}`);
  chk('…and takes the newer description', e.description === 'escalated', e.description);

  pipeline.ingestEvent({ name: NAME, device: DEV, severity: 10, description: 'flapped back' },
    'e2e', false, DEFAULT_ORG_ID);
  e = ev(NAME, DEV);
  chk('a LOWER severity does not downgrade the event', e.severity === 80, `sev ${e.severity}`);
  chk('…but still counts the hit', e.hits === 3, `hits ${e.hits}`);
  chk('…and still takes the newer description', e.description === 'flapped back', e.description);

  pipeline.ingestEvent({ name: NAME, device: DEV, severity: 80, description: 'equal' },
    'e2e', false, DEFAULT_ORG_ID);
  chk('an EQUAL severity is a no-op on severity (the > boundary)', ev(NAME, DEV).severity === 80);

  // the per-minute rollup rides the same transaction
  const buckets = db.prepare('SELECT SUM(count) c FROM event_buckets WHERE event_id = ?').get(eventId).c;
  chk('every ingest bumped the event_buckets rollup', buckets === 4, `${buckets} counted`);

  // ── 2. the automation's case note — `char(10)` is SQLite's spelling, Postgres
  //       spells it `chr(10)`. The newline is a bound parameter now, so neither is
  //       needed. What must survive is the APPEND: this is the only
  //       concurrency-safe note append in the repo (CLAUDE.md calls it the model),
  //       and a rewrite that turned it into an overwrite would destroy operator
  //       text with no error anywhere.
  const RAISE = 'disk_full';
  const CLEAR = 'disk_ok';
  db.prepare(`INSERT INTO automations (org_id, name, enabled, trigger_json, actions_json,
      cooldown_m, created_at) VALUES (?, 'auto-close disk', 1, ?, ?, 0, ?)`)
    .run(DEFAULT_ORG_ID, JSON.stringify({ event: CLEAR, severityMin: 0 }),
      JSON.stringify([{ type: 'close_event', raiseEvent: RAISE }]), now());
  automations.invalidate?.(DEFAULT_ORG_ID);

  // an open case to close: CASE_THRESHOLD decides, so raise it well above
  pipeline.ingestEvent({ name: RAISE, device: DEV, severity: 90, description: 'disk at 99%' },
    'e2e', false, DEFAULT_ORG_ID);
  const raised = ev(RAISE, DEV);
  const caseRow = () => db.prepare("SELECT * FROM cases WHERE event_id = ? AND status != 'closed'").get(raised.id);
  chk('a severity over the case threshold opens a case', !!caseRow(), 'no case opened');

  // seed a note the way a human would, so the append has something to preserve
  const openCaseId = caseRow().id;
  db.prepare('UPDATE cases SET note = ? WHERE id = ?').run('operator: replacing the disk', openCaseId);

  pipeline.ingestEvent({ name: CLEAR, device: DEV, severity: 10, description: 'disk recovered' },
    'e2e', false, DEFAULT_ORG_ID);

  const closed = await until(() => db.prepare("SELECT * FROM cases WHERE id = ? AND status = 'closed'")
    .get(openCaseId), 4000);
  chk('the automation closes the case', !!closed, 'case still open');
  chk('…and PRESERVES the note that was already there',
    !!closed && closed.note.startsWith('operator: replacing the disk'), closed && closed.note);
  chk('…appending rather than overwriting',
    !!closed && /auto-closed by automation/.test(closed.note), closed && closed.note);
  chk('…separated by a newline, not concatenated onto the same line',
    !!closed && closed.note.includes('the disk\nauto-closed'), JSON.stringify(closed && closed.note));

  // ── 3. "the latest synthetic result" — was `SELECT ok, meta, MAX(ts)` with no
  //       GROUP BY, a SQLite extension Postgres rejects outright. The endpoint
  //       must still report the NEWEST result, and the failure mode of getting
  //       this wrong is a dashboard that says "ok" while the check is failing.
  const chkId = db.prepare(`INSERT INTO synthetic_checks (org_id, type, target, interval_s,
      enabled, created_at) VALUES (?, 'http', 'https://example.test', 60, 1, ?)`)
    .run(DEFAULT_ORG_ID, now()).lastInsertRowid;
  const t0 = now();
  // results carry a location; the local one is created at boot (ensureLocalLocation)
  const locId = db.prepare("SELECT id FROM synthetic_locations ORDER BY id LIMIT 1").get().id;
  const insResult = db.prepare(`INSERT INTO synthetic_results (check_id, location_id, ts, ok, latency_ms, meta)
    VALUES (?, ?, ?, ?, 10, ?)`);
  insResult.run(chkId, locId, t0 - 60000, 1, JSON.stringify({ note: 'older, healthy' }));
  insResult.run(chkId, locId, t0, 0, JSON.stringify({ note: 'newest, failing' }));

  const infra = await fetch(`${BASE}/api/assets`, { headers: { cookie: sess.cookie } });
  const infraBody = await infra.json().catch(() => []);
  const row = (Array.isArray(infraBody) ? infraBody : []).find((r) => r.kind === 'check' && r.id === chkId);
  chk('the asset list includes the check', !!row, JSON.stringify(infraBody).slice(0, 200));
  chk('…and reports the NEWEST result, not the oldest',
    !!row && row.status === 'failing', row && row.status);
  chk('…and its timestamp is the newest one', !!row && row.lastSeen === t0, row && row.lastSeen);

  // a check with no results at all must read "pending", not crash: the rewrite
  // returns undefined where the aggregate returned an all-NULL row
  const emptyId = db.prepare(`INSERT INTO synthetic_checks (org_id, type, target, interval_s,
      enabled, created_at) VALUES (?, 'icmp', '10.0.0.1', 60, 1, ?)`)
    .run(DEFAULT_ORG_ID, now()).lastInsertRowid;
  const infra2 = await (await fetch(`${BASE}/api/assets`, { headers: { cookie: sess.cookie } })).json();
  const emptyRow = (Array.isArray(infra2) ? infra2 : []).find((r) => r.kind === 'check' && r.id === emptyId);
  chk('a check with no results reads "pending" (no-rows path)',
    !!emptyRow && emptyRow.status === 'pending', emptyRow && emptyRow.status);
  chk('…with a null lastSeen', !!emptyRow && emptyRow.lastSeen === null, emptyRow && emptyRow.lastSeen);

  // ── 4. the custom-vendor rollup — `feed_type` sat bare beside COUNT/MIN/MAX with
  //       `GROUP BY feed_url`, which Postgres rejects. It is aggregated rather than
  //       added to the GROUP BY, because adding it would SPLIT one feed URL
  //       registered under two type strings into two rows and halve the `orgs`
  //       count the endpoint exists to rank by. This asserts the rollup, not the
  //       spelling.
  const org2 = newId();
  db.prepare(`INSERT INTO organizations (id, name, slug, plan, status, created_at)
    VALUES (?, 'Second Org', 'second', 'business', 'active', ?)`).run(org2, now());
  const FEED = 'https://vendor.example/status.atom';
  const insVendor = db.prepare(`INSERT INTO vendors (org_id, slug, name, feed_url, feed_type,
      enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)`);
  insVendor.run(DEFAULT_ORG_ID, 'custom-a', 'Vendor A', FEED, 'rss', now());
  // the same feed in a second org, deliberately typed differently — this is the
  // row that would split the group if feed_type were added to GROUP BY
  insVendor.run(org2, 'custom-b', 'Vendor A (dup)', FEED, 'statuspage', now());

  const sa = await fetch(`${BASE}/api/superadmin/custom-vendors`, { headers: { cookie: sess.cookie } });
  const list = await sa.json().catch(() => []);
  chk('the custom-vendor rollup answers 200', sa.status === 200, `status ${sa.status}`);
  const entry = Array.isArray(list) && list.find((v) => v.feedUrl === FEED);
  chk('…and returns the feed once', !!entry, JSON.stringify(list).slice(0, 200));
  chk('…counting BOTH orgs that registered it', !!entry && entry.orgs === 2, entry && entry.orgs);
  chk('…and still reports a feed type', !!entry && !!entry.feedType, entry && entry.feedType);

  report();
}

main().catch(die);
