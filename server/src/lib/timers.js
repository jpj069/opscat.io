'use strict';
/**
 * Durable timers — the ONE mechanism, over a table descriptor
 * (docs/ONCALL-V1.md §9.3, docs/AUTOMATION-V1.md §5.2).
 *
 * Two modules need to say "come back to this in five minutes, and still come
 * back if the process dies in between": the escalation clock here, and the flow
 * engine's `wait` node. Building that twice means two sweepers, two lease models
 * and two answers to "did it fire?" — the failure the house already avoided by
 * making `lib/status-scale.js` one ordering rather than a copy per consumer.
 *
 * So the mechanism is shared and the TABLES are not. `alert_timers` and (later)
 * `flow_waits` are two typed tables using this file, because SQLite cannot
 * enforce a foreign key that points at two parents, and `ON DELETE CASCADE`
 * from the owning alert or run is what keeps an orphaned timer from firing into
 * nothing. One behaviour, two owners, no polymorphic parent column.
 *
 * Semantics, all of which the callers depend on:
 *
 *  - **Durable.** A timer is a row. Nothing lives in `setTimeout`, so a restart
 *    loses no escalation — the sweeper picks up whatever is due, INCLUDING what
 *    fell due while the process was down.
 *  - **Claimed, not deleted, when it fires.** `claim` stamps a lease; a crash
 *    between claim and effect leaves a row whose lease expires and is re-taken.
 *    At-least-once, which is why every consumer's handler must be idempotent
 *    for its own (owner, step) pair.
 *  - **Cancellable.** `cancel` is a soft delete (`canceled_at`), so "why did
 *    this never fire?" has an answer in the table rather than an absence.
 */
const { db } = require('../db');
const { now } = require('../util');

const LEASE_MS = 60000; // a claimed timer is retried if it was not finished within this

/**
 * @param {string} table    e.g. 'alert_timers'
 * @param {string} ownerCol e.g. 'alert_id'
 */
function create(table, ownerCol) {
  const q = {
    ins: db.prepare(`INSERT INTO ${table}
      (${ownerCol}, kind, ref, step_position, round, resume_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    due: db.prepare(`SELECT * FROM ${table}
      WHERE canceled_at IS NULL AND resume_at <= ?
        AND (claimed_at IS NULL OR claimed_at < ?)
      ORDER BY resume_at LIMIT ?`),
    claim: db.prepare(`UPDATE ${table} SET claimed_at = ?
      WHERE id = ? AND canceled_at IS NULL AND (claimed_at IS NULL OR claimed_at < ?)`),
    done: db.prepare(`DELETE FROM ${table} WHERE id = ?`),
    cancelOwner: db.prepare(`UPDATE ${table} SET canceled_at = ?
      WHERE ${ownerCol} = ? AND canceled_at IS NULL`),
    cancelStep: db.prepare(`UPDATE ${table} SET canceled_at = ?
      WHERE ${ownerCol} = ? AND kind = ? AND canceled_at IS NULL`),
    pending: db.prepare(`SELECT * FROM ${table}
      WHERE ${ownerCol} = ? AND canceled_at IS NULL ORDER BY resume_at`),
  };

  return {
    /** Come back to `ownerId` at `resumeAt`. `kind`/`ref` are the consumer's own. */
    schedule(ownerId, { kind, ref = null, stepPosition = 0, round = 0, resumeAt }) {
      return Number(q.ins.run(ownerId, kind, ref, stepPosition, round, resumeAt, now()).lastInsertRowid);
    },

    /** Everything still pending for one owner — the "what happens next" read. */
    pending(ownerId) { return q.pending.all(ownerId); },

    /**
     * Stop timers. Without `kind` this is the whole owner, which is what a
     * terminal transition on the subject needs: a case that closes must drop the
     * escalation clock in the same breath, or the most common good-news path in
     * the product still wakes second line five minutes later.
     */
    cancel(ownerId, kind) {
      const t = now();
      return (kind ? q.cancelStep.run(t, ownerId, kind) : q.cancelOwner.run(t, ownerId)).changes;
    },

    /**
     * Take everything due, atomically. The SELECT and the lease UPDATE share one
     * transaction so two sweeps (a timer tick landing on top of a boot sweep)
     * cannot both claim the same row.
     */
    claimDue(limit = 100, at = now()) {
      const taken = [];
      db.transaction(() => {
        for (const row of q.due.all(at, at - LEASE_MS, limit)) {
          if (q.claim.run(at, row.id, at - LEASE_MS).changes) taken.push(row);
        }
      })();
      return taken;
    },

    /** The effect happened; the row has done its job. */
    finish(id) { q.done.run(id); },
  };
}

module.exports = { create, LEASE_MS };
