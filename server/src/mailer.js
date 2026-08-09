'use strict';
// Outbound e-mail behind one interface, with two interchangeable transports:
//   - Resend HTTP API (RESEND_API_KEY) — default for the hosted cloud
//   - generic SMTP submission via nodemailer (SMTP_HOST/PORT/USER/PASS/SECURE)
//     so self-hosters can point at any relay (SES, Mailgun, corporate smarthost)
// MAIL_TRANSPORT=resend|smtp forces one; unset, Resend wins when both are set.
const config = require('./config');

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

function transport() {
  if (config.mailTransport === 'resend') return config.resendApiKey ? 'resend' : null;
  if (config.mailTransport === 'smtp') return config.smtp.host ? 'smtp' : null;
  if (config.resendApiKey) return 'resend';
  if (config.smtp.host) return 'smtp';
  return null;
}

function mailConfigured() { return transport() !== null; }

// to: array of addresses. Throws with a transport-tagged message on failure.
async function sendMail({ from, to, subject, html }) {
  const t = transport();
  if (!t) throw new Error('no mail transport configured (set RESEND_API_KEY or SMTP_HOST)');
  if (t === 'resend') {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html }),
    });
    if (!resp.ok) throw new Error(`resend ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    return;
  }
  try {
    await smtp().sendMail({ from, to, subject, html });
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

module.exports = { sendMail, mailConfigured, linkMail };
