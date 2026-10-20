//
// Service worker: network first so updates show up at once, cache as the offline fallback
//

const cacheName = 'vigo-v8';
const shell = [
    './',
    'index.html',
    'app.css',
    'app.js',
    'manifest.webmanifest',
    'icons/icon.svg',
    'icons/icon-192.png',
    'icons/icon-512.png',
    'icons/maskable-512.png',
    'icons/favicon-32.png',
    'icons/apple-touch-icon.png',
    'ble/cps.js',
    'ble/cscs.js',
    'ble/device.js',
    'ble/ftms.js',
    'ble/hrs.js',
    'ble/rampa.js',
    'ble/revs.js',
    'ble/uuids.js',
    'record/fit.js',
    'record/recorder.js',
    'store/db.js',
    'store/devices.js',
    'store/library.js',
    'ui/chart.js',
    'ui/sound.js',
    'ui/dom.js',
    'ui/router.js',
    'version.json',
    'workout/builtin.js',
    'workout/cues.js',
    'workout/parse.js',
    'workout/player.js',
    'workout/target.js',
];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll(shell)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== cacheName).map((k) => caches.delete(k))))
            .then(() => self.clients.claim()),
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if(request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

    event.respondWith((async () => {
        const cache = await caches.open(cacheName);
        try {
            const response = await fetch(request);
            if(response.ok) cache.put(request, response.clone());
            return response;
        } catch(error) {
            const cached = await cache.match(request, {ignoreSearch: true});
            if(cached) return cached;
            throw error;
        }
    })());
});
