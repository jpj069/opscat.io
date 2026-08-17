'use strict';
// Alert engine: matches pipeline events against rules, honors cooldowns,
// sends via e-mail (Resend/SMTP, see mailer.js), Microsoft Teams, Slack,
// Telegram, Discord, ntfy, Pushover or a generic webhook, records every
// attempt.
//
// The Microsoft channel is `msteams` everywhere in code and storage; "Teams"
// alone is ambiguous now that On-Call has a Team object of its own
// (docs/ONCALL-V1.md §2). The UI label is still "Microsoft Teams".
const { db, getOrgSetting } = require('../db');
const config = require('../config');
const { now, DEFAULT_ORG_ID } = require('../util');
const mailer = require('../mailer');
const pipeline = require('./pipeline');
const { safeFetch } = require('../lib/ssrf');

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

async function sendEmail(recipients, subject, html, orgId = DEFAULT_ORG_ID) {
  if (!mailer.mailConfigured()) throw new Error('no mail transport configured (RESEND_API_KEY or SMTP_HOST)');
  const from = getOrgSetting(orgId, 'alert_email_from', 'OpsCat <onboarding@resend.dev>');
  await mailer.sendMail({ from, to: recipients, subject, html });
}

// Every channel below posts to a URL a `lead` typed into a rule, so all of them
// go through safeFetch — scheme check, SSRF guard on every redirect hop,
// timeout, body cap (lib/ssrf.js). Without it a rule is a request forgery
// primitive pointed at the host's own network, exactly like the automation
// webhook action was. Telegram and Pushover are deliberately NOT here: their
// URLs are fixed API hosts and only the addressee comes from the rule.
const jsonPost = (url, obj) => safeFetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj),
});

async function sendMsTeams(url, title, text) {
  // MessageCard works for Teams incoming webhooks and most generic receivers.
  const resp = await jsonPost(url, {
    '@type': 'MessageCard', '@context': 'https://schema.org/extensions',
    themeColor: 'f85149', summary: title, title, text,
  });
  if (!resp.ok) throw new Error(`webhook ${resp.status}`);
}

async function sendWebhook(url, payload) {
  const resp = await jsonPost(url, payload);
  if (!resp.ok) throw new Error(`webhook ${resp.status}`);
}

async function sendSlack(url, title, text) {
  const resp = await jsonPost(url, { text: `*${title}*\n${text}` });
  if (!resp.ok) throw new Error(`slack ${resp.status}`);
}

async function sendDiscord(url, title, text) {
  // Discord caps message content at 2000 chars.
  const resp = await jsonPost(url, { content: `**${title}**\n${text}`.slice(0, 2000) });
  if (!resp.ok) throw new Error(`discord ${resp.status}`);
}

async function sendNtfy(url, title, text, severity) {
  const resp = await safeFetch(url, {
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

/**
 * Send ONE message to ONE address on ONE channel.
 *
 * The alert chain (engine/alert-chain.js) delivers to a person's contact
 * methods, which are the same eight channels a rule can name — so it calls
 * this rather than growing a second copy of the transports. One implementation
 * means the SSRF guard, the ntfy header sanitising and the Discord length cap
 * cannot be right in one place and missing in the other.
 *
 * The three LOUD channels are here too, and they are the only ones that need
 * more than an address:
 *
 *  - `sms` and `voice` go through the provider adapter (`lib/telephony.js`),
 *    which is what keeps a vendor out of this file. A call is handed the
 *    acknowledgement TOKEN rather than a message, because a call that cannot be
 *    answered with a keypress is a robocall.
 *  - `push` carries a JSON subscription rather than an address, and reports its
 *    own cost as zero — it is the one loud channel that is free.
 *
 * The return value is `{ costMicros }` when the channel is metered, so the
 * caller can log what the night cost.
 */
async function sendVia(kind, address, { title, text, severity = 0, orgId = DEFAULT_ORG_ID,
  token = null, methodId = null } = {}) {
  if (kind === 'sms') {
    const r = await require('../lib/telephony').sendSms(orgId, address, text);
    return { costMicros: r.costMicros ?? null };
  }
  if (kind === 'voice') {
    if (!token) throw new Error('a voice call needs an acknowledgement token');
    const r = await require('../lib/telephony').placeCall(orgId, address, { token, text });
    return { costMicros: r.costMicros ?? null };
  }
  if (kind === 'push') {
    let sub = null;
    try { sub = JSON.parse(address); } catch { /* handled below */ }
    const wp = require('../lib/webpush');
    if (!wp.isSubscription(sub)) throw new Error('push subscription is unreadable');
    await wp.send(sub, { title, body: text.split('\n')[0], url: `${config.baseUrl}/app/oncall/alerts` }, methodId);
    return { costMicros: 0 };
  }
  if (kind === 'email') {
    const html = `<h2 style="font-family:sans-serif">${title}</h2>
<pre style="font-family:monospace;background:#f4f4f4;padding:12px;border-radius:6px">${text
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`;
    await sendEmail([address], title, html, orgId);
    return { costMicros: null };
  }
  if (kind === 'ntfy') { await sendNtfy(address, title, text, severity); return { costMicros: null }; }
  if (kind === 'telegram') {
    const botToken = getOrgSetting(orgId, 'telegram_bot_token');
    if (!botToken) throw new Error('telegram_bot_token not configured (Settings → Notifications)');
    await sendTelegram(botToken, address, title, text);
    return { costMicros: null };
  }
  if (kind === 'pushover') {
    const appToken = getOrgSetting(orgId, 'pushover_token');
    if (!appToken) throw new Error('pushover_token not configured (Settings → Notifications)');
    await sendPushover(appToken, address, title, text, severity);
    return { costMicros: null };
  }
  throw new Error(`channel "${kind}" is not available yet`);
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
  } else if (rule.channel === 'msteams') {
    const url = recipients[0] || getOrgSetting(orgId, 'msteams_webhook_url');
    if (!url) throw new Error('no Microsoft Teams webhook URL configured');
    await sendMsTeams(url, title, text.replace(/\n/g, '<br>'));
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

const getActiveWindow = db.prepare(`SELECT name FROM maintenance_windows
  WHERE org_id = ? AND starts_at <= ? AND ends_at >= ? ORDER BY id LIMIT 1`);

// The chain's own signals. A rule that raised an alert ON one of these would
// build a perpetual motion machine: exhausted → event → alert → exhausted. The
// refusal is recorded rather than silent, because a rule that quietly never
// fires is indistinguishable from a quiet night.
const SELF_EVENTS = ['alert_exhausted', 'alert_undeliverable', 'oncall_gap'];

function raiseFromRule(rule, ev, orgId) {
  const log = (err) => insNotif.run(orgId, now(), rule.id, rule.name, ev.id, null, 'alert', 0, err);
  if (SELF_EVENTS.includes(ev.name)) {
    return log(`refused: "${ev.name}" is raised BY the alert chain — a policy rule on it would escalate itself`);
  }
  // The OPEN case, not the latest one: an alert about a case somebody already
  // closed is the failure this whole slice is built to avoid.
  const c = require('../lib/cases').openForEvent(orgId, ev.id);
  if (!c) {
    return log('no open case for this event — cases open at severity 60+, and an alert needs a subject');
  }
  const r = require('./alert-chain').raise(orgId, {
    subjectKind: 'case', subjectId: c.id, policyId: rule.policy_id,
    source: `rule:${rule.id}`, severity: ev.severity,
  });
  if (r && r.error) log(`alert not raised: ${r.error}`);
}

function onEvent(ev) {
  const t = now();
  const orgId = ev.org_id || 1;
  const rules = getRules.all(orgId);
  if (!rules.length) return;
  // planned work: keep recording events, but hold every notification back —
  // one visible "suppressed" line per rule/cooldown in the notification log
  const win = getActiveWindow.get(orgId, t, t);
  for (const rule of rules) {
    if (ev.severity < rule.severity_min) continue;
    if (rule.trigger_name && rule.trigger_name !== ev.name) continue;
    const fired = getFire.get(rule.id, ev.dedupe_key);
    if (fired && t - fired.fired_at < rule.cooldown_m * 60 * 1000) continue;
    setFire.run(rule.id, ev.dedupe_key, t);
    if (win) {
      insNotif.run(orgId, now(), rule.id, rule.name, ev.id, null, rule.channel, 1,
        `suppressed: maintenance window "${win.name}"`);
      continue;
    }
    // A rule with a policy target raises an ALERT instead of notifying a
    // channel: the ladder, the ack and the escalation, with no flow involved.
    // That is what makes on-call work in the community edition out of the box
    // (docs/ONCALL-V1.md §8) — one column on the rule, not a second engine.
    if (rule.target_type === 'policy') { raiseFromRule(rule, ev, orgId); continue; }
    dispatch(rule, ev)
      .then((caseLabel) => insNotif.run(orgId, now(), rule.id, rule.name, ev.id, caseLabel, rule.channel, 1, null))
      .catch((err) => {
        insNotif.run(orgId, now(), rule.id, rule.name, ev.id, null, rule.channel, 0, String(err.message).slice(0, 300));
        console.error(`alert rule "${rule.name}" failed:`, err.message);
      });
  }
}

function start() { pipeline.on('event', onEvent); }

module.exports = { start, dispatch, sendVia, sendEmail, severityLabel, SELF_EVENTS };
