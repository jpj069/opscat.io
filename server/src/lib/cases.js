'use strict';
/**
 * Case verbs — the ONE mutation path for cases (docs/ONCALL-V1.md §5).
 *
 * This file exists for a single reason: a case that closes must stop the alert
 * chain that is ringing about it. `grep "status = 'closed'"` over `server/src`
 * returned EIGHT write sites — the event-scoped close and the generic PATCH in
 * `routes/ops.js`, two more in `mcp/tools.js`, and the `close_event` automation
 * — and threading a cancel hook through eight call sites means the ninth one
 * forgets. The cost of forgetting is precise and bad: an alert that keeps
 * escalating after the problem is over, i.e. the second-line responder woken at
 * 03:07 about a disk that recovered at 03:02.
 *
 * That is the same shape `lib/incidents.js` was created for, so it gets the same
 * answer. Everything that closes, acknowledges or re-opens a case comes through
 * here; the timeline entry stays at the call site, because only the caller knows
 * whether a person or an agent did it.
 *
 * The alert engine is required LAZILY. It needs this module (to write
 * `cases.acked_at` when an alert is acknowledged) and this module needs it (to
 * cancel on close) — one of the two directions has to be deferred, and the
 * cancel path is the one that is already inside a function call.
 */
const { db } = require('../db');
const { now } = require('../util');

const label = (id) => `C-${1000 + id}`;
const STATUSES = ['open', 'assigned', 'closed'];

const q = {
  byId: db.prepare('SELECT * FROM cases WHERE id = ? AND org_id = ?'),
  openForEvent: db.prepare("SELECT * FROM cases WHERE event_id = ? AND org_id = ? AND status != 'closed'"),
  latestForEvent: db.prepare('SELECT * FROM cases WHERE event_id = ? AND org_id = ? ORDER BY id DESC LIMIT 1'),
  close: db.prepare("UPDATE cases SET status = 'closed', closed_at = ? WHERE id = ? AND status != 'closed'"),
  // The newline is BOUND, not spelled: SQLite has `char(10)`, Postgres has
  // `chr(10)`, and neither is needed — a parameter is portable by construction.
  // The append must stay in SQL: this is the repo's only concurrency-safe note
  // append, and read-modify-write in JS would lose whatever another writer added
  // in between. Bound args: (closed_at, '\n', note, id).
  closeWithNote: db.prepare(`UPDATE cases SET status = 'closed', closed_at = ?,
    note = COALESCE(note || ?, '') || ? WHERE id = ? AND status != 'closed'`),
  note: db.prepare("UPDATE cases SET note = ? WHERE event_id = ? AND org_id = ? AND status != 'closed'"),
  assign: db.prepare(`UPDATE cases SET assigned_user_id = ?,
    status = CASE WHEN status = 'open' THEN 'assigned' ELSE status END
    WHERE event_id = ? AND org_id = ? AND status != 'closed'`),
  ack: db.prepare('UPDATE cases SET acked_at = ?, acked_by = ? WHERE id = ? AND acked_at IS NULL'),
  update: db.prepare(`UPDATE cases SET
      status = COALESCE(?, status),
      assigned_user_id = COALESCE(?, assigned_user_id),
      root_cause = COALESCE(?, root_cause),
      note = COALESCE(?, note),
      closed_at = CASE WHEN ? = 'closed' AND closed_at IS NULL THEN ? ELSE closed_at END
    WHERE id = ? AND org_id = ?`),
};

// The hook every close site shares. Kept private: a caller that wants "close a
// case" must not be able to choose whether the alerts stop.
function afterClose(orgId, caseId) {
  require('../engine/alert-chain').onSubjectClosed(orgId, 'case', caseId, 'case closed');
}

/** The open case for an event, or null. */
function openForEvent(orgId, eventId) { return q.openForEvent.get(eventId, orgId) || null; }
/** The most recent case for an event whatever its status — what a label lookup wants. */
function latestForEvent(orgId, eventId) { return q.latestForEvent.get(eventId, orgId) || null; }
function byId(orgId, id) { return q.byId.get(id, orgId) || null; }

/**
 * Close one case. Idempotent: an already-closed case is left alone and reports
 * `false`, so a second "finish" cannot re-stamp `closed_at` or re-fire the hook.
 */
function close(orgId, caseId, { note = null, at = now() } = {}) {
  const changed = note
    ? q.closeWithNote.run(at, '\n', note, caseId).changes
    : q.close.run(at, caseId).changes;
  if (!changed) return false;
  afterClose(orgId, caseId);
  return true;
}

/** Close whatever open case an event has. Returns how many closed (0 or 1). */
function closeForEvent(orgId, eventId, opts = {}) {
  const c = openForEvent(orgId, eventId);
  if (!c) return 0;
  return close(orgId, c.id, opts) ? 1 : 0;
}

/** Latest note for the Cases page. The append-only history is the caller's job. */
function setNoteForEvent(orgId, eventId, note) { return q.note.run(note, eventId, orgId).changes; }

function assignForEvent(orgId, eventId, userId) { return q.assign.run(userId, eventId, orgId).changes; }

/**
 * The generic patch behind `PATCH /api/cases/:id` and the MCP update tool.
 * Fields left `undefined` are untouched; a transition INTO closed runs the hook.
 */
function update(orgId, caseId, { status, assignedUserId, rootCause, note } = {}) {
  const before = byId(orgId, caseId);
  if (!before) return null;
  q.update.run(status || null, assignedUserId || null, rootCause ?? null, note ?? null,
    status || null, now(), caseId, orgId);
  if (status === 'closed' && before.status !== 'closed') afterClose(orgId, caseId);
  return byId(orgId, caseId);
}

/**
 * "I have seen it, stop ringing."
 *
 * Writes `acked_at`/`acked_by` and nothing else — deliberately NOT
 * `assigned_user_id` (§13.4). Acknowledging at 03:02 is a reflex; owning the
 * case is a separate statement, and conflating the two makes the night-shift
 * responder who only silenced their phone the owner in the statistics.
 *
 * Returns false when the case was already acknowledged, which is what lets the
 * endpoint answer 409 instead of pretending the second click did something.
 */
function acknowledge(orgId, caseId, userId, { at = now() } = {}) {
  const c = byId(orgId, caseId);
  if (!c) return null;
  if (!q.ack.run(at, userId, caseId).changes) return false;
  return true;
}

module.exports = {
  label, STATUSES, byId, openForEvent, latestForEvent,
  close, closeForEvent, setNoteForEvent, assignForEvent, update, acknowledge,
};
