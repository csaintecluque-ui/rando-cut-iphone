// Garde l'appli sur le téléphone pour qu'elle marche sans réseau (en randonnée, en vacances).
// Change VERSION à chaque modification de l'appli : le téléphone prend alors la nouvelle version.
const VERSION = 'randocut-iphone-1';
const FICHIERS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'lib/gopro.js',
  'lib/mesures.js',
  'lib/selection.js',
  'lib/film.js',
  'lib/media.js',
  'vendor/mediabunny.js',
  'icones/favicon.svg',
  'icones/logo.svg',
  'icones/icone-180.png',
  'icones/icone-192.png',
  'icones/icone-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(FICHIERS);
    // l'encodeur AAC de secours (gros) : gardé s'il se télécharge, sinon tant pis
    await cache.add('vendor/aac.js').catch(() => {});
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const nom of await caches.keys()) if (nom !== VERSION) await caches.delete(nom);
    await self.clients.claim();
  })());
});

// d'abord le réseau (pour avoir la dernière version) ; le cache si on est hors ligne
// ou si le réseau met plus de 3 s à répondre (mauvais signal en montagne)
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const enCache = await caches.match(req, { ignoreSearch: true });
    const reseau = fetch(req).then((rep) => {
      if (rep.ok) {
        const copie = rep.clone();
        caches.open(VERSION).then((c) => c.put(req, copie)).catch(() => {});
      }
      return rep;
    });
    if (!enCache) return reseau;
    return Promise.race([
      reseau.catch(() => enCache),
      new Promise((ok) => setTimeout(() => ok(enCache), 3000)),
    ]);
  })());
});
