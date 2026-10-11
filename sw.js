// 投资助理 Service Worker：network-first（在线必拿最新，离线回退缓存）
const CACHE = "ia-cache-v28";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./data.js",
  "./data/lt.js",
  "./data/valuation.js",
  "./data/us.js",
  "./data/asset.js",
  "./data/divbt.js",
  "./data/divbt-sell.js",
  "./data/etf.js",
  "./data/baseline.js",
  "./data/reports.js",
  "./data/snap-all.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/icon.svg"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  var url = e.request.url;
  // 行情接口（JSONP）与跨域资源不缓存
  if (url.indexOf("gtimg.cn") >= 0 || url.indexOf(self.location.origin) !== 0) return;
  e.respondWith(
    fetch(e.request).then(function (resp) {
      if (resp && resp.ok) {
        var copy = resp.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      }
      return resp;
    }).catch(function () {
      return caches.match(e.request, { ignoreSearch: true }).then(function (r) {
        return r || caches.match("./index.html");
      });
    })
  );
});
