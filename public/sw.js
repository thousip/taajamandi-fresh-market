// TaajaMandi service worker (PWA foundation, overnight build 20 Nov 2026).
// Deliberately minimal: it never caches prices, availability, baskets, orders, Supabase or any API response.
// Only page navigations are handled: network first, and the offline page if the network is unreachable.
const CACHE = 'taajamandi-shell-v1';
const OFFLINE_URL = '/offline.html';
const PRECACHE = [OFFLINE_URL, '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.mode !== 'navigate') return; // everything else goes straight to the network
  event.respondWith(fetch(req).catch(() => caches.match(OFFLINE_URL)));
});
