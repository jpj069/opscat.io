'use strict';
// Alert engine: matches pipeline events against rules, honors cooldowns,
// sends via Resend e-mail or Teams/webhook, records every attempt.
const { db, getOrgSetting } = require('../db');
const config = require('../config');
const { now } = require('../util');
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
  if (!config.resendApiKey) throw new Error('RESEND_API_KEY not configured');
  const from = getOrgSetting(orgId, 'alert_email_from', 'OpsCat <onboarding@resend.dev>');
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: recipients, subject, html }),
  });
  if (!resp.ok) throw new Error(`resend ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
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

async function dispatch(rule, ev) {
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
    await sendEmail(recipients, title, html);
  } else if (rule.channel === 'teams') {
    const url = recipients[0] || getSetting('teams_webhook_url');
    if (!url) throw new Error('no Teams webhook URL configured');
    await sendTeams(url, title, text.replace(/\n/g, '<br>'));
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

module.exports = { start, sendEmail, severityLabel };
