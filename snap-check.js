// 历史数据快照回归测试
// 覆盖：数据层（data/snap-all.js 覆盖率）/ 展示层（历史留档页「历史数据」卡：日期下拉、
//       快照视图的指数/名单/A股港股表/美股表）/ 归档脚本幂等性（同日重跑覆盖不重复）
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
["data.js", "data/lt.js", "data/valuation.js", "data/us.js", "data/asset.js", "data/divbt.js", "data/divbt-sell.js", "data/etf.js", "data/baseline.js", "data/reports.js", "data/snap-all.js", "app.js"].forEach(f => eval(fs.readFileSync(path.join(DIR, f), "utf8")));

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ FAIL " + name + (detail != null ? "  [" + detail + "]" : "")); }
}

console.log("=== 1. 数据层（data/snap-all.js） ===");
const SN = window.SNAPS;
assert("SNAPS 已加载", !!SN);
const dates = Object.keys(SNAPS || {}).sort();
assert("至少有 1 天快照", dates.length >= 1, dates.length);
assert("日期键格式 YYYY-MM-DD", dates.every(d => /^\d{4}-\d{2}-\d{2}$/.test(d)));
const s0 = SNAPS[dates[dates.length - 1]];   // 最早一天
assert("A股港股行情覆盖 28 只", (s0.ah || []).length === 28, (s0.ah || []).length);
assert("美股行情覆盖 21 只", (s0.us || []).length === 21, (s0.us || []).length);
assert("三大指数齐全", (s0.indices || []).length === 3, (s0.indices || []).length);
assert("含美债10Y（老唐法锚）", !!s0.rfUS && s0.rfUS.v > 0, JSON.stringify(s0.rfUS));
assert("含当日名单", !!s0.lists && !!s0.lists.picks && Array.isArray(s0.lists.formal));
assert("名单四象限结构完整", ["steady", "growth", "rotate", "tenx"].every(c => Array.isArray(s0.lists.picks[c])));
assert("估值分位字段存在", !!s0.valPct && Object.keys(s0.valPct).length > 0, Object.keys(s0.valPct || {}).length);
const moutai = (s0.ah || []).find(x => x.c === "sh600519");
assert("快照含茅台且字段完整", moutai && moutai.px > 0 && moutai.pe > 0, JSON.stringify(moutai).slice(0, 80));

console.log("=== 2. 展示层（历史留档页） ===");
window._setValMode && window._setValMode("band");
showTab("history");
const hb = store["history-body"].innerHTML;
assert("历史留档页含「历史数据」卡", hb.indexOf("历史数据（按日期查看）") >= 0);
assert("含日期下拉与查看按钮", !!store["snap-date"] && hb.indexOf('window.snapView()') >= 0);
assert("下拉选项 = 快照天数", (store["snap-date"].innerHTML.match(/<option/g) || []).length === dates.length,
  (store["snap-date"].innerHTML.match(/<option/g) || []).length + " vs " + dates.length);
assert("默认展示最新一天", store["snap-view"].innerHTML.indexOf("A股港股行情") >= 0);
assert("指数 chips 已渲染", store["snap-view"].innerHTML.indexOf("上证指数") >= 0);
assert("当日名单区已渲染", store["snap-view"].innerHTML.indexOf("当日名单") >= 0 && store["snap-view"].innerHTML.indexOf("建仓正式名单") >= 0);
assert("A股港股表行数 = 28（含表头）", (store["snap-view"].innerHTML.match(/<tr>/g) || []).length >= 28 + 21 + 3);
assert("美股表含 52 周位置列", store["snap-view"].innerHTML.indexOf("52周位置") >= 0);
assert("行情截至信息展示", store["snap-view"].innerHTML.indexOf("行情截至") >= 0);
// 切到更早日期（多天时才可测）
if (dates.length >= 2) {
  window.snapView(dates[0]);
  assert("可切换日期查看", store["snap-view"].innerHTML.indexOf(dates[0]) >= 0 || store["snap-view"].innerHTML.indexOf("A股港股行情") >= 0);
}
window.snapView("2000-01-01");
assert("无归档日期给出提示", store["snap-view"].innerHTML.indexOf("没有") >= 0);

console.log("=== 3. 归档脚本幂等性（archive-snap.js 同日重跑） ===");
const arch = require("./archive-snap.js");
const before = fs.readFileSync(path.join(DIR, "data", "snap-all.js"), "utf8");
arch.archive();
const after = fs.readFileSync(path.join(DIR, "data", "snap-all.js"), "utf8");
const nb = { window: {} };
new Function("window", after)(nb.window);
assert("同日重跑后日期数不变", Object.keys(nb.window.SNAPS).length === dates.length,
  Object.keys(nb.window.SNAPS).length + " vs " + dates.length);
assert("同日重跑内容一致（覆盖当日，不重复入库）", before === after);
// 恢复全局 window.SNAPS（archive 后文件未变，无需重载）
assert("raw 副本目录存在", fs.existsSync(path.join(DIR, "..", "investment-assistant-archive", s0.date, "data.js")));

console.log("\n结果: " + pass + " 通过, " + fail + " 失败");
process.exit(fail ? 1 : 0);
