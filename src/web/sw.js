/* Embernest service worker: caches the app shell only.
   /api/* and /pair are never cached (they are always answered by the network). */

const CACHE = 'embernest-shell';
const VERSION_KEY = '/__embernest_version';
const SHELL = [
  '/',
  '/app.js',
  '/css/tokens.css',
  '/css/base.css',
  '/css/components.css',
  '/css/layout.css',
  '/css/screens.css',
  '/css/chat.css',
  '/css/guide.css',
  '/js/theme.js',
  '/js/explain.js',
  '/js/models-guide.js',
  '/js/chat.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

/** Server version from /api/health, or 'offline' when it cannot be reached. */
async function serverVersion() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    const data = await res.json();
    return String(data.version || 'unknown').replace(/[^\w.-]/g, '');
  } catch (_) {
    return 'offline';
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const version = await serverVersion();
    const cache = await caches.open(CACHE);
    const stored = await cache.match(VERSION_KEY);
    // A new Embernest version: drop the old shell so nothing stale is served offline.
    if (stored && (await stored.text()) !== version) {
      await Promise.all((await cache.keys()).map((req) => cache.delete(req)));
    }
    await cache.addAll(SHELL);
    await cache.put(VERSION_KEY, new Response(version));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop the pre-rename cache (and any other old shell cache).
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE && /-shell$/.test(n)).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

/** Network first (so a new release shows at once), cached copy when offline. */
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/pair') return;
  if (!SHELL.includes(url.pathname)) return;
  event.respondWith(networkFirst(event.request));
});
