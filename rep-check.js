// 财报披露日历回归测试
// 覆盖：数据层（data/reports.js 覆盖率与格式）/ 辅助函数（repInfo 天数与加急判定）/ 展示层
//       （A股港股页与美股页的财报日历卡、每日推荐 / 好公司清单 / 美股四象限 / 美股池 / 详情页的「财报」标记）
const fs = require("fs");
const path = require("path");
const DIR = __dirname;
const store = {}; let LS = {};
global.localStorage = { getItem: k => LS[k] ?? null, setItem: (k, v) => { LS[k] = String(v); } };
function mkEl(id) { return { id, style: {}, innerHTML: "", textContent: "", className: "", value: "", files: [], appendChild() {}, setAttribute() {}, addEventListener() {}, click() {} }; }
global.document = {
  getElementById(id) { if (!store[id]) store[id] = mkEl(id); return store[id]; },
  querySelectorAll() { return []; },
  getElementsByTagName() { const h = mkEl("head"); h.appendChild = function (el) { setTimeout(() => el.onerror && el.onerror(), 0); }; return [h]; },
  createElement() { return mkEl("x"); }, addEventListener() {}
};
global.window = global; global.window.localStorage = global.localStorage; global.navigator = {};
global.Blob = class {}; const RU = require("url").URL; RU.createObjectURL = () => "blob:"; global.URL = RU;
global.FileReader = class {}; global.location = { protocol: "https:" };
["data.js", "data/lt.js", "data/valuation.js", "data/us.js", "data/asset.js", "data/divbt.js", "data/divbt-sell.js", "data/etf.js", "data/baseline.js", "data/reports.js", "app.js"].forEach(f => eval(fs.readFileSync(path.join(DIR, f), "utf8")));

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ FAIL " + name + (detail != null ? "  [" + detail + "]" : "")); }
}

console.log("=== 1. 数据层（data/reports.js） ===");
const R = window.REPORTS;
assert("REPORTS 已加载", !!R && !!R.dates);
const AHCodes = window.STOCKS.map(s => s.code);
const USCodes = window.US_STOCKS.map(s => s.code);
const all = AHCodes.concat(USCodes);
const have = all.filter(c => R.dates[c]);
assert("披露日覆盖率 ≥ 42/49（A股港股 28 + 美股 21）", have.length >= 42, have.length + "/" + all.length);
assert("披露日格式均为 YYYY-MM-DD", have.every(c => /^\d{4}-\d{2}-\d{2}$/.test(R.dates[c])));
["sh600519", "hk00700", "usAAPL"].forEach(c => assert("关键标的有披露日: " + c, !!R.dates[c], R.dates[c] || "缺失"));

console.log("=== 2. 辅助函数（天数与加急判定） ===");
// 用 REPORTS.asOf 作基准日做自洽校验：days 应等于 date − asOf
const dMoutai = R.dates["sh600519"];
if (dMoutai) {
  const info = window._repInfo("sh600519", R.asOf);
  const expect = Math.round((new Date(dMoutai + "T00:00:00") - new Date(R.asOf + "T00:00:00")) / 86400000);
  assert("repInfo 天数自洽（基准日注入）", info && info.days === expect, info && info.days + " vs " + expect);
}
// 边界：把基准日设为「披露日前 3 天」→ days=3 且加急；设为「披露日后 1 天」→ 已披露
const anyCode = have[0];
if (anyCode) {
  const d0 = R.dates[anyCode];
  const minus3 = new Date(new Date(d0 + "T00:00:00").getTime() - 3 * 86400000);
  const p2 = n => ("0" + n).slice(-2);
  const ref3 = minus3.getFullYear() + "-" + p2(minus3.getMonth() + 1) + "-" + p2(minus3.getDate());
  const lab3 = window._repLabel(anyCode, ref3);
  assert("披露前 3 天 → 标红并提示天数", lab3.indexOf("rep-soon") >= 0 && lab3.indexOf("3天") >= 0, lab3);
  const plus1 = new Date(new Date(d0 + "T00:00:00").getTime() + 86400000);
  const refP = plus1.getFullYear() + "-" + p2(plus1.getMonth() + 1) + "-" + p2(plus1.getDate());
  const labP = window._repLabel(anyCode, refP);
  assert("披露后 1 天 → 显示已披露", labP.indexOf("已披露") >= 0, labP);
  const far = new Date(new Date(d0 + "T00:00:00").getTime() - 30 * 86400000);
  const refF = far.getFullYear() + "-" + p2(far.getMonth() + 1) + "-" + p2(far.getDate());
  const labF = window._repLabel(anyCode, refF);
  assert("披露前 30 天 → 普通样式不标红", labF.indexOf("repchip") >= 0 && labF.indexOf("rep-soon") < 0, labF);
}
assert("未知代码 → —", window._repLabel("sh999999") === '<span class="muted">—</span>' || window._repLabel("sh999999").indexOf("—") >= 0);

console.log("=== 3. A股港股页（财报日历 + 各板块标记） ===");
window.showTab("ah");
const ahHtml = store["ah-body"].innerHTML;
assert("页顶含「财报日历」卡", ahHtml.indexOf("财报日历") >= 0 && ahHtml.indexOf("A股 + 港股标的池") >= 0);
assert("日历卡列出披露安排（repitem）", ahHtml.indexOf("repitem") >= 0 && ahHtml.indexOf("天后") >= 0);
const pickHtml = store["pick-body"].innerHTML;
assert("每日推荐表新增「财报」列", pickHtml.indexOf("<th>财报</th>") >= 0);
assert("每日推荐行含披露日标记（repchip）", pickHtml.indexOf("repchip") >= 0);
const screenHtml = store["screen-body"].innerHTML;
assert("好公司清单表新增「财报」列", screenHtml.indexOf("<th>财报</th>") >= 0);
// 好公司清单 28 行 / reports.js 覆盖度随 refresh 与**财报季节**变化：
//   Q3 集中披露刚结束时绝大多数标的是「已披露」（days<0 显示已披露、不带 repchip），
//   财报季前则大量带 repchip —— 写死下限会季节性翻红。
//   → 改为动态自洽：页面 repchip 数 = 主池+观察池中「披露日在今天及以后」的标的数（与 repLabel 口径一致）
const screenRows = (screenHtml.match(/<tr/g) || []).length - 1;
const screenChips = (screenHtml.match(/repchip/g) || []).length;
{
  const today = new Date();
  const todayStr = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");
  const dates = (window.REPORTS || {}).dates || {};
  const pool = (window.STOCKS || []).concat(window.WATCH || []);
  const expectChips = pool.filter(s => dates[s.code] && dates[s.code] >= todayStr).length;
  assert("好公司清单 repchip 数 = 披露日在未来的标的数（自洽）", screenChips === expectChips,
    "页面 " + screenChips + "/" + screenRows + " 行 vs 数据 " + expectChips + " 只（财报季空窗属正常）");
  assert("披露日字段已接入（数据侧至少 1 只未来披露或已全覆盖）", expectChips > 0 || Object.keys(dates).length >= 28,
    "dates 覆盖 " + Object.keys(dates).length + " 键");
}

console.log("=== 4. 美股页（财报日历 + 四象限 / 标的池标记） ===");
window.showTab("us");
const usHtml = store["us-body"].innerHTML;
assert("美股页含「财报日历」卡", usHtml.indexOf("财报日历") >= 0 && usHtml.indexOf("美股标的池") >= 0);
assert("美股四象限表新增「财报」列", usHtml.indexOf("<th>财报</th>") >= 0);
const usTableHtml = store["us-table"].innerHTML;
assert("美股标的池全表新增「财报」列", usTableHtml.indexOf("repchip") >= 0);
// 下季尚未预约披露的标的（数据源返回已过期的上季日期）应显示「已披露」而不是日期 chip
const usRep = (usTableHtml.match(/repchip/g) || []).length;
const usPast = (usTableHtml.match(/已披露/g) || []).length;
assert("美股池每行都有财报标记（未预约 → 已披露）", usRep + usPast >= 20, "chip " + usRep + " + 已披露 " + usPast);

console.log("=== 5. 标的详情页（下次财报） ===");
window.showTab("detail");
window.renderDetail();
const detailHtml = store["detail-body"].innerHTML;
assert("详情页含「下次财报」行", detailHtml.indexOf("下次财报") >= 0);
assert("详情页披露日含天数提示", detailHtml.indexOf("天后") >= 0 || detailHtml.indexOf("已披露") >= 0 || detailHtml.indexOf("今天") >= 0);

console.log("\nrep-check: " + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
