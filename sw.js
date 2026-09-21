// Service worker RemsoMuscu. Bumper CACHE à chaque déploiement pour forcer la
// mise à jour sur iPhone (même logique que l'app Sport).
const CACHE = 'remsomuscu-v2';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './data/programme.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS.map(a => new Request(a, { cache: 'reload' })))).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Les démos d'exercices viennent de GitHub : réseau seul, jamais mises en cache.
  if (url.origin !== self.location.origin) return;

  // Navigations (HTML) : réseau d'abord pour que l'app soit toujours fraîche
  // en ligne, cache en secours pour le mode hors-ligne.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const copy = res.clone();
          e.waitUntil(caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {}));
          return res;
        })
        .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
    );
    return;
  }

  // Assets : cache d'abord, revalidation en arrière-plan (waitUntil obligatoire
  // sinon iOS tue le SW avant la fin de la mise à jour du cache).
  e.respondWith(
    caches.match(e.request).then(cached => {
      const revalidate = fetch(e.request)
        .then(res => caches.open(CACHE).then(c => c.put(e.request, res.clone())).then(() => res))
        .catch(() => cached);
      if (cached) {
        e.waitUntil(revalidate.catch(() => {}));
        return cached;
      }
      return revalidate;
    })
  );
});
