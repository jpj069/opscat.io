'use strict';
// Account activation by LINK, not by a password an admin relays through a chat.
//
// The old flow created the user with a random password, showed it to the admin
// once, and forced a change at first login. Three things were wrong with it: the
// secret travelled through Slack/WhatsApp, the new colleague had to type a
// 16-character base64url string on a phone and then immediately invent another
// password, and none of it was necessary — the product already had magic-link
// sign-in, with the token table, the TTL and the mail transport all in place.
//
// So an invitation is a single-use token with a 7-day TTL and purpose 'invite'.
// Opening it signs the user in; setting a password is then an OFFER, because the
// account works passwordless and the same mail can always let them back in.
//
// The one-time password survives as the FALLBACK for instances with no mail
// transport (community, air-gapped). There the shared secret is unavoidable, so
// `must_change_password` stays set and the forced dialog stays hard — the point
// was never to remove that guard, it was to stop creating the secret it guards.
const crypto = require('crypto');
const q = require('../db/shim');
const { getSetting } = require('../db');
const config = require('../config');
const { now, sha256 } = require('../util');
const mailer = require('../mailer');

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// A re-invite supersedes the first link, and expired rows of every purpose are
// swept while we are here.
const delPending = q.prepare(`DELETE FROM login_tokens
  WHERE (user_id = ? AND purpose = 'invite') OR expires_at < ?`);
const insInvite = q.prepare(`INSERT INTO login_tokens (token_hash, user_id, created_at, expires_at, purpose)
  VALUES (?, ?, ?, ?, 'invite')`);
const clearPass = q.prepare(`UPDATE users SET pass_salt = '', pass_hash = '', must_change_password = 0
  WHERE id = ?`);

const mailConfigured = () => mailer.mailConfigured();

/**
 * Issue an activation link for `user` and mail it. Throws if the send fails, so
 * the caller can fall back to a one-time password rather than leaving someone
 * with an account they cannot reach.
 *
 * kind: 'invite' — a new colleague; 'reset' — an admin cleared their password.
 */
async function sendInviteLink(user, { kind = 'invite', orgName = '', invitedBy = '' } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const t = now();
  await delPending.run(user.id, t);
  await insInvite.run(sha256(token), user.id, t, t + INVITE_TTL_MS);

  const url = `${config.baseUrl}/app/login?token=${token}`;
  const from = getSetting('auth_email_from', getSetting('alert_email_from', 'OpsCat <onboarding@resend.dev>'));
  // "to Acme on OpsCat", but just "to OpsCat" when the org IS called OpsCat —
  // otherwise our own instance mails "invited to OpsCat on OpsCat".
  const where = orgName && orgName !== 'OpsCat' ? `${orgName} on OpsCat` : 'OpsCat';
  const by = invitedBy ? ` by ${invitedBy}` : '';
  const invite = kind === 'invite';

  await mailer.sendMail({
    from,
    to: [user.email],
    subject: invite ? `You have been invited to ${where}` : 'Set a new OpsCat password',
    html: mailer.linkMail({
      intro: invite
        ? `You have been invited to ${where}${by}. Click to activate your account:`
        : `Your OpsCat password was reset${by}. Click to set a new one:`,
      cta: invite ? 'Activate your account' : 'Set a new password',
      url,
      note: 'This link works once and expires in 7 days. If you did not expect it, ignore this mail.',
    }),
  });
}

/** Clear a user's password entirely — the account becomes link-only until they set one. */
function clearPassword(userId) {
  return clearPass.run(userId);
}

module.exports = { sendInviteLink, clearPassword, mailConfigured, INVITE_TTL_MS };
