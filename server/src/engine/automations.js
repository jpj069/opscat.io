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
const q = require('../db/shim');
const { now, isId } = require('../util');
const sec = require('../security');
const pipeline = require('./pipeline');
const { safeFetch } = require('../lib/ssrf');
const cases = require('../lib/cases');

const getAutomations = q.prepare('SELECT * FROM automations WHERE org_id = ? AND enabled = 1');
// Same at-most-once claim as the alert engine's cooldown (engine/alerts.js):
// the condition lives in the WHERE, so `changes` — not a JS comparison against
// a row read a moment earlier — decides who runs the actions. Two runners past
// this gate means the actions run twice, and the actions are not reads: the
// webhook is POSTed twice to whatever the lead pointed it at, and close_event
// finishes the raise events and closes their cases a second time, appending a
// second auto-close note to work somebody may already have reopened.
const claimFire = q.prepare(`INSERT INTO automation_fires (automation_id, dedupe_key, fired_at) VALUES (?, ?, ?)
  ON CONFLICT(automation_id, dedupe_key) DO UPDATE SET fired_at = excluded.fired_at
  WHERE automation_fires.fired_at <= ?`);
const findRaiseEvents = q.prepare(`SELECT id, name, device, target, severity FROM events
  WHERE org_id = ? AND name = ? AND device = ? AND status = 'active'`);
const finishEvent = q.prepare(`UPDATE events SET status = 'finished', finished_at = ? WHERE id = ?`);
const findOpenCase = q.prepare("SELECT id, note FROM cases WHERE event_id = ? AND status != 'closed'");
const assignCase = q.prepare(`UPDATE cases SET assigned_user_id = ?,
  status = CASE WHEN status = 'open' THEN 'assigned' ELSE status END WHERE id = ?`);
const userExists = q.prepare('SELECT id FROM users WHERE id = ? AND active = 1');

// per-org cache of parsed automations; invalidated by the CRUD routes
const cache = new Map();
async function automationsFor(orgId) {
  let list = cache.get(orgId);
  if (list) return list;
  list = [];
  for (const row of await getAutomations.all(orgId)) {
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

async function runCloseEvent(auto, params, ev) {
  const raiseName = String(params.raiseEvent || '');
  if (!raiseName) return { ok: false, detail: 'close_event: no raiseEvent configured' };
  const t = now();
  let closed = 0;
  for (const raise of await findRaiseEvents.all(auto.orgId, raiseName, ev.device)) {
    if (params.matchTarget && String(raise.target || '') !== String(ev.target || '')) continue;
    await finishEvent.run(t, raise.id);
    // through lib/cases: the clear event is the good-news path, and it is the
    // one that MUST also stop an escalation that is still ringing (ONCALL-V1 §5).
    // AWAITED, not fired and forgotten: closeForEvent became async with the shim,
    // and an un-awaited call orders neither the close nor the alert cancel against
    // this run — and its rejection reaches no catch. `closed` counts loop
    // iterations, so the detail below looked right either way.
    await cases.closeForEvent(auto.orgId, raise.id, {
      at: t,
      note: `auto-closed by automation "${auto.name}" — clear event ${ev.name}`
        + (ev.target ? ` (${ev.target})` : ''),
    });
    closed++;
  }
  return { ok: true, detail: `close_event ${raiseName} on ${ev.device}: ${closed} event(s) finished` };
}

async function runAssignCase(auto, params, ev) {
  // `users.id` is a uuid: `Number(params.userId)` was NaN for every real user,
  // NaN is falsy, and the guard below then reported "unknown user" — an
  // automation that had worked before the uuid migration failing with a message
  // that blamed the configuration (CLAUDE.md § Identity keys).
  const userId = params.userId;
  if (!isId(userId) || !(await userExists.get(userId))) return { ok: false, detail: 'assign_case: unknown user' };
  const c = await findOpenCase.get(ev.id);
  if (!c) return { ok: true, detail: 'assign_case: no open case for event — skipped' };
  await assignCase.run(userId, c.id);
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
      if (action.type === 'close_event') result = await runCloseEvent(auto, action, ev);
      else if (action.type === 'assign_case') result = await runAssignCase(auto, action, ev);
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

async function onEvent(ev) {
  const orgId = ev.org_id || 1;
  const autos = await automationsFor(orgId);
  if (!autos.length) return;
  const t = now();
  for (const auto of autos) {
    if (!matches(auto.trigger, ev)) continue;
    // Claimed before the actions run, unchanged: an action that fails has still
    // burned the cooldown. The other order — claim on success — would hold the
    // gate open across the webhook's retries and backoff (up to ~5s), and every
    // event arriving in that window would run the actions again.
    const claimed = await claimFire.run(auto.id, ev.dedupe_key, t, t - auto.cooldownM * 60 * 1000);
    if (claimed.changes !== 1) continue; // another runner already owns this fire
    runActions(auto, ev).catch((e) => console.error('automation error:', e.message));
  }
}

// `emit()` is a SYNCHRONOUS fan-out (engine/pipeline.js) whose per-listener
// try/catch cannot see a rejected promise, so the catch is spelled out here and
// logs exactly what emit's own catch logs. Without it a failed claim or action
// becomes an unhandledRejection and, under NODE_ENV=test, takes the process down.
function start() {
  pipeline.on('event', (ev) => { onEvent(ev).catch((e) => console.error('listener error', e)); });
}

module.exports = { start, invalidate };
