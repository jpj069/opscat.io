// Web Push subscription (docs/ONCALL-V1.md §7) — the browser half.
//
// Three things a caller needs to know, and all three are reported rather than
// guessed at, because every one of them produces the same symptom otherwise
// ("I enabled it and nothing arrives"):
//
//  1. **iOS delivers Web Push only from an INSTALLED web app.** Safari refuses
//     the permission prompt entirely until the site has been added to the home
//     screen, so `supported()` says so specifically instead of "unsupported".
//     That constraint has to be in the UI; nobody guesses it from a prompt that
//     never appears.
//  2. **Permission can be denied permanently.** Once it is `denied`, calling
//     `subscribe()` again does nothing forever — the browser will not re-ask.
//     The screen has to say "your browser is blocking notifications" and point
//     at the site settings.
//  3. **The subscription is per BROWSER, not per person.** Somebody on a laptop
//     and a phone has two, and both should ring.
import { api } from './api';

export type PushState =
  | { state: 'ready' }
  | { state: 'denied' }
  | { state: 'needs-install' }   // iOS Safari, not added to the home screen
  | { state: 'unsupported' };

/** Is the standalone/installed display mode active? */
function installed(): boolean {
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return window.matchMedia?.('(display-mode: standalone)').matches === true || nav.standalone === true;
}

const isIos = () => /iP(hone|ad|od)/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function supported(): PushState {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    // On iOS the APIs are genuinely absent until the app is installed, so the
    // honest message is "install it first", not "your browser cannot do this".
    return isIos() && !installed() ? { state: 'needs-install' } : { state: 'unsupported' };
  }
  if (Notification.permission === 'denied') return { state: 'denied' };
  return { state: 'ready' };
}

// The VAPID key travels as base64url and the PushManager wants bytes.
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Register the worker, ask for permission, subscribe, and hand the subscription
 * to the server. Returns the created contact-method id.
 *
 * Throws with a message meant to be shown as-is: every failure here is
 * something the person has to do differently, not an internal error.
 */
export async function subscribe(label?: string): Promise<number> {
  const s = supported();
  if (s.state === 'needs-install') {
    throw new Error('On iPhone and iPad, add OpsCat to the Home Screen first — Safari only delivers push to an installed app.');
  }
  if (s.state === 'unsupported') throw new Error('This browser cannot receive push notifications.');
  if (s.state === 'denied') {
    throw new Error('Notifications are blocked for this site. Allow them in your browser settings, then try again.');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notification permission was not granted.');

  const reg = await navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' });
  await navigator.serviceWorker.ready;

  const { key } = await api.get<{ key: string }>('/api/oncall/me/push-key');
  // An existing subscription is reused: re-subscribing produces a different
  // endpoint in some browsers, and the old one would keep ringing a device the
  // person thinks they replaced.
  const existing = await reg.pushManager.getSubscription();
  const sub = existing ?? await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
  });

  const resp = await api.post<{ id: number }>('/api/oncall/me/push', {
    subscription: sub.toJSON(),
    label: label || browserLabel(),
  });
  return resp.id;
}

/** A name a human recognises in a list of their own devices. */
export function browserLabel(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
      : /Chrome\//.test(ua) ? 'Chrome'
        : /Firefox\//.test(ua) ? 'Firefox'
          : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android'
    : isIos() ? 'iOS'
      : /Mac OS X/.test(ua) ? 'macOS'
        : /Windows/.test(ua) ? 'Windows'
          : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}
