/* Tsukiato service worker — AppMint / PWA shell cache + offline list snapshot bridge */
const CACHE = 'tsukiato-shell-v12';
const DATA_CACHE = 'tsukiato-data-v1';
const IMAGE_CACHE = 'tsukiato-img-v1';
const SNAPSHOT_REQ = './__tsukiato_list_snapshot.json';

const PRECACHE = [
  './',
  './index.html',
  './jszip.min.js',
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
      Promise.all(
        keys
          .filter((k) => ![CACHE, DATA_CACHE, IMAGE_CACHE].includes(k))
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Page → SW: persist offline list snapshot into Cache API (survives some WebView
// localStorage quirks; AppMint "cache" layer can keep the SW cache).
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'persist-list-snapshot' && data.payload) {
    event.waitUntil(
      (async () => {
        try {
          const cache = await caches.open(DATA_CACHE);
          const body = typeof data.payload === 'string' ? data.payload : JSON.stringify(data.payload);
          await cache.put(
            new Request(SNAPSHOT_REQ, { method: 'GET' }),
            new Response(body, {
              headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache',
              },
            })
          );
        } catch (e) {}
        if (event.ports && event.ports[0]) {
          try { event.ports[0].postMessage({ ok: true }); } catch (e) {}
        }
      })()
    );
    return;
  }
  if (data.type === 'clear-list-snapshot') {
    event.waitUntil(
      caches.open(DATA_CACHE).then((c) => c.delete(SNAPSHOT_REQ)).catch(() => {})
    );
  }
});

// Shell: cache-first. API: network-only (list offline = localStorage + DATA_CACHE).
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Synthetic snapshot URL — serve from data cache only
  if (url.pathname.endsWith('/__tsukiato_list_snapshot.json') || url.href.includes('__tsukiato_list_snapshot.json')) {
    event.respondWith(
      caches.open(DATA_CACHE).then((c) => c.match(SNAPSHOT_REQ)).then((r) => {
        return r || new Response('null', { status: 404, headers: { 'Content-Type': 'application/json' } });
      })
    );
    return;
  }

  // AniList GraphQL API + MAL API: network-only (auth tokens, mutations, live data).
  // AniList CDN image hosts (s4.anilist.co, img.anilist.co, etc.) are NOT excluded —
  // they go through the Cache API path below so covers survive offline.
  if (
    url.hostname === 'graphql.anilist.co' ||
    url.hostname.includes('myanimelist.net') ||
    url.hostname.includes('api.myanimelist') ||
    url.hostname.includes('workers.dev')
  ) {
    return; // network only
  }

  // AniList CDN cover images — cache-first in tsukiato-img-v1 so they survive offline
  const isAnilistCdn = (
    url.hostname.includes('anilist.co') &&
    url.hostname !== 'graphql.anilist.co'
  );
  if (isAnilistCdn) {
    event.respondWith(
      caches.open(IMAGE_CACHE).then((imgCache) =>
        imgCache.match(req).then((cached) => {
          if (cached) return cached;
          return fetch(req, { mode: 'cors', credentials: 'omit' }).then((res) => {
            if (res && res.ok) {
              imgCache.put(req, res.clone()).catch(() => {});
            }
            return res;
          }).catch(() => cached || new Response('', { status: 503 }));
        })
      )
    );
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            if (res && res.ok) {
              const dest = req.destination;
              if (
                dest === 'document' ||
                dest === 'script' ||
                dest === 'style' ||
                dest === 'image' ||
                dest === 'manifest' ||
                req.url.endsWith('.webmanifest') ||
                req.url.endsWith('.html') ||
                req.url.endsWith('/')
              ) {
                const copy = res.clone();
                caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
              }
            }
            return res;
          })
          .catch(() => cached || caches.match('./index.html') || caches.match('./'));
        // AppMint offline: prefer cache for navigations when offline
        if (req.mode === 'navigate') {
          return network.then((r) => r).catch(() => cached || caches.match('./index.html'));
        }
        return cached || network;
      })
    );
  }
});

self.addEventListener('periodicsync', (event) => {
  if (event.tag !== 'episode-check') return;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      if (list && list.length) {
        list.forEach((c) => {
          try { c.postMessage({ type: 'episode-check' }); } catch (e) {}
        });
        return;
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow('./').catch(() => {});
      }
    })
  );
});

/** Page → SW: show a system notification (works when app is backgrounded). */
self.addEventListener('message', (event) => {
  const data = event && event.data;
  if (!data || data.type !== 'show-notification') return;
  const title = data.title || 'Tsukiato';
  const options = data.options || {};
  event.waitUntil(
    self.registration.showNotification(title, options).catch((err) => {
      console.warn('[sw] showNotification failed', err);
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = (event.notification && event.notification.data) || {};
  const mediaId = data.mediaId || null;
  const targetUrl = data.url || './';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        try {
          c.postMessage({ type: 'notification-open', mediaId: mediaId, episode: data.episode || null });
        } catch (e) {}
        if ('focus' in c) return c.focus();
      }
      if (self.clients.openWindow) {
        const url = mediaId ? (targetUrl + (targetUrl.indexOf('?') >= 0 ? '&' : '?') + 'openMedia=' + encodeURIComponent(mediaId)) : targetUrl;
        return self.clients.openWindow(url).catch(() => {});
      }
    })
  );
});

self.addEventListener('notificationclose', (event) => {
  // no-op — reserved for analytics
});
