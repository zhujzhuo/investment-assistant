// 财报速览测试：数据完整性 + 单季还原正确性 + 页面渲染
// 用法: node earnings-check.js
const fs = require("fs");
const path = require("path");
const DIR = __dirname;

let pass = 0, fail = 0;
function assert(name, ok, detail) {
  if (ok) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (detail ? " → " + detail : "")); }
}

// ---------- 1. 数据文件 ----------
console.log("== 1. 数据文件 ==");
const ERN_F = path.join(DIR, "data", "earnings.js");
assert("data/earnings.js 存在", fs.existsSync(ERN_F));
const w = { window: {} };
new Function("window", fs.readFileSync(ERN_F, "utf8"))(w.window);
const E = w.window.EARNINGS;
assert("EARNINGS 可解析", !!E);
assert("含 asOf 日期", !!E.asOf && /^\d{4}-\d{2}-\d{2}$/.test(E.asOf));
assert("条目数 = 主池28+观察池5", E.items.length === 33, "实际 " + E.items.length);

// ---------- 2. 单季还原正确性（贵州茅台手算对照） ----------
console.log("== 2. 单季还原（茅台对照） ==");
const mt = E.items.find((x) => x.code === "sh600519");
assert("茅台存在", !!mt && !mt.err);
// 手算：2026H1 累计 445.2 亿 − 2026Q1 累计 272.4 亿 = Q2 单季 172.8 亿
assert("茅台 Q2 单季净利 ≈172.8 亿", mt && mt.npQYi != null && Math.abs(mt.npQYi - 172.8) < 1, mt && mt.npQYi);
// 2025Q2 单季 = 2025H1(454.0) − 2025Q1；脚本内用同法，同比 ≈ -6.9%（数据源 NPParentCompanyYOY_Q 为 -6.9）
assert("茅台 Q2 单季同比 ≈ -6.9%", mt && mt.npYoY != null && Math.abs(mt.npYoY - (-6.9)) < 1.5, mt && mt.npYoY);
assert("茅台报告期 = 2026Q2", mt && mt.q === "2026Q2");

// ---------- 3. 字段口径 ----------
console.log("== 3. 字段口径 ==");
const okItems = E.items.filter((x) => !x.err);
assert("全部 33 只无错误", E.items.filter((x) => x.err).length === 0,
  E.items.filter((x) => x.err).map((x) => x.name + ":" + x.err).join("; "));
assert("每条含 q/revYi/npYi", okItems.every((x) => x.q && x.revYi != null && x.npYi != null));
assert("A股多数含 vs 预期", okItems.filter((x) => x.mkt === "A" && x.vsCons != null).length >= 15,
  "实际 " + okItems.filter((x) => x.mkt === "A" && x.vsCons != null).length);
assert("兆易单季同比为正（存储周期）", (E.items.find((x) => x.code === "sh603986") || {}).npYoY > 100);
assert("腾讯含港股季度预期口径", (E.items.find((x) => x.code === "hk00700") || {}).vsCons != null);
assert("腾讯 vs 预期合理（-12% ± 2）", Math.abs((E.items.find((x) => x.code === "hk00700") || {}).vsCons - (-12)) < 2);
assert("阿里标记口径不可靠", !!(E.items.find((x) => x.code === "hk09988") || {}).qUnreliable);
assert("阿里弃用环比（npQoQ 空）", (E.items.find((x) => x.code === "hk09988") || {}).npQoQ == null);

// ---------- 4. 页面渲染（DOM 桩） ----------
console.log("== 4. 页面渲染 ==");
global.window = {};
const store = {};
global.document = {
  getElementById: function (id) { if (!store[id]) store[id] = { style: {}, innerHTML: "" }; return store[id]; },
  createElement: function () { return {}; }
};
global.navigator = {}; global.location = { protocol: "http:" };
global.fetch = function () { return Promise.resolve({ text: () => Promise.resolve("") }); };
global.setInterval = function () { return 0; }; global.setTimeout = function (f, t) { return 0; };
global.flash = function () { };
const load = (f) => eval(fs.readFileSync(path.join(DIR, f), "utf8"));
["data.js", "data/lt.js", "data/valuation.js", "data/us.js", "data/asset.js", "data/divbt.js", "data/etf.js", "data/reports.js", "data/earnings.js"].forEach(load);
load("app.js");
window.showTab("ah");
const ah = (store["ah-body"] || {}).innerHTML || "";
const eb = (store["earnings-body"] || {}).innerHTML || "";
assert("ah 页含财报速览标题", ah.indexOf("财报速览 · 最新一期") >= 0);
assert("表格 33 行渲染", eb.split("<tr").length >= 34, "实际 " + eb.split("<tr").length);
assert("含怎么读说明", eb.indexOf("三个答案") >= 0);
assert("含超预期/低于预期文案", eb.indexOf("超预期") >= 0 || eb.indexOf("符合预期") >= 0);
assert("判定词（盈利扩张/收缩）", eb.indexOf("盈利扩张") >= 0 || eb.indexOf("盈利收缩") >= 0);
assert("无 undefined/NaN 泄漏", !/undefined|NaN/.test(eb));
// tab 顺序
const idx = fs.readFileSync(path.join(DIR, "index.html"), "utf8");
const order = [...idx.matchAll(/showTab\('([a-z]+)'\)/g)].map((m) => m[1]);
assert("nav 第 2 位 = A股港股(ah)", order[1] === "ah", order.slice(0, 3).join("→"));
assert("section 第 2 位 = tab-ah", /<section id="tab-ah"[^>]*>/.test(idx.split('<section id="tab-plan"')[1].slice(0, 200)));

console.log("\n结果：" + (pass + fail) + " 项 · " + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
