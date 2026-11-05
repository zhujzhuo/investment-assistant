// 投资助理 Service Worker
// 策略（v44，2026-11-03）：**全部同源资源「网络优先 + 离线回退缓存」**。
// 旧版把「应用外壳（html/css/app.js）」设为缓存优先，导致手机端 PWA / 添加到主屏长期停在
// 旧 index.html + 旧 app.js：新功能（如「📋 操作手册」tab）上线后手机端看不见；更糟的是
// 带 ?t= 时间戳打开能拿到新 HTML，但 app.js 仍命中旧缓存，出现「新导航 + 旧代码」不匹配，
// 点新 tab 直接空白。统一网络优先后，在线时每次打开都取最新，离线时用缓存兜底（PWA 仍可用）。
const CACHE = "ia-cache-v44";
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
// 数据文件仍预缓存一份，仅作离线回退（在线时永远走网络取最新）
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

// 导航请求（含带 ?t= 时间戳的首页 URL）统一把缓存 key 规范化为 ./index.html，避免缓存膨胀
function isNavigation(req) {
  if (req.mode === "navigate" || req.destination === "document") return true;
  try {
    var p = new URL(req.url).pathname;
    return p === "/" || /\.html$/.test(p);
  } catch (e) { return false; }
}

self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  var url = e.request.url;
  // 行情接口（JSONP）与跨域资源不缓存、直连
  if (url.indexOf("gtimg.cn") >= 0 || url.indexOf(self.location.origin) !== 0) return;

  e.respondWith(
    // no-store 同时绕过浏览器 HTTP 缓存与 CDN 旧副本；在线时永远拿服务器当前版本
    fetch(e.request, { cache: "no-store" }).then(function (resp) {
      if (resp && resp.ok) {
        var copy = resp.clone();
        var key = isNavigation(e.request) ? "./index.html" : e.request;
        caches.open(CACHE).then(function (c) { c.put(key, copy); });
      }
      return resp;
    }).catch(function () {
      // 离线：忽略查询串找缓存，再依次回退首页
      return caches.match(e.request, { ignoreSearch: true }).then(function (r) {
        return r || caches.match("./index.html") || caches.match("./");
      });
    })
  );
});
