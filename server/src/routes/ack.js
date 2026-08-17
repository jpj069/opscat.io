'use strict';
/**
 * `/a/:token` — acknowledge an alert from whatever device the message reached
 * (docs/ONCALL-V1.md §7).
 *
 * **The ack route must not be a GET.** Corporate mail scanners and link-preview
 * bots fetch every URL in a message, so an acknowledging GET means alerts
 * acknowledge themselves before the human has looked at their phone — silently,
 * and only for the customers whose mail gateway does it. So `GET` renders a
 * confirmation screen with a button and `POST` performs the acknowledgement.
 * That is the same two-step the status-page unsubscribe uses, for the same
 * reason.
 *
 * The route is public by design: the token IS the credential (32 random bytes,
 * stored as a SHA-256 hash, single use, expiring). Requiring a session instead
 * would defeat the point — the person is holding a phone at 03:02, and the
 * whole feature is "one tap, the ringing stops".
 */
const express = require('express');
const { escapeHtml: esc, RateLimiter } = require('../util');
const chain = require('../engine/alert-chain');

const router = express.Router();

// A token is unguessable, but the endpoint is public and cheap to hammer.
const limiter = new RateLimiter({ perMinute: 60, burst: 20 });

function page(res, status, title, body, extra = '') {
  res.status(status).type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} — OpsCat</title>
<style>
  :root { color-scheme: light dark; --bg:#ffffff; --fg:#16191d; --mut:#5b6570; --line:#e3e6ea; --acc:#388bfd; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0d1117; --fg:#e6edf3; --mut:#8b949e; --line:#232a33; }
  }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.55 system-ui, sans-serif;
         display:flex; min-height:100vh; align-items:center; justify-content:center; padding:24px; }
  .box { max-width:420px; width:100%; border:1px solid var(--line); border-radius:12px; padding:28px; }
  h1 { font-size:20px; margin:0 0 12px; }
  p { color:var(--mut); margin:0 0 16px; }
  .sub { font-weight:600; color:var(--fg); }
  button { width:100%; padding:12px 16px; font-size:16px; font-weight:600; border:0; border-radius:8px;
           background:var(--acc); color:#fff; cursor:pointer; }
</style></head>
<body><div class="box"><h1>${esc(title)}</h1>${body}${extra}</div></body></html>`);
}

const subjectLine = (info) => (info.subject
  ? `<p><span class="sub">${esc(info.subject.label)}</span> — ${esc(info.subject.title)}</p>` : '');

router.get('/a/:token', (req, res) => {
  if (!limiter.allow(req.ip || 'anon')) return page(res, 429, 'Too many requests', '<p>Try again in a moment.</p>');
  const info = chain.tokenInfo(req.params.token);
  // One answer for "wrong", "expired" and "already used": the token is a
  // credential, and telling a stranger which of the three it is tells them the
  // shape of a valid one.
  if (!info || info.expired) {
    return page(res, 404, 'Link no longer valid',
      '<p>This acknowledgement link has expired or has already been used. Open OpsCat to acknowledge the alert.</p>');
  }
  if (info.used || info.alert.status !== 'active') {
    return page(res, 200, 'Already acknowledged',
      `${subjectLine(info)}<p>This alert is ${esc(info.alert.status)} — nothing is escalating.</p>`);
  }
  page(res, 200, 'Acknowledge this alert', subjectLine(info)
    + '<p>Acknowledging stops the escalation. It does not assign the case to you.</p>'
    + `<form method="post" action="/a/${esc(req.params.token)}"><button type="submit">Acknowledge</button></form>`);
});

router.post('/a/:token', (req, res) => {
  if (!limiter.allow(req.ip || 'anon')) return page(res, 429, 'Too many requests', '<p>Try again in a moment.</p>');
  const r = chain.ackByToken(req.params.token);
  if (!r) {
    return page(res, 404, 'Link no longer valid',
      '<p>This acknowledgement link has expired or has already been used.</p>');
  }
  page(res, 200, 'Acknowledged', subjectLine(r)
    + '<p>The escalation has stopped. Thank you — go back to sleep.</p>');
});

module.exports = router;
