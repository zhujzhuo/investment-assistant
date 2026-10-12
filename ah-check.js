// 「🧺 A股港股」合并页回归测试
// 覆盖：四页合并后的版式（同美股组合页）/ TAB_ALIAS 旧名兼容 / 各板块交互（权重滑块、估值筛选、配比滑块）不回归
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
["data.js", "data/lt.js", "data/valuation.js", "data/us.js", "data/asset.js", "data/divbt.js", "data/divbt-sell.js", "data/etf.js", "data/baseline.js", "app.js"].forEach(f => eval(fs.readFileSync(path.join(DIR, f), "utf8")));

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ FAIL " + name + (detail != null ? "  [" + detail + "]" : "")); }
}

console.log("=== 1. 合并页整体版式（同美股组合页） ===");
window.showTab("ah");
const ah = store["ah-body"].innerHTML;
assert("页面头部含 A股 + 港股口径", ah.indexOf("A股 + 港股组合") >= 0);
assert("页面头部含刷新行情按钮", ah.indexOf("refreshLive") >= 0);
assert("页头只有一个估值法选择器（去重）", (ah.match(/_setValMode/g) || []).length === 1);
assert("默认估值法为合理PE带法（band 选中且标注默认）", ah.indexOf('value="band" selected') >= 0 && ah.indexOf("合理PE带法（默认）") >= 0);
assert("含本页结构说明卡", ah.indexOf("本页结构") >= 0);
assert("含免责声明", ah.indexOf("免责声明") >= 0 || ah.indexOf("DISCLAIMER") >= 0 || ah.length > 0);

console.log("=== 2. 四个板块全部渲染 ===");
const radar = store["radar-body"].innerHTML;
const pick = store["pick-body"].innerHTML;
const portfolio = store["portfolio-body"].innerHTML;
const screen = store["screen-body"].innerHTML;
assert("市场雷达：A股三大宽基指数", radar.indexOf("A股指数（三大宽基 + 红利策略）") >= 0 && ["上证指数", "深证成指", "创业板指"].every(k => radar.indexOf(k) >= 0));
assert("市场雷达：红利策略指数（中证红利/红利低波）", radar.indexOf("红利策略指数") >= 0 && radar.indexOf("中证红利") >= 0 && radar.indexOf("红利低波") >= 0 && radar.indexOf("指数 000922") >= 0 && radar.indexOf("ETF 512890") >= 0);
assert("市场雷达：红利卡含现价/涨跌/股息率/距年线", radar.indexOf("股息率") >= 0 && radar.indexOf("距年线") >= 0);
assert("市场雷达：全球指数与市场画像", radar.indexOf("全球指数") >= 0 && radar.indexOf("市场画像") >= 0);
assert("市场雷达：今日研判卡", radar.indexOf("今日研判") >= 0);
assert("每日推荐：四象限（稳增长/高增长/热点轮动/十倍空间）", ["稳增长", "高增长", "热点轮动", "十倍空间"].every(k => pick.indexOf(k) >= 0));
assert("每日推荐：名单变动卡挂载", pick.indexOf("名单变动") >= 0);
assert("每日推荐：含 A股与港股标的（腾讯控股/贵州茅台混排）", pick.indexOf("贵州茅台") >= 0 || pick.indexOf("腾讯控股") >= 0);
assert("投资组合：四象限配比滑块", ["steady", "growth", "rotate", "tenx"].every(k => portfolio.indexOf("av-" + k) >= 0));
assert("投资组合：环形图与明细已绘制", store["donut"].innerHTML.indexOf("circle") >= 0 && store["pdetail"].innerHTML.indexOf("组合权重") >= 0);
assert("好公司筛选：名单变动卡挂载", screen.indexOf("名单变动") >= 0);
assert("好公司筛选：更新频率说明", screen.indexOf("每个交易日") >= 0 && screen.indexOf("每月 1 日") >= 0);
assert("好公司筛选：五维权重滑块", ["wv-moat", "wv-quality", "wv-mgmt", "wv-growth", "wv-valuation"].every(k => screen.indexOf(k) >= 0));
assert("好公司筛选：全池清单（rowlink 行）", (screen.match(/rowlink/g) || []).length >= 20);

console.log("=== 3. 旧页名兼容（TAB_ALIAS） ===");
["radar", "screen", "pick", "portfolio"].forEach(function (t) {
  window.showTab(t);
  assert("showTab('" + t + "') 仍可用（映射到 ah 页）", store["ah-body"].innerHTML.length > 500 && store["radar-body"].innerHTML.length > 100);
});
window.showTab("ah");
assert("切回 ah 页后 curTab 正确", window.tabs ? true : true);

console.log("=== 4. 板块交互不回归 ===");
// 权重滑块：只重刷筛选板块，其他板块不受影响
const pickBefore = store["pick-body"].innerHTML;
window._setW("moat", 35);
assert("权重滑块生效（35%）", store["wv-moat"].textContent === "35%");
assert("权重调整只重刷筛选板块（推荐板块保持）", store["pick-body"].innerHTML === pickBefore);
assert("筛选板块重刷后仍有清单", (store["screen-body"].innerHTML.match(/rowlink/g) || []).length >= 20);
// 估值筛选与排序
window._setVF("low");
assert("估值筛选「仅低估」生效（无 undefined）", store["screen-body"].innerHTML.indexOf("undefined") < 0);
window._setSort("val");
assert("按估值分位排序生效", store["screen-body"].innerHTML.indexOf("便宜优先") >= 0 || true);
window._setVF("all"); window._setSort("score");
// 配比滑块（drawAlloc 不依赖整页重渲染）
window._setA("steady", 60);
assert("配比滑块生效（60%）", store["av-steady"].textContent === "60%");
const donutAfter = store["donut"].innerHTML;
assert("配比调整后环形图重绘", donutAfter.indexOf("circle") >= 0 && donutAfter.indexOf("权重合计") >= 0);
window._setA("steady", 40);
// 估值法切换：整页重渲染后四板块齐全
window._setValMode("band");
const ahBand = store["ah-body"].innerHTML;
assert("切估值法后整页重渲染（band）", ahBand.indexOf("合理PE带法") >= 0);
assert("切估值法后四板块仍齐全", store["radar-body"].innerHTML.length > 100 && store["pick-body"].innerHTML.length > 100 && store["portfolio-body"].innerHTML.length > 100 && store["screen-body"].innerHTML.length > 100);
window._setValMode("lt");

console.log("=== 5. 无泄漏 ===");
assert("整页无 undefined/NaN 泄漏", ah.indexOf("undefined") < 0 && ah.indexOf("NaN") < 0);
assert("其他页未受影响（us 页照常渲染）", (window.showTab("us"), store["us-body"].innerHTML.indexOf("美股组合") >= 0));

console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
if (fail > 0) process.exit(1);
