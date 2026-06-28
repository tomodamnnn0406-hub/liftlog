// Lift Log — Service Worker v43
// Strategy:
//   liftlog.html  → network-first (always get the latest version)
//   everything else → cache-first (icons, Chart.js — safe to cache long-term)

const CACHE_NAME = 'liftlog-v51';
const STATIC_ASSETS = [
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js'
];

// ── Install: pre-cache static assets only (NOT the HTML) ──────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting(); // take control immediately
});

// ── Activate: remove ALL old caches ───────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim(); // take control of open tabs immediately
});

// ── Fetch ──────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = event.request.url;
  const isHTML = event.request.destination === 'document' || url.endsWith('liftlog.html');

  if (isHTML) {
    // Network-first for the app shell: always try to fetch the latest,
    // fall back to cache only if offline.
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
  } else {
    // Cache-first for static assets
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.ok && event.request.method === 'GET') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        });
      }).catch(() => {
        if (isHTML) return caches.match('./liftlog.html');
      })
    );
  }
});

// ── Notification click: focus the app and route to the right view ───────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data   = event.notification.data || {};
  const target = data.url || './liftlog.html';
  const view   = data.view || null;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cls => {
      for (const c of cls) {
        if ('focus' in c) {
          if (view) c.postMessage({ type: 'navigate', view });
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
