// 「名单变动提示」回归测试
// 覆盖：基线文件解析 / 变动卡渲染（首次归档、无变动、有移入移出）/ 四个页面挂载 / gen-baseline 可重跑
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
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
["data.js", "data/lt.js", "data/valuation.js", "data/us.js", "data/asset.js", "data/divbt.js", "data/divbt-sell.js", "data/etf.js", "data/baseline.js", "app.js"].forEach(f => eval(fs.readFileSync(path.join(DIR, f), "utf8")));

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ FAIL " + name + (detail != null ? "  [" + detail + "]" : "")); }
}

console.log("=== 1. 基线文件 ===");
const B = window.IA_BASELINE;
assert("data/baseline.js 存在且可解析", !!B);
assert("含 asOf / prevAsOf / lists / changes 四要素", B && !!B.asOf && "prevAsOf" in B && !!B.lists && !!B.changes);
assert("四套名单齐全（picks/formal/usPicks/pool）", B && ["picks", "formal", "usPicks", "pool"].every(k => B.lists[k]));
assert("picks 四象限非空", B && ["steady", "growth", "rotate", "tenx"].every(k => B.lists.picks[k] && B.lists.picks[k].length >= 1));
assert("正式名单非空且带距离", B && B.lists.formal.picks.length >= 1 && typeof B.lists.formal.picks[0].dist === "number");
assert("美股名单四象限非空", B && ["steady", "growth", "rotate", "tenx"].every(k => B.lists.usPicks[k] && B.lists.usPicks[k].length >= 1));
assert("changes 四类为数组", B && ["picks", "formal", "us", "pool"].every(k => Array.isArray(B.changes[k])));

console.log("=== 2. 首次归档态渲染（注入 prevAsOf = null 的模拟基线，避免依赖真实文件的归档进度） ===");
window.IA_BASELINE = { version: 1, asOf: B.asOf, prevAsOf: null, lists: B.lists, changes: { picks: [], formal: [], us: [], pool: [] } };
window.showTab("pick");
let pickHtml = store["pick-body"].innerHTML;
assert("每日推荐页含「名单变动」卡", pickHtml.indexOf("名单变动") >= 0);
assert("首次归档提示文案", pickHtml.indexOf("首次归档基线") >= 0);
assert("头部说明改为「重算 + 归档」口径", pickHtml.indexOf("行情重算") >= 0 && pickHtml.indexOf("归档") >= 0);
assert("旧文案「每日 18:00 自动更新并归档飞书」已移除", pickHtml.indexOf("归档飞书") < 0);
assert("无 undefined/NaN 泄漏", pickHtml.indexOf("undefined") < 0 && pickHtml.indexOf("NaN") < 0);

console.log("=== 3. 有变动时的渲染（注入模拟基线） ===");
window.IA_BASELINE = {
  version: 1, asOf: "2026-10-10", prevAsOf: "2026-10-09",
  lists: B.lists, changes: {
    picks: [
      { dir: "in", scope: "picks", cat: "growth", tag: "高增长", name: "测试甲", reason: "2026H1 净利 +29.4% · ROE 26.0%" },
      { dir: "out", scope: "picks", cat: "steady", tag: "稳增长", name: "测试乙", reason: "象限内排序跌出前 3 名（本期末位：某股）" }
    ],
    formal: [{ dir: "in", scope: "formal", tag: "已达买点", name: "测试丙", reason: "距老唐买点 已跌进（-2.2%），综合分 6.1" }],
    us: [{ dir: "out", scope: "us", tag: "热点轮动", name: "测试丁", reason: "象限内排序跌出前 2 名" }],
    pool: [{ dir: "in", scope: "pool", mkt: "AH", name: "测试戊", reason: "月度复核新入池（白酒），详见当日日报" }]
  }
};
window.showTab("pick");
pickHtml = store["pick-body"].innerHTML;
assert("移入行：▲ 移入 + 标的 + 原因", pickHtml.indexOf("▲ 移入") >= 0 && pickHtml.indexOf("测试甲") >= 0 && pickHtml.indexOf("净利 +29.4%") >= 0);
assert("移出行：▽ 移出 + 标的 + 原因", pickHtml.indexOf("▽ 移出") >= 0 && pickHtml.indexOf("排序跌出前 3 名") >= 0);
assert("对比区间标注（上期 → 本期）", pickHtml.indexOf("2026-10-09") >= 0 && pickHtml.indexOf("2026-10-10") >= 0);
window.showTab("fund");
const fundHtml = store["fund-body"].innerHTML;
assert("建仓节奏页显示正式名单变动", fundHtml.indexOf("名单变动") >= 0 && fundHtml.indexOf("测试丙") >= 0 && fundHtml.indexOf("已达买点") >= 0);
window.showTab("screen");
const screenHtml = store["screen-body"].innerHTML;
assert("好公司筛选页显示筛选池变动", screenHtml.indexOf("名单变动") >= 0 && screenHtml.indexOf("测试戊") >= 0 && screenHtml.indexOf("月度复核") >= 0);
assert("筛选页含更新频率说明（每交易日 / 每月 1 日）", screenHtml.indexOf("每个交易日") >= 0 && screenHtml.indexOf("每月 1 日") >= 0);
window.showTab("us");
const usHtml = store["us-body"].innerHTML;
assert("美股页显示美股名单变动", usHtml.indexOf("名单变动") >= 0 && usHtml.indexOf("测试丁") >= 0);
assert("美股页含名单更新口径说明", usHtml.indexOf("每个交易日随行情重算") >= 0 || usHtml.indexOf("每个交易日") >= 0);

console.log("=== 4. 无变动态渲染 ===");
window.IA_BASELINE = { version: 1, asOf: "2026-10-10", prevAsOf: "2026-10-09", lists: B.lists, changes: { picks: [], formal: [], us: [], pool: [] } };
window.showTab("pick");
pickHtml = store["pick-body"].innerHTML;
assert("无变动时显示「名单无变动」", pickHtml.indexOf("名单无变动") >= 0);
assert("不出现 ▲/▽ 标记", pickHtml.indexOf("▲ 移入") < 0 && pickHtml.indexOf("▽ 移出") < 0);

console.log("=== 5. 基线缺失时不渲染 ===");
window.IA_BASELINE = undefined;
window.showTab("pick");
pickHtml = store["pick-body"].innerHTML;
assert("无基线时不渲染变动卡（页面不报错）", pickHtml.indexOf("⚑") < 0 && pickHtml.indexOf("undefined") < 0);

console.log("=== 6. gen-baseline.js 可重跑（同日重跑保留当日 changes） ===");
const nodeBin = process.argv[0];
const out1 = execFileSync(nodeBin, [path.join(DIR, "gen-baseline.js")], { encoding: "utf8" });
assert("脚本退出成功且有归档输出", out1.indexOf("基线归档") >= 0, out1.slice(0, 80));
const fresh = fs.readFileSync(path.join(DIR, "data/baseline.js"), "utf8");
const holder = {};
new Function("window", fresh)(holder);
const NB = holder.IA_BASELINE;
assert("重跑后基线仍可解析", !!NB);
assert("同日重跑不伪造 prevAsOf（保持原值）", NB.prevAsOf === B.prevAsOf, NB.prevAsOf + " vs " + B.prevAsOf);
assert("名单四要素完整", NB.lists && NB.changes && NB.lists.picks && NB.changes.picks);

console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
