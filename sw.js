/* Tsukiato service worker — cache app shell for offline open */
const CACHE = 'tsukiato-shell-v9';
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './apple-touch-icon.png',
  './favicon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Shell: cache-first. API (anilist/mal): network-only (app uses localStorage offline data).
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never cache GraphQL / token APIs — list offline is localStorage
  if (
    url.hostname.includes('anilist.co') ||
    url.hostname.includes('myanimelist.net') ||
    url.hostname.includes('api.myanimelist') ||
    url.pathname.includes('/api/')
  ) {
    return;
  }

  // Same-origin navigation / assets
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            if (res && res.ok && (req.destination === 'document' || req.destination === 'script' || req.destination === 'style' || req.destination === 'image' || req.url.endsWith('.webmanifest'))) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
            }
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
  }
});


/* Wake clients on a ~6h cadence when the browser grants periodicSync */
self.addEventListener('periodicsync', (event) => {
  if (event.tag !== 'episode-check') return;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      list.forEach((c) => {
        try { c.postMessage({ type: 'episode-check' }); } catch (e) {}
      });
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});
