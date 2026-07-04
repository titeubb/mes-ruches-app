const CACHE = 'mes-ruches-v1';
const ASSETS = ['/', '/index.html', '/manifest.json'];

// Installation : mise en cache des fichiers principaux
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Réseau en priorité, cache en fallback
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then(r => {
        const clone = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return r;
      })
      .catch(() => caches.match(e.request))
  );
});

// ── Réception d'une notification push ────────────────────────────────────────
self.addEventListener('push', e => {
  let data = { title: '🐝 Mes Ruches', body: 'Variation de poids détectée' };
  try { data = e.data.json(); } catch {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      vibrate: [200, 100, 200],
      tag: 'ruche-alerte',
      renotify: true,
      data: { url: '/' }
    })
  );
});

// Clic sur la notification → ouvre l'app
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window' }).then(wins => {
      const w = wins.find(w => w.url.includes(self.location.origin));
      if (w) return w.focus();
      return clients.openWindow('/');
    })
  );
});
