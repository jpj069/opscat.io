'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const config = require('./config');
require('./db'); // opens DB, applies schema/migrations, resolves app secret
const edition = require('./edition'); // sets plan enforcement (community vs cloud)
const { securityHeaders } = require('./security');
const { seed } = require('./engine/seed');

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', 1);

app.use(securityHeaders);
// Stripe webhook needs the raw body for signature verification — must run
// before the JSON parser consumes the stream.
app.use('/api/billing/webhook', express.raw({ type: '*/*', limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));

// unauthenticated: health + public status page
app.use(require('./routes/public'));

// open ingest surface (API-key / agent-token / probe-key auth)
app.use('/v1', require('./routes/ingest'));

// IMPORTANT: mount specific /api/* routers BEFORE the broad '/api' ops router,
// whose requireSession applies to everything under it. Public routes (plans,
// signup, Google OAuth, the Stripe webhook) must be reachable without a session.
app.use('/api/auth', require('./routes/auth'));
app.use('/api/auth', require('./routes/oauth-github')); // community: GitHub login
let eeOAuth = false;
try { app.use('/api/auth', require('./routes/oauth')); eeOAuth = true; } catch (e) { /* EE module absent */ }

// public config for the login/pricing UI (no auth): plans, edition, auth options
app.get('/api/plans', (req, res) => res.json({
  edition: edition.EDITION,
  plans: require('./plans').publicPlans(),
  auth: {
    google: eeOAuth && !!config.google.clientId,
    microsoft: eeOAuth && !!config.microsoft.clientId,
    github: !!config.github.clientId,
    signupsOpen: config.signupsOpen && edition.isCloud(),
  },
}));

// Enterprise-edition routes (billing / super-admin / self-service orgs). Self-guard by edition + role.
try { app.use('/api/billing', require('./routes/billing')); } catch (e) { /* EE module absent */ }
try { app.use('/api/superadmin', require('./routes/superadmin')); } catch (e) { /* EE module absent */ }
try { app.use('/api/orgs', require('./routes/orgs')); } catch (e) { /* EE module absent */ }

// session-authenticated app APIs — ops is the catch-all for the remaining
// /api/* routes, so it MUST be mounted last.
app.use('/api/admin', require('./routes/admin'));
app.use('/api/synthetics', require('./routes/synthetics'));
app.use('/api', require('./routes/ops'));

// --- static: marketing site at /, app SPA at /app ---
const pub = config.publicDir;         // built web/ (app), served under /app
const wwwDir = config.wwwDir;          // marketing static, served at /
const appIndex = path.join(pub, 'index.html');
if (fs.existsSync(pub)) {
  app.use('/app', express.static(pub, { maxAge: '1h', index: 'index.html' }));
  app.get(['/app', '/app/*'], (req, res) => res.sendFile(appIndex));
}
if (wwwDir && fs.existsSync(wwwDir)) {
  app.use(express.static(wwwDir, { maxAge: '1h', index: 'index.html' }));
  app.get('/', (req, res) => res.sendFile(path.join(wwwDir, 'index.html')));
} else if (fs.existsSync(pub)) {
  app.get('/', (req, res) => res.redirect('/app'));
} else {
  app.get('/', (req, res) => res.json({ service: 'opscat', note: 'frontend not built' }));
}

// JSON 404 + error handler (never leak stack traces)
app.use((req, res) => res.status(404).json({ error: 'not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid JSON body' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'body too large' });
  }
  console.error('unhandled error:', err && err.message);
  res.status(500).json({ error: 'internal error' });
});

// bootstrap + engines
seed();
require('./engine/alerts').start();
require('./engine/synthetics').start();
require('./engine/snmp').start();
require('./engine/retention').start();

app.listen(config.port, () => {
  console.log(`OpsCat server listening on :${config.port}`);
});

process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
