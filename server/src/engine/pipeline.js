'use strict';
// Log → event pipeline: classify lines, score severity, dedupe into events,
// auto-open cases, notify the alert engine and SSE stream.
//
// Storage goes through the async shim. `getOrgSetting` stays on the spine and
// stays synchronous (docs/POSTGRES-MIGRATION-PLAN.md § the spine), which is what
// keeps `classify()` — called once per ingested line — a plain function.
const q = require('../db/shim');
const logs = require('../db/log-store');   // log LINES may not be in `q` — see db/log-store.js
const { getOrgSetting } = require('../db');
const { now, DEFAULT_ORG_ID } = require('../util');

// Built-in classifiers, evaluated in order; first match wins.
// Custom classifiers are per-organization (org_settings key 'classifiers',
// JSON array of {pattern, flags, name, severity, targetGroup}) and take
// precedence over the built-ins. Managed via /api/admin/pipeline/classifiers.
const BUILTIN_CLASSIFIERS = [
  { re: /ddos[_ ]?(underattack|attack)[\s:]*([^\s]*)/i, name: 'ddos', sev: 95, target: 2 },
  { re: /out of memory|oom[- _]?kill|memory cgroup out of memory/i, name: 'out_of_memory', sev: 85 },
  { re: /kernel panic|watchdog: BUG|EXT4-fs error|I\/O error/i, name: 'kernel_error', sev: 88 },
  { re: /segfault|core dumped/i, name: 'crash', sev: 70 },
  { re: /rpm ping (failed|too high)[\s:]*\(?([^)\s]*)/i, name: 'rpm_ping', sev: 72, target: 2 },
  { re: /BGP.*(down|Idle)|bgp neighbor.*down/i, name: 'bgp', sev: 75 },
  { re: /port\s+(\S+).*\b(down|low-warning|high-warning)/i, name: 'port', sev: 55, target: 1 },
  { re: /link (down|flap)/i, name: 'link', sev: 55 },
  { re: /smartd|SMART (usage|Prefailure)|BACK UP DATA NOW/i, name: 'smartd', sev: 65 },
  { re: /disk (full|usage)|no space left on device/i, name: 'disk_full', sev: 78 },
  { re: /certificate.*(expir|renew.*fail)|cert_renew_failed/i, name: 'cert_renew_failed', sev: 58 },
  { re: /TLS Error|handshake failed/i, name: 'tls_error', sev: 30 },
  { re: /authentication failure|failed password|invalid user/i, name: 'auth_failure', sev: 35 },
  { re: /login (successful|succeeded)|session opened/i, name: 'mgmtloginout', sev: 22 },
  { re: /synthetic_check_failed[\s:]*(\S*)/i, name: 'synthetic_check_failed', sev: 70, target: 1 },
  { re: /snmp_unreachable[\s:]*(\S*)/i, name: 'snmp_unreachable', sev: 75, target: 1 },
  { re: /agent_offline[\s:]*(\S*)/i, name: 'agent_offline', sev: 68, target: 1 },
  { re: /\berror\b|\bfailed\b|\bfailure\b/i, name: 'error', sev: 30 },
  { re: /\bwarn(ing)?\b/i, name: 'warning', sev: 22 },
];

// compiled custom classifiers per org, invalidated by loadClassifiers()
const customCache = new Map();
function customClassifiersFor(orgId) {
  let list = customCache.get(orgId);
  if (list) return list;
  list = [];
  try {
    const raw = getOrgSetting(orgId, 'classifiers');
    if (raw) {
      list = JSON.parse(raw)
        // `enabled: false` is a DRAFT — stored, listed and testable, but not part
        // of the chain. Absent means enabled, so every rule written before drafts
        // existed stays live.
        .filter((c) => c.enabled !== false)
        .map((c) => ({
          re: new RegExp(c.pattern, c.flags || 'i'),
          name: c.name, sev: c.severity, target: c.targetGroup,
        }));
    }
  } catch { list = []; }
  customCache.set(orgId, list);
  return list;
}
// call after saving an org's classifiers (no arg: drop every org's cache)
function loadClassifiers(orgId) {
  if (orgId == null) customCache.clear();
  else customCache.delete(orgId);
}

// Map syslog severity (0..7) to a score floor so explicitly-critical syslog
// lines create events even without a pattern match.
const SYSLOG_FLOOR = [92, 88, 82, 55, 35, 15, 0, 0];

function classify(line, syslogSev, orgId = DEFAULT_ORG_ID) {
  for (const [source, list] of [['custom', customClassifiersFor(orgId)], ['builtin', BUILTIN_CLASSIFIERS]]) {
    for (const c of list) {
      const m = c.re.exec(line);
      if (m) {
        return {
          name: c.name,
          severity: c.sev,
          target: c.target && m[c.target] ? String(m[c.target]).slice(0, 200) : null,
          source, pattern: c.re.source,
        };
      }
    }
  }
  const floor = SYSLOG_FLOOR[Math.min(7, Math.max(0, syslogSev ?? 6))];
  if (floor >= 20) {
    return { name: 'syslog_sev' + syslogSev, severity: floor, target: null, source: 'syslog', pattern: null };
  }
  return null;
}

// serializable rule listing for the admin UI (never exposes compiled regexes)
function listClassifiers(orgId) {
  const custom = [];
  try {
    const raw = getOrgSetting(orgId, 'classifiers');
    if (raw) custom.push(...JSON.parse(raw));
  } catch { /* corrupt value behaves like "none" — same as classify() */ }
  return {
    builtin: BUILTIN_CLASSIFIERS.map((c) => ({
      pattern: c.re.source, flags: c.re.flags, name: c.name,
      severity: c.sev, targetGroup: c.target ?? null,
    })),
    custom,
  };
}

/* The log write moved to src/db/log-store.js when a second engine could hold it
 * — with the batching and the reasoning behind it. What stayed here is the
 * bucket rollup below, which is Postgres either way.
 */
const sqlCache = new Map();
function batchSql(kind, n, build) {
  const key = `${kind}:${n}`;
  let sql = sqlCache.get(key);
  if (sql === undefined) { sql = build(n); sqlCache.set(key, sql); }
  return sql;
}
// THE dedupe write. It was SELECT-then-INSERT-or-UPDATE, racing the partial
// unique index `idx_events_dedupe_active` instead of cooperating with it: under
// Postgres the loser of that race raises 23505, and the abort takes the whole
// enclosing transaction with it — a 500-line ingest batch lost because two of
// its lines happened to share a dedupe key. As one statement the index decides,
// and both callers get the row back whichever branch ran — so what `emit()`
// hands the alert engine and the SSE stream is now the row as written, not the
// hand-patched pre-image that used to carry the PREVIOUS occurrence's
// description while the database already held the new one.
//
// The conflict target repeats the index's `WHERE status = 'active'` because the
// index is PARTIAL; SQLite and Postgres both need that to match it, and without
// it a finished event would no longer be re-openable as a fresh row.
//
// `severity` is a CASE, not SQLite's two-argument `MAX(severity, ?)` — that one
// is a hard parse error in Postgres, whose MAX is aggregate-only. `hits` and
// `severity` are table-qualified: an unqualified `x = x + 1` is ambiguous in
// Postgres. `description` keeps the stored text when the caller sends none,
// which is what ingestEvent's `newDesc || ev.description` used to do in JS.
const upsertEvent = q.prepare(`INSERT INTO events
  (org_id, dedupe_key, name, device, ip, target, description, severity, hits, first_seen, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  ON CONFLICT (org_id, dedupe_key) WHERE status = 'active' DO UPDATE SET
    hits = events.hits + 1,
    last_seen = excluded.last_seen,
    severity = CASE WHEN excluded.severity > events.severity
      THEN excluded.severity ELSE events.severity END,
    description = COALESCE(NULLIF(excluded.description, ''), events.description)
  RETURNING *`);
/* The per-minute rollup, AGGREGATED IN JS to one row per (event, minute) before
 * anything is written. It used to be one statement per matched line, which a
 * 500-line batch hammering a single flapping device turns into 500 updates of
 * one row — and their order is data-dependent, which is the shape two concurrent
 * batches deadlock on under Postgres. Folding first also makes the multi-row
 * form legal at all: `ON CONFLICT … DO UPDATE` may not touch the same row twice
 * within one statement, so the fold is a correctness precondition and not only
 * an optimisation.
 *
 * `excluded.count` rather than the literal `+ 1` the single-row version carried:
 * the row now brings its own count. `event_buckets.count` stays TABLE-QUALIFIED
 * — an unqualified `count = count + …` is ambiguous in Postgres.
 */
const BUCKET_TUPLE = '(?, ?, ?)';
const BUCKET_BATCH = 200;
const bucketInsertSql = (n) => batchSql('bucket', n, (rows) => (
  `INSERT INTO event_buckets (event_id, bucket, count) VALUES ${
    new Array(rows).fill(BUCKET_TUPLE).join(', ')}
  ON CONFLICT(event_id, bucket) DO UPDATE SET count = event_buckets.count + excluded.count`));

/** @param {Array<{id:number, bucket:number, n:number}>} rows one entry per (event, minute) */
async function writeBuckets(rows) {
  for (let i = 0; i < rows.length; i += BUCKET_BATCH) {
    const chunk = rows.slice(i, i + BUCKET_BATCH);
    const args = [];
    for (const r of chunk) args.push(r.id, r.bucket, r.n);
    await q.run(bucketInsertSql(chunk.length), ...args);
  }
}
const insCase = q.prepare(`INSERT INTO cases (org_id, event_id, name, device, severity, status, opened_at)
  VALUES (?, ?, ?, ?, ?, 'open', ?)`);
const findOpenCaseForEvent = q.prepare(
  "SELECT id FROM cases WHERE event_id = ? AND status != 'closed'");
const bumpStats = q.prepare(`INSERT INTO ingest_stats (org_id, bucket, lines, bytes, events)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(org_id, bucket) DO UPDATE SET lines = ingest_stats.lines + excluded.lines,
    bytes = ingest_stats.bytes + excluded.bytes, events = ingest_stats.events + excluded.events`);
// Second counter, one minute wide. It exists because an hourly average is not a
// peak: a 30s burst of 5k lines/s shows up as ~42 lines/s once divided over its
// hour, and that is the number someone would size the ingest on. Pruned to 48h
// (retention.js) — 1440 rows per org per day.
const bumpMinutes = q.prepare(`INSERT INTO ingest_minutes (org_id, bucket, lines, bytes)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(org_id, bucket) DO UPDATE SET lines = ingest_minutes.lines + excluded.lines,
    bytes = ingest_minutes.bytes + excluded.bytes`);
const hourBucket = (t) => Math.floor(t / 3600000) * 3600000;
const minuteBucket = (t) => Math.floor(t / 60000) * 60000;

const CASE_THRESHOLD = 60;

// Listeners: alert engine + SSE hub subscribe here.
const listeners = { event: [], log: [] };
function on(type, fn) { listeners[type].push(fn); }
function emit(type, payload) {
  for (const fn of listeners[type]) { try { fn(payload); } catch (e) { console.error('listener error', e); } }
}

/**
 * Ingest a batch of log lines for one organization.
 *
 * Two passes, and the split is deliberate. The first touches no storage at all:
 * it sanitises, classifies (a regex walk that can be slow on a custom rule) and
 * builds the rows. Only the second opens the transaction — so the write window
 * is as short as the writes, rather than as long as the request. Under
 * better-sqlite3 that is tidiness; under node-postgres the transaction pins a
 * pooled connection for its whole life, and holding one across 500 lines' worth
 * of regex evaluation is how a pool of ten serves nine.
 *
 * @param {Array<{ts?:number, device:string, line:string, sev?:number, meta?:object}>} entries
 * @param {string} source label (api key name, 'agent:xyz', 'snmp', 'synthetics')
 * @param {string} orgId owning organization
 * @returns {Promise<{accepted:number, events:number}>}
 */
async function ingestLogs(entries, source, orgId = DEFAULT_ORG_ID) {
  const t = now();
  let bytes = 0;
  const logRows = [];        // 7-element parameter tuples, one per accepted line
  const matches = [];        // one per classified line, in arrival order
  const touchedEvents = [];
  const emittedLogs = [];

  for (const e of entries) {
    const device = String(e.device || 'unknown').slice(0, 100);
    const line = String(e.line || '').slice(0, 8192);
    if (!line) continue;
    const sev = Number.isInteger(e.sev) ? Math.min(7, Math.max(0, e.sev)) : 6;
    let ts = Number.isFinite(e.ts) ? e.ts : t;
    if (ts < 1e12) ts *= 1000; // seconds → ms
    if (ts > t + 5 * 60 * 1000 || ts < t - 30 * 24 * 3600 * 1000) ts = t; // reject silly timestamps
    logRows.push({ orgId, ts, device, line, sev, source,
      meta: e.meta ? JSON.stringify(e.meta).slice(0, 2000) : null });
    bytes += Buffer.byteLength(line);
    const cls = classify(line, sev, orgId);
    // `matched` lets Scout mine only lines no classifier knows
    emittedLogs.push({ orgId, ts, device, line, sev, matched: !!cls });
    if (!cls) continue;
    const ip = e.meta && typeof e.meta.ip === 'string' ? e.meta.ip.slice(0, 45) : null;
    matches.push({
      ts, device, ip, cls,
      dedupe: `${cls.name}|${device}|${cls.target || ''}`,
      desc: (cls.target ? `${cls.name} ${cls.target}` : line).slice(0, 300),
    });
  }
  const accepted = logRows.length;

  if (accepted) {
    /* THE LINES GO FIRST WHEN THEY ARE NOT IN POSTGRES, AND THE ORDER IS THE
     * WHOLE DESIGN OF THIS BRANCH.
     *
     * With one engine this was a single transaction: lines and the events
     * derived from them committed together or not at all. ClickHouse has no
     * transaction the Postgres one can join, so that guarantee is gone and what
     * replaces it is a choice about WHICH failure we prefer. There are two:
     *
     *   lines first  — if the transaction then fails, the sender gets an error
     *                  and retries, so the lines are written TWICE and the
     *                  events once. Visible duplication, nothing lost.
     *   lines after  — if the write then fails, the sender was already told
     *                  `accepted: 500` and the lines are simply gone. Silent
     *                  loss, and undetectable from the outside.
     *
     * Lines first. This codebase treats a silent wrong answer as the worst
     * outcome available, and "we said we accepted 500 lines and kept none" is
     * exactly that — a customer would find it by noticing an event whose
     * evidence is missing, weeks later, with no error anywhere to explain it.
     * Duplicated lines are noise a reader can see, they do not affect event
     * dedupe (which keys on the classifier result, not on the line), and
     * retention removes them on the same schedule as everything else.
     *
     * It also shortens the transaction by the length of a network round trip,
     * which is the opposite of the usual cost of moving work out of one.
     *
     * On Postgres `logs.transactional` is true and none of this applies: the
     * insert joins the transaction below exactly as it always did. */
    if (!logs.transactional) await logs.insert(logRows);

    await q.withTx(async () => {
      if (logs.transactional) await logs.insert(logRows);
      // The rollup is folded here and written once below — see writeBuckets.
      /* Upserted in DEDUPE-KEY order, not arrival order — this is a lock-ordering
       * fix, not a tidy-up.
       *
       * Each iteration takes a row lock on one `events` row and holds it to the
       * end of the transaction. In arrival order the sequence is data-dependent,
       * so two concurrent batches that both mention devices A and B can take
       * them as (A,B) and (B,A) — a cycle. PostgreSQL breaks it by killing one
       * transaction, which rolls the whole batch back and answers the sender a
       * 500. Measured before this line existed: two senders writing about ONE
       * shared device with two event types managed **153 lines/s with 79% of
       * batches refused**, against 16,700 lines/s when their devices were
       * disjoint. Sorting removes the cycle because every transaction now takes
       * the same rows in the same order.
       *
       * This is the same defect that was already fixed one loop below, where
       * folding `event_buckets` in JS removed ITS data-dependent update order.
       * That fix was made for the "cannot affect row a second time" error and
       * happened to fix the ordering too; this loop was left beside it.
       *
       * The sort changes no count: every match still upserts, so `hits`,
       * `touchedEvents.length` and the number of `emit('event')` calls are
       * exactly what they were. Only the ORDER of the emitted events changes,
       * within a single batch, which no consumer defines an expectation on.
       *
       * `localeCompare` is deliberately NOT used — it is locale-dependent, and a
       * lock order that varies with the server's locale would reintroduce the
       * cycle between two instances configured differently.
       */
      const ordered = [...matches].sort((a, b) => (a.dedupe < b.dedupe ? -1 : a.dedupe > b.dedupe ? 1 : 0));
      const buckets = new Map();
      for (const m of ordered) {
        const ev = await upsertEvent.get(orgId, m.dedupe, m.cls.name, m.device, m.ip,
          m.cls.target, m.desc, m.cls.severity, m.ts, m.ts);
        // `hits === 1` IS the insert branch: hits starts at 1 and the upsert only
        // ever increments it, so a bumped row can never come back at 1. Opening a
        // case stays a first-sighting action — an escalation onto an existing
        // event has never opened one and must not start now.
        if (ev.hits === 1 && m.cls.severity >= CASE_THRESHOLD) {
          const existing = await findOpenCaseForEvent.get(ev.id);
          if (!existing) await insCase.run(orgId, ev.id, m.cls.name, m.device, m.cls.severity, m.ts);
        }
        const bucket = Math.floor(m.ts / 60000);
        const key = `${ev.id}|${bucket}`;
        const seen = buckets.get(key);
        if (seen) seen.n++;
        else buckets.set(key, { id: ev.id, bucket, n: 1 });
        touchedEvents.push(ev);
      }
      await writeBuckets([...buckets.values()]);
      await bumpStats.run(orgId, hourBucket(t), accepted, bytes, touchedEvents.length);
      await bumpMinutes.run(orgId, minuteBucket(t), accepted, bytes);
    });
  }

  for (const l of emittedLogs) emit('log', l);
  for (const ev of touchedEvents) emit('event', ev);
  return { accepted, events: touchedEvents.length };
}

// Direct event ingestion (webhooks, Sentry, engines) — bypasses log storage optionally.
/** @returns {Promise<{accepted:number, events:number}>} */
async function ingestEvent({ name, device, target, description, severity, ip, ts }, source, alsoLog = true, orgId = DEFAULT_ORG_ID) {
  const entryLine = description || `${name} ${target || ''}`.trim();
  if (alsoLog) {
    return ingestLogs([{
      ts, device, line: `${name}: ${entryLine}`,
      sev: severity >= 80 ? 2 : severity >= 60 ? 3 : severity >= 40 ? 4 : 5,
      meta: ip ? { ip } : undefined,
    }], source, orgId);
  }
  // classify() may not know this name; insert/bump the event directly.
  const t = Number.isFinite(ts) ? (ts < 1e12 ? ts * 1000 : ts) : now();
  const sev = Math.min(100, Math.max(0, Math.round(severity ?? 50)));
  const dedupe = `${name}|${device}|${target || ''}`;
  let ev;
  await q.withTx(async () => {
    // Same Shape B rewrite as ingestLogs above, and the same reason: this path
    // carries the vendor/synthetic/on-call/reputation engines, which re-raise
    // one dedupe key over and over.
    ev = await upsertEvent.get(orgId, dedupe, name, device, ip || null, target || null,
      (description || '').slice(0, 300), sev, t, t);
    if (ev.hits === 1 && sev >= CASE_THRESHOLD) await insCase.run(orgId, ev.id, name, device, sev, t);
    await writeBuckets([{ id: ev.id, bucket: Math.floor(t / 60000), n: 1 }]);
    await bumpStats.run(orgId, hourBucket(t), 0, 0, 1);
  });
  emit('event', ev);
  return { accepted: 1, events: 1 };
}

/**
 * Dry-run a rule against the logs already stored — "what would this have done
 * yesterday", instead of "does it match this one line I pasted".
 *
 * The counts only mean something if the rule is placed where it will really sit.
 * A new custom rule is APPENDED, and `classify()` walks custom → builtin →
 * syslog floor, first match wins. So per line there are three outcomes, and they
 * are the three numbers an admin needs before switching a draft live:
 *
 *   shadowed  an existing CUSTOM rule already matches → the new rule never fires,
 *             however well it matches. This is the failure the tester cannot show.
 *   takeover  a builtin (or the syslog floor) classifies it today → the line keeps
 *             producing an event, under the new name/severity.
 *   fresh     nothing classifies it today → genuinely new events.
 *
 * Bounded on purpose: newest N lines, and a wall-clock budget, because the pattern
 * can come from a text field and a bad regex over 20k lines is a stalled request.
 * Both limits are reported rather than silently applied.
 */
const DRYRUN_MAX_LINES = 20000;
const DRYRUN_BUDGET_MS = 2000;



async function backtest({ orgId = DEFAULT_ORG_ID, pattern, flags = 'i', name = 'rule', severity = 50,
  targetGroup = null, hours = 24 }) {
  let re;
  try { re = new RegExp(pattern, flags); } catch (e) { throw new Error(`invalid pattern: ${e.message}`); }
  const since = now() - Math.min(720, Math.max(1, hours)) * 3600000;
  const rows = await logs.recent({ orgId, since, limit: DRYRUN_MAX_LINES });

  const out = {
    hours, scanned: 0, matched: 0, shadowed: 0, takeover: 0, fresh: 0,
    events: 0, cases: 0, samples: [],
    truncated: rows.length >= DRYRUN_MAX_LINES, timedOut: false,
  };
  const keys = new Set();
  const caseKeys = new Set();
  const started = Date.now();
  for (const r of rows) {
    if (out.scanned % 500 === 0 && Date.now() - started > DRYRUN_BUDGET_MS) {
      out.timedOut = true;
      break;
    }
    out.scanned++;
    const m = re.exec(r.line);
    if (!m) continue;
    out.matched++;
    const current = classify(r.line, r.sev, orgId);
    if (current && current.source === 'custom') { out.shadowed++; continue; }
    if (current) out.takeover++; else out.fresh++;
    const target = targetGroup && m[targetGroup] ? String(m[targetGroup]).slice(0, 200) : null;
    const key = `${name}|${r.device}|${target || ''}`;
    keys.add(key);
    if (severity >= CASE_THRESHOLD) caseKeys.add(key);
    if (out.samples.length < 5) {
      out.samples.push({
        ts: r.ts, device: r.device, line: r.line.slice(0, 300), target,
        replaces: current ? { name: current.name, source: current.source } : null,
      });
    }
  }
  out.events = keys.size;
  out.cases = caseKeys.size;
  return out;
}

module.exports = {
  ingestLogs, ingestEvent, classify, loadClassifiers, listClassifiers, backtest, on, CASE_THRESHOLD,
};
