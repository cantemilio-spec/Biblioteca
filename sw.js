// Service worker: apenas o "shell" do app (mesma origem). Livros ficam no IndexedDB, nunca em cache público.
const CACHE = 'bd-shell-v44';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'icon.svg', 'icons/boto.png', 'icons/apple-touch-icon.png',
  'css/theme.css', 'css/app.css', 'css/reader.css',
  'js/main.js', 'js/config.js', 'js/db.js', 'js/settings.js', 'js/ui.js', 'js/books.js',
  'js/zip.js', 'js/epub.js', 'js/annotations.js', 'js/annot-ui.js', 'js/pdf.js', 'js/reader-pdf.js', 'js/metadata.js', 'js/metadata-ui.js', 'js/text.js', 'js/anchors.js', 'js/reader.js', 'js/importer.js', 'js/covers.js', 'js/classics.js', 'js/capas.js', 'js/lib-tabs.js', 'js/library.js', 'js/collections.js', 'js/welcome.js', 'js/painel.js', 'js/settings-view.js', 'js/classics.js', 'js/welcome.js', 'js/painel.js', 'js/lib-tabs.js', 'js/library.js', 'js/settings-view.js', 'icons/icon-192.png', 'icons/icon-512.png', 'js/stats.js', 'js/collections.js', 'js/stats-view.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (new URL(req.url).pathname.includes('/public/books/') && !req.url.endsWith('.json')) return; // EPUBs vão direto à rede (viram IndexedDB; não duplicar em cache)
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match('index.html'))),
  );
});
