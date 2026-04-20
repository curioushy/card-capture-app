const CACHE_NAME = 'card-capture-v12';

const APP_SHELL = [
  '/card-capture-app/',
  '/card-capture-app/index.html',
  '/card-capture-app/manifest.json',
  '/card-capture-app/css/app.css',
  '/card-capture-app/css/capture.css',
  '/card-capture-app/css/components.css',
  '/card-capture-app/js/app.js',
  '/card-capture-app/js/db.js',
  '/card-capture-app/js/ocr.js',
  '/card-capture-app/js/detect.js',
  '/card-capture-app/js/export.js',
  '/card-capture-app/js/import.js',
  '/card-capture-app/js/screens/home.js',
  '/card-capture-app/js/screens/new-session.js',
  '/card-capture-app/js/screens/capture.js',
  '/card-capture-app/js/screens/detection.js',
  '/card-capture-app/js/screens/confirm.js',
  '/card-capture-app/js/screens/contacts.js',
  '/card-capture-app/js/screens/contact-detail.js',
  '/card-capture-app/js/screens/sessions.js',
  '/card-capture-app/js/screens/settings.js',
  '/card-capture-app/assets/icon-192.png',
  '/card-capture-app/assets/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Network-first for CDN assets (OpenCV, Tesseract)
  if (url.hostname !== location.hostname) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for app shell
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      });
    })
  );
});
