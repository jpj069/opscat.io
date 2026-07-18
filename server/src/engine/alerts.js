'use strict';
// Alert engine: matches pipeline events against rules, honors cooldowns,
// sends via e-mail (Resend/SMTP, see mailer.js), Teams, Slack, Telegram,
// Discord, ntfy, Pushover or a generic webhook, records every attempt.
const { db, getOrgSetting } = require('../db');
const config = require('../config');
const { now } = require('../util');
const mailer = require('../mailer');
const pipeline = require('./pipeline');

const getRules = db.prepare('SELECT * FROM alert_rules WHERE org_id = ? AND enabled = 1');
const getFire = db.prepare('SELECT fired_at FROM rule_fires WHERE rule_id = ? AND dedupe_key = ?');
const setFire = db.prepare(`INSERT INTO rule_fires (rule_id, dedupe_key, fired_at) VALUES (?, ?, ?)
  ON CONFLICT(rule_id, dedupe_key) DO UPDATE SET fired_at = excluded.fired_at`);
const insNotif = db.prepare(`INSERT INTO notifications
  (org_id, ts, rule_id, rule_name, event_id, case_label, channel, ok, error)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const caseForEvent = db.prepare("SELECT id FROM cases WHERE event_id = ? ORDER BY id DESC LIMIT 1");

function severityLabel(s) {
  return s >= 80 ? 'Critical' : s >= 60 ? 'High' : s >= 40 ? 'Medium' : s >= 20 ? 'Low' : 'Info';
}

async function sendEmail(recipients, subject, html, orgId = 1) {
  if (!mailer.mailConfigured()) throw new Error('no mail transport configured (RESEND_API_KEY or SMTP_HOST)');
  const from = getOrgSetting(orgId, 'alert_email_from', 'OpsCat <onboarding@resend.dev>');
  await mailer.sendMail({ from, to: recipients, subject, html });
}

async function sendTeams(url, title, text) {
  // MessageCard works for Teams incoming webhooks and most generic receivers.
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      '@type': 'MessageCard', '@context': 'https://schema.org/extensions',
      themeColor: 'f85149', summary: title, title, text,
    }),
  });
  if (!resp.ok) throw new Error(`webhook ${resp.status}`);
}

async function sendWebhook(url, payload) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error(`webhook ${resp.status}`);
}

async function sendSlack(url, title, text) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `*${title}*\n${text}` }),
  });
  if (!resp.ok) throw new Error(`slack ${resp.status}`);
}

async function sendDiscord(url, title, text) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Discord caps message content at 2000 chars.
    body: JSON.stringify({ content: `**${title}**\n${text}`.slice(0, 2000) }),
  });
  if (!resp.ok) throw new Error(`discord ${resp.status}`);
}

async function sendNtfy(url, title, text, severity) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      // ntfy headers must stay ASCII; the title is built from event fields.
      Title: title.replace(/[^\x20-\x7e]/g, '?'),
      Priority: severity >= 80 ? 'urgent' : severity >= 60 ? 'high' : 'default',
      Tags: 'rotating_light',
    },
    body: text,
  });
  if (!resp.ok) throw new Error(`ntfy ${resp.status}`);
}

async function sendTelegram(botToken, chatId, title, text) {
  const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: `${title}\n\n${text}` }),
  });
  if (!resp.ok) throw new Error(`telegram ${resp.status}: ${(await resp.text()).slice(0, 100)}`);
}

async function sendPushover(appToken, userKey, title, text, severity) {
  const resp = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      token: appToken, user: userKey, title, message: text.slice(0, 1024),
      priority: severity >= 80 ? '1' : '0',
    }),
  });
  if (!resp.ok) throw new Error(`pushover ${resp.status}: ${(await resp.text()).slice(0, 100)}`);
}

async function dispatch(rule, ev) {
  const orgId = rule.org_id || 1;
  const sevLabel = severityLabel(ev.severity);
  const caseRow = caseForEvent.get(ev.id);
  const caseLabel = caseRow ? `C-${1000 + caseRow.id}` : null;
  const title = `[OpsCat ${sevLabel}] ${ev.name} on ${ev.device}`;
  const text = `${ev.description || ev.name}\n\nSeverity: ${ev.severity} (${sevLabel})\n` +
    `Device: ${ev.device}${ev.ip ? ` (${ev.ip})` : ''}\nHits: ${ev.hits}\n` +
    (caseLabel ? `Case: ${caseLabel}\n` : '') + `${config.baseUrl}/app/monitor`;
  let recipients = [];
  try { recipients = JSON.parse(rule.recipients || '[]'); } catch { /* noop */ }

  if (rule.channel === 'email') {
    if (!recipients.length) throw new Error('rule has no e-mail recipients');
    const html = `<h2 style="font-family:sans-serif">${title}</h2>
<pre style="font-family:monospace;background:#f4f4f4;padding:12px;border-radius:6px">${text
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`;
    await sendEmail(recipients, title, html, orgId);
  } else if (rule.channel === 'teams') {
    const url = recipients[0] || getOrgSetting(orgId, 'teams_webhook_url');
    if (!url) throw new Error('no Teams webhook URL configured');
    await sendTeams(url, title, text.replace(/\n/g, '<br>'));
  } else if (rule.channel === 'slack') {
    if (!recipients.length) throw new Error('rule has no Slack webhook URL');
    for (const url of recipients) await sendSlack(url, title, text);
  } else if (rule.channel === 'discord') {
    if (!recipients.length) throw new Error('rule has no Discord webhook URL');
    for (const url of recipients) await sendDiscord(url, title, text);
  } else if (rule.channel === 'ntfy') {
    if (!recipients.length) throw new Error('rule has no ntfy topic URL');
    for (const url of recipients) await sendNtfy(url, title, text, ev.severity);
  } else if (rule.channel === 'telegram') {
    const botToken = getOrgSetting(orgId, 'telegram_bot_token');
    if (!botToken) throw new Error('telegram_bot_token not configured (Settings → Notifications)');
    if (!recipients.length) throw new Error('rule has no Telegram chat id');
    for (const chatId of recipients) await sendTelegram(botToken, chatId, title, text);
  } else if (rule.channel === 'pushover') {
    const appToken = getOrgSetting(orgId, 'pushover_token');
    if (!appToken) throw new Error('pushover_token not configured (Settings → Notifications)');
    if (!recipients.length) throw new Error('rule has no Pushover user key');
    for (const userKey of recipients) await sendPushover(appToken, userKey, title, text, ev.severity);
  } else {
    const url = recipients[0];
    if (!url) throw new Error('rule has no webhook URL');
    await sendWebhook(url, {
      source: 'opscat', event: ev.name, device: ev.device, ip: ev.ip, target: ev.target,
      severity: ev.severity, severity_label: sevLabel, hits: ev.hits,
      description: ev.description, case: caseLabel, ts: ev.last_seen,
    });
  }
  return caseLabel;
}

function onEvent(ev) {
  const t = now();
  const orgId = ev.org_id || 1;
  for (const rule of getRules.all(orgId)) {
    if (ev.severity < rule.severity_min) continue;
    if (rule.trigger_name && rule.trigger_name !== ev.name) continue;
    const fired = getFire.get(rule.id, ev.dedupe_key);
    if (fired && t - fired.fired_at < rule.cooldown_m * 60 * 1000) continue;
    setFire.run(rule.id, ev.dedupe_key, t);
    dispatch(rule, ev)
      .then((caseLabel) => insNotif.run(orgId, now(), rule.id, rule.name, ev.id, caseLabel, rule.channel, 1, null))
      .catch((err) => {
        insNotif.run(orgId, now(), rule.id, rule.name, ev.id, null, rule.channel, 0, String(err.message).slice(0, 300));
        console.error(`alert rule "${rule.name}" failed:`, err.message);
      });
  }
}

function start() { pipeline.on('event', onEvent); }

module.exports = { start, dispatch, sendEmail, severityLabel };
