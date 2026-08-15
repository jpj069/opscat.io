'use strict';
// Status-page subscribers (docs/INCIDENTS-V2.md slice 2): e-mail double-opt-in.
//
// The contract, in one breath: an address subscribes on the public page and is
// PENDING until its owner clicks the mailed confirm link — nothing is ever sent
// to an unconfirmed address except that link. Confirmed subscribers get a mail
// for every transition of a PUBLISHED incident (and the moment one becomes
// published), each carrying that subscriber's own unsubscribe link. The token
// is hashed at rest and mailed in links only; it is the subscriber's single
// credential for both confirm and unsubscribe. Every entry point answers
// uniformly so probing an address book against the form reveals nothing.
const crypto = require('crypto');
const { db, getOrgSetting } = require('../db');
const { now, sha256, isEmail } = require('../util');
const config = require('../config');
const mailer = require('../mailer');

const CONFIRM_TTL_MS = 48 * 60 * 60 * 1000;   // pending rows expire (and may re-subscribe)
const RESEND_MS = 10 * 60 * 1000;             // confirm-mail throttle per address
const MAX_PER_ORG = 5000;                     // abuse bound, far above any real page

const q = {
  byEmail: db.prepare('SELECT * FROM status_subscribers WHERE org_id = ? AND email = ?'),
  byToken: db.prepare('SELECT * FROM status_subscribers WHERE token_hash = ?'),
  count: db.prepare('SELECT COUNT(*) c FROM status_subscribers WHERE org_id = ?'),
  ins: db.prepare(`INSERT INTO status_subscribers (org_id, email, token_hash, created_at, last_sent_at)
    VALUES (?, ?, ?, ?, ?)`),
  touchSent: db.prepare('UPDATE status_subscribers SET last_sent_at = ? WHERE id = ?'),
  refresh: db.prepare(`UPDATE status_subscribers SET token_hash = ?, created_at = ?, last_sent_at = ?
    WHERE id = ?`),
  confirm: db.prepare('UPDATE status_subscribers SET confirmed_at = ? WHERE id = ?'),
  del: db.prepare('DELETE FROM status_subscribers WHERE id = ?'),
  confirmedOf: db.prepare(`SELECT * FROM status_subscribers
    WHERE org_id = ? AND confirmed_at IS NOT NULL`),
  org: db.prepare('SELECT * FROM organizations WHERE id = ?'),
};

const enabled = (orgId) => getOrgSetting(orgId, 'status_subscribers_enabled', '1') === '1';
const available = (orgId) => enabled(orgId) && mailer.mailConfigured();

// The org's public page URL — the default org lives at /status, every other
// one at /status/<slug>. Confirm/unsubscribe URLs carry only the token: it is
// globally unique, so the org falls out of the row.
function statusUrl(orgId) {
  const org = q.org.get(orgId);
  return org && org.id !== 1 && org.slug
    ? `${config.baseUrl}/status/${org.slug}` : `${config.baseUrl}/status`;
}
const confirmUrl = (token) => `${config.baseUrl}/status/confirm?token=${token}`;
const unsubUrl = (token) => `${config.baseUrl}/status/unsubscribe?token=${token}`;

function orgName(orgId) {
  return getOrgSetting(orgId, 'org_name', 'OpsCat');
}
function fromAddress() {
  // status mails are notifications, so they share the alert sender
  const { getSetting } = require('../db');
  return getSetting('alert_email_from', 'OpsCat Alerts <onboarding@resend.dev>');
}

async function sendConfirmMail(orgId, email, token) {
  await mailer.sendMail({
    from: fromAddress(), to: email,
    subject: `Confirm your ${orgName(orgId)} status updates`,
    html: mailer.linkMail({
      intro: `You (or someone using this address) asked for status updates from ${orgName(orgId)}. ` +
        'Click to confirm — until then, nothing else will be sent to this address.',
      cta: 'Confirm subscription', url: confirmUrl(token),
      note: 'The link is valid for 48 hours. Not you? Just ignore this mail.',
    }),
  });
}

// Uniform by design: every path returns { ok: true } — a probe cannot learn
// whether an address is new, pending or already subscribed.
async function subscribe(orgId, rawEmail) {
  if (!available(orgId)) return { ok: false, unavailable: true };
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!isEmail(email) || email.length > 200) return { ok: true };
  const t = now();
  const existing = q.byEmail.get(orgId, email);
  if (existing && existing.confirmed_at) return { ok: true };
  if (existing) {
    if (t - (existing.last_sent_at || 0) < RESEND_MS) return { ok: true };
    const token = crypto.randomBytes(32).toString('base64url');
    q.refresh.run(sha256(token), t, t, existing.id);
    sendConfirmMail(orgId, email, token).catch((e) =>
      console.error('[subscribers] confirm mail:', e.message));
    return { ok: true };
  }
  if (q.count.get(orgId).c >= MAX_PER_ORG) return { ok: true };
  const token = crypto.randomBytes(32).toString('base64url');
  q.ins.run(orgId, email, sha256(token), t, t);
  sendConfirmMail(orgId, email, token).catch((e) =>
    console.error('[subscribers] confirm mail:', e.message));
  return { ok: true };
}

// -> { orgId } on success, null on anything else (unknown, expired, already)
function confirm(token) {
  if (typeof token !== 'string' || token.length < 20) return null;
  const row = q.byToken.get(sha256(token));
  if (!row || row.confirmed_at) return null;
  if (now() - row.created_at > CONFIRM_TTL_MS) { q.del.run(row.id); return null; }
  q.confirm.run(now(), row.id);
  return { orgId: row.org_id };
}

// works for pending AND confirmed rows — an unconfirmed address must be able
// to stop the confirm mails too. -> { orgId } or null.
function unsubscribe(token) {
  if (typeof token !== 'string' || token.length < 20) return null;
  const row = q.byToken.get(sha256(token));
  if (!row) return null;
  q.del.run(row.id);
  return { orgId: row.org_id };
}

// Called from lib/incidents for every transition of a published incident and
// the moment one becomes published. Fire-and-forget per subscriber: one bad
// address must not stop the fan-out, and the caller does not wait.
function notifyIncident(incident, kind, message) {
  if (!available(incident.org_id)) return;
  const subs = q.confirmedOf.all(incident.org_id);
  if (!subs.length) return;
  const name = orgName(incident.org_id);
  const label = `INC-${2000 + incident.id}`;
  const verb = kind === 'published' ? 'incident' : incident.status;
  const subject = `[${name} status] ${label} ${verb}: ${incident.title}`;
  const page = statusUrl(incident.org_id);
  for (const s of subs) {
    // the clear token left the process with the confirm mail (only its hash is
    // stored), so notification mails address unsubscribe by row id + keyed MAC
    // — stateless, and deleting the row revokes it
    const mac = crypto.createHmac('sha256', config.secret).update(`unsub:${s.id}`).digest('base64url');
    const unsub = `${config.baseUrl}/status/unsubscribe?id=${s.id}&sig=${mac}`;
    const html = `<p style="font-family:sans-serif"><strong>${label}</strong> — ${escapeHtml(incident.title)}</p>
<p style="font-family:sans-serif">Status: <strong>${escapeHtml(incident.status)}</strong>${
  message ? `<br>${escapeHtml(message)}` : ''}</p>
<p style="font-family:sans-serif"><a href="${page}">View the status page</a></p>
<p style="font-family:sans-serif;font-size:12px;color:#666"><a href="${unsub}">Unsubscribe</a> from ${escapeHtml(name)} status updates.</p>`;
    mailer.sendMail({ from: fromAddress(), to: s.email, subject, html })
      .catch((e) => console.error(`[subscribers] notify ${s.email}:`, e.message));
  }
}

// the MAC-addressed unsubscribe used in notification mails
function unsubscribeById(id, sig) {
  const rowId = Number(id);
  if (!Number.isInteger(rowId) || typeof sig !== 'string') return null;
  const mac = crypto.createHmac('sha256', config.secret).update(`unsub:${rowId}`).digest('base64url');
  if (sig.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(mac))) return null;
  const row = db.prepare('SELECT * FROM status_subscribers WHERE id = ?').get(rowId);
  if (!row) return null;
  q.del.run(row.id);
  return { orgId: row.org_id };
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function adminList(orgId) {
  const rows = db.prepare(`SELECT id, email, confirmed_at, created_at FROM status_subscribers
    WHERE org_id = ? ORDER BY created_at DESC LIMIT 500`).all(orgId);
  return {
    confirmed: rows.filter((r) => r.confirmed_at).length,
    pending: rows.filter((r) => !r.confirmed_at).length,
    rows: rows.map((r) => ({ id: r.id, email: r.email,
      confirmedAt: r.confirmed_at, createdAt: r.created_at })),
  };
}

function adminDelete(orgId, id) {
  const row = db.prepare('SELECT id FROM status_subscribers WHERE id = ? AND org_id = ?').get(id, orgId);
  if (!row) return false;
  q.del.run(row.id);
  return true;
}

module.exports = {
  available, enabled, subscribe, confirm, unsubscribe, unsubscribeById,
  notifyIncident, adminList, adminDelete, statusUrl,
};
