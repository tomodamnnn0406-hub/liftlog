// Lift Log — Service Worker v47
// Strategy:
//   liftlog.html  → network-first (always get the latest version)
//   everything else → cache-first (icons, Chart.js — safe to cache long-term)

const CACHE_NAME = 'liftlog-v76';
const STATIC_ASSETS = [
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js'
];

// ── Install: pre-cache static assets only (NOT the HTML) ──────────────────
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Cache each asset independently. addAll() is all-or-nothing: one
    // unreachable file (e.g. the Chart.js CDN while offline or blocked) would
    // reject the whole install, leaving the app with NO service worker — so no
    // offline support and no push notifications.
    await Promise.all(STATIC_ASSETS.map(async url => {
      try { await cache.add(url); } catch (e) { /* fetched on demand later */ }
    }));
  })());
  self.skipWaiting(); // take control immediately
});

// ── Activate: remove ALL old caches ───────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      // 'll-state' holds draft/push flags shared with the page — never evict it.
      Promise.all(keys.filter(k => k !== CACHE_NAME && k !== 'll-state').map(k => caches.delete(k)))
    )
  );
  self.clients.claim(); // take control of open tabs immediately
});

// ── Fetch ──────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = event.request.url;
  const isHTML = event.request.destination === 'document' || url.endsWith('liftlog.html');

  // version.json is the update probe — it must ALWAYS come from the network,
  // otherwise a cached copy would pin the app to whatever version it first saw.
  if (url.includes('version.json')) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }).catch(() => new Response('{}', {
      headers: { 'Content-Type': 'application/json' }
    })));
    return;
  }

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

// ── Push: real background notifications ────────────────────────────────────
// Payload shape: { kind, title, body, view, version }
//   kind 'update'  → a new version was deployed
//   kind 'goal'    → monthly goal reminder
//   kind 'unsaved' → only shown if this device actually has an unsaved workout
// Record what actually reached this device, so "no notification arrived" can be
// diagnosed instead of guessed. The app reads this back in Settings.
async function pushLog(entry) {
  try {
    const c = await caches.open('ll-state');
    let log = [];
    const prev = await c.match('/__ll_push_log');
    if (prev) { try { log = await prev.json(); } catch (e) { log = []; } }
    log.unshift({ at: new Date().toISOString(), ...entry });
    await c.put('/__ll_push_log', new Response(JSON.stringify(log.slice(0, 8)),
      { headers: { 'Content-Type': 'application/json' } }));
  } catch (e) {}
}

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let d = {};
    let decodeError = null;
    try { d = event.data ? event.data.json() : {}; }
    catch (e) { decodeError = String(e && e.message || e); d = { body: event.data ? event.data.text() : '' }; }

    const ja = (d.lang === 'ja');
    let title = d.title || 'Lift Log';
    let body  = d.body  || '';
    let view  = d.view  || 'dashboard';

    if (d.kind === 'unsaved') {
      // The page mirrors draft state into the cache; skip the notification
      // entirely when there's nothing unsaved on THIS device.
      let draft = null;
      try {
        const c   = await caches.open('ll-state');
        const res = await c.match('/__ll_draft');
        if (res) draft = await res.json();
      } catch (e) {}
      if (!draft || !draft.hasDraft) {                 // nothing to nag about
        await pushLog({ kind: 'unsaved', shown: false, suppressed: 'no unsaved workout' });
        return;
      }
      title = ja ? '未保存のワークアウト' : 'Unsaved workout';
      body  = ja ? `${draft.exercises}種目が保存されていません — タップして保存`
                 : `${draft.exercises} exercise(s) not saved yet — tap to finish`;
      view  = 'log';
    }

    // The tag MUST be unique per send. iOS treats a repeated tag as "replace the
    // existing notification", which it does silently — no banner, no sound — so a
    // second update/test notification looked like nothing had arrived at all.
    // `renotify` is supposed to force a re-alert but WebKit doesn't honour it.
    const tag = 'll-' + (d.kind || 'msg') + '-' + (d.ts || Date.now());
    let shown = false, showError = null;
    try {
      await self.registration.showNotification(title, {
        body,
        icon: './icon-192.png',
        badge: './icon-192.png',
        tag,
        renotify: true,
        data: { view, kind: d.kind || '', version: d.version || 0 }
      });
      shown = true;
    } catch (e) {
      showError = String(e && e.message || e);
    }
    await pushLog({ kind: d.kind || '?', title, shown, decodeError, showError, perm: (self.Notification && self.Notification.permission) || '?' });
    // Badge the home-screen icon too (best-effort — not on every platform).
    try { if (self.navigator && self.navigator.setAppBadge) await self.navigator.setAppBadge(1); } catch (e) {}
  })());
});

// iOS/browsers can rotate a subscription; drop our copy so the app re-registers.
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    try {
      const c = await caches.open('ll-state');
      await c.put('/__ll_push_stale', new Response('1'));
    } catch (e) {}
  })());
});

// ── Notification click: focus the app and route to the right view ───────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  try { if (self.navigator && self.navigator.clearAppBadge) self.navigator.clearAppBadge(); } catch (e) {}
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
