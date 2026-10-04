/* Service Worker: оболонка застосунку офлайн, стратегії кешування. Аудіо та API не кешуються. */

const VERSION = 'v1';
const SHELL_CACHE = `aiwaves-shell-${VERSION}`;
const COVER_CACHE = `aiwaves-covers-${VERSION}`;
const MAX_COVERS = 120;

const SHELL = [
  '/',
  '/css/style.css',
  '/js/app.js',
  '/js/api.js',
  '/js/auth.js',
  '/js/colors.js',
  '/js/comments.js',
  '/js/live.js',
  '/js/modal.js',
  '/js/player.js',
  '/js/socket.js',
  '/js/state.js',
  '/js/ui.js',
  '/js/util.js',
  '/js/visualizer.js',
  '/js/views/home.js',
  '/js/views/me.js',
  '/js/views/room.js',
  '/js/views/rooms.js',
  '/js/views/settings.js',
  '/js/views/track.js',
  '/manifest.json',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('aiwaves-') && k !== SHELL_CACHE && k !== COVER_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res && res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || (await network) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  const p = url.pathname;
  // Потокове аудіо (Range), API, сокети, адмінка — завжди напряму в мережу.
  if (p.startsWith('/stream/') || p.startsWith('/api/') || p.startsWith('/socket.io/') || p.startsWith('/admin') || p === '/healthz') return;
  if (request.headers.has('range')) return;

  // Навігація: мережа → кеш → оболонка "/".
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (p === '/' && res.ok) caches.open(SHELL_CACHE).then((c) => c.put('/', res.clone()));
          return res;
        })
        .catch(async () => (await caches.match(request)) || (await caches.match('/')) || new Response('Офлайн', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }))
    );
    return;
  }

  // Обкладинки: кеш-спочатку (файли незмінні — ім'я є UUID).
  if (p.startsWith('/uploads/covers/')) {
    event.respondWith(
      caches.open(COVER_CACHE).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const res = await fetch(request);
        if (res.ok) {
          cache.put(request, res.clone());
          trimCache(COVER_CACHE, MAX_COVERS);
        }
        return res;
      })
    );
    return;
  }

  // Статика застосунку: stale-while-revalidate.
  if (/\.(?:js|css|json|svg|png|ico|webp)$/.test(p)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
