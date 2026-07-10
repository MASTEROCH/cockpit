// WANDO service worker — мгновенный запуск + офлайн (stale-while-revalidate)
// Кэшируем только своё (same-origin GET); Supabase/Telegram/CDN идут напрямую.
const CACHE = 'wando-v1';
const CORE = ['./', './index.html', './manifest.webmanifest', './wando-icon-180.png', './wando-icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: u.pathname === '/' }).then(hit => {
    const net = fetch(e.request).then(r => {
      if (r && r.ok) { const cl = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cl)); }
      return r;
    }).catch(() => hit);
    return hit || net;   // кэш мгновенно, сеть обновляет кэш к следующему открытию
  }));
});
