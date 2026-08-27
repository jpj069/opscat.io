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
 * Sections 8-11 were added later, for four invariants on the same hot path that
 * the rest of the suite still could not contradict. Each was measured the same
 * way — break it, run all 22 harnesses, watch them stay green:
 *
 *   no case ever opened from a LOG line over the threshold  → 1535/1535 passed
 *   the event_buckets fold stops counting                   → 1535/1535 passed
 *   only the FIRST 100-line chunk of a batch is written     → 1535/1535 passed
 *   a check pinned to one probe location runs on all of them → 1535/1535 passed
 *
 * Three of the four are truthiness bugs a lost `await` produces (`!Promise` is
 * always false), which is the one hole the type gate cannot see — so nothing but
 * an assertion that ingests the real shape can hold them.
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

// Fixtures and read-back go through the SHIM, so they land in the database
// `run-e2e.js` handed this process in DATABASE_URL — the same one the code under
// test reads. A connection the harness opened for itself would be a different
// session, and a fixture written there surfaces as a foreign-key violation
// several calls later, pointing at the wrong thing entirely.
const q = require('./src/db/shim');
const { now, newId, DEFAULT_ORG_ID } = require('./src/util');
const pipeline = require('./src/engine/pipeline');
const automations = require('./src/engine/automations');
const synthetics = require('./src/engine/synthetics');

const BASE = 'http://127.0.0.1:3137';

/* `until` (e2e-lib.js) THROWS on a thenable, deliberately: a Promise is truthy,
 * so `while (!fn())` would be satisfied on the first poll and the wait would be
 * no wait at all. That guard also means it cannot take an async predicate — and
 * with the fixtures on the shim, the effect waited for below is a database row
 * rather than an in-memory value.
 *
 * So the DB-backed wait uses this variant, which AWAITS its predicate. The hole
 * `until` guards cannot exist here by construction: the query is resolved before
 * it is tested, never mistaken for `true`. The scheduler wait further down stays
 * on `until` — `ranLocally` is an ordinary array and reads synchronously.
 */
const untilAsync = async (fn, ms = 4000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 >= ms) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
};

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

const ev = (dedupeName, device) => q.prepare(
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

  await pipeline.ingestEvent({ name: NAME, device: DEV, severity: 40, description: 'first' },
    'e2e', false, DEFAULT_ORG_ID);
  let e = await ev(NAME, DEV);
  chk('a new event is created at the severity it arrived with', e && e.severity === 40, `sev ${e && e.severity}`);
  chk('…with one hit', e && e.hits === 1, `hits ${e && e.hits}`);
  const eventId = e.id;

  await pipeline.ingestEvent({ name: NAME, device: DEV, severity: 80, description: 'escalated' },
    'e2e', false, DEFAULT_ORG_ID);
  e = await ev(NAME, DEV);
  chk('a higher severity ESCALATES the existing event', e.severity === 80, `sev ${e.severity}`);
  chk('…on the same row, not a new one', e.id === eventId, `id ${e.id} vs ${eventId}`);
  chk('…and counts a second hit', e.hits === 2, `hits ${e.hits}`);
  chk('…and takes the newer description', e.description === 'escalated', e.description);

  await pipeline.ingestEvent({ name: NAME, device: DEV, severity: 10, description: 'flapped back' },
    'e2e', false, DEFAULT_ORG_ID);
  e = await ev(NAME, DEV);
  chk('a LOWER severity does not downgrade the event', e.severity === 80, `sev ${e.severity}`);
  chk('…but still counts the hit', e.hits === 3, `hits ${e.hits}`);
  chk('…and still takes the newer description', e.description === 'flapped back', e.description);

  await pipeline.ingestEvent({ name: NAME, device: DEV, severity: 80, description: 'equal' },
    'e2e', false, DEFAULT_ORG_ID);
  chk('an EQUAL severity is a no-op on severity (the > boundary)',
    (await ev(NAME, DEV)).severity === 80);

  // the per-minute rollup rides the same transaction
  const buckets = (await q.prepare('SELECT SUM(count) c FROM event_buckets WHERE event_id = ?')
    .get(eventId)).c;
  chk('every ingest bumped the event_buckets rollup', buckets === 4, `${buckets} counted`);

  // ── 2. the automation's case note — `char(10)` is SQLite's spelling, Postgres
  //       spells it `chr(10)`. The newline is a bound parameter now, so neither is
  //       needed. What must survive is the APPEND: this is the only
  //       concurrency-safe note append in the repo (CLAUDE.md calls it the model),
  //       and a rewrite that turned it into an overwrite would destroy operator
  //       text with no error anywhere.
  const RAISE = 'disk_full';
  const CLEAR = 'disk_ok';
  await q.prepare(`INSERT INTO automations (org_id, name, enabled, trigger_json, actions_json,
      cooldown_m, created_at) VALUES (?, 'auto-close disk', 1, ?, ?, 0, ?)`)
    .run(DEFAULT_ORG_ID, JSON.stringify({ event: CLEAR, severityMin: 0 }),
      JSON.stringify([{ type: 'close_event', raiseEvent: RAISE }]), now());
  automations.invalidate?.(DEFAULT_ORG_ID);

  // an open case to close: CASE_THRESHOLD decides, so raise it well above
  await pipeline.ingestEvent({ name: RAISE, device: DEV, severity: 90, description: 'disk at 99%' },
    'e2e', false, DEFAULT_ORG_ID);
  const raised = await ev(RAISE, DEV);
  const caseRow = () => q.prepare("SELECT * FROM cases WHERE event_id = ? AND status != 'closed'").get(raised.id);
  chk('a severity over the case threshold opens a case', !!await caseRow(), 'no case opened');

  // seed a note the way a human would, so the append has something to preserve
  const openCaseId = (await caseRow()).id;
  await q.prepare('UPDATE cases SET note = ? WHERE id = ?').run('operator: replacing the disk', openCaseId);

  await pipeline.ingestEvent({ name: CLEAR, device: DEV, severity: 10, description: 'disk recovered' },
    'e2e', false, DEFAULT_ORG_ID);

  const closed = await untilAsync(() => q.prepare("SELECT * FROM cases WHERE id = ? AND status = 'closed'")
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
  const chkId = await q.prepare(`INSERT INTO synthetic_checks (org_id, type, target, interval_s,
      enabled, created_at) VALUES (?, 'http', 'https://example.test', 60, 1, ?)`)
    .insert(DEFAULT_ORG_ID, now());
  const t0 = now();
  /* Every probe location must belong to a real organisation. `start()` used to
   * call `ensureLocalLocation(1)` — the literal default-org id from before
   * organisations became uuids — which created a row owned by NOBODY on every
   * boot. It is a tenant-isolation smell on SQLite (a location no org can
   * account for, showing up in the fleet list) and a hard
   * `invalid input syntax for type uuid` on Postgres, where it stops the
   * scheduler from starting at all. A literal like that must not be able to come
   * back quietly, so it is asserted rather than remembered. */
  const orphanLocs = await q.prepare(`SELECT l.id, l.org_id FROM synthetic_locations l
    LEFT JOIN organizations o ON o.id = l.org_id WHERE o.id IS NULL`).all();
  chk('every probe location belongs to a real organization — no orphan from a literal org id',
    orphanLocs.length === 0, JSON.stringify(orphanLocs));

  const localLoc = await q.prepare(
    "SELECT id FROM synthetic_locations WHERE org_id = ? AND kind = 'local'").get(DEFAULT_ORG_ID);
  chk('…and the default org has a local probe location, which is the one boot creates',
    !!localLoc, JSON.stringify(await q.prepare('SELECT id, org_id, kind FROM synthetic_locations').all()));

  /* Results carry a location, and this NAMES the one it means. It used to be
   * `ORDER BY id LIMIT 1`, which worked only because `synthetics.start()` was
   * creating an orphan row for the literal org `1` that happened to sort first —
   * so the check was reading a location belonging to no organisation while
   * looking like it read the org's own. Fixing the orphan would have broken this
   * silently, or worse, left it green against a different row than it means. */
  // Tolerant on purpose, matching the `localLoc3 ? … : -1` idiom further down:
  // `chk` collects and `report()` prints, so a TypeError here would take the
  // whole run's diagnostics with it and the reader would see a stack trace
  // instead of the two checks above naming exactly what is wrong.
  const locId = localLoc ? localLoc.id : -1;
  const insResult = q.prepare(`INSERT INTO synthetic_results (check_id, location_id, ts, ok, latency_ms, meta)
    VALUES (?, ?, ?, ?, 10, ?)`);
  await insResult.run(chkId, locId, t0 - 60000, 1, JSON.stringify({ note: 'older, healthy' }));
  await insResult.run(chkId, locId, t0, 0, JSON.stringify({ note: 'newest, failing' }));

  const infra = await fetch(`${BASE}/api/assets`, { headers: { cookie: sess.cookie } });
  const infraBody = await infra.json().catch(() => []);
  const row = (Array.isArray(infraBody) ? infraBody : []).find((r) => r.kind === 'check' && r.id === chkId);
  chk('the asset list includes the check', !!row, JSON.stringify(infraBody).slice(0, 200));
  chk('…and reports the NEWEST result, not the oldest',
    !!row && row.status === 'failing', row && row.status);
  chk('…and its timestamp is the newest one', !!row && row.lastSeen === t0, row && row.lastSeen);

  // a check with no results at all must read "pending", not crash: the rewrite
  // returns undefined where the aggregate returned an all-NULL row
  const emptyId = await q.prepare(`INSERT INTO synthetic_checks (org_id, type, target, interval_s,
      enabled, created_at) VALUES (?, 'icmp', '10.0.0.1', 60, 1, ?)`)
    .insert(DEFAULT_ORG_ID, now());
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
  await q.prepare(`INSERT INTO organizations (id, name, slug, plan, status, created_at)
    VALUES (?, 'Second Org', 'second', 'business', 'active', ?)`).run(org2, now());
  const FEED = 'https://vendor.example/status.atom';
  const insVendor = q.prepare(`INSERT INTO vendors (org_id, slug, name, feed_url, feed_type,
      enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)`);
  await insVendor.run(DEFAULT_ORG_ID, 'custom-a', 'Vendor A', FEED, 'rss', now());
  // the same feed in a second org, deliberately typed differently — this is the
  // row that would split the group if feed_type were added to GROUP BY
  await insVendor.run(org2, 'custom-b', 'Vendor A (dup)', FEED, 'statuspage', now());

  const sa = await fetch(`${BASE}/api/superadmin/custom-vendors`, { headers: { cookie: sess.cookie } });
  const list = await sa.json().catch(() => []);
  chk('the custom-vendor rollup answers 200', sa.status === 200, `status ${sa.status}`);
  const entry = Array.isArray(list) && list.find((v) => v.feedUrl === FEED);
  chk('…and returns the feed once', !!entry, JSON.stringify(list).slice(0, 200));
  chk('…counting BOTH orgs that registered it', !!entry && entry.orgs === 2, entry && entry.orgs);
  chk('…and still reports a feed type', !!entry && !!entry.feedType, entry && entry.feedType);

  // ── 5. case-insensitive search — SQLite's LIKE is case-INSENSITIVE for ASCII
  //       by default; Postgres LIKE is case-SENSITIVE. A literal translation
  //       silently narrows every user-facing search: org lookup stops finding
  //       "Acme" for "acme", log search returns fewer lines, and the MCP tool
  //       under-reports to an agent that has no way to notice. `lower() LIKE
  //       lower()` is identical on SQLite today and correct on Postgres later.
  const insLog = q.prepare(`INSERT INTO logs (org_id, ts, device, line, sev, source)
    VALUES (?, ?, ?, ?, 4, 'e2e')`);
  const tLog = now();
  await insLog.run(DEFAULT_ORG_ID, tLog, 'Router-Alpha', 'Interface GigabitEthernet0/1 FLAPPING');
  await insLog.run(DEFAULT_ORG_ID, tLog, 'router-beta', 'interface reset, no flapping seen');

  const logs = async (q) => (await (await fetch(
    `${BASE}/api/logs?q=${encodeURIComponent(q)}&limit=50`,
    { headers: { cookie: sess.cookie } })).json());

  chk('log search matches regardless of the QUERY\'s case',
    (await logs('FLAPPING')).length === 2 && (await logs('flapping')).length === 2,
    `${(await logs('FLAPPING')).length} vs ${(await logs('flapping')).length}`);
  chk('…and regardless of the STORED line\'s case',
    (await logs('gigabitethernet')).length === 1, `${(await logs('gigabitethernet')).length}`);
  chk('…and the device filter is case-insensitive too',
    (await logs('router-alpha')).length === 1, `${(await logs('router-alpha')).length}`);

  const orgs = async (q) => (await (await fetch(
    `${BASE}/api/superadmin/orgs?q=${encodeURIComponent(q)}`,
    { headers: { cookie: sess.cookie } })).json());
  const found = await orgs('second org');
  chk('org search finds "Second Org" for a lower-case query',
    Array.isArray(found) && found.some((o) => o.id === org2), JSON.stringify(found).slice(0, 160));

  // ── 6. the uptime bucket index — was `CAST(<float> AS INTEGER)`, and SQLite
  //       TRUNCATES where Postgres ROUNDS. `bucketMs` is fractional whenever the
  //       span does not divide by the bucket count (5 minutes over 64 buckets is
  //       4687.5), so half the buckets would shift by one on the port. 64 buckets
  //       is deliberately the case that divides badly.
  // A result at the very END of the window is what separates the two behaviours.
  // Its offset is just under spanMs, so truncation gives bucket 63 — in range and
  // drawn. Rounding gives 64, which is out of range and silently DROPPED by the
  // handler's own `r.b < buckets` guard, leaving the last bucket empty on a chart
  // that has data for it.
  await insResult.run(chkId, locId, now(), 1, JSON.stringify({ note: 'at the window edge' }));
  const hist = await (await fetch(`${BASE}/api/synthetics/history?minutes=5&buckets=64`,
    { headers: { cookie: sess.cookie } })).json();
  chk('the uptime history answers for a fractional bucket width (5min / 64)',
    hist && !hist.error, JSON.stringify(hist).slice(0, 160));
  const mine = (hist.checks || []).find((c) => c.checkId === chkId);
  chk('…and the check appears in it', !!mine, JSON.stringify(hist.checks || []).slice(0, 160));
  chk('…and the LAST bucket holds the result at the window edge, not "na" '
    + '(rounding would push it to index 64 and drop it)',
    !!mine && mine.buckets[63] && mine.buckets[63].s !== 'na',
    mine && JSON.stringify(mine.buckets[63]));

  // ── 7. day buckets are UTC days.
  //
  // The three analytics charts used to bucket with `strftime(…, 'unixepoch')`,
  // which is UTC in SQLite; Postgres has no strftime and its replacement renders
  // in the SESSION TimeZone, so a literal translation moves every bucket by the
  // server's offset — and the chart still looks plausible afterwards, which is
  // why this is checked rather than reviewed. They now bucket arithmetically
  // (`ts - ts % 86400000`, util.js `utcDaySql`), and the assertion is unchanged
  // by that: a timestamp just after midnight UTC must land on the NEW day and
  // one just before on the old one, whatever the mechanism.
  // Deliberately three days back: TODAY already has log rows from the checks
  // above, so asserting "today appears" would pass whatever the timezone does.
  // A quiet day makes the two probe rows the only thing that can produce it.
  const dayMs = 86400000;
  const midnight = Math.floor((now() - 3 * dayMs) / dayMs) * dayMs;  // 00:00 UTC, 3 days ago
  const before = midnight - 30 * 60000;                 // 23:30 UTC, 4 days ago
  const after = midnight + 30 * 60000;                  // 00:30 UTC, 3 days ago
  await insLog.run(DEFAULT_ORG_ID, before, 'clock-probe', 'thirty minutes before midnight UTC');
  await insLog.run(DEFAULT_ORG_ID, after, 'clock-probe', 'thirty minutes after midnight UTC');
  // A third, hours later on the SAME day as `after`. Without it these checks
  // test the LABEL and not the GROUPING: a bucket expression that does no
  // bucketing at all still produces the right day string per row, so the set of
  // days is right while the chart has one point per log line. Measured — that
  // mutation passed every check here until this row existed.
  await insLog.run(DEFAULT_ORG_ID, after + 6 * 3600000, 'clock-probe', 'same UTC day, six hours later');

  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const an = await (await fetch(`${BASE}/api/analytics?range=7d`,
    { headers: { cookie: sess.cookie } })).json();
  const days = new Set((an.volume || []).map((r) => r.d));
  chk('a log 30 min BEFORE midnight UTC buckets on the previous UTC day',
    days.has(iso(before)), `${iso(before)} not in ${[...days].join(',')}`);
  chk('…and one 30 min AFTER midnight UTC buckets on the new UTC day',
    days.has(iso(after)), `${iso(after)} not in ${[...days].join(',')}`);
  chk('…so the two land on DIFFERENT days (the boundary is real, not rounded away)',
    iso(before) !== iso(after), `${iso(before)} vs ${iso(after)}`);
  const sameDay = (an.volume || []).filter((r) => r.d === iso(after));
  chk('…and the two rows six hours apart share ONE row — the day is the group key, '
    + 'not the timestamp',
    sameDay.length === 1 && sameDay[0].m === 2, JSON.stringify(sameDay));

  // The same rewrite touched two more charts, and only `volume` was covered —
  // which is how a repo ends up with two of three call sites silently wrong.
  // `mttrDaily` buckets on closed_at, and it is an AVG rather than a COUNT, so
  // it also proves the grouping key and the aggregate did not come apart.
  const insCase = q.prepare(`INSERT INTO cases (org_id, name, device, severity, status, opened_at, closed_at)
    VALUES (?, 'clock-probe', 'host-clock', 50, 'closed', ?, ?)`);
  await insCase.run(DEFAULT_ORG_ID, before - 60000, before);   // closed 23:30 UTC, open 60s
  await insCase.run(DEFAULT_ORG_ID, after - 60000, after);     // closed 00:30 UTC, open 60s
  // Same UTC day as the one above, open three times as long — so the day's AVG
  // is 120s only if both cases really landed in one group.
  await insCase.run(DEFAULT_ORG_ID, after + 6 * 3600000 - 180000, after + 6 * 3600000);
  const an2 = await (await fetch(`${BASE}/api/analytics?range=7d`,
    { headers: { cookie: sess.cookie } })).json();
  const mttrDays = new Set((an2.mttrDaily || []).map((r) => r.d));
  chk('the MTTR chart buckets a case closed before midnight UTC on the old day',
    mttrDays.has(iso(before)), `${iso(before)} not in ${[...mttrDays].join(',')}`);
  chk('…and one closed after midnight on the new one',
    mttrDays.has(iso(after)), `${iso(after)} not in ${[...mttrDays].join(',')}`);
  const oldDay = (an2.mttrDaily || []).filter((r) => r.d === iso(before));
  const newDay = (an2.mttrDaily || []).filter((r) => r.d === iso(after));
  chk('…the old day is one row averaging its single 60s case',
    oldDay.length === 1 && oldDay[0].v === 60000, JSON.stringify(oldDay));
  chk('…and the new day is ONE row averaging 60s and 180s to 120s, so the group '
    + 'key and the aggregate did not come apart',
    newDay.length === 1 && newDay[0].v === 120000, JSON.stringify(newDay));

  // ── 8. a LOG LINE that classifies over the case threshold opens a case.
  //
  // Section 2 above proves the threshold through `ingestEvent(alsoLog=false)`,
  // which inserts the case unconditionally (there cannot be an open case for an
  // event that was just created on that path). The LOG path is a different four
  // lines and was covered by nothing: it looks the open case up first, because a
  // log-derived event can be re-opened after a finish while its case is still
  // around, and that lookup is the one statement here whose failure is silent.
  //
  //   const existing = await findOpenCaseForEvent.get(ev.id);
  //   if (!existing) await insCase.run(…);
  //
  // Drop that await and `existing` is a Promise, which is truthy, so `!existing`
  // is false for every event that ever arrives: no case is opened from a log
  // line again, anywhere, with no error and no log entry. The type gate cannot
  // see it — truthiness is the one hole layer 2 does not close — so the only
  // thing that can is a check that ingests a LINE and looks for the case.
  const CASE_DEV = 'case-log-probe-01';
  const caseIngest = await pipeline.ingestLogs(
    [{ device: CASE_DEV, line: 'kernel panic - not syncing: Attempted to kill init', sev: 2 }],
    'e2e', DEFAULT_ORG_ID);
  chk('a log line that classifies is accepted and produces an event',
    caseIngest.accepted === 1 && caseIngest.events === 1, JSON.stringify(caseIngest));
  const logEvent = await ev('kernel_error', CASE_DEV);
  chk('…the event carries the classifier\'s severity, which is over CASE_THRESHOLD',
    !!logEvent && logEvent.severity === 88 && logEvent.severity >= pipeline.CASE_THRESHOLD,
    logEvent && String(logEvent.severity));
  const logCase = await q.prepare("SELECT * FROM cases WHERE event_id = ? AND status != 'closed'")
    .get(logEvent.id);
  chk('…and a case is opened from it — the LOG path, not ingestEvent\'s direct insert',
    !!logCase, 'no case opened for the log-derived event');
  chk('…carrying the classified name, device and severity',
    !!logCase && logCase.name === 'kernel_error' && logCase.device === CASE_DEV
      && logCase.severity === 88, JSON.stringify(logCase));

  // A second line on the same dedupe key must NOT open a second case: `hits === 1`
  // is the insert branch, and the open-case lookup is the belt to that braces.
  await pipeline.ingestLogs(
    [{ device: CASE_DEV, line: 'kernel panic - not syncing: again', sev: 2 }], 'e2e', DEFAULT_ORG_ID);
  const caseCount = (await q.prepare('SELECT COUNT(*) c FROM cases WHERE event_id = ?')
    .get(logEvent.id)).c;
  chk('…and a second occurrence does not open a second case', caseCount === 1, `${caseCount} cases`);

  // ── 9. the event_buckets FOLD — one row per (event, minute), not per line.
  //
  // `ingestLogs` aggregates the rollup in JS before writing it, and the comment
  // on `writeBuckets` calls that a correctness precondition rather than an
  // optimisation: `ON CONFLICT … DO UPDATE` may not touch the same row twice
  // within one statement, so a batch that did not fold would be an error under
  // Postgres and a wrong number under SQLite. Section 1's bucket check sums four
  // SEPARATE ingest calls, each of which folds trivially to one entry of 1 — so
  // it passes whether the fold works or not. Three lines sharing a dedupe key in
  // ONE batch is the only shape that can tell the difference.
  //
  // The three timestamps are DISTINCT and anchored to the start of a minute, one
  // second apart. Identical ones would have made the "one row" half of this
  // vacuous — three equal keys collapse in the Map whatever the bucket
  // expression does — so the minute arithmetic itself would go untested.
  const FOLD_DEV = 'fold-probe-01';
  const foldMinute = Math.floor(now() / 60000) * 60000;
  const foldRes = await pipeline.ingestLogs([
    { device: FOLD_DEV, line: 'link down on ge-0/0/3', sev: 4, ts: foldMinute + 1000 },
    { device: FOLD_DEV, line: 'link down on ge-0/0/3', sev: 4, ts: foldMinute + 2000 },
    { device: FOLD_DEV, line: 'link down on ge-0/0/3', sev: 4, ts: foldMinute + 3000 },
  ], 'e2e', DEFAULT_ORG_ID);
  chk('three identical lines in one batch are all accepted', foldRes.accepted === 3,
    JSON.stringify(foldRes));
  const foldEvent = await ev('link', FOLD_DEV);
  chk('…and dedupe onto ONE event carrying three hits',
    !!foldEvent && foldEvent.hits === 3, foldEvent && `hits ${foldEvent.hits}`);
  const foldBuckets = await q.prepare(
    'SELECT COUNT(*) n, SUM(count) c FROM event_buckets WHERE event_id = ?').get(foldEvent.id);
  chk('…and the rollup is ONE row for that minute, not three',
    foldBuckets.n === 1, `${foldBuckets.n} rows`);
  chk('…whose count is 3 — the fold counted every line, it did not just deduplicate them',
    foldBuckets.c === 3, `count ${foldBuckets.c}`);

  // ── 10. the log insert is CHUNKED, and every chunk must land.
  //
  // `LOG_BATCH = 100`, and an agent posts up to 500 lines at a time. The loop
  // that walks the batch in chunks is one statement with no observable effect
  // other than the rows it writes, so a mistake in it — an off-by-one on the
  // stride, a `break` where a `continue` belonged, a slice bound taken from the
  // wrong variable — loses lines SILENTLY: `accepted` is computed from
  // `logRows.length` before the loop runs, so the API answers "250 accepted"
  // while the table holds 100. Nothing else in the suite ingests more than a
  // handful of lines at once, so every existing check fits in the first chunk.
  //
  // 250 is deliberately two full chunks plus a short one — a stride bug that
  // survives an exact multiple does not survive a remainder. The lines are
  // written not to classify (no builtin matches, and syslog severity 6 floors to
  // 0), so this measures the log write and nothing else.
  const CHUNK_DEV = 'chunk-probe-01';
  const N = 250;
  const bulk = [];
  for (let i = 0; i < N; i++) bulk.push({ device: CHUNK_DEV, line: `chunk probe line ${i}`, sev: 6 });
  const bulkRes = await pipeline.ingestLogs(bulk, 'e2e', DEFAULT_ORG_ID);
  chk('a 250-line batch reports every line accepted', bulkRes.accepted === N, `${bulkRes.accepted}`);
  chk('…and none of them classified, so this measures the log write alone',
    bulkRes.events === 0, `${bulkRes.events} events`);
  const stored = (await q.prepare('SELECT COUNT(*) c FROM logs WHERE org_id = ? AND device = ?')
    .get(DEFAULT_ORG_ID, CHUNK_DEV)).c;
  chk('…and all 250 rows are in the table — every chunk was written, not just the first',
    stored === N, `${stored} of ${N} stored`);
  const lastLine = (await q.prepare('SELECT COUNT(*) c FROM logs WHERE org_id = ? AND device = ? AND line = ?')
    .get(DEFAULT_ORG_ID, CHUNK_DEV, `chunk probe line ${N - 1}`)).c;
  chk('…including the final short chunk\'s last line', lastLine === 1, `${lastLine}`);

  // ── 11. a check assigned to ONE probe location must not run on ANOTHER.
  //
  // `check_locations` is the assignment table, and "no rows = run everywhere" is
  // the rule `runsOnLocation` encodes. Both of its call sites are written
  //
  //     if (!(await runsOnLocation(check.id, locId))) continue;
  //
  // parenthesised on purpose, because `!await f()` reads as `!Promise` the moment
  // the await is lost — always false, so the guard stops existing and every check
  // runs on every location. Nothing in the suite ingested this: a customer's
  // check pinned to their Frankfurt probe would silently also be run from ours,
  // billing them for it and filling their uptime history with a vantage point
  // they did not ask for.
  //
  // The runner is replaced on the exported RUNNERS object, so this needs no
  // network and, more importantly, records the CALL rather than its result: the
  // runner is invoked synchronously right after the guard, so by the time the
  // control check has been called the assigned one has already been decided.
  // That makes the negative assertion deterministic instead of a race with a
  // fire-and-forget `.then(recordResult)`.
  const org3 = newId();
  await q.prepare(`INSERT INTO organizations (id, name, slug, plan, status, created_at)
    VALUES (?, 'Probe Org', 'probe-org', 'business', 'active', ?)`).run(org3, now());
  const remoteLoc = await q.prepare(`INSERT INTO synthetic_locations (org_id, city, cc, kind, active, created_at)
    VALUES (?, 'Frankfurt', 'DE', 'customer', 1, ?)`).insert(org3, now());

  const ranLocally = [];
  synthetics.RUNNERS.tcp = async (check) => {
    ranLocally.push(check.id);
    return { ok: true, latency: 1, meta: { probe: 'e2e-fake' } };
  };

  const insChk = q.prepare(`INSERT INTO synthetic_checks (org_id, type, target, interval_s,
      enabled, created_at) VALUES (?, 'tcp', ?, 60, 1, ?)`);
  // Inserted FIRST, so the scheduler evaluates it before the control check.
  const pinnedChk = await insChk.insert(org3, 'pinned.example:443', now());
  await q.prepare('INSERT INTO check_locations (check_id, location_id) VALUES (?, ?)')
    .run(pinnedChk, remoteLoc);
  const anywhereChk = await insChk.insert(org3, 'anywhere.example:443', now());

  // Driven, not slept on: the scheduler's own 5s tick is what exercises tick(),
  // which is not exported — so the wait is on the CONTROL check having been
  // called, with a deadline that turns a dead scheduler into a FAIL.
  await until(() => ranLocally.includes(anywhereChk), 15000);
  chk('the scheduler runs a check with no location assignment on the local probe',
    ranLocally.includes(anywhereChk), `called: ${JSON.stringify(ranLocally)}`);
  chk('…and does NOT run a check assigned to a remote location on the local probe',
    !ranLocally.includes(pinnedChk), `called: ${JSON.stringify(ranLocally)}`);
  const localLoc3 = await q.prepare("SELECT id FROM synthetic_locations WHERE kind = 'local' AND org_id = ?")
    .get(org3);
  chk('…the org did get its own local probe location, so the guard is what stopped it '
    + '(not a missing location)', !!localLoc3, 'no local location for the probe org');
  /* Being CALLED and having WRITTEN are two different instants, and only the
   * first one is what `ranLocally` records. The runner's result row is written
   * after it returns, on a promise nobody here holds — so reading the table
   * straight after the wait above asks a question the scheduler has not
   * finished answering. It passed on every machine anyone ran it on and failed
   * on a loaded CI runner, which is the whole signature of this mistake.
   *
   * So the row is waited for, and the ABSENCE below is asserted afterwards:
   * once the unassigned check's result has landed, the pinned one has had at
   * least as long to write a wrong one, which is a stronger claim than reading
   * both at an arbitrary moment. */
  const countAt = async (id, locId) => (await q.prepare(
    'SELECT COUNT(*) c FROM synthetic_results WHERE check_id = ? AND location_id = ?')
    .get(id, locId)).c;
  await untilAsync(async () => (await countAt(anywhereChk, localLoc3 ? localLoc3.id : -1)) >= 1, 15000);
  const anywhereResults = await countAt(anywhereChk, localLoc3 ? localLoc3.id : -1);
  chk('…while the unassigned check recorded its result AT the local location',
    anywhereResults >= 1, `${anywhereResults} results`);
  const pinnedResults = (await q.prepare('SELECT COUNT(*) c FROM synthetic_results WHERE check_id = ?')
    .get(pinnedChk)).c;
  chk('…so the pinned check has no result rows at all',
    pinnedResults === 0, `${pinnedResults} results written`);

  // The same guard sits in runAllNow(), which "check now" in the UI calls — a
  // separate line that a mutation of tick() alone leaves untouched, and vice
  // versa. This one is fully driven: it awaits every runner before returning.
  ranLocally.length = 0;
  await synthetics.runAllNow(org3);
  chk('"run all now" also runs the unassigned check',
    ranLocally.includes(anywhereChk), `called: ${JSON.stringify(ranLocally)}`);
  chk('…and also skips the one assigned to a remote location',
    !ranLocally.includes(pinnedChk), `called: ${JSON.stringify(ranLocally)}`);

  report();
}

main().catch(die);
