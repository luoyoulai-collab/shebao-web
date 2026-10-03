/* 一键社保认证 · Service Worker：预缓存全部资源，装到桌面后可离线使用 */
var VERSION = 'sb-v10';

/* 只用 LSTM_ONLY（createWorker 第二个参数 = 1），worker 只会 importScripts 两个 LSTM 核里的一个。
   原来把 4 个核全预缓存了，首访要多下 9MB —— 审查发现的缺陷。
   没预缓存的核在联网时仍会按需进缓存（见下面的 fetch 分支）。 */
var PRECACHE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'js/app.js',
  'js/ocr.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png',
  'vendor/tesseract/tesseract.min.js',
  'vendor/tesseract/worker.min.js',
  'vendor/tesseract/tesseract-core-lstm.wasm.js',
  'vendor/tesseract/tesseract-core-simd-lstm.wasm.js',
  'vendor/tessdata/chi_sim.traineddata.gz'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION)
      .then(function (cache) { return cache.addAll(PRECACHE); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== VERSION) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      return fetch(e.request).then(function (resp) {
        var copy = resp.clone();
        caches.open(VERSION).then(function (cache) {
          if (resp.ok && new URL(e.request.url).origin === location.origin) {
            cache.put(e.request, copy);
          }
        });
        return resp;
      }).catch(function () {
        // respondWith 解析成 undefined 会被浏览器当成硬错误（白屏），
        // 所以这里必须永远给回一个真正的 Response —— 审查发现的缺陷。
        if (e.request.mode === 'navigate') {
          return caches.match('index.html').then(function (m) {
            return m || new Response(
              '<!DOCTYPE html><meta charset="utf-8"><title>离线</title>' +
              '<p style="font-size:28px;padding:24px;font-family:sans-serif">' +
              '现在是离线状态，缓存也丢了。请联网后重新打开本页一次。</p>',
              { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
            );
          });
        }
        return new Response('', { status: 504, statusText: 'offline' });
      });
    })
  );
});
