'use strict';
const express = require('express');
const crypto = require('crypto');
const { db, getSetting, getOrgSetting, listMemberships, getMembership } = require('../db');
const config = require('../config');
const { now, sha256, verifyPassword, hashPassword, isEmail, isStr, httpError } = require('../util');
const sec = require('../security');
const edition = require('../edition');
const mailer = require('../mailer');

const router = express.Router();

// The user object the browser gets, in one place — it is returned from three
// routes (password login, magic-link login, /me) and they must not drift.
// `hasPassword` is what lets the UI ask for the current one only when there IS
// one: an invited user sets their first password without proving anything, they
// proved ownership of the address by opening the activation link.
// Two shapes reach this: a full row from `SELECT *` (the two login routes) and
// the request context, which deliberately omits pass_hash and carries the derived
// `has_password` instead (see security.js). Reading only `pass_hash` here is how
// /me silently answered hasPassword:false forever — caught by e2e-invite.js.
const publicUser = (u) => ({
  id: u.id, email: u.email, name: u.name, role: u.role, color: u.color,
  mustChangePassword: !!u.must_change_password,
  hasPassword: u.has_password !== undefined ? !!u.has_password : !!u.pass_hash,
  isSuperAdmin: !!u.is_super_admin,
});

router.post('/login', (req, res) => {
  const ip = sec.clientIp(req);
  if (!sec.authLimiter.allow(ip)) return httpError(res, 429, 'too many attempts, slow down');
  const { email, password } = req.body || {};
  if (!isEmail(email) || !isStr(password, 200)) return httpError(res, 400, 'email and password required');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  // An empty pass_hash means "this account has no password" — an invited user who
  // has not set one, or an SSO/reset account. It must never be loggable-into with
  // any password, so it takes the same dummy-hash path as an unknown address (both
  // for the answer and for the timing).
  const hasPass = !!(user && user.pass_hash);
  // Always run the hash to keep timing uniform for unknown users.
  const ok = hasPass
    ? verifyPassword(password, user.pass_salt, user.pass_hash)
    : (verifyPassword(password, '00'.repeat(16), '00'.repeat(64)), false);
  if (!ok || !user.active) {
    sec.audit(user ? user.id : null, 'login_failed', `${email} from ${ip}`);
    return httpError(res, 401, 'invalid credentials');
  }
  const { sid, csrf } = sec.createSession(user.id, req);
  sec.setSessionCookie(res, sid);
  sec.audit(user.id, 'login', ip);
  res.json({ user: publicUser(user), csrf });
});

// --- magic-link login (passwordless) ---
// Always answers {ok:true} to prevent user enumeration. Token: 32 bytes,
// 15 min TTL, single use; delivered via the configured mail transport.
router.post('/magic-link', async (req, res) => {
  const ip = sec.clientIp(req);
  if (!sec.authLimiter.allow(`ml:${ip}`)) return httpError(res, 429, 'too many attempts, slow down');
  const { email } = req.body || {};
  if (!isEmail(email)) return httpError(res, 400, 'valid email required');
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email.toLowerCase());
  if (user && mailer.mailConfigured()) {
    try {
      const token = crypto.randomBytes(32).toString('base64url');
      const t = now();
      // Only this user's OTHER SIGN-IN tokens go — a pending invitation must
      // survive, or requesting a magic link would silently void the activation
      // link the admin just sent. Expired rows of any purpose are swept here too.
      db.prepare(`DELETE FROM login_tokens
        WHERE (user_id = ? AND purpose = 'login') OR expires_at < ?`).run(user.id, t);
      db.prepare(`INSERT INTO login_tokens (token_hash, user_id, created_at, expires_at, purpose)
        VALUES (?, ?, ?, ?, 'login')`).run(sha256(token), user.id, t, t + 15 * 60 * 1000);
      const url = `${config.baseUrl}/app/login?token=${token}`;
      const from = getSetting('auth_email_from', getSetting('alert_email_from', 'OpsCat <onboarding@resend.dev>'));
      // audit before the send so a delivery failure is still visible as a
      // matched request (unknown addresses leave no trace on purpose)
      sec.audit(user.id, 'magic_link_requested', ip);
      await mailer.sendMail({
        from, to: [user.email], subject: 'Your OpsCat sign-in link',
        html: mailer.linkMail({
          intro: 'Click to sign in to OpsCat (valid 15 minutes):',
          cta: 'Sign in to OpsCat', url,
        }),
      });
    } catch (e) { console.error('magic-link mail failed:', e.message); }
  }
  res.json({ ok: true });
});

router.post('/magic-login', (req, res) => {
  const ip = sec.clientIp(req);
  if (!sec.authLimiter.allow(`mt:${ip}`)) return httpError(res, 429, 'too many attempts, slow down');
  const { token } = req.body || {};
  if (!isStr(token, 100)) return httpError(res, 400, 'token required');
  const row = db.prepare('SELECT * FROM login_tokens WHERE token_hash = ?').get(sha256(token));
  const t = now();
  if (!row || row.used_at || row.expires_at < t) return httpError(res, 401, 'invalid or expired link');
  db.prepare('UPDATE login_tokens SET used_at = ? WHERE token_hash = ?').run(t, row.token_hash);
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(row.user_id);
  if (!user) return httpError(res, 401, 'account disabled');
  const { sid, csrf } = sec.createSession(user.id, req);
  sec.setSessionCookie(res, sid);
  sec.audit(user.id, row.purpose === 'invite' ? 'invite_accepted' : 'login_magic_link', ip);
  // `invited` tells the app this was an activation, not a routine sign-in, so it
  // can offer "set a password" once. An offer, not a gate: the account works
  // passwordless, and a link they just proved they can read is how they get back in.
  res.json({ user: publicUser(user), csrf, invited: row.purpose === 'invite' });
});

router.post('/logout', sec.requireSession, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(req.session.id);
  sec.clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', sec.requireSession, (req, res) => {
  res.json({ user: publicUser(req.user), csrf: req.session.csrf });
});

router.post('/change-password', sec.requireSession, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!isStr(newPassword, 200)) return httpError(res, 400, 'newPassword required');
  if (newPassword.length < 12) return httpError(res, 400, 'new password must be at least 12 characters');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  // Two cases need no proof of the old password: a FORCED change replaces an
  // admin-issued one the user may never have seen, and an account with NO
  // password (invited, or reset by an admin) has nothing to prove — ownership of
  // the address was proven by opening the link that created this session.
  // Only a voluntary change on an account that has a password must prove it.
  if (!user.must_change_password && user.pass_hash) {
    if (!isStr(currentPassword, 200)) return httpError(res, 400, 'currentPassword and newPassword required');
    if (!verifyPassword(currentPassword, user.pass_salt, user.pass_hash)) {
      return httpError(res, 401, 'current password incorrect');
    }
  }
  const { salt, hash } = hashPassword(newPassword);
  db.prepare('UPDATE users SET pass_salt = ?, pass_hash = ?, must_change_password = 0 WHERE id = ?')
    .run(salt, hash, user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(user.id, req.session.id);
  sec.audit(user.id, 'password_changed', null);
  res.json({ ok: true });
});

// --- multi-org: the caller's organizations + switching the active one ---
router.get('/orgs', sec.requireSession, (req, res) => {
  res.json({
    activeOrgId: req.orgId,
    orgs: listMemberships(req.user.id).map((m) => ({
      orgId: m.org_id, name: m.name, slug: m.slug, plan: m.plan, role: m.role,
      onboardingDone: getOrgSetting(m.org_id, 'onboarding_done', '1') === '1',
    })),
  });
});

router.post('/switch-org', sec.requireSession, (req, res) => {
  // Switching organizations is a Cloud-edition feature; community is single-org.
  if (!edition.isCloud()) return httpError(res, 403, 'switching organizations is a Cloud feature');
  const orgId = parseInt(req.body && req.body.orgId, 10);
  if (!Number.isInteger(orgId) || orgId <= 0) return httpError(res, 400, 'orgId required');
  // Only orgs the user is a member of. (Super-admins target other orgs through
  // the platform console's X-OpsCat-Org header, not this endpoint.)
  if (!getMembership(req.user.id, orgId)) return httpError(res, 403, 'not a member of that organization');
  db.prepare('UPDATE sessions SET active_org_id = ? WHERE id = ?').run(orgId, req.session.id);
  sec.audit(req.user.id, 'org_switch', `org ${orgId}`, orgId);
  res.json({ ok: true, activeOrgId: orgId });
});

module.exports = router;
