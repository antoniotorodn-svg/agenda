// Service worker: deja la app instalable y disponible sin conexión.
// Estrategia network-first para index.html (para recibir actualizaciones)
// y cache-first para el resto de recursos estáticos.
const CACHE = 'hostal-jijones-v1';
const ASSETS = ['./', './index.html', './icon.svg', './manifest.json'];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);
    if (e.request.method !== 'GET' || url.origin !== location.origin) return;
    // El proxy iCal nunca se cachea
    if (url.pathname.startsWith('/api/')) return;

    if (url.pathname === '/' || url.pathname.endsWith('/index.html')) {
        e.respondWith(
            fetch(e.request)
                .then(resp => {
                    const copy = resp.clone();
                    caches.open(CACHE).then(c => c.put(e.request, copy));
                    return resp;
                })
                .catch(() => caches.match(e.request))
        );
        return;
    }
    e.respondWith(
        caches.match(e.request).then(hit => hit || fetch(e.request).then(resp => {
            const copy = resp.clone();
            caches.open(CACHE).then(c => c.put(e.request, copy));
            return resp;
        }))
    );
});
