// offline cache. bump V when shipping changes
const V = 'rite-v2';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
  'fonts/redaction50.woff2', 'fonts/spectral.woff2', 'fonts/spectral-600.woff2', 'fonts/plexmono.woff2', 'fonts/plexmono-600.woff2'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('rite-') && k !== V).map(k => caches.delete(k)))));
  self.clients.claim();
});

// own files only, network first so updates land. recipe pics from other sites just go straight through
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin !== location.origin || !u.pathname.includes('/rite')) return;
  e.respondWith(fetch(r).then(res => {
    const cp = res.clone();
    caches.open(V).then(c => c.put(r, cp));
    return res;
  }).catch(() => caches.match(r, { ignoreSearch: true })));
});
