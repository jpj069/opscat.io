'use strict';
/**
 * Web Push (docs/ONCALL-V1.md §7) — an acknowledgeable alert on a phone with no
 * app store and no per-message cost.
 *
 * The `web-push` dependency is deliberate. RFC 8291 payload encryption is
 * ECDH-ES over P-256 into HKDF into AES-128-GCM, plus VAPID JWTs per endpoint —
 * roughly two hundred lines of cryptography whose failure mode is "the browser
 * silently drops the message". That is the wrong thing to hand-roll, and the
 * library is the one every implementation uses.
 *
 * **VAPID keys are generated once and stored**, in `settings` alongside
 * `app_secret`. They are the identity of this OpsCat installation to the push
 * services; regenerating them silently invalidates every existing subscription
 * in every browser, so they are minted on first use and then left alone.
 *
 * The iOS constraint is real and is stated in the UI rather than discovered:
 * Safari delivers Web Push **only when the site has been installed to the home
 * screen**. A subscription cannot even be created otherwise, so the browser
 * reports the failure — but "Add to Home Screen first" is not a thing anyone
 * guesses from a permission prompt that never appears.
 */
const webpush = require('web-push');
const { getSetting, setSetting } = require('../db');
const q = require('../db/shim');
const config = require('../config');
const { now } = require('../util');

let keys = null;

/* Async because the FIRST call may have to store a freshly generated pair, and
 * that store must land before anyone is told the public key. A fire-and-forget
 * write here would be the worst kind of cheap: the browser subscribes against a
 * key the next restart has forgotten, and every push to that device fails with
 * a signature error nobody connects to a boot two weeks earlier. Every call
 * after the first answers from `keys` without touching the database. */
async function vapid() {
  if (keys) return keys;
  let pub = getSetting('vapid_public');
  let priv = getSetting('vapid_private');
  if (!pub || !priv) {
    const gen = webpush.generateVAPIDKeys();
    pub = gen.publicKey; priv = gen.privateKey;
    await setSetting('vapid_public', pub);
    await setSetting('vapid_private', priv);
  }
  keys = { publicKey: pub, privateKey: priv };
  return keys;
}

/** The public key the browser needs to subscribe. Safe to hand out. */
async function publicKey() { return (await vapid()).publicKey; }

/**
 * A push subscription is what the browser hands us: an endpoint URL plus two
 * keys. Validated here rather than at the route, because "looks like a
 * subscription" is the same question wherever it is asked.
 */
function isSubscription(v) {
  return !!v && typeof v === 'object'
    && typeof v.endpoint === 'string' && /^https:\/\/[^\s]{10,500}$/.test(v.endpoint)
    && !!v.keys && typeof v.keys.p256dh === 'string' && typeof v.keys.auth === 'string';
}

const dropMethod = q.prepare('DELETE FROM contact_methods WHERE id = ?');

/**
 * Deliver one push. `methodId` lets a subscription the push service has
 * RETIRED delete itself: a 404 or 410 is the service saying "this browser is
 * gone for good", and keeping the row would mean every future escalation spends
 * a rung on a device that no longer exists.
 */
async function send(subscription, { title, body, url }, methodId = null) {
  const k = await vapid();
  webpush.setVapidDetails(
    // The `mailto:` subject is the contact the push service uses if our sends
    // start misbehaving. It has to be a real address, and the deployment's own
    // base URL is the honest default when nobody configured one.
    `mailto:${config.pushContact || 'ops@' + new URL(config.baseUrl).hostname}`,
    k.publicKey, k.privateKey,
  );
  try {
    await webpush.sendNotification(subscription, JSON.stringify({ title, body, url, ts: now() }), {
      TTL: 3600,
      urgency: 'high',
    });
  } catch (err) {
    const status = err && err.statusCode;
    if (methodId && (status === 404 || status === 410)) {
      await dropMethod.run(methodId);
      throw new Error('push subscription expired — the browser has been removed');
    }
    throw new Error(`push ${status || ''}: ${String(err && err.body ? err.body : err.message).slice(0, 200)}`);
  }
}

module.exports = { publicKey, isSubscription, send };
