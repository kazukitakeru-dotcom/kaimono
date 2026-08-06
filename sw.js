// ファイルを更新したら CACHE_NAME を必ず上げること。
// 上げないと古いキャッシュが配られて、変更が端末に届かない。
// 新しいファイルを足したら ASSETS にも追加する。
const CACHE_NAME = 'kaimono-memo-v6';
const ASSETS = [
  './index.html',
  './styles.css',
  './app.js',
  './sync.js',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // 同期（Supabase）の通信には一切触らない。
  // キャッシュを挟むと古い応答を掴んで、同期が壊れたように見えることがある。
  if (event.request.method !== 'GET') return;
  if (new URL(event.request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request).catch(() => cached);
    })
  );
});
