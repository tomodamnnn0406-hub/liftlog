// Lift Log — Service Worker
// Cache-first strategy so the app works fully offline.

const CACHE_NAME = 'liftlog-v1';
const ASSETS = [
  './liftlog.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js'
];

// ── Install: pre-cache all assets ──────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// ── Activate: remove old caches ────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch: serve from cache, fall back to network ──────────────────────────
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cache successful GET responses from our own origin
        if (
          response.ok &&
          event.request.method === 'GET' &&
          (event.request.url.startsWith(self.location.origin) ||
           event.request.url.includes('cdnjs.cloudflare.com'))
        ) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    }).catch(() => {
      // If both cache and network fail, return the app shell
      if (event.request.destination === 'document') {
        return caches.match('./liftlog.html');
      }
    })
  );
});
