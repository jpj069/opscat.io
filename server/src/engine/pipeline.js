'use strict';
// Log → event pipeline: classify lines, score severity, dedupe into events,
// auto-open cases, notify the alert engine and SSE stream.
const { db, getOrgSetting } = require('../db');
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

const insLog = db.prepare(
  'INSERT INTO logs (org_id, ts, device, line, sev, source, meta) VALUES (?, ?, ?, ?, ?, ?, ?)');
const findActiveEvent = db.prepare(
  "SELECT * FROM events WHERE org_id = ? AND dedupe_key = ? AND status = 'active'");
const insEvent = db.prepare(`INSERT INTO events
  (org_id, dedupe_key, name, device, ip, target, description, severity, hits, first_seen, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`);
// `MAX(severity, ?)` was SQLite's TWO-ARGUMENT scalar max. Postgres has no such
// function — `MAX` there is an aggregate, so this is a hard parse error, on the
// hottest write path in the product. CASE is the portable spelling and compiles
// to the same thing; it costs a second bind of the same value.
const bumpEvent = db.prepare(`UPDATE events SET hits = hits + 1, last_seen = ?,
  severity = CASE WHEN ? > severity THEN ? ELSE severity END,
  description = ? WHERE id = ?`);
const bumpBucket = db.prepare(`INSERT INTO event_buckets (event_id, bucket, count) VALUES (?, ?, 1)
  ON CONFLICT(event_id, bucket) DO UPDATE SET count = event_buckets.count + 1`);
const insCase = db.prepare(`INSERT INTO cases (org_id, event_id, name, device, severity, status, opened_at)
  VALUES (?, ?, ?, ?, ?, 'open', ?)`);
const findOpenCaseForEvent = db.prepare(
  "SELECT id FROM cases WHERE event_id = ? AND status != 'closed'");
const bumpStats = db.prepare(`INSERT INTO ingest_stats (org_id, bucket, lines, bytes, events)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(org_id, bucket) DO UPDATE SET lines = ingest_stats.lines + excluded.lines,
    bytes = ingest_stats.bytes + excluded.bytes, events = ingest_stats.events + excluded.events`);
// Second counter, one minute wide. It exists because an hourly average is not a
// peak: a 30s burst of 5k lines/s shows up as ~42 lines/s once divided over its
// hour, and that is the number someone would size the ingest on. Pruned to 48h
// (retention.js) — 1440 rows per org per day.
const bumpMinutes = db.prepare(`INSERT INTO ingest_minutes (org_id, bucket, lines, bytes)
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
 * @param {Array<{ts?:number, device:string, line:string, sev?:number, meta?:object}>} entries
 * @param {string} source label (api key name, 'agent:xyz', 'snmp', 'synthetics')
 * @param {number} orgId owning organization
 * @returns {{accepted:number, events:number}}
 */
function ingestLogs(entries, source, orgId = DEFAULT_ORG_ID) {
  const t = now();
  let accepted = 0;
  let bytes = 0;
  const touchedEvents = [];
  const emittedLogs = [];

  db.transaction(() => {
    for (const e of entries) {
      const device = String(e.device || 'unknown').slice(0, 100);
      const line = String(e.line || '').slice(0, 8192);
      if (!line) continue;
      const sev = Number.isInteger(e.sev) ? Math.min(7, Math.max(0, e.sev)) : 6;
      let ts = Number.isFinite(e.ts) ? e.ts : t;
      if (ts < 1e12) ts *= 1000; // seconds → ms
      if (ts > t + 5 * 60 * 1000 || ts < t - 30 * 24 * 3600 * 1000) ts = t; // reject silly timestamps
      insLog.run(orgId, ts, device, line, sev, source, e.meta ? JSON.stringify(e.meta).slice(0, 2000) : null);
      accepted++;
      bytes += Buffer.byteLength(line);
      const cls = classify(line, sev, orgId);
      // `matched` lets Scout mine only lines no classifier knows
      emittedLogs.push({ orgId, ts, device, line, sev, matched: !!cls });
      if (!cls) continue;
      const ip = e.meta && typeof e.meta.ip === 'string' ? e.meta.ip.slice(0, 45) : null;
      const dedupe = `${cls.name}|${device}|${cls.target || ''}`;
      const desc = (cls.target ? `${cls.name} ${cls.target}` : line).slice(0, 300);
      let ev = findActiveEvent.get(orgId, dedupe);
      if (ev) {
        bumpEvent.run(ts, cls.severity, cls.severity, desc, ev.id);
        ev = { ...ev, hits: ev.hits + 1, last_seen: ts, severity: Math.max(ev.severity, cls.severity) };
      } else {
        const info = insEvent.run(orgId, dedupe, cls.name, device, ip, cls.target, desc, cls.severity, ts, ts);
        ev = {
          id: info.lastInsertRowid, org_id: orgId, dedupe_key: dedupe, name: cls.name, device, ip,
          target: cls.target, description: desc, severity: cls.severity, hits: 1,
          status: 'active', first_seen: ts, last_seen: ts,
        };
        if (cls.severity >= CASE_THRESHOLD) {
          const existing = findOpenCaseForEvent.get(ev.id);
          if (!existing) insCase.run(orgId, ev.id, cls.name, device, cls.severity, ts);
        }
      }
      bumpBucket.run(ev.id, Math.floor(ts / 60000));
      touchedEvents.push(ev);
    }
    if (accepted) {
      bumpStats.run(orgId, hourBucket(t), accepted, bytes, touchedEvents.length);
      bumpMinutes.run(orgId, minuteBucket(t), accepted, bytes);
    }
  })();

  for (const l of emittedLogs) emit('log', l);
  for (const ev of touchedEvents) emit('event', ev);
  return { accepted, events: touchedEvents.length };
}

// Direct event ingestion (webhooks, Sentry, engines) — bypasses log storage optionally.
function ingestEvent({ name, device, target, description, severity, ip, ts }, source, alsoLog = true, orgId = DEFAULT_ORG_ID) {
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
  db.transaction(() => {
    ev = findActiveEvent.get(orgId, dedupe);
    if (ev) {
      bumpEvent.run(t, sev, sev, (description || '').slice(0, 300) || ev.description, ev.id);
      ev = { ...ev, hits: ev.hits + 1, last_seen: t, severity: Math.max(ev.severity, sev) };
    } else {
      const info = insEvent.run(orgId, dedupe, name, device, ip || null, target || null,
        (description || '').slice(0, 300), sev, t, t);
      ev = { id: info.lastInsertRowid, org_id: orgId, name, device, ip, target, description, severity: sev,
        hits: 1, status: 'active', first_seen: t, last_seen: t, dedupe_key: dedupe };
      if (sev >= CASE_THRESHOLD) insCase.run(orgId, ev.id, name, device, sev, t);
    }
    bumpBucket.run(ev.id, Math.floor(t / 60000));
    bumpStats.run(orgId, hourBucket(t), 0, 0, 1);
  })();
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

function backtest({ orgId = DEFAULT_ORG_ID, pattern, flags = 'i', name = 'rule', severity = 50,
  targetGroup = null, hours = 24 }) {
  let re;
  try { re = new RegExp(pattern, flags); } catch (e) { throw new Error(`invalid pattern: ${e.message}`); }
  const since = now() - Math.min(720, Math.max(1, hours)) * 3600000;
  const rows = db.prepare(`SELECT ts, device, line, sev FROM logs
    WHERE org_id = ? AND ts >= ? ORDER BY ts DESC LIMIT ?`).all(orgId, since, DRYRUN_MAX_LINES);

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
