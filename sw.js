/* Service worker: app shell offline + runtime cache for fonts and parser libraries.
   Voice API calls are never cached here — audio is cached in IndexedDB by the app. */

const CACHE = 'razkazvach-v2';
const SHELL = [
    './', './index.html', './css/app.css', './manifest.json',
    './js/main.js', './js/player.js', './js/engines.js', './js/parsers.js', './js/text.js', './js/db.js', './js/usage.js', './js/config.js',
    './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
];
const RUNTIME_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net'];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);

    // Third-party libraries and fonts: cache-first (versioned URLs)
    if (RUNTIME_HOSTS.includes(url.hostname)) {
        event.respondWith(
            caches.match(req).then((hit) => hit || fetch(req).then((res) => {
                if (res.ok || res.type === 'opaque') {
                    const copy = res.clone();
                    caches.open(CACHE).then((c) => c.put(req, copy));
                }
                return res;
            }))
        );
        return;
    }
    if (url.origin !== self.location.origin) return;

    // App shell: network-first so updates arrive, cache when offline
    event.respondWith(
        fetch(req).then((res) => {
            if (res.ok) {
                const copy = res.clone();
                caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
        }).catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
    );
});
