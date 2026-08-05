const CACHE_VERSION = 'v3.0.0';
const CACHE_NAME = 'supplier-workbench-' + CACHE_VERSION;
const CORE_ASSETS = [
  'index.html',
  'login.html',
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
  'icon-192-maskable.png',
  'icon-512-maskable.png',
  'apple-touch-icon.png'
];

// Install: pre-cache core assets (relative paths resolved against SW location)
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(CORE_ASSETS).catch(() => {});
    })
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      );
    })
  );
  self.clients.claim();
});

// Fetch: network-first for HTML, cache-first for assets
// Uses the request itself as cache key — works under any sub-path (e.g. GitHub Pages /repo/)
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle GET requests
  if (req.method !== 'GET') return;

  // Skip cross-origin requests (CDN scripts, GitHub API, news APIs)
  if (url.origin !== self.location.origin) return;

  // Network-first for HTML documents (so updates are fetched)
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(
      fetch(req).then((resp) => {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then(c => c.put(req, clone)).catch(() => {});
        return resp;
      }).catch(() => {
        return caches.match(req).then(c => c || caches.match('index.html'));
      })
    );
    return;
  }

  // Cache-first for other same-origin assets
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((resp) => {
        if (resp.status === 200) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put(req, clone)).catch(() => {});
        }
        return resp;
      }).catch(() => cached);
    })
  );
});
