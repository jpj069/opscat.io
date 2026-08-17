/* OpsCat service worker — Web Push only (docs/ONCALL-V1.md §7).
 *
 * It deliberately caches NOTHING. A NOC tool that serves a stale dashboard from
 * a cache is worse than one that fails to load: the numbers look current and are
 * not, which is the one failure mode this product exists to prevent. The only
 * reason this file exists is that Web Push requires a service worker — the
 * browser wakes IT, not the page, when a push arrives.
 */
self.addEventListener('install', (e) => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_) { /* non-JSON push */ }
  const title = d.title || 'OpsCat alert';
  event.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    tag: d.tag || 'opscat-alert',
    // An alert must not be swept away with the other notifications: it stays on
    // screen until it is acted on, which is the whole difference between a page
    // and a notice.
    requireInteraction: true,
    renotify: true,
    data: { url: d.url || '/app/oncall/alerts' },
    icon: '/app/apple-touch-icon.png',
    badge: '/app/favicon-32.png',
  }));
});

// Tapping the notification focuses an OpsCat tab if one is open rather than
// opening a fifth one — at 03:00 the last thing anyone needs is tab management.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/app/oncall/alerts';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes('/app') && 'focus' in c) { await c.focus(); if (c.navigate) await c.navigate(url); return; }
    }
    if (self.clients.openWindow) await self.clients.openWindow(url);
  })());
});
