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
// same story for the LiveKit webhook (OpsCat Bridge)
app.use('/api/hooks/livekit', express.raw({ type: '*/*', limit: '1mb' }));
// Bridge speech chunks (audio/* only — the JSON room routes stay untouched)
app.use('/api/room', express.raw({ type: 'audio/*', limit: '4mb' }));
app.use(express.json({ limit: '1mb' }));
// the public status page's "report a problem" form posts urlencoded
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

// unauthenticated: health + public status page
// BEFORE public.js: a status page on its own verified domain answers at that
// host's root, and public.js owns `/` for the marketing site.
app.use(require('./routes/status'));
app.use(require('./routes/public'));

// open ingest surface (API-key / agent-token / probe-key auth)
app.use('/v1', require('./routes/heartbeat')); // public ping, token-in-URL auth
app.use('/v1', require('./routes/ingest'));

// MCP: the OAuth 2.1 authorization server (+ .well-known discovery, which MUST
// live at the app root) and the Streamable HTTP endpoint. Both carry their own
// auth — Bearer for /mcp, the browser session for the consent screen — so they
// mount before the session-guarded /api routers.
app.use(require('./routes/mcp-oauth'));
app.use(require('./routes/mcp'));

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
    // Whether this instance can send mail at all. The login screen hides the
    // magic-link tab without it (the route silently no-ops), and the invite
    // dialog says "send an invitation" instead of promising one it cannot send.
    mail: require('./mailer').mailConfigured(),
  },
}));

// Enterprise-edition routes (billing / super-admin / self-service orgs). Self-guard by edition + role.
try { app.use('/api/billing', require('./routes/billing')); } catch (e) { /* EE module absent */ }
try { app.use('/api/superadmin', require('./routes/superadmin')); } catch (e) { /* EE module absent */ }
try { app.use('/api/orgs', require('./routes/orgs')); } catch (e) { /* EE module absent */ }

// OpsCat Bridge (community core; the hosted cloud gates by plan): mounts
// specific /api paths, everything else falls through to ops below.
app.use('/api', require('./routes/bridge'));

// session-authenticated app APIs — ops is the catch-all for the remaining
// /api/* routes, so it MUST be mounted last.
app.use('/api/admin', require('./routes/admin'));
app.use('/api/synthetics', require('./routes/synthetics'));
app.use('/api/reputation', require('./routes/reputation'));
app.use('/api/vendors', require('./routes/vendors'));
app.use('/api/oncall', require('./routes/oncall'));
app.use('/api', require('./routes/ops'));

// --- static: marketing site at /, app SPA at /app ---
const pub = config.publicDir;         // built web/ (app), served under /app
const wwwDir = config.wwwDir;          // marketing static, served at /
// host-agent files (repo root /agent, /app/agent in the Docker image) so a
// server can be onboarded with a single command, no checkout needed:
//   curl -fsSL https://<host>/agent/install.sh | sudo OPSCAT_URL=… OPSCAT_AGENT_TOKEN=… sh
const agentDir = path.join(__dirname, '..', '..', 'agent');
if (fs.existsSync(agentDir)) {
  app.use('/agent', express.static(agentDir, { maxAge: '5m', index: false }));
}
const appIndex = path.join(pub, 'index.html');
if (fs.existsSync(pub)) {
  app.use('/app', express.static(pub, { maxAge: '1h', index: 'index.html' }));
  // Express 5 / path-to-regexp v8: wildcards must be NAMED — a bare '*' throws at
  // registration. '*splat' is the SPA catch-all that serves index.html for deep links.
  app.get(['/app', '/app/*splat'], (req, res) => res.sendFile(appIndex));
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
require('./engine/automations').start();
require('./engine/scout').start();
require('./engine/synthetics').start();
require('./engine/reputation').start();
require('./engine/snmp').start();
require('./engine/heartbeats').start();
require('./engine/vendors').start();
require('./engine/reports').start();
require('./engine/retention').start();
require('./engine/reconcile').start(); // orphan sweeper for provisioned sensor nodes
require('./engine/oncall').start();        // on-call gap watch (docs/ONCALL-V1.md)
require('./engine/bridge-insights').start(); // Bridge AI analyzer (docs/BRIDGE.md phase 3)

app.listen(config.port, () => {
  console.log(`OpsCat server listening on :${config.port}`);
});

/* In production a rejected promise must not take the server down: one failed
 * alert delivery is not a reason to stop ingesting logs. Under test it must do
 * exactly that.
 *
 * The reason is the Postgres port. Once the storage layer is async, a forgotten
 * `await` shows up as an unhandled rejection and NOTHING ELSE — the request
 * still answers 200, the harness still records a PASS, and the only trace is a
 * line on stderr that a green CI run scrolls past. Logging it is how a missed
 * await stays invisible for a release. Exiting non-zero is how it becomes a
 * build failure.
 *
 * NODE_ENV=test is set by run-e2e.js, so this is live for every harness. */
process.on('unhandledRejection', (e) => {
  console.error('unhandledRejection', e);
  if (process.env.NODE_ENV === 'test') {
    console.error('exiting non-zero: an unhandled rejection under test is a failure, not a log line');
    process.exit(1);
  }
});
