const V='jarvis-v4';
const A=['./', './index.html','./style.css','./app.js','./manifest.json','./icons/icon-192.png','./icons/icon-512.png'];
self.addEventListener('install',e=>e.waitUntil(caches.open(V).then(c=>c.addAll(A))));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==V).map(k=>caches.delete(k))))));
self.addEventListener('fetch',e=>{
  if(/anthropic|huggingface|jsdelivr|esm\.sh|duckduckgo/.test(e.request.url)){e.respondWith(fetch(e.request));return;}
  e.respondWith(caches.match(e.request).then(c=>c||fetch(e.request)));
});
