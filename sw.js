// WANDO service worker — мгновенный запуск + офлайн (stale-while-revalidate)
// Кэшируем только своё (same-origin GET); Supabase/Telegram/CDN идут напрямую.
const CACHE = 'wando-v2';
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

// ROCH #1391: пуш «от тебя что-то нужно» (срок, упоминание, назначение). Показываем ВСЕГДА —
// тихий пуш без уведомления iOS считает нарушением и отзывает подписку.
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'WANDO', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'WANDO', {
    body: d.body || '', tag: d.tag || undefined, renotify: !!d.tag,
    icon: './wando-icon-180.png', badge: './wando-icon-180.png', data: { url: d.url || './' }
  }));
});
// тап по уведомлению: открытое окно — на передний план и открыть задачу, иначе — новое окно по ссылке
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const w = list.find(c => new URL(c.url).origin === location.origin);
    if (w) { w.postMessage({ type: 'wando-open', url }); return w.focus(); }
    return self.clients.openWindow(url);
  }));
});
