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
const store = require('../db/shim');
const { getOrgSetting } = require('../db');
const { now, sha256, isEmail, escapeHtml } = require('../util');
const config = require('../config');
const mailer = require('../mailer');
const plans = require('../plans');
const pages = require('./status-pages');

const CONFIRM_TTL_MS = 48 * 60 * 60 * 1000;   // pending rows expire (and may re-subscribe)
const RESEND_MS = 10 * 60 * 1000;             // confirm-mail throttle per address
const MAX_PER_ORG = 5000;                     // abuse bound, far above any real page

// Two different ceilings, deliberately:
//   MAX_PER_ORG counts EVERY row and exists so a bot cannot fill the table with
//     pending addresses. It is not a commercial limit.
//   the plan's `statusSubscribers` counts CONFIRMED rows only (plans.js) and is
//     the commercial one. It is checked when a NEW address subscribes, never at
//     confirm time: a visitor who already has the mail in their inbox must not
//     be met with "link invalid" because the org filled up meanwhile. The org
//     stops taking new sign-ups at the limit; anyone mid-flight completes.
const orgPlanStmt = store.prepare('SELECT plan FROM organizations WHERE id = ?');

async function subscriberSlotFree(orgId) {
  const plan = ((await orgPlanStmt.get(orgId)) || {}).plan || 'free';
  return (await plans.checkLimit(orgId, plan, 'statusSubscribers')).ok;
}

const q = {
  byEmail: store.prepare('SELECT * FROM status_subscribers WHERE page_id = ? AND email = ?'),
  byToken: store.prepare('SELECT * FROM status_subscribers WHERE token_hash = ?'),
  byId: store.prepare('SELECT * FROM status_subscribers WHERE id = ?'),
  count: store.prepare('SELECT COUNT(*) c FROM status_subscribers WHERE org_id = ?'),
  // ON CONFLICT, not "we looked a statement ago and there was no row". Two
  // simultaneous sign-ups of the same address collide on UNIQUE(page_id, email);
  // under Postgres that is a 23505 which ABORTS the enclosing transaction, and
  // here it would mail a second confirm link whose token has already replaced the
  // one in the first mail. `.changes` says whether this caller owns the row.
  ins: store.prepare(`INSERT INTO status_subscribers (org_id, page_id, email, token_hash, created_at, last_sent_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (page_id, email) DO NOTHING`),
  touchSent: store.prepare('UPDATE status_subscribers SET last_sent_at = ? WHERE id = ?'),
  // The resend throttle lives in the WHERE clause for the same reason: two
  // re-subscribes arriving together both pass a JS `t - last_sent_at >= RESEND_MS`
  // check, both mint a token, and the second overwrites the first — so the link in
  // the first mail is dead before it is read. Bound: (hash, t, t, id, t - RESEND_MS).
  refresh: store.prepare(`UPDATE status_subscribers SET token_hash = ?, created_at = ?, last_sent_at = ?
    WHERE id = ? AND COALESCE(last_sent_at, 0) <= ?`),
  // Claiming the confirmation is what keeps it counting ONCE against the plan's
  // `statusSubscribers` allowance — the number the org is billed on. A confirm
  // link gets clicked twice all the time (a mail scanner, then the human), and
  // both clicks would otherwise pass the `row.confirmed_at` check.
  confirm: store.prepare('UPDATE status_subscribers SET confirmed_at = ? WHERE id = ? AND confirmed_at IS NULL'),
  del: store.prepare('DELETE FROM status_subscribers WHERE id = ?'),
  confirmedOf: store.prepare(`SELECT * FROM status_subscribers
    WHERE page_id = ? AND confirmed_at IS NOT NULL`),
  org: store.prepare('SELECT * FROM organizations WHERE id = ?'),
};

const enabled = (orgId) => getOrgSetting(orgId, 'status_subscribers_enabled', '1') === '1';
// Takes a PAGE since schema v18 — subscriptions belong to the page they were
// made on, because an audience-specific page has its own audience. The enable
// switch and the mail transport stay org-level questions.
const available = (page) => !!page && enabled(page.org_id) && mailer.mailConfigured();
// The same question asked about an ORG rather than a page, for the admin screen,
// which has no page in hand. It exists because `available(req.orgId)` type-checks
// fine and is wrong: a uuid is truthy, `page.org_id` on a string is undefined,
// and `enabled(undefined)` falls through to the '1' default — so an org that had
// switched subscriptions OFF still saw `available: true`. Two questions, two
// functions, rather than one that silently accepts either.
const availableForOrg = (orgId) => enabled(orgId) && mailer.mailConfigured();

// The page's public URL — its own domain when it has a verified one, otherwise
// /status or /status/<slug>. Confirm/unsubscribe URLs carry only the token: it
// is globally unique, so the page falls out of the row.
const statusUrl = async (page) => pages.absoluteUrl(page);

// The page a confirm/unsubscribe link belongs to, for rendering that flow in the
// page's own branding. Returns null for a token nobody recognises — the mini
// page then falls back to neutral chrome rather than leaking a guess.
async function pageForToken(token) {
  if (typeof token !== 'string' || token.length < 20) return null;
  const row = await q.byToken.get(sha256(token));
  return row ? pages.pageById(row.page_id) : null;
}
async function pageForRowId(id) {
  const row = await q.byId.get(Number(id));
  return row ? pages.pageById(row.page_id) : null;
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

async function sendConfirmMail(page, email, token) {
  await mailer.sendMail({
    from: fromAddress(), to: email,
    subject: `Confirm your ${page.name} status updates`,
    html: await brandedMail(page, {
      body: `<p>You (or someone using this address) asked for status updates from `
        + `<strong>${escapeHtml(page.name)}</strong>. Click to confirm — until then, nothing `
        + 'else will be sent to this address.</p>',
      cta: { label: 'Confirm subscription', url: confirmUrl(token) },
      note: 'The link is valid for 48 hours. Not you? Just ignore this mail.',
    }),
  });
}

// Status mails wear the PAGE's brand, not OpsCat's: they are the same
// conversation as the status page itself, and a subscriber who confirmed on a
// logo-bearing page should not get an unbranded box back. The logo is linked
// absolutely (a mail has no origin) and every client that blocks remote images
// still sees the name in the alt text.
async function brandedMail(page, { body, cta, note, footer }) {
  const b = await require('./status-branding').brandingFor(page, await pages.absoluteUrl(page));
  const p = b.palette;
  const head = b.logoUrl
    ? `<img src="${b.logoUrl}" alt="${escapeHtml(page.name)}" style="height:28px;max-width:200px">`
    : `<span style="display:inline-block;width:22px;height:22px;border-radius:6px;background:${b.accent};
        vertical-align:middle"></span> <strong style="color:${p.heading};vertical-align:middle">${
  escapeHtml(page.name)}</strong>`;
  return `<div style="background:${p.bg};padding:24px;font-family:Inter,system-ui,sans-serif;color:${p.text}">
  <div style="max-width:520px;margin:0 auto">
    <div style="margin-bottom:16px">${head}</div>
    <div style="background:${p.surface};border:1px solid ${p.borderStrong};border-radius:8px;padding:20px">
      <div style="font-size:14px;line-height:1.5">${body}</div>
      ${cta ? `<p style="margin:18px 0 4px"><a href="${cta.url}"
        style="background:${b.accent};color:${b.accentInk};text-decoration:none;border-radius:6px;
        padding:10px 18px;font-weight:600;font-size:13px;display:inline-block">${cta.label}</a></p>` : ''}
      ${note ? `<p style="font-size:12px;color:${p.muted};margin-top:14px">${note}</p>` : ''}
    </div>
    ${footer ? `<p style="font-size:12px;color:${p.muted};margin-top:14px">${footer}</p>` : ''}
  </div>
</div>`;
}

// Uniform by design: every path returns { ok: true } — a probe cannot learn
// whether an address is new, pending or already subscribed.
async function subscribe(page, rawEmail) {
  if (!available(page)) return { ok: false, unavailable: true };
  const orgId = page.org_id;
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!isEmail(email) || email.length > 200) return { ok: true };
  const t = now();
  const existing = await q.byEmail.get(page.id, email);
  if (existing && existing.confirmed_at) return { ok: true };
  if (existing) {
    if (t - (existing.last_sent_at || 0) < RESEND_MS) return { ok: true };
    const token = crypto.randomBytes(32).toString('base64url');
    // The stored token is the one that gets mailed: only the caller whose UPDATE
    // won the throttle sends. The loser answers uniformly and mails nothing.
    if ((await q.refresh.run(sha256(token), t, t, existing.id, t - RESEND_MS)).changes !== 1) return { ok: true };
    sendConfirmMail(page, email, token).catch((e) =>
      console.error('[subscribers] confirm mail:', e.message));
    return { ok: true };
  }
  if ((await q.count.get(orgId)).c >= MAX_PER_ORG) return { ok: true };
  if (!(await subscriberSlotFree(orgId))) return { ok: true }; // plan full — same uniform answer
  const token = crypto.randomBytes(32).toString('base64url');
  // Insert first, mail second: the row is the claim on this address, and only the
  // caller that actually inserted it holds the token the confirm link carries.
  if ((await q.ins.run(orgId, page.id, email, sha256(token), t, t)).changes !== 1) return { ok: true };
  sendConfirmMail(page, email, token).catch((e) =>
    console.error('[subscribers] confirm mail:', e.message));
  return { ok: true };
}

// -> { orgId, pageId } on success, null on anything else (unknown, expired, already)
async function confirm(token) {
  if (typeof token !== 'string' || token.length < 20) return null;
  const row = await q.byToken.get(sha256(token));
  if (!row || row.confirmed_at) return null;
  if (now() - row.created_at > CONFIRM_TTL_MS) { await q.del.run(row.id); return null; }
  // `.changes`, not the read above, decides. A second click of the same link is
  // "already confirmed" (null), not a second confirmed subscriber — otherwise the
  // plan allowance is double-counted and the welcome path runs twice.
  if ((await q.confirm.run(now(), row.id)).changes !== 1) return null;
  return { orgId: row.org_id, pageId: row.page_id };
}

// works for pending AND confirmed rows — an unconfirmed address must be able
// to stop the confirm mails too. -> { orgId, pageId } or null.
async function unsubscribe(token) {
  if (typeof token !== 'string' || token.length < 20) return null;
  const row = await q.byToken.get(sha256(token));
  if (!row) return null;
  await q.del.run(row.id);
  return { orgId: row.org_id, pageId: row.page_id };
}

// Called from lib/incidents for every transition of a published incident and
// the moment one becomes published. Fire-and-forget per subscriber: one bad
// address must not stop the fan-out, and the caller does not wait.
// Fans out per PAGE, not per org: a subscriber signed up on one page and should
// hear about the things that page shows. An incident naming no component is an
// org-wide announcement and reaches every page — which is also what keeps the
// pre-v18 behaviour intact, since those incidents are the common case.
async function notifyIncident(incident, kind, message) {
  if (!enabled(incident.org_id) || !mailer.mailConfigured()) return;
  const componentIds = (await store.prepare('SELECT component_id FROM incident_components WHERE incident_id = ?')
    .all(incident.id)).map((r) => r.component_id);
  // AWAITED: the page set an incident may be mailed about. Left pending, the
  // caller below would iterate nothing — or, worse, a truthy predicate would
  // widen it to every page of the org (see lib/status-pages.js).
  const targets = await pages.pagesForIncidentComponents(incident.org_id, componentIds);
  const label = `INC-${2000 + incident.id}`;
  const verb = kind === 'published' ? 'incident' : incident.status;
  for (const page of targets) {
    if (!published(page)) continue;
    const subs = await q.confirmedOf.all(page.id);
    if (!subs.length) continue;
    const subject = `[${page.name} status] ${label} ${verb}: ${incident.title}`;
    const url = await statusUrl(page);
    for (const s of subs) {
      // the clear token left the process with the confirm mail (only its hash is
      // stored), so notification mails address unsubscribe by row id + keyed MAC
      // — stateless, and deleting the row revokes it
      const mac = crypto.createHmac('sha256', config.secret).update(`unsub:${s.id}`).digest('base64url');
      const unsub = `${config.baseUrl}/status/unsubscribe?id=${s.id}&sig=${mac}`;
      const html = await brandedMail(page, {
        body: `<p><strong>${label}</strong> — ${escapeHtml(incident.title)}</p>
<p>Status: <strong>${escapeHtml(incident.status)}</strong>${message ? `<br>${escapeHtml(message)}` : ''}</p>`,
        cta: { label: 'View the status page', url },
        footer: `<a href="${unsub}">Unsubscribe</a> from ${escapeHtml(page.name)} status updates.`,
      });
      mailer.sendMail({ from: fromAddress(), to: s.email, subject, html })
        .catch((e) => console.error(`[subscribers] notify ${s.email}:`, e.message));
    }
  }
}

// An unpublished page has no public presence, so it sends nothing either — the
// same rule the page itself follows, applied to the mails it would have caused.
const published = (page) => page.published === 1;

// the MAC-addressed unsubscribe used in notification mails
async function unsubscribeById(id, sig) {
  const rowId = Number(id);
  if (!Number.isInteger(rowId) || typeof sig !== 'string') return null;
  const mac = crypto.createHmac('sha256', config.secret).update(`unsub:${rowId}`).digest('base64url');
  if (sig.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(mac))) return null;
  const row = await q.byId.get(rowId);
  if (!row) return null;
  await q.del.run(row.id);
  return { orgId: row.org_id, pageId: row.page_id };
}

async function adminList(orgId) {
  const rows = await store.prepare(`SELECT s.id, s.email, s.confirmed_at, s.created_at, s.page_id, p.name page_name
    FROM status_subscribers s LEFT JOIN status_pages p ON p.id = s.page_id
    WHERE s.org_id = ? ORDER BY s.created_at DESC LIMIT 500`).all(orgId);
  return {
    confirmed: rows.filter((r) => r.confirmed_at).length,
    pending: rows.filter((r) => !r.confirmed_at).length,
    rows: rows.map((r) => ({ id: r.id, email: r.email, pageId: r.page_id, pageName: r.page_name,
      confirmedAt: r.confirmed_at, createdAt: r.created_at })),
  };
}

async function adminDelete(orgId, id) {
  const row = await store.prepare('SELECT id FROM status_subscribers WHERE id = ? AND org_id = ?').get(id, orgId);
  if (!row) return false;
  await q.del.run(row.id);
  return true;
}

module.exports = {
  available, availableForOrg, enabled, subscribe, confirm, unsubscribe, unsubscribeById,
  notifyIncident, adminList, adminDelete, statusUrl, pageForToken, pageForRowId,
};
