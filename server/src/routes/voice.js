'use strict';
/**
 * The voice acknowledgement round trip (docs/ONCALL-V1.md §7, §13.2).
 *
 * A call that only speaks is a robocall: the person is awake, knows something
 * broke, and still has to find a laptop to stop the escalation. So the call flow
 * is **speak, then wait for a keypress**, and the keypress acknowledges.
 *
 * The provider drives it. When the call connects, the provider fetches a
 * call-flow document from us — TwiML for Twilio, NCCO for Vonage — and posts the
 * digit back. Both documents are generated here from the SAME alert the SMS and
 * the mail describe, so the three cannot drift.
 *
 * Public and session-free, exactly like `/a/:token`, and for the same reason:
 * the token IS the credential (32 random bytes, SHA-256 at rest, single use,
 * expiring). Two differences from the mail link, both deliberate:
 *
 *  - **Fetching the flow document must not acknowledge.** It is the exact
 *    equivalent of a mail scanner following a link: the provider fetches the URL
 *    to find out what to say, before anybody has heard anything. Only the digit
 *    callback acknowledges.
 *  - **Only the digit `1` acknowledges.** A call that is answered by voicemail
 *    produces no digits at all, and a mis-key must not silence an escalation.
 */
const express = require('express');
const crypto = require('crypto');
const { escapeHtml: esc, RateLimiter } = require('../util');
const config = require('../config');
const chain = require('../engine/alert-chain');
const telephony = require('../lib/telephony');

const router = express.Router();
const limiter = new RateLimiter({ perMinute: 120, burst: 40 });

/** What the call says. Kept short: this is being read aloud to someone asleep. */
function speech(info) {
  const s = info.subject;
  if (!s) return 'An OpsCat alert is waiting for you.';
  return `OpsCat alert. ${s.label.replace(/-/g, ' ')}. ${s.title}. Severity ${s.severity}.`;
}

// Twilio signs every request it makes to us with the account auth token. We hold
// that token (bring-your-own credentials), so the signature is checkable — and a
// check we can perform is a check we perform. It is defence in depth over the
// token in the URL, not a replacement for it.
function twilioSignatureOk(req, orgId) {
  const c = telephony.configFor(orgId);
  if (c.provider !== 'twilio' || !c.secret) return true;   // not Twilio: nothing to verify
  const sig = req.get('X-Twilio-Signature');
  if (!sig) return false;
  const url = `${config.baseUrl}${req.originalUrl}`;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const data = url + Object.keys(body).sort().map((k) => k + body[k]).join('');
  const expect = crypto.createHmac('sha1', c.secret).update(Buffer.from(data, 'utf8')).digest('base64');
  const a = Buffer.from(sig); const b = Buffer.from(expect);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const twiml = (inner) => `<?xml version="1.0" encoding="UTF-8"?>\n<Response>${inner}</Response>`;
const say = (t) => `<Say voice="alice">${esc(t)}</Say>`;

// ---- Twilio: the call flow -------------------------------------------------
router.get('/v/:token/twiml', async (req, res) => {
  if (!limiter.allow(req.ip || 'anon')) return res.status(429).end();
  const info = await chain.tokenInfo(req.params.token);
  res.type('text/xml');
  if (!info || info.expired || info.used || info.alert.status !== 'active') {
    return res.send(twiml(say('This OpsCat alert has already been handled. Goodbye.')));
  }
  res.send(twiml(
    `<Gather numDigits="1" timeout="12" method="POST" `
    + `action="${esc(`${config.baseUrl}/v/${req.params.token}/digits`)}">`
    + say(speech(info)) + say('Press 1 to acknowledge and stop the escalation.')
    + say('Press 1 to acknowledge.')
    + '</Gather>'
    + say('No key was pressed. The escalation continues. Goodbye.'),
  ));
});

router.post('/v/:token/digits', async (req, res) => {
  if (!limiter.allow(req.ip || 'anon')) return res.status(429).end();
  res.type('text/xml');
  const info = await chain.tokenInfo(req.params.token);
  if (!info || !twilioSignatureOk(req, info.alert.org_id)) {
    return res.send(twiml(say('This call could not be verified. Goodbye.')));
  }
  const digits = String((req.body && req.body.Digits) || '');
  if (digits !== '1') return res.send(twiml(say('Nothing was acknowledged. Goodbye.')));
  const r = await chain.ackByToken(req.params.token);
  res.send(twiml(say(r
    ? 'Acknowledged. The escalation has stopped. Goodbye.'
    : 'This alert has already been handled. Goodbye.')));
});

// ---- Vonage: the same flow, in that provider's document --------------------
router.get('/v/:token/ncco', async (req, res) => {
  if (!limiter.allow(req.ip || 'anon')) return res.status(429).end();
  const info = await chain.tokenInfo(req.params.token);
  if (!info || info.expired || info.used || info.alert.status !== 'active') {
    return res.json([{ action: 'talk', text: 'This OpsCat alert has already been handled. Goodbye.' }]);
  }
  res.json([
    { action: 'talk', text: `${speech(info)} Press 1 to acknowledge and stop the escalation.` },
    { action: 'input', type: ['dtmf'], dtmf: { maxDigits: 1, timeOut: 12 },
      eventUrl: [`${config.baseUrl}/v/${req.params.token}/digits-json`], eventMethod: 'POST' },
  ]);
});

router.post('/v/:token/digits-json', async (req, res) => {
  if (!limiter.allow(req.ip || 'anon')) return res.status(429).end();
  const dtmf = (req.body && req.body.dtmf) || {};
  if (String(dtmf.digits || '') !== '1') {
    return res.json([{ action: 'talk', text: 'Nothing was acknowledged. Goodbye.' }]);
  }
  const r = await chain.ackByToken(req.params.token);
  res.json([{ action: 'talk', text: r
    ? 'Acknowledged. The escalation has stopped. Goodbye.'
    : 'This alert has already been handled. Goodbye.' }]);
});

module.exports = router;
