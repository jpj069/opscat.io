'use strict';
const express = require('express');
const crypto = require('crypto');
const { db, getSetting } = require('../db');
const config = require('../config');
const { now, sha256, verifyPassword, hashPassword, isEmail, isStr, httpError } = require('../util');
const sec = require('../security');
const mailer = require('../mailer');

const router = express.Router();

router.post('/login', (req, res) => {
  const ip = sec.clientIp(req);
  if (!sec.authLimiter.allow(ip)) return httpError(res, 429, 'too many attempts, slow down');
  const { email, password } = req.body || {};
  if (!isEmail(email) || !isStr(password, 200)) return httpError(res, 400, 'email and password required');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  // Always run the hash to keep timing uniform for unknown users.
  const ok = user
    ? verifyPassword(password, user.pass_salt, user.pass_hash)
    : (verifyPassword(password, '00'.repeat(16), '00'.repeat(64)), false);
  if (!ok || !user.active) {
    sec.audit(user ? user.id : null, 'login_failed', `${email} from ${ip}`);
    return httpError(res, 401, 'invalid credentials');
  }
  const { sid, csrf } = sec.createSession(user.id, req);
  sec.setSessionCookie(res, sid);
  sec.audit(user.id, 'login', ip);
  res.json({
    user: { id: user.id, email: user.email, name: user.name, role: user.role, color: user.color,
      mustChangePassword: !!user.must_change_password, isSuperAdmin: !!user.is_super_admin },
    csrf,
  });
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
      db.prepare('DELETE FROM login_tokens WHERE user_id = ? OR expires_at < ?').run(user.id, t);
      db.prepare(`INSERT INTO login_tokens (token_hash, user_id, created_at, expires_at)
        VALUES (?, ?, ?, ?)`).run(sha256(token), user.id, t, t + 15 * 60 * 1000);
      const url = `${config.baseUrl}/app/login?token=${token}`;
      const from = getSetting('auth_email_from', getSetting('alert_email_from', 'OpsCat <onboarding@resend.dev>'));
      // audit before the send so a delivery failure is still visible as a
      // matched request (unknown addresses leave no trace on purpose)
      sec.audit(user.id, 'magic_link_requested', ip);
      await mailer.sendMail({
        from, to: [user.email], subject: 'Your OpsCat sign-in link',
        html: `<p style="font-family:sans-serif">Click to sign in to OpsCat (valid 15 minutes):</p>
<p><a href="${url}" style="font-family:sans-serif;background:#388bfd;color:#fff;padding:10px 18px;
border-radius:5px;text-decoration:none">Sign in to OpsCat</a></p>
<p style="font-family:monospace;font-size:12px;color:#666">${url}</p>`,
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
  sec.audit(user.id, 'login_magic_link', ip);
  res.json({
    user: { id: user.id, email: user.email, name: user.name, role: user.role, color: user.color,
      mustChangePassword: !!user.must_change_password, isSuperAdmin: !!user.is_super_admin },
    csrf,
  });
});

router.post('/logout', sec.requireSession, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(req.session.id);
  sec.clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', sec.requireSession, (req, res) => {
  res.json({
    user: { id: req.user.id, email: req.user.email, name: req.user.name, role: req.user.role,
      color: req.user.color, mustChangePassword: !!req.user.must_change_password,
      isSuperAdmin: !!req.user.is_super_admin },
    csrf: req.session.csrf,
  });
});

router.post('/change-password', sec.requireSession, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!isStr(newPassword, 200)) return httpError(res, 400, 'newPassword required');
  if (newPassword.length < 12) return httpError(res, 400, 'new password must be at least 12 characters');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  // A forced change replaces an admin-issued password the user may never have
  // seen (e.g. after an SSO or magic-link login) — only voluntary changes must
  // prove knowledge of the old password.
  if (!user.must_change_password) {
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

module.exports = router;
