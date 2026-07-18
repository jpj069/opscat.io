'use strict';
// Log → event pipeline: classify lines, score severity, dedupe into events,
// auto-open cases, notify the alert engine and SSE stream.
const { db, getSetting } = require('../db');
const { now } = require('../util');

// Built-in classifiers, evaluated in order; first match wins.
// Custom classifiers can be added via settings key 'classifiers' (JSON array
// of {pattern, flags, name, severity, targetGroup}) and take precedence.
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

let customClassifiers = null;
function loadClassifiers() {
  try {
    const raw = getSetting('classifiers');
    customClassifiers = raw
      ? JSON.parse(raw).map((c) => ({
          re: new RegExp(c.pattern, c.flags || 'i'),
          name: c.name, sev: c.severity, target: c.targetGroup,
        }))
      : [];
  } catch { customClassifiers = []; }
}
loadClassifiers();

// Map syslog severity (0..7) to a score floor so explicitly-critical syslog
// lines create events even without a pattern match.
const SYSLOG_FLOOR = [92, 88, 82, 55, 35, 15, 0, 0];

function classify(line, syslogSev) {
  for (const c of [...(customClassifiers || []), ...BUILTIN_CLASSIFIERS]) {
    const m = c.re.exec(line);
    if (m) {
      return {
        name: c.name,
        severity: c.sev,
        target: c.target && m[c.target] ? String(m[c.target]).slice(0, 200) : null,
      };
    }
  }
  const floor = SYSLOG_FLOOR[Math.min(7, Math.max(0, syslogSev ?? 6))];
  if (floor >= 20) return { name: 'syslog_sev' + syslogSev, severity: floor, target: null };
  return null;
}

const insLog = db.prepare(
  'INSERT INTO logs (org_id, ts, device, line, sev, source, meta) VALUES (?, ?, ?, ?, ?, ?, ?)');
const findActiveEvent = db.prepare(
  "SELECT * FROM events WHERE org_id = ? AND dedupe_key = ? AND status = 'active'");
const insEvent = db.prepare(`INSERT INTO events
  (org_id, dedupe_key, name, device, ip, target, description, severity, hits, first_seen, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`);
const bumpEvent = db.prepare(`UPDATE events SET hits = hits + 1, last_seen = ?,
  severity = MAX(severity, ?), description = ? WHERE id = ?`);
const bumpBucket = db.prepare(`INSERT INTO event_buckets (event_id, bucket, count) VALUES (?, ?, 1)
  ON CONFLICT(event_id, bucket) DO UPDATE SET count = count + 1`);
const insCase = db.prepare(`INSERT INTO cases (org_id, event_id, name, device, severity, status, opened_at)
  VALUES (?, ?, ?, ?, ?, 'open', ?)`);
const findOpenCaseForEvent = db.prepare(
  "SELECT id FROM cases WHERE event_id = ? AND status != 'closed'");

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
function ingestLogs(entries, source, orgId = 1) {
  const t = now();
  let accepted = 0;
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
      emittedLogs.push({ orgId, ts, device, line, sev });

      const cls = classify(line, sev);
      if (!cls) continue;
      const ip = e.meta && typeof e.meta.ip === 'string' ? e.meta.ip.slice(0, 45) : null;
      const dedupe = `${cls.name}|${device}|${cls.target || ''}`;
      const desc = (cls.target ? `${cls.name} ${cls.target}` : line).slice(0, 300);
      let ev = findActiveEvent.get(orgId, dedupe);
      if (ev) {
        bumpEvent.run(ts, cls.severity, desc, ev.id);
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
  })();

  for (const l of emittedLogs) emit('log', l);
  for (const ev of touchedEvents) emit('event', ev);
  return { accepted, events: touchedEvents.length };
}

// Direct event ingestion (webhooks, Sentry, engines) — bypasses log storage optionally.
function ingestEvent({ name, device, target, description, severity, ip, ts }, source, alsoLog = true, orgId = 1) {
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
      bumpEvent.run(t, sev, (description || '').slice(0, 300) || ev.description, ev.id);
      ev = { ...ev, hits: ev.hits + 1, last_seen: t, severity: Math.max(ev.severity, sev) };
    } else {
      const info = insEvent.run(orgId, dedupe, name, device, ip || null, target || null,
        (description || '').slice(0, 300), sev, t, t);
      ev = { id: info.lastInsertRowid, org_id: orgId, name, device, ip, target, description, severity: sev,
        hits: 1, status: 'active', first_seen: t, last_seen: t, dedupe_key: dedupe };
      if (sev >= CASE_THRESHOLD) insCase.run(orgId, ev.id, name, device, sev, t);
    }
    bumpBucket.run(ev.id, Math.floor(t / 60000));
  })();
  emit('event', ev);
  return { accepted: 1, events: 1 };
}

module.exports = { ingestLogs, ingestEvent, classify, loadClassifiers, on, CASE_THRESHOLD };
