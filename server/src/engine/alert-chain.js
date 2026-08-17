'use strict';
/**
 * The alert chain (docs/ONCALL-V1.md §3.5, §5–§7) — one delivery attempt chain
 * with a lifecycle:
 *
 *        create ──► active(step 0, round 0)
 *                      │
 * ack (any target) ────┼──► acked ──► resolved      (subject closed/resolved)
 *                      │
 *   step timeout ──────┼──► active(step n+1)
 *                      │        └─ last step? round < repeat_n ? active(0, round+1) : exhausted
 *                      │
 * subject terminal ────┴──► canceled
 *
 * Four rules carry the weight, and each of them is a failure that looks like
 * silence if it is missed:
 *
 *  1. **Targets resolve LATE, deliveries fan out early.** A step's targets are
 *     expanded to users at the moment the step begins, never at alert creation:
 *     a handover in the middle of an escalation has to reach whoever is on call
 *     NOW. Each user is then notified in parallel through their own rules, and
 *     the step timeout is ONE timer for the step, not one per person.
 *  2. **A gap advances immediately.** A step whose schedule resolves to nobody
 *     raises `oncall_gap` and moves on rather than waiting out a timeout for a
 *     person who does not exist. "No answer" must never render as a benign one.
 *  3. **Undeliverable is an alert, not a log line.** If every contact method of
 *     every target on a step fails, `alert_undeliverable` (severity 85) is
 *     raised — a system that cannot reach anybody looks, from the inside,
 *     exactly like a quiet night.
 *  4. **Cancelling is native and not optional.** Every terminal transition on a
 *     subject sweeps its alerts and drops their timers. `lib/cases.js` and
 *     `lib/incidents.js` are the two places that call it, which is why they had
 *     to become single mutation paths first.
 */
const { db, getOrgSetting } = require('../db');
const { now, sha256, randHex } = require('../util');
const config = require('../config');
const pipeline = require('./pipeline');
const oncall = require('./oncall');
const alerts = require('./alerts');
const timers = require('../lib/timers');
const contacts = require('../lib/contacts');

const clock = timers.create('alert_timers', 'alert_id');

const ACK_TTL_MS = 24 * 3600 * 1000;
const SWEEP_MS = 5000;
const MAX_STEPS = 10;
const MAX_TARGET_USERS = 100;

// ---- queries ---------------------------------------------------------------
const q = {
  policy: db.prepare('SELECT * FROM escalation_policies WHERE id = ? AND org_id = ?'),
  steps: db.prepare('SELECT * FROM escalation_steps WHERE policy_id = ? ORDER BY position'),
  targets: db.prepare('SELECT kind, ref_id FROM escalation_targets WHERE step_id = ?'),
  alert: db.prepare('SELECT * FROM alerts WHERE id = ?'),
  alertOfOrg: db.prepare('SELECT * FROM alerts WHERE id = ? AND org_id = ?'),
  liveForSubject: db.prepare(`SELECT * FROM alerts
    WHERE org_id = ? AND subject_kind = ? AND subject_id = ? AND status IN ('active','acked')`),
  samePolicy: db.prepare(`SELECT * FROM alerts WHERE org_id = ? AND subject_kind = ? AND subject_id = ?
    AND status IN ('active','acked') AND COALESCE(policy_id, -1) = COALESCE(?, -1) LIMIT 1`),
  insAlert: db.prepare(`INSERT INTO alerts
    (org_id, subject_kind, subject_id, policy_id, urgency, status, step_position, round,
     source, message, created_at)
    VALUES (?, ?, ?, ?, ?, 'active', 0, 0, ?, ?, ?)`),
  setStep: db.prepare('UPDATE alerts SET step_position = ?, round = ? WHERE id = ?'),
  setAcked: db.prepare(`UPDATE alerts SET status = 'acked', acked_at = ?, acked_by = ?
    WHERE id = ? AND status = 'active'`),
  end: db.prepare(`UPDATE alerts SET status = ?, ended_at = ?, end_reason = ?
    WHERE id = ? AND status IN ('active','acked')`),
  insAttempt: db.prepare(`INSERT INTO alert_attempts
    (alert_id, user_id, step_position, round, via, notified_at) VALUES (?, ?, ?, ?, ?, ?)`),
  attempts: db.prepare(`SELECT a.*, u.name, u.email, u.color FROM alert_attempts a
    JOIN users u ON u.id = a.user_id WHERE a.alert_id = ? ORDER BY a.notified_at, a.id`),
  insNotif: db.prepare(`INSERT INTO notifications
    (org_id, ts, rule_id, rule_name, event_id, case_label, channel, ok, error, alert_id, cost_micros)
    VALUES (?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?)`),
  insToken: db.prepare(`INSERT INTO alert_tokens (token_hash, alert_id, user_id, purpose, expires_at)
    VALUES (?, ?, ?, 'ack', ?)`),
  tokenByHash: db.prepare('SELECT * FROM alert_tokens WHERE token_hash = ?'),
  useToken: db.prepare('UPDATE alert_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL'),
  methods: db.prepare('SELECT * FROM contact_methods WHERE user_id = ? ORDER BY id'),
  rules: db.prepare(`SELECT r.delay_m, m.* FROM notification_rules r
    JOIN contact_methods m ON m.id = r.method_id
    WHERE r.user_id = ? AND r.urgency = ? ORDER BY r.delay_m, r.id`),
  method: db.prepare('SELECT * FROM contact_methods WHERE id = ? AND user_id = ?'),
  user: db.prepare('SELECT id, name, email, color FROM users WHERE id = ? AND active = 1'),
  member: db.prepare(`SELECT u.id, u.name, u.email, u.color FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.user_id = ? AND m.org_id = ? AND u.active = 1`),
  teamMembers: db.prepare(`SELECT u.id, u.name, u.email, u.color FROM team_members tm
    JOIN users u ON u.id = tm.user_id JOIN teams t ON t.id = tm.team_id
    WHERE tm.team_id = ? AND t.org_id = ? AND u.active = 1 ORDER BY u.name`),
  schedule: db.prepare('SELECT * FROM schedules WHERE id = ? AND org_id = ?'),
  caseRow: db.prepare('SELECT * FROM cases WHERE id = ? AND org_id = ?'),
  incidentRow: db.prepare('SELECT * FROM incidents WHERE id = ? AND org_id = ?'),
  window: db.prepare(`SELECT name FROM maintenance_windows
    WHERE org_id = ? AND starts_at <= ? AND ends_at >= ? ORDER BY id LIMIT 1`),
};

// ---- the subject -----------------------------------------------------------
// An alert hangs on a case OR an incident (§13.5). Cases carry the overwhelming
// majority, but an incident declared by hand at 03:15 because customers are
// calling has no case behind it, and "alert the on-call" is exactly the button
// wanted there.
function subjectOf(orgId, kind, id) {
  if (kind === 'case') {
    const c = q.caseRow.get(id, orgId);
    if (!c) return null;
    return { kind, id: c.id, label: `C-${1000 + c.id}`, severity: c.severity,
      title: `${c.name} on ${c.device}`, closed: c.status === 'closed',
      url: `${config.baseUrl}/app/cases` };
  }
  const i = q.incidentRow.get(id, orgId);
  if (!i) return null;
  return { kind, id: i.id, label: `INC-${2000 + i.id}`, severity: i.severity,
    title: i.title, closed: i.status === 'resolved',
    url: `${config.baseUrl}/app/incidents` };
}

// ---- suppression (§6) ------------------------------------------------------
// Three questions, three objects, so none has to be a special case in another.
function parseJson(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }

function withinSupportHours(policy, at) {
  const hours = parseJson(policy.hours_json);
  if (!hours) return true;                       // around the clock
  return oncall.restrictionCovers(hours, at, hours.tz || 'UTC');
}

// ---- notification text -----------------------------------------------------
function messageFor(alert, subject, step, token) {
  const sevLabel = alerts.severityLabel(subject.severity);
  const title = `[OpsCat ${alert.urgency === 'high' ? 'ALERT' : 'notice'}] ${subject.label} ${subject.title}`;
  const lines = [
    subject.title,
    '',
    `Severity: ${subject.severity} (${sevLabel})`,
    `Urgency: ${alert.urgency}`,
    `Escalation: step ${step.position + 1}${alert.round ? `, pass ${alert.round + 1}` : ''}`,
  ];
  if (alert.message) lines.push('', alert.message);
  // The acknowledgement round-trip needs no app: a link is the lowest common
  // denominator every channel carries.
  if (token) lines.push('', `Acknowledge: ${config.baseUrl}/a/${token}`);
  lines.push('', subject.url);
  return { title, text: lines.join('\n') };
}

// ---- target expansion (§5) -------------------------------------------------
// user → itself; team → all members; schedule → whoever is on call AT THIS
// MOMENT. A schedule that resolves to nobody is a gap: it is raised as an event
// and reported back so the caller can advance instead of waiting out a timeout
// for a person who does not exist.
function expandTargets(orgId, stepId) {
  const users = new Map();      // id -> { user, via }
  let gaps = 0; let targets = 0;
  for (const t of q.targets.all(stepId)) {
    targets++;
    if (t.kind === 'user') {
      const u = q.member.get(t.ref_id, orgId);
      if (u) users.set(u.id, { user: u, via: 'user' });
    } else if (t.kind === 'team') {
      for (const u of q.teamMembers.all(Number(t.ref_id), orgId)) {
        if (!users.has(u.id)) users.set(u.id, { user: u, via: `team:${t.ref_id}` });
      }
    } else if (t.kind === 'schedule') {
      const s = q.schedule.get(Number(t.ref_id), orgId);
      if (!s) continue;
      const r = oncall.resolve(s);
      if (!r.user) { gaps++; oncall.raiseGap(s); continue; }
      if (!users.has(r.user.id)) users.set(r.user.id, { user: r.user, via: `schedule:${s.id}` });
    }
  }
  const all = [...users.values()];
  return { people: all.slice(0, MAX_TARGET_USERS), gaps, targets, dropped: Math.max(0, all.length - MAX_TARGET_USERS) };
}

// ---- delivery --------------------------------------------------------------
function logDelivery(alert, subject, channel, ok, error, costMicros = null) {
  q.insNotif.run(alert.org_id, now(), `alert ${subject.label}`, subject.label,
    channel, ok ? 1 : 0, error || null, alert.id, costMicros);
}

function mintToken(alertId, userId) {
  const token = randHex(32);
  q.insToken.run(sha256(token), alertId, userId, now() + ACK_TTL_MS);
  return token;
}

/**
 * A person's ordered delivery plan for one urgency. Three tiers, each a fallback
 * for the one above, because every level of "not configured yet" has to reach
 * them anyway:
 *
 *  1. Their notification RULES for this urgency — "push now, SMS in 5 minutes".
 *  2. Failing that, every contact METHOD they have registered, immediately. A
 *     person who added their phone and never opened the rules editor plainly
 *     wants to be reached on their phone; treating that as "unconfigured" and
 *     mailing them instead is the product deciding it knows better.
 *  3. Failing that, their ACCOUNT E-MAIL — known-good, because they sign in with
 *     it. Without this last tier a fresh org builds a perfect ladder and reaches
 *     nobody, which is silence we chose rather than a limitation.
 */
function planFor(user, urgency) {
  const rules = q.rules.all(user.id, urgency);
  if (rules.length) return rules.map((r) => ({ ...r, delay_m: r.delay_m }));
  const methods = q.methods.all(user.id);
  if (methods.length) return methods.map((m) => ({ ...m, delay_m: 0 }));
  // The account e-mail is not a contact_methods row, so it carries no id and
  // needs no decryption — the shape below is what the sender expects.
  return [{ delay_m: 0, id: null, kind: 'email', address: user.email, encrypted: 0, verified_at: 1 }];
}

/**
 * Turn one plan entry into something sendable, or say why not.
 *
 * The two refusals here are the whole point of slice 3: an sms/voice method that
 * has not been VERIFIED is never rung (a wrong number costs money on every
 * escalation and wakes a stranger), and a metered channel an org's plan does not
 * include is not silently used. Both come back as a REASON, because a method
 * that is quietly skipped is indistinguishable from a channel that failed.
 */
function resolveEntry(entry, orgId) {
  if (entry.id === null) return { ok: true, address: entry.address };   // the account e-mail
  const gate = contacts.usable(entry, orgId);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const address = contacts.decodeAddress(entry);
  if (!address) return { ok: false, reason: 'contact address is unreadable — the app secret changed' };
  return { ok: true, address };
}

async function sendOne(alert, subject, user, entry, token) {
  const resolved = resolveEntry(entry, alert.org_id);
  if (!resolved.ok) throw new Error(resolved.reason);
  const { title, text } = messageFor(alert, subject, entry.step, token);
  // The token goes with it: a voice call is handed the token rather than a
  // message, because the provider fetches a call flow that speaks AND listens.
  return alerts.sendVia(entry.kind, resolved.address, {
    title, text, severity: subject.severity, orgId: alert.org_id,
    token, methodId: entry.id ?? null,
  });
}

/**
 * Deliver to one person NOW, walking their zero-delay methods in order.
 *
 * A hard failure advances to the next contact method immediately rather than
 * burning the step timeout on a channel that has already refused (§7). Delayed
 * rules become timers — unless they could not fire inside the step, which is a
 * configuration to surface, never a silent drop (§5).
 */
async function deliverNow(alert, subject, target, step, stepMs) {
  const plan = planFor(target.user, alert.urgency);
  const token = mintToken(alert.id, target.user.id);
  const immediate = plan.filter((p) => !p.delay_m);
  const later = plan.filter((p) => p.delay_m > 0);

  for (const p of later) {
    if (p.delay_m * 60000 >= stepMs) {
      logDelivery(alert, subject, p.kind, false,
        `skipped: this rule fires after ${p.delay_m} min, the step escalates after ${Math.round(stepMs / 60000)} min`);
      continue;
    }
    clock.schedule(alert.id, {
      // `p.id` is the contact_methods id: the plan rows are the METHOD spread
      // with the rule's delay on top, so there is no separate `method_id`.
      // Getting this wrong cost a delayed rule its delivery, silently — the
      // timer fired, found no method, and returned.
      kind: 'notify', ref: `${target.user.id}|${p.id}`,
      stepPosition: step.position, round: alert.round, resumeAt: now() + p.delay_m * 60000,
    });
  }

  let delivered = false;
  for (const p of immediate) {
    try {
      const r = await sendOne(alert, subject, target.user, { ...p, step }, token);
      logDelivery(alert, subject, p.kind, true, null, r && r.costMicros);
      delivered = true;
      break;
    } catch (err) {
      logDelivery(alert, subject, p.kind, false, String(err.message).slice(0, 300));
    }
  }
  return { delivered, pending: later.length > 0 };
}

// ---- the lifecycle ---------------------------------------------------------
function stepsOf(policyId) { return q.steps.all(policyId).slice(0, MAX_STEPS); }

/** Begin `alert.step_position` of `alert.round`: expand, notify, arm the clock. */
function beginStep(alert) {
  const policy = q.policy.get(alert.policy_id, alert.org_id);
  const subject = subjectOf(alert.org_id, alert.subject_kind, alert.subject_id);
  if (!policy || !subject) return end(alert, 'canceled', 'policy or subject vanished');
  const steps = stepsOf(policy.id);
  const step = steps[alert.step_position];
  if (!step) return advance(alert);

  const { people, gaps, targets, dropped } = expandTargets(alert.org_id, step.id);
  const stepMs = Math.max(1, step.timeout_m) * 60000;
  if (dropped) {
    logDelivery(alert, subject, 'alert', false,
      `step ${step.position + 1}: ${dropped} target(s) beyond the ${MAX_TARGET_USERS}-person cap were not notified`);
  }

  if (!people.length) {
    // Nobody to ring on this rung. Advancing immediately is the whole point of
    // rule 2: waiting out the timeout for an empty schedule is five minutes of
    // silence that reads exactly like five minutes of "nobody has answered yet".
    logDelivery(alert, subject, 'alert', false,
      gaps ? `step ${step.position + 1}: on-call gap, no one to notify — escalating now`
        : `step ${step.position + 1}: ${targets ? 'targets resolved to nobody' : 'no targets configured'} — escalating now`);
    return advance(alert);
  }

  const t = now();
  for (const p of people) {
    q.insAttempt.run(alert.id, p.user.id, alert.step_position, alert.round, p.via, t);
  }
  // One timer for the STEP, not one per person — and NO step timer at all for a
  // low-urgency alert: "is this worth waking someone for" is answered once, at
  // raise time, and a `low` alert notifies exactly once (§6). It stays active
  // until it is acknowledged or its subject closes, so it is still visible and
  // still cancellable; it simply never climbs the ladder.
  if (alert.urgency === 'high') {
    clock.schedule(alert.id, {
      kind: 'step', stepPosition: alert.step_position, round: alert.round, resumeAt: t + stepMs,
    });
  }

  // Deliveries are awaited only against each other, never against the caller:
  // raising an alert must not block the request or the pipeline that caused it.
  Promise.all(people.map((p) => deliverNow(alert, subject, p, step, stepMs)))
    .then((results) => {
      const any = results.some((r) => r.delivered || r.pending);
      if (!any) {
        logDelivery(alert, subject, 'alert', false,
          `step ${step.position + 1}: every contact method of every target failed`);
        pipeline.ingestEvent({
          name: 'alert_undeliverable', device: subject.label, target: null, severity: 85,
          description: `alert_undeliverable — ${subject.label} "${subject.title}": no contact method of any `
            + `target on step ${step.position + 1} could be reached`,
        }, 'oncall', false, alert.org_id);
      }
    })
    .catch((err) => console.error('alert delivery failed:', err.message));
  return alert;
}

/** Step timeout elapsed with no acknowledgement: next rung, next pass, or done. */
function advance(alert) {
  const fresh = q.alert.get(alert.id);
  if (!fresh || fresh.status !== 'active') return fresh;
  const policy = q.policy.get(fresh.policy_id, fresh.org_id);
  if (!policy) return end(fresh, 'canceled', 'policy deleted');
  const steps = stepsOf(policy.id);
  // Timers belonging to the rung we are leaving must not fire into the next one.
  clock.cancel(fresh.id);

  let step = fresh.step_position + 1;
  let round = fresh.round;
  if (step >= steps.length) {
    if (round >= policy.repeat_n) return exhaust(fresh, policy, steps);
    step = 0; round += 1;
  }
  q.setStep.run(step, round, fresh.id);
  return beginStep(q.alert.get(fresh.id));
}

function exhaust(alert, policy, steps) {
  const subject = subjectOf(alert.org_id, alert.subject_kind, alert.subject_id);
  end(alert, 'exhausted', 'policy exhausted');
  const tried = q.attempts.all(alert.id).map((a) => a.name);
  // The single most important signal the module emits: the policy reached
  // NOBODY. Raised as a pipeline event so an org can route it today — to a
  // manager, a second policy, a chat channel — without waiting for flows.
  pipeline.ingestEvent({
    name: 'alert_exhausted', device: subject ? subject.label : `alert ${alert.id}`, target: null, severity: 85,
    description: `alert_exhausted — policy "${policy.name}" ran ${steps.length} step(s)`
      + `${policy.repeat_n ? ` × ${policy.repeat_n + 1} passes` : ''} without an acknowledgement`
      + `${tried.length ? `; tried ${[...new Set(tried)].join(', ')}` : ''}`,
  }, 'oncall', false, alert.org_id);
  return q.alert.get(alert.id);
}

function end(alert, status, reason) {
  q.end.run(status, now(), reason, alert.id);
  clock.cancel(alert.id);
  return q.alert.get(alert.id);
}

// ---- the verbs -------------------------------------------------------------
/**
 * Raise an alert against a policy.
 *
 * Idempotent per (subject, policy): a second raise while one is still live
 * returns the SAME alert. A flaring event that re-fires its rule, or a re-run
 * flow, must not ring the same person twice about the same case.
 */
function raise(orgId, { subjectKind, subjectId, policyId, urgency, source, message, severity, at = now() }) {
  const policy = q.policy.get(policyId, orgId);
  if (!policy) return { error: 'unknown escalation policy' };
  const subject = subjectOf(orgId, subjectKind, subjectId);
  if (!subject) return { error: `unknown ${subjectKind}` };
  if (subject.closed) return { error: `${subject.label} is already closed` };

  // A ladder with no rungs cannot ring anybody. Refusing here means the operator
  // is told at the moment they wire the rule up, rather than discovering it as an
  // `alert_exhausted` event three seconds after the first real incident.
  if (!stepsOf(policyId).length) return { error: `policy "${policy.name}" has no escalation steps` };

  const existing = q.samePolicy.get(orgId, subjectKind, subjectId, policyId);
  if (existing) return { alert: existing, already: true };

  const sev = Number.isFinite(severity) ? severity : subject.severity;
  const u = urgency === 'high' || urgency === 'low' ? urgency : (sev >= policy.high_min ? 'high' : 'low');

  // Planned work holds EVERYTHING, exactly as a channel rule does — with the
  // same visible suppression line, so the log answers "why was nobody woken".
  const win = q.window.get(orgId, at, at);
  if (win) {
    q.insNotif.run(orgId, at, `policy ${policy.name}`, subject.label, 'alert', 1,
      `suppressed: maintenance window "${win.name}"`, null, null);
    return { suppressed: 'maintenance' };
  }
  // Outside support hours a LOW-urgency alert is not delivered. High always goes:
  // support hours answer "is anyone supposed to be reachable", not "may we ring".
  if (u === 'low' && !withinSupportHours(policy, at)) {
    q.insNotif.run(orgId, at, `policy ${policy.name}`, subject.label, 'alert', 1,
      'suppressed: outside support hours (low urgency)', null, null);
    return { suppressed: 'hours' };
  }

  const id = Number(q.insAlert.run(orgId, subjectKind, subjectId, policyId, u,
    String(source || 'user'), message || null, at).lastInsertRowid);
  beginStep(q.alert.get(id));
  return { alert: q.alert.get(id) };
}

/** Any alerted person may acknowledge — that is what stops the escalation. */
function ack(orgId, alertId, userId, how = 'api') {
  const a = q.alertOfOrg.get(alertId, orgId);
  if (!a) return { error: 'unknown alert' };
  if (a.status !== 'active') return { error: `alert is ${a.status}`, alert: a };
  q.setAcked.run(now(), userId, a.id);
  clock.cancel(a.id);
  // The ack is a fact on the SUBJECT, caused by the alert (§3.6) — which is what
  // finally gives `case.unacked` a column to read and Analytics an MTTA.
  if (a.subject_kind === 'case') require('../lib/cases').acknowledge(orgId, a.subject_id, userId);
  return { alert: q.alertOfOrg.get(a.id, orgId), how };
}

/**
 * The subject reached a terminal state. Active alerts are cancelled, already
 * acknowledged ones are resolved — the escalation was stopped at the ack, this
 * is the bookkeeping that closes the row.
 */
function onSubjectClosed(orgId, kind, id, reason = 'subject closed') {
  const live = q.liveForSubject.all(orgId, kind, id);
  for (const a of live) end(a, a.status === 'acked' ? 'resolved' : 'canceled', reason);
  return live.length;
}

/** A flow (or a human) saying "handled, stop alerting". */
function cancelFor(orgId, kind, id, reason = 'canceled') {
  return onSubjectClosed(orgId, kind, id, reason);
}

// ---- the sweeper -----------------------------------------------------------
// Durable by construction: nothing lives in setTimeout, so a restart loses no
// escalation. Whatever fell due while the process was down fires on the first
// sweep after boot.
function fire(row) {
  const alert = q.alert.get(row.alert_id);
  if (!alert || alert.status !== 'active') { clock.finish(row.id); return; }
  // A timer from a rung we have already left is stale by definition.
  if (row.step_position !== alert.step_position || row.round !== alert.round) {
    clock.finish(row.id);
    return;
  }
  if (row.kind === 'step') {
    clock.finish(row.id);
    advance(alert);
    return;
  }
  if (row.kind === 'notify') {
    clock.finish(row.id);
    const [userId, methodId] = String(row.ref || '').split('|');
    const user = q.user.get(userId);
    const method = q.method.get(methodId, userId);
    const subject = subjectOf(alert.org_id, alert.subject_kind, alert.subject_id);
    const policy = q.policy.get(alert.policy_id, alert.org_id);
    if (!user || !method || !subject || !policy) return;
    const step = stepsOf(policy.id)[alert.step_position];
    if (!step) return;
    const token = mintToken(alert.id, user.id);
    sendOne(alert, subject, user, { ...method, step }, token)
      .then((r) => logDelivery(alert, subject, method.kind, true, null, r && r.costMicros))
      .catch((err) => logDelivery(alert, subject, method.kind, false, String(err.message).slice(0, 300)));
    return;
  }
  clock.finish(row.id);
}

function sweep(at = now()) {
  for (const row of clock.claimDue(100, at)) {
    try { fire(row); } catch (err) { console.error('alert timer failed:', err.message); }
  }
}

function start() {
  sweep();                                  // whatever fell due while we were down
  const iv = setInterval(() => sweep(), SWEEP_MS);
  iv.unref();
}

// ---- token acknowledgement -------------------------------------------------
// GET renders, POST performs (§7): corporate mail scanners fetch every URL in a
// message, so an acknowledging GET would let a link-preview bot silence alerts
// before the human has looked at their phone.
function tokenInfo(token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{16,128}$/i.test(token)) return null;
  const row = q.tokenByHash.get(sha256(token));
  if (!row) return null;
  const alert = q.alert.get(row.alert_id);
  if (!alert) return null;
  const subject = subjectOf(alert.org_id, alert.subject_kind, alert.subject_id);
  const user = q.user.get(row.user_id);
  return {
    row, alert, subject, user,
    expired: row.expires_at < now(),
    used: !!row.used_at,
  };
}

function ackByToken(token) {
  const info = tokenInfo(token);
  if (!info || info.expired || info.used) return null;
  if (!q.useToken.run(now(), sha256(token)).changes) return null;   // single use, race-safe
  const r = ack(info.alert.org_id, info.alert.id, info.row.user_id, 'token');
  return { ...info, result: r };
}

// ---- read model ------------------------------------------------------------
function view(a, { includeAttempts = false } = {}) {
  const subject = subjectOf(a.org_id, a.subject_kind, a.subject_id);
  const policy = a.policy_id ? q.policy.get(a.policy_id, a.org_id) : null;
  const acked = a.acked_by ? q.user.get(a.acked_by) : null;
  const out = {
    id: a.id, status: a.status, urgency: a.urgency,
    subjectKind: a.subject_kind, subjectId: a.subject_id,
    subjectLabel: subject ? subject.label : null,
    subjectTitle: subject ? subject.title : null,
    severity: subject ? subject.severity : null,
    policyId: a.policy_id, policyName: policy ? policy.name : null,
    step: a.step_position, round: a.round, source: a.source, message: a.message,
    createdAt: a.created_at, ackedAt: a.acked_at,
    ackedBy: acked ? { id: acked.id, name: acked.name, color: acked.color } : null,
    ackMinutes: a.acked_at ? Math.round((a.acked_at - a.created_at) / 60000) : null,
    endedAt: a.ended_at, endReason: a.end_reason,
    nextAt: null,
  };
  const pending = clock.pending(a.id).find((t) => t.kind === 'step');
  if (pending && a.status === 'active') out.nextAt = pending.resume_at;
  if (includeAttempts) {
    out.attempts = q.attempts.all(a.id).map((t) => ({
      user: { id: t.user_id, name: t.name, color: t.color },
      step: t.step_position, round: t.round, via: t.via, notifiedAt: t.notified_at,
    }));
  }
  return out;
}

/** Live alerts for one subject — the badge on a case or an incident. */
function forSubject(orgId, kind, id) {
  return db.prepare(`SELECT * FROM alerts WHERE org_id = ? AND subject_kind = ? AND subject_id = ?
    ORDER BY created_at DESC LIMIT 20`).all(orgId, kind, id).map((a) => view(a));
}

module.exports = {
  start, sweep, raise, ack, ackByToken, tokenInfo, cancelFor, onSubjectClosed,
  view, forSubject, subjectOf, clock, ACK_TTL_MS,
};
