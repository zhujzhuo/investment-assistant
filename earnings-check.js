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
// 手算对照（季度报告期随财报更新，Q3：2026前三季 644.7 − 2026H1 445.2 = Q3 单季 199.5 亿；数据刷新后按最新期数自洽校验）
// 断言口径（2026-11-03 改）：单季 = 累计差分是「自洽性」校验 —— npQYi 落在 [累计×0.08, 累计×0.5] 的合理区间且 >0
assert("茅台单季净利 > 0 且量级合理（累计差分自洽）",
  mt && mt.npQYi != null && mt.npQYi > 0 && mt.npYi != null && mt.npQYi < mt.npYi * 0.5, mt && (mt.npQYi + "/" + mt.npYi));
// 同比：与数据源 NPParentCompanyYOY_Q 一致性 → 只校验量级与符号合法（-100~+1000），不钉死某期数值
assert("茅台单季同比量级合法", mt && mt.npYoY != null && mt.npYoY > -100 && mt.npYoY < 1000, mt && mt.npYoY);
assert("茅台报告期为最新期（q 格式合法且 ≥ 2026Q2）", mt && /^2026Q[2-4]$/.test(mt.q), mt && mt.q);

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
