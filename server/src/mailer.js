'use strict';
// Outbound e-mail behind one interface. Transports:
//   - generic SMTP submission via nodemailer (SMTP_HOST/PORT/USER/PASS/SECURE)
//     so self-hosters can point at any relay (SES, Mailgun, Resend's SMTP,
//     a corporate smarthost)
//   - the hosted service's own HTTP mail API, which lives in
//     `src/ee/mail-transport.js` and is therefore absent from the community
//     build. When that module is present and configured it is the default.
// MAIL_TRANSPORT=<name>|smtp forces one; MAIL_TRANSPORT=off disables mail
// entirely (the e2e harnesses use it so an exported key can never send live
// mail). Unset: the hosted transport when configured, otherwise SMTP when
// SMTP_HOST is set.
const config = require('./config');

// Optional private transport. A missing module is the community build; any
// OTHER load error is a real bug and must not be swallowed as "absent".
let hosted = null;
try { hosted = require('./ee/mail-transport'); } catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND' || !String(e.message).includes('mail-transport')) throw e;
}

// The Resend HTTP transport was removed. A deployment that still exports only
// RESEND_API_KEY would otherwise lose mail without a word, so say so once.
if (process.env.RESEND_API_KEY && !config.smtp.host && !(hosted && hosted.configured())) {
  console.warn('[mail] RESEND_API_KEY is set but the Resend transport was removed — '
    + 'configure SMTP instead (Resend: SMTP_HOST=smtp.resend.com SMTP_PORT=465 '
    + 'SMTP_SECURE=true SMTP_USER=resend SMTP_PASS=<the API key>). Mail is OFF.');
}

let smtpTransport = null;
function smtp() {
  if (!smtpTransport) {
    const nodemailer = require('nodemailer');
    smtpTransport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  return smtpTransport;
}

// Test seam: a harness that wants to see the finished message without any
// network sets a sink. It takes precedence over every transport (including
// MAIL_TRANSPORT=off) and receives exactly what a transport would have sent.
let testSink = null;
function _setTestSink(fn) { testSink = typeof fn === 'function' ? fn : null; }

function transport() {
  if (testSink) return 'test';
  const forced = config.mailTransport;
  if (forced === 'off') return null;
  if (forced === 'smtp') return config.smtp.host ? 'smtp' : null;
  if (forced && hosted && forced === hosted.name) return hosted.configured() ? 'hosted' : null;
  if (hosted && hosted.configured()) return 'hosted';
  if (config.smtp.host) return 'smtp';
  return null;
}

function mailConfigured() { return transport() !== null; }

// Which transport is active, and — for one with a readiness check — whether its
// credential is accepted. Logged once at boot; never throws.
async function describe() {
  const t = transport();
  if (t === 'hosted') return `${hosted.name} (key ${hosted.probe ? await hosted.probe() : 'unchecked'})`;
  if (t === 'smtp') return `smtp (${config.smtp.host}:${config.smtp.port})`;
  return t || 'none';
}

// to: array of addresses. Throws with a transport-tagged message on failure.
//
// `text` is the plain-text alternative and every transport carries it.
// It is optional because the three auth mails are a link and a sentence, but
// anything a machine sends repeatedly should pass one: a message with no
// text/plain part scores as bulk with most filters, and it is the only thing a
// terminal client or a watch notification ever renders.
//
// `headers` is an object of extra headers. Values must already be header-safe
// — see `lib/alert-mail.js` `headerSafe()`; a bare CR or LF in one ends the
// header and begins another, which in a mail is a forged Bcc. A transport may
// carry only a subset of them (the hosted one drops anything outside its
// provider's allow-list); SMTP carries all of them.
async function sendMail({ from, to, subject, html, text, headers }) {
  const t = transport();
  if (!t) throw new Error('no mail transport configured (set SMTP_HOST)');
  const extra = headers && Object.keys(headers).length ? headers : undefined;
  const msg = { from, to, subject, html, ...(text ? { text } : {}), ...(extra ? { headers: extra } : {}) };
  if (t === 'test') { await testSink(msg); return; }
  if (t === 'hosted') { await hosted.send(msg); return; }
  try {
    await smtp().sendMail(msg);
  } catch (e) {
    throw new Error(`smtp: ${String(e.message).slice(0, 200)}`);
  }
}

// One button, one copyable URL — the shape all three transactional auth mails
// share (sign-in link, invitation, password reset). Inline styles only: mail
// clients strip <style> blocks, and several rewrite class names.
function linkMail({ intro, cta, url, note }) {
  return `<p style="font-family:sans-serif">${intro}</p>
<p><a href="${url}" style="font-family:sans-serif;background:#388bfd;color:#fff;padding:10px 18px;
border-radius:5px;text-decoration:none">${cta}</a></p>
<p style="font-family:monospace;font-size:12px;color:#666">${url}</p>${
  note ? `\n<p style="font-family:sans-serif;font-size:12px;color:#666">${note}</p>` : ''}`;
}

module.exports = { sendMail, mailConfigured, describe, linkMail, _setTestSink };
