const CACHE = 'jarvis-v2';
const ASSETS = ['./', './index.html', './style.css', './app.js',
  './manifest.json', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install',  e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
));
self.addEventListener('fetch', e => {
  // API запросы — только в сеть
  if (e.request.url.includes('anthropic.com') || e.request.url.includes('huggingface.co') || e.request.url.includes('jsdelivr.net')) {
    e.respondWith(fetch(e.request));
    return;
  }
  e.respondWith(caches.match(e.request).then(c => c || fetch(e.request)));
});
