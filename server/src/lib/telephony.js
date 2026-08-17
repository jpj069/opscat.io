'use strict';
/**
 * SMS and voice — an ADAPTER with several implementations, never one vendor
 * wired in (docs/ONCALL-V1.md §7, §13.2).
 *
 * The shape is `engine/vendor-feeds.js`: ten status-feed formats behind one
 * interface. Here it is three telephony providers behind two verbs. That is not
 * architecture for its own sake — which provider OpsCat runs itself is
 * deliberately undecided, and the adapter is what keeps that decision
 * reversible. It also makes "bring your own credentials" real rather than a
 * bullet point: a self-hoster with a GSM modem uses `webhook` and is not waiting
 * for us to integrate anything.
 *
 * Two requirements the interface carries from day one, because they are what
 * separates a real alert from a robocall and a bill from a surprise:
 *
 *  - **A voice call is TTS text PLUS DTMF capture.** The provider is handed a
 *    callback URL, not a recording; `routes/voice.js` answers it with the
 *    provider's own call-flow document (TwiML / NCCO) which speaks the alert and
 *    then waits for a keypress. Without the second half it is a robocall that
 *    nobody can answer, and the person still has to find a laptop.
 *  - **Every send reports a cost signal.** `costMicros` is millionths of the
 *    account currency. Providers differ on when they know it — Vonage returns a
 *    price with the SMS response, Twilio only after the call completes — so the
 *    adapter reports what it got and falls back to the org's configured
 *    per-message price. A null there would make the metered channels the only
 *    part of the product whose spend cannot be answered from its own log.
 *
 * Credentials live in `org_settings`, encrypted with the app secret and never
 * returned by the API (the `llm.js` contract: GET reports `configured`, not the
 * secret).
 */
const { getOrgSetting, setOrgSetting } = require('../db');
const config = require('../config');
const { encrypt, decrypt } = require('../util');
const { safeFetch } = require('./ssrf');

const PROVIDERS = ['twilio', 'vonage', 'webhook'];
const TIMEOUT_MS = 15000;

// ---- configuration ---------------------------------------------------------
const KEYS = {
  provider: 'telephony_provider',
  sid: 'telephony_account',        // Twilio Account SID / Vonage API key
  secretEnc: 'telephony_secret',   // Twilio auth token / Vonage API secret — ENCRYPTED
  from: 'telephony_from',          // the calling/sending number, E.164
  webhookUrl: 'telephony_webhook_url',
  priceSms: 'telephony_price_sms_micros',
  priceVoice: 'telephony_price_voice_micros',
};

function readSecret(orgId) {
  const raw = getOrgSetting(orgId, KEYS.secretEnc, '');
  if (!raw) return '';
  try { return decrypt(raw, config.secret); } catch { return ''; }
}

function configFor(orgId) {
  return {
    provider: getOrgSetting(orgId, KEYS.provider, ''),
    account: getOrgSetting(orgId, KEYS.sid, ''),
    secret: readSecret(orgId),
    from: getOrgSetting(orgId, KEYS.from, ''),
    webhookUrl: getOrgSetting(orgId, KEYS.webhookUrl, ''),
    priceSms: parseInt(getOrgSetting(orgId, KEYS.priceSms, '') || '0', 10) || 0,
    priceVoice: parseInt(getOrgSetting(orgId, KEYS.priceVoice, '') || '0', 10) || 0,
  };
}

/** What the settings screen may see: everything except the secret itself. */
function statusFor(orgId) {
  const c = configFor(orgId);
  return {
    provider: c.provider, account: c.account, from: c.from, webhookUrl: c.webhookUrl,
    priceSmsMicros: c.priceSms, priceVoiceMicros: c.priceVoice,
    configured: isConfigured(orgId),
    hasSecret: !!c.secret,
  };
}

function save(orgId, patch) {
  if (patch.provider !== undefined) setOrgSetting(orgId, KEYS.provider, PROVIDERS.includes(patch.provider) ? patch.provider : '');
  if (patch.account !== undefined) setOrgSetting(orgId, KEYS.sid, String(patch.account).slice(0, 200));
  if (patch.from !== undefined) setOrgSetting(orgId, KEYS.from, String(patch.from).slice(0, 32));
  if (patch.webhookUrl !== undefined) setOrgSetting(orgId, KEYS.webhookUrl, String(patch.webhookUrl).slice(0, 500));
  if (patch.priceSmsMicros !== undefined) setOrgSetting(orgId, KEYS.priceSms, String(Math.max(0, parseInt(patch.priceSmsMicros, 10) || 0)));
  if (patch.priceVoiceMicros !== undefined) setOrgSetting(orgId, KEYS.priceVoice, String(Math.max(0, parseInt(patch.priceVoiceMicros, 10) || 0)));
  // '' clears the stored secret; anything else replaces it. It is never read back.
  if (patch.secret !== undefined) {
    setOrgSetting(orgId, KEYS.secretEnc, patch.secret ? encrypt(String(patch.secret), config.secret) : '');
  }
}

function isConfigured(orgId) {
  const c = configFor(orgId);
  if (c.provider === 'webhook') return !!c.webhookUrl;
  if (c.provider === 'twilio' || c.provider === 'vonage') return !!(c.account && c.secret && c.from);
  return false;
}

// ---- implementations -------------------------------------------------------
// Each returns { providerRef, costMicros } or throws. The throw message reaches
// the notification log verbatim, so it has to be readable by the person asking
// "why did my phone not ring".

const form = (obj) => new URLSearchParams(obj).toString();

async function twilioSms(c, to, text) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.account)}/Messages.json`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${c.account}:${c.secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form({ To: to, From: c.from, Body: text.slice(0, 1200) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`twilio ${resp.status}: ${String(body.message || '').slice(0, 200)}`);
  // Twilio prices a message asynchronously — `price` is null on create. The
  // org's configured per-message figure is what makes the spend answerable now.
  return { providerRef: body.sid || null, costMicros: priceToMicros(body.price) ?? c.priceSms };
}

async function twilioCall(c, to, answerUrl) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.account)}/Calls.json`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${c.account}:${c.secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    // `Url` is fetched by Twilio when the call connects and answered by
    // routes/voice.js with TwiML that speaks and then gathers a digit.
    body: form({ To: to, From: c.from, Url: answerUrl, Method: 'GET' }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`twilio ${resp.status}: ${String(body.message || '').slice(0, 200)}`);
  return { providerRef: body.sid || null, costMicros: c.priceVoice };
}

async function vonageSms(c, to, text) {
  const resp = await fetch('https://rest.nexmo.com/sms/json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ api_key: c.account, api_secret: c.secret, to: to.replace(/^\+/, ''), from: c.from, text: text.slice(0, 1200) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await resp.json().catch(() => ({}));
  const m = body.messages && body.messages[0];
  // Vonage answers 200 with a per-message status — a 200 here is NOT success.
  if (!resp.ok || !m || m.status !== '0') {
    throw new Error(`vonage ${(m && m.status) || resp.status}: ${String((m && m['error-text']) || '').slice(0, 200)}`);
  }
  return { providerRef: m['message-id'] || null, costMicros: priceToMicros(m['message-price']) ?? c.priceSms };
}

async function vonageCall(c, to, answerUrl) {
  // The Calls API wants a JWT from an application private key; the legacy
  // answer_url flow below takes the API key/secret pair the SMS side already
  // uses, which is the whole point of one credential per org.
  const resp = await fetch('https://api.nexmo.com/v1/calls', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`${c.account}:${c.secret}`).toString('base64')}` },
    body: JSON.stringify({
      to: [{ type: 'phone', number: to.replace(/^\+/, '') }],
      from: { type: 'phone', number: c.from.replace(/^\+/, '') },
      answer_url: [answerUrl],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`vonage ${resp.status}: ${String(body.title || body.error_title || '').slice(0, 200)}`);
  return { providerRef: body.uuid || null, costMicros: c.priceVoice };
}

/**
 * The bring-your-own implementation: one POST to a URL the operator owns.
 *
 * This is what makes the loudest channel something the community edition can
 * actually do — a GSM modem, an on-premise SIP gateway, a corporate SMS API.
 * It goes through `safeFetch` because the URL is typed by a user, exactly like
 * an alert-rule webhook.
 */
async function webhookSend(c, kind, to, { text, answerUrl }) {
  if (!c.webhookUrl) throw new Error('no telephony webhook URL configured');
  const resp = await safeFetch(c.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'opscat', kind, to, text, ackUrl: answerUrl || null }),
    timeoutMs: TIMEOUT_MS,
  });
  if (!resp.ok) throw new Error(`telephony webhook ${resp.status}`);
  // safeFetch returns the (capped) body as a STRING on `.text`, not as a
  // method — it drains rather than exposing a Response. Calling `resp.text()`
  // here threw into the catch below and the gateway's reported price was
  // silently replaced by the org's fallback figure, which is a cost report that
  // looks right and is not.
  let body = {};
  try { body = JSON.parse(resp.text || '{}'); } catch { /* a bare 200 is fine */ }
  return {
    providerRef: body.id || null,
    costMicros: priceToMicros(body.price) ?? (kind === 'sms' ? c.priceSms : c.priceVoice),
  };
}

// "0.0075" -> 7500 micros. Providers report prices as decimal strings, sometimes
// negative (Twilio bills as a debit), sometimes absent.
function priceToMicros(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Math.abs(Number(v));
  return Number.isFinite(n) ? Math.round(n * 1e6) : null;
}

// ---- the two verbs ---------------------------------------------------------
async function sendSms(orgId, to, text) {
  const c = configFor(orgId);
  if (!isConfigured(orgId)) throw new Error('no SMS provider configured (Settings → Notifications)');
  if (c.provider === 'twilio') return twilioSms(c, to, text);
  if (c.provider === 'vonage') return vonageSms(c, to, text);
  return webhookSend(c, 'sms', to, { text });
}

/**
 * Place a call that can be ANSWERED.
 *
 * The caller hands over the acknowledgement token, not a URL: which document a
 * provider fetches (TwiML, NCCO) is this file's business, and having the alert
 * chain know that would put provider knowledge back in the caller the adapter
 * exists to keep it out of. A `webhook` gateway gets the plain ack link instead,
 * because it can put that in an SMS or read it out — it has no call flow.
 */
async function placeCall(orgId, to, { token, text }) {
  const c = configFor(orgId);
  if (!isConfigured(orgId)) throw new Error('no voice provider configured (Settings → Notifications)');
  if (c.provider === 'twilio') return twilioCall(c, to, `${config.baseUrl}/v/${token}/twiml`);
  if (c.provider === 'vonage') return vonageCall(c, to, `${config.baseUrl}/v/${token}/ncco`);
  return webhookSend(c, 'voice', to, { text, answerUrl: `${config.baseUrl}/a/${token}` });
}

module.exports = {
  PROVIDERS, KEYS, configFor, statusFor, save, isConfigured, sendSms, placeCall, priceToMicros,
};
