'use strict';
/*
 * Shared plumbing for social logins. Community providers (GitHub) and the
 * EE providers (Google, Microsoft) both go through here: CSRF state rows in
 * `oauth_states`, then a common "e-mail → user" finish step.
 *
 * Sign-up for a previously unknown e-mail requires the EE accounts module
 * (cloud edition). In a community build that module is absent and unknown
 * e-mails are turned away — social login then only works for users that an
 * admin has already created.
 */
const crypto = require('crypto');
const { db } = require('./db');
const config = require('./config');
const edition = require('./edition');
const { now } = require('./util');
const sec = require('./security');

let eeAccounts = null;
try { eeAccounts = require('./ee/accounts'); } catch (e) { /* community build */ }

const insState = db.prepare('INSERT INTO oauth_states (state, provider, redirect, created_at) VALUES (?, ?, ?, ?)');
const getState = db.prepare('SELECT * FROM oauth_states WHERE state = ?');
const delState = db.prepare('DELETE FROM oauth_states WHERE state = ?');

const STATE_TTL_MS = 10 * 60 * 1000;

function beginState(provider, redirectQuery) {
  const state = crypto.randomBytes(16).toString('hex');
  const redirect = typeof redirectQuery === 'string' ? redirectQuery.slice(0, 200) : '/app';
  insState.run(state, provider, redirect, now());
  return state;
}

function consumeState(state, provider) {
  const row = state && getState.get(state);
  if (!row || row.provider !== provider || now() - row.created_at > STATE_TTL_MS) return null;
  delState.run(state);
  return row;
}

// Finish an OAuth flow with a provider-verified identity. `emailVerified` must
// only be true when the provider actually vouches for the address.
function finishLogin(req, res, row, { provider, email, name, emailVerified }) {
  if (!email || !emailVerified) return res.redirect('/app/login?error=email');
  email = String(email).toLowerCase();

  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (user) {
    if (!user.active) return res.redirect('/app/login?error=disabled');
    // adopt the provider for password-less accounts created via invite
    db.prepare("UPDATE users SET auth_provider = ? WHERE id = ? AND auth_provider = 'password' AND pass_hash = ''")
      .run(provider, user.id);
  } else {
    // unknown e-mail → self-service signup (cloud edition + EE module only)
    if (!edition.isCloud() || !config.signupsOpen || !eeAccounts) {
      return res.redirect('/app/login?error=nosignup');
    }
    const fallbackName = name || email.split('@')[0];
    const created = eeAccounts.createOrganizationWithOwner({
      orgName: `${fallbackName}'s team`, email, name: fallbackName, provider,
    });
    user = created.user;
    sec.audit(user.id, `signup_${provider}`, email, created.org.id);
  }

  const { sid } = sec.createSession(user.id, req);
  sec.setSessionCookie(res, sid);
  sec.audit(user.id, `login_${provider}`, sec.clientIp(req), user.org_id);
  res.redirect(typeof row.redirect === 'string' && row.redirect.startsWith('/') ? row.redirect : '/app');
}

module.exports = { beginState, consumeState, finishLogin };
