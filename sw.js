// 投资助理 Service Worker
// 双层策略：
//  · 数据文件（data.js / data/*.js）—— 网络优先 + no-store，每次页面加载都向服务器取最新，
//    无需为数据更新而 bump 版本；只有数据真变了且已部署，刷新页面即可见（离线时回退缓存）。
//  · 应用外壳（html/css/app.js/icons/manifest）—— 缓存优先，保证离线可用；仅在 shell 真正
//    变更时 bump 下方 CACHE 版本号即可生效。
const CACHE = "ia-cache-v43";
const SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/icon.svg"
];
// 数据文件仍预缓存一份，仅作离线回退（在线时 fetch 走 no-store 永远取最新）
const DATA_ASSETS = [
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
  "./data/earnings.js",
  "./data/comps.js",
  "./data/snap-all.js"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    Promise.all([
      caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }),
      caches.open(CACHE).then(function (c) { return c.addAll(DATA_ASSETS); })
    ]).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

function isData(reqUrl) {
  return reqUrl.indexOf("/data/") >= 0 || reqUrl.slice(-8) === "/data.js";
}

self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  var url = e.request.url;
  // 行情接口（JSONP）与跨域资源不缓存、直连
  if (url.indexOf("gtimg.cn") >= 0 || url.indexOf(self.location.origin) !== 0) return;

  if (isData(url)) {
    // 数据文件：no-store 绕过浏览器 HTTP 缓存，永远向网络取最新；成功则更新缓存，失败回退缓存
    e.respondWith(
      fetch(e.request, { cache: "no-store" }).then(function (resp) {
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
  } else {
    // 应用外壳：缓存优先，离线可用；缺失则回源并回退首页
    e.respondWith(
      caches.match(e.request).then(function (r) {
        return r || fetch(e.request).catch(function () { return caches.match("./index.html"); });
      })
    );
  }
});
