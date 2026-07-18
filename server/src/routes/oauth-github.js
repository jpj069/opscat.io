'use strict';
/*
 * GitHub login — a community (Apache-2.0) feature.
 *
 *   GET /api/auth/github           — begin GitHub OAuth
 *   GET /api/auth/github/callback  — finish GitHub OAuth
 *
 * Routes 404 while GITHUB_CLIENT_ID is unset. Only primary+verified GitHub
 * e-mail addresses are accepted. In the community edition this signs in
 * existing users; self-service signup additionally needs the cloud edition
 * (see oauth-common.js).
 */
const express = require('express');
const config = require('../config');
const { httpError } = require('../util');
const oauth = require('../oauth-common');

const router = express.Router();

function configured() { return !!(config.github.clientId && config.github.clientSecret); }
function redirectUri() { return `${config.baseUrl}/api/auth/github/callback`; }

router.get('/github', (req, res) => {
  if (!configured()) return httpError(res, 404, 'GitHub login is not configured');
  const state = oauth.beginState('github', req.query.redirect);
  const params = new URLSearchParams({
    client_id: config.github.clientId,
    redirect_uri: redirectUri(),
    scope: 'read:user user:email',
    state,
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

router.get('/github/callback', async (req, res) => {
  if (!configured()) return httpError(res, 404, 'GitHub login is not configured');
  const { code, state } = req.query;
  const row = oauth.consumeState(state, 'github');
  if (!code || !row) return res.redirect('/app/login?error=oauth');
  try {
    const tokenResp = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: config.github.clientId, client_secret: config.github.clientSecret,
        code: String(code), redirect_uri: redirectUri(),
      }),
    });
    if (!tokenResp.ok) throw new Error(`token ${tokenResp.status}`);
    const { access_token } = await tokenResp.json();
    if (!access_token) throw new Error('no access token');

    const gh = (path) => fetch(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'opscat',
      },
    });
    const userResp = await gh('/user');
    if (!userResp.ok) throw new Error(`user ${userResp.status}`);
    const ghUser = await userResp.json();

    // /user.email is often null (private) — the emails endpoint carries the
    // verified flag we require.
    let email = null;
    const emailsResp = await gh('/user/emails');
    if (emailsResp.ok) {
      const emails = await emailsResp.json();
      const primary = Array.isArray(emails) && emails.find((e) => e.primary && e.verified);
      const anyVerified = Array.isArray(emails) && emails.find((e) => e.verified);
      email = (primary || anyVerified || {}).email || null;
    }
    oauth.finishLogin(req, res, row, {
      provider: 'github', email, emailVerified: !!email,
      name: ghUser.name || ghUser.login,
    });
  } catch (e) {
    console.error('github oauth error:', e.message);
    res.redirect('/app/login?error=oauth');
  }
});

module.exports = router;
