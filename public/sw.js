const CACHE_NAME = 'nordicwings-v31';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/blog/',
  '/blog/index.html',
  '/blog/cheapest-flights-helsinki-bangkok.html',
  '/blog/cheapest-time-fly-helsinki-manila.html',
  '/blog/cheapest-european-cities-from-helsinki.html',
  '/blog/trending-flights-from-helsinki-summer-2026.html',
  '/blog/cheapest-flights-helsinki-singapore.html',
  '/blog/cheapest-flights-helsinki-tokyo.html',
  '/blog/cheapest-flights-helsinki-dubai.html',
  '/blog/cheapest-flights-helsinki-philippines-winter.html',
  '/blog/cheapest-flights-helsinki-new-york.html',
  '/blog/cheapest-flights-helsinki-rome.html',
  '/blog/cheapest-flights-helsinki-tenerife.html',
  '/blog/cheapest-flights-helsinki-bali.html',
  '/blog/cheapest-flights-helsinki-london.html',
  '/blog/cheapest-flights-helsinki-cancun.html',
  '/blog/cheapest-flights-helsinki-lisbon.html'
];

// Install: cache static assets
self.addEventListener('install', event => {
  self.skipWaiting(); // activate new SW immediately without waiting for tabs to close
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network-first for HTML, cache-first for assets
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  // Skip external requests
  if (url.origin !== location.origin) return;

  const isHTML = event.request.headers.get('accept')?.includes('text/html');
  // Also use network-first for JS and CSS so updates deploy immediately
  const isScript = url.pathname.endsWith('.js') || url.pathname.endsWith('.css');

  if (isHTML || isScript) {
    // Network first — always get fresh code
    event.respondWith(
      fetch(event.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
  } else {
    // Cache first for images and other static assets
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request))
    );
  }
});
