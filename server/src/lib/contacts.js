'use strict';
/**
 * Contact methods — the encryption boundary and the "may this be used" rule
 * (docs/ONCALL-V1.md §3.4, §7).
 *
 * Two things about a contact method are easy to get subtly wrong in three
 * different places, so they live in one:
 *
 *  1. **What is stored is not always what was typed.** A phone number is
 *     personal data and a Web Push subscription is a bearer capability — anyone
 *     holding the endpoint can push to that device. Both are AES-256-GCM at rest
 *     with `OPSCAT_SECRET`, the pattern SNMP community strings already use.
 *     E-mail, ntfy, Telegram and Pushover stay in the clear: they are addresses
 *     the operator pasted from somewhere else and reads back constantly, and
 *     encrypting them would buy nothing while making the notification log
 *     unreadable.
 *  2. **A method that exists is not a method that may be rung.** An sms/voice
 *     method must be VERIFIED, because a wrong number costs money on every
 *     escalation and wakes a stranger; and the alert's ORG must have the plan
 *     feature, because those are the only channels with a marginal cost per
 *     message. Both refusals are reported with a reason rather than by the
 *     method quietly not being in the list — a person who added their phone and
 *     is never called has no way to tell the difference from a quiet night.
 */
const { db } = require('../db');
const config = require('../config');
const { encrypt, decrypt } = require('../util');
const plans = require('../plans');

// Kinds whose address is ciphertext at rest.
const ENCRYPTED_KINDS = ['sms', 'voice', 'push'];
// Kinds that are metered, need verification, and are gated by plan.
const METERED_KINDS = ['sms', 'voice'];
// Kinds a person may register today. `push` is added by the browser through its
// own endpoint, not by typing an address, so it is not in the typed list.
const TYPED_KINDS = ['email', 'ntfy', 'telegram', 'pushover', 'sms', 'voice'];

const isEncryptedKind = (kind) => ENCRYPTED_KINDS.includes(kind);
const isMetered = (kind) => METERED_KINDS.includes(kind);

/** What to store, and whether it is ciphertext. */
function encodeAddress(kind, address) {
  return isEncryptedKind(kind)
    ? { address: encrypt(address, config.secret), encrypted: 1 }
    : { address, encrypted: 0 };
}

/**
 * The plaintext address of a row.
 *
 * Returns null rather than throwing when the ciphertext cannot be read — that
 * happens when `OPSCAT_SECRET` changed, and the right behaviour is a failed
 * delivery with a reason in the log, not a crashed sweep that takes every other
 * alert down with it.
 */
function decodeAddress(row) {
  if (!row) return null;
  if (!row.encrypted) return row.address;
  try { return decrypt(row.address, config.secret); } catch { return null; }
}

/**
 * What the owner sees. A phone number is shown to its owner in full — this is
 * the one screen whose job is "is this the right number" — but a push
 * subscription is a 200-character endpoint nobody can read, so it is described
 * rather than printed.
 */
function displayAddress(row) {
  if (row.kind === 'push') return row.label || 'this browser';
  return decodeAddress(row) ?? '(unreadable — the app secret changed)';
}

/**
 * May this method be used to deliver an alert for `orgId`?
 * Returns `{ ok: true }` or `{ ok: false, reason }`. The reason is written to
 * the notification log, so it must read as an explanation to a human at 03:00.
 */
function usable(row, orgId) {
  if (!isMetered(row.kind)) return { ok: true };
  if (!row.verified_at) {
    return { ok: false, reason: `${row.kind} number not verified — verify it under On-Call › My on-call` };
  }
  const org = db.prepare('SELECT plan FROM organizations WHERE id = ?').get(orgId);
  if (!plans.hasFeature(org ? org.plan : 'free', row.kind)) {
    return { ok: false, reason: `${row.kind} is not included in this organization's plan` };
  }
  return { ok: true };
}

/**
 * Normalise a phone number to E.164-ish. Deliberately strict rather than clever:
 * every provider here wants `+<country><number>`, and a "helpful" guess at the
 * country code is how a German mobile becomes a US landline.
 */
function normalisePhone(raw) {
  const v = String(raw || '').replace(/[\s\-().]/g, '');
  return /^\+[1-9]\d{6,15}$/.test(v) ? v : null;
}

module.exports = {
  ENCRYPTED_KINDS, METERED_KINDS, TYPED_KINDS,
  isEncryptedKind, isMetered, encodeAddress, decodeAddress, displayAddress,
  usable, normalisePhone,
};
