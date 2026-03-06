// ============================================================
// MIST Portal — Service Worker
// Strategy: Cache-first for assets, network-first for data
// ============================================================

const CACHE_NAME = 'mist-portal-v1';
const STATIC_CACHE = 'mist-static-v1';
const DYNAMIC_CACHE = 'mist-dynamic-v1';

// Files to pre-cache on install (app shell)
const APP_SHELL = [
  '/',
  '/index.html',
  '/mist-portal.jsx',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  // CDN assets — cached on first load
  'https://unpkg.com/react@18/umd/react.production.min.js',
  'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js',
  'https://unpkg.com/@babel/standalone/babel.min.js',
];

// Offline fallback page (shown when network + cache both fail)
const OFFLINE_PAGE = '/offline.html';

// ── Install ──────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  console.log('[SW] Installing MIST Portal Service Worker...');
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => {
        console.log('[SW] Pre-caching app shell');
        // Cache what we can, ignore failures (CDN may block)
        return Promise.allSettled(
          APP_SHELL.map(url => cache.add(url).catch(() => console.warn('[SW] Could not cache:', url)))
        );
      })
      .then(() => self.skipWaiting())
  );
});

// ── Activate ─────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== STATIC_CACHE && key !== DYNAMIC_CACHE)
          .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch Strategy ────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and chrome-extension requests
  if (request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;

  // Firebase / API calls — Network first, no caching
  if (
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('firestore.googleapis.com')
  ) {
    event.respondWith(fetch(request).catch(() => new Response('{}', { headers: { 'Content-Type': 'application/json' } })));
    return;
  }

  // App shell files — Cache first, fallback to network
  if (
    url.pathname === '/' ||
    url.pathname === '/index.html' ||
    url.pathname.endsWith('.jsx') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.json'
  ) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request)
          .then(response => {
            if (!response || response.status !== 200) return response;
            const clone = response.clone();
            caches.open(STATIC_CACHE).then(cache => cache.put(request, clone));
            return response;
          })
          .catch(() => {
            if (url.pathname === '/' || url.pathname === '/index.html') {
              return caches.match('/offline.html');
            }
          });
      })
    );
    return;
  }

  // Images — Cache first, dynamic cache
  if (
    request.destination === 'image' ||
    url.hostname === 'images.unsplash.com'
  ) {
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request)
          .then(response => {
            if (!response || response.status !== 200) return response;
            const clone = response.clone();
            caches.open(DYNAMIC_CACHE).then(cache => {
              cache.put(request, clone);
              // Limit dynamic cache to 60 items
              cache.keys().then(keys => {
                if (keys.length > 60) cache.delete(keys[0]);
              });
            });
            return response;
          })
          .catch(() => new Response('', { status: 404 }));
      })
    );
    return;
  }

  // Everything else — Network first, fallback to cache
  event.respondWith(
    fetch(request)
      .then(response => {
        if (!response || response.status !== 200) return response;
        const clone = response.clone();
        caches.open(DYNAMIC_CACHE).then(cache => cache.put(request, clone));
        return response;
      })
      .catch(() => caches.match(request))
  );
});

// ── Push Notifications (ready for Firebase Cloud Messaging) ──
self.addEventListener('push', (event) => {
  const data = event.data?.json() || {};
  const title = data.title || 'MIST Portal';
  const options = {
    body: data.body || 'You have a new notification',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-72.png',
    tag: data.tag || 'mist-notif',
    data: { url: data.url || '/' },
    actions: [
      { action: 'open', title: 'Open Portal' },
      { action: 'dismiss', title: 'Dismiss' }
    ],
    vibrate: [200, 100, 200],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// ── Notification Click ────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // Focus existing window if open
      for (const client of clientList) {
        if (client.url === url && 'focus' in client) return client.focus();
      }
      // Otherwise open new window
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

// ── Background Sync (for offline form submissions) ──────────
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-inbox') {
    event.waitUntil(syncInbox());
  }
});

async function syncInbox() {
  // When Firebase is added, this will sync pending offline messages
  console.log('[SW] Background sync: inbox');
}
