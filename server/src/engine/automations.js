'use strict';
// Automation engine: matches pipeline events against per-org automations and
// runs their actions. Action types (v1):
//   close_event  — lifecycle: a "clear" event finishes the matching open
//                  "raise" event (same org+device, same target when
//                  matchTarget) and closes its open case
//   assign_case  — assign the triggering event's case to a user
//   webhook      — POST a JSON payload to a URL (SSRF-guarded, see runWebhook)
// Every executed action lands in audit_log as 'automation_run' with
// user_id NULL (system actor) so the whole feature stays auditable.
const { db } = require('../db');
const { now } = require('../util');
const sec = require('../security');
const pipeline = require('./pipeline');
const { safeFetch } = require('../lib/ssrf');

const getAutomations = db.prepare('SELECT * FROM automations WHERE org_id = ? AND enabled = 1');
const getFire = db.prepare('SELECT fired_at FROM automation_fires WHERE automation_id = ? AND dedupe_key = ?');
const setFire = db.prepare(`INSERT INTO automation_fires (automation_id, dedupe_key, fired_at) VALUES (?, ?, ?)
  ON CONFLICT(automation_id, dedupe_key) DO UPDATE SET fired_at = excluded.fired_at`);
const findRaiseEvents = db.prepare(`SELECT id, name, device, target, severity FROM events
  WHERE org_id = ? AND name = ? AND device = ? AND status = 'active'`);
const finishEvent = db.prepare(`UPDATE events SET status = 'finished', finished_at = ? WHERE id = ?`);
const findOpenCase = db.prepare("SELECT id, note FROM cases WHERE event_id = ? AND status != 'closed'");
const closeCase = db.prepare(`UPDATE cases SET status = 'closed', closed_at = ?,
  note = COALESCE(note || char(10), '') || ? WHERE id = ?`);
const assignCase = db.prepare(`UPDATE cases SET assigned_user_id = ?,
  status = CASE WHEN status = 'open' THEN 'assigned' ELSE status END WHERE id = ?`);
const userExists = db.prepare('SELECT id FROM users WHERE id = ? AND active = 1');

// per-org cache of parsed automations; invalidated by the CRUD routes
const cache = new Map();
function automationsFor(orgId) {
  let list = cache.get(orgId);
  if (list) return list;
  list = [];
  for (const row of getAutomations.all(orgId)) {
    try {
      list.push({ id: row.id, orgId, name: row.name, cooldownM: row.cooldown_m,
        trigger: JSON.parse(row.trigger_json), actions: JSON.parse(row.actions_json) });
    } catch { /* corrupt row: skip, surfaced by the UI as invalid */ }
  }
  cache.set(orgId, list);
  return list;
}
function invalidate(orgId) {
  if (orgId == null) cache.clear();
  else cache.delete(orgId);
}

function matches(trigger, ev) {
  if (ev.severity < (trigger.severityMin || 0)) return false;
  if (trigger.event && trigger.event !== '*' && trigger.event !== ev.name) return false;
  return true;
}

function runCloseEvent(auto, params, ev) {
  const raiseName = String(params.raiseEvent || '');
  if (!raiseName) return { ok: false, detail: 'close_event: no raiseEvent configured' };
  const t = now();
  let closed = 0;
  for (const raise of findRaiseEvents.all(auto.orgId, raiseName, ev.device)) {
    if (params.matchTarget && String(raise.target || '') !== String(ev.target || '')) continue;
    finishEvent.run(t, raise.id);
    const c = findOpenCase.get(raise.id);
    if (c) {
      closeCase.run(t, `auto-closed by automation "${auto.name}" — clear event ${ev.name}` +
        (ev.target ? ` (${ev.target})` : ''), c.id);
    }
    closed++;
  }
  return { ok: true, detail: `close_event ${raiseName} on ${ev.device}: ${closed} event(s) finished` };
}

function runAssignCase(auto, params, ev) {
  const userId = Number(params.userId);
  if (!userId || !userExists.get(userId)) return { ok: false, detail: 'assign_case: unknown user' };
  const c = findOpenCase.get(ev.id);
  if (!c) return { ok: true, detail: 'assign_case: no open case for event — skipped' };
  assignCase.run(userId, c.id);
  return { ok: true, detail: `assign_case C-${1000 + c.id} → user ${userId}` };
}

// A retry is only safe where a repeat is harmless. A refused or malformed
// request will be refused again, and a 4xx is the receiver's verdict — retrying
// either just doubles the noise. A timeout or a 5xx is the transient case, and
// the receiver of an ops webhook is expected to be idempotent on the event's
// dedupe key, so it is the one worth repeating.
const WEBHOOK_RETRIES = 2;
const RETRY_BACKOFF_MS = [1000, 4000];

async function runWebhook(auto, params, ev) {
  const url = String(params.url || '');
  const payload = JSON.stringify({
    source: 'opscat-automation', automation: auto.name, event: ev.name, device: ev.device,
    target: ev.target, severity: ev.severity, hits: ev.hits, ts: ev.last_seen,
  });
  const short = url.slice(0, 120);
  let last = '';
  for (let attempt = 0; ; attempt++) {
    try {
      // safeFetch owns the scheme check, the SSRF guard on EVERY redirect hop,
      // the timeout and the body cap (lib/ssrf.js). Before it, this action
      // validated `^https?://` and nothing else — so a lead could point an
      // automation at 169.254.169.254 and read the cloud metadata service's
      // answer out of the audit detail.
      const resp = await safeFetch(url, {
        method: 'POST', body: payload,
        headers: { 'Content-Type': 'application/json' },
      });
      if (resp.ok) {
        return { ok: true, detail: `webhook ${short}: delivered${attempt ? ` (attempt ${attempt + 1})` : ''}` };
      }
      last = `HTTP ${resp.status}`;
      if (resp.status < 500) return { ok: false, detail: `webhook ${short}: ${last}` };
    } catch (err) {
      last = String(err.message).slice(0, 120);
      // A guard rejection is a decision, not a hiccup — never retried.
      if (/private address|url must be|invalid URL|too many redirects/.test(last)) {
        return { ok: false, detail: `webhook ${short}: ${last}` };
      }
    }
    if (attempt >= WEBHOOK_RETRIES) return { ok: false, detail: `webhook ${short}: ${last}` };
    await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[attempt] || 4000));
  }
}

async function runActions(auto, ev) {
  for (const action of auto.actions) {
    let result;
    try {
      if (action.type === 'close_event') result = runCloseEvent(auto, action, ev);
      else if (action.type === 'assign_case') result = runAssignCase(auto, action, ev);
      else if (action.type === 'webhook') result = await runWebhook(auto, action, ev);
      else result = { ok: false, detail: `unknown action type ${String(action.type).slice(0, 40)}` };
    } catch (e) {
      result = { ok: false, detail: `${action.type}: ${String(e.message).slice(0, 200)}` };
    }
    sec.audit(null, 'automation_run',
      `[${auto.name}] on ${ev.name}@${ev.device}: ${result.ok ? 'OK' : 'FAILED'} — ${result.detail}`,
      auto.orgId);
    if (!result.ok) console.error(`automation "${auto.name}" action failed:`, result.detail);
  }
}

function onEvent(ev) {
  const orgId = ev.org_id || 1;
  const autos = automationsFor(orgId);
  if (!autos.length) return;
  const t = now();
  for (const auto of autos) {
    if (!matches(auto.trigger, ev)) continue;
    const fired = getFire.get(auto.id, ev.dedupe_key);
    if (fired && t - fired.fired_at < auto.cooldownM * 60 * 1000) continue;
    setFire.run(auto.id, ev.dedupe_key, t);
    runActions(auto, ev).catch((e) => console.error('automation error:', e.message));
  }
}

function start() { pipeline.on('event', onEvent); }

module.exports = { start, invalidate };
