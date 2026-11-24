// Makes the app open with no signal. Each published version is downloaded whole into its own
// cache and served from there, so a phone never runs a mix of old and new files.
// VERSION is written by tools/stamp.mjs (npm test fails if it is out of date).
const VERSION = 'b1cb0715cf';
const CACHE = 'split-' + VERSION;
const SHELL = ['./', 'index.html', 'app.js', 'money.js', 'clean.js', 'store.js', 'firebase-config.js',
  'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];
const LIBS = ['https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js'];
const DEV = self.location.hostname === 'localhost';

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })));
    // The database library: wanted for offline use, but its absence must not block install.
    await Promise.all(LIBS.map(async (u) => {
      try { const r = await fetch(u); if (r.ok) await c.put(u, r); } catch { /* fetched on demand later */ }
    }));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('split-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const lib = LIBS.includes(url.href);
  if (!lib && url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    if (DEV && !lib) { try { return await fetch(e.request); } catch { /* fall through to the cache */ } }
    const hit = await c.match(e.request, { ignoreSearch: !lib });
    if (hit) return hit;
    try {
      const r = await fetch(e.request);
      if (lib && r.ok) c.put(e.request, r.clone());
      return r;
    } catch (err) {
      if (e.request.mode === 'navigate') { const page = await c.match('index.html'); if (page) return page; }
      throw err;
    }
  })());
});
