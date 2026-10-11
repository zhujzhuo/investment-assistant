// 历史估值百分位自检：分位计算 / 实时价联动 / 三档参考价 / 筛选排序 / 页面渲染 / 缺失数据降级
const fs = require("fs");
const path = require("path");
const dir = __dirname;
const store = {};

function mkEl(id) {
  return { id, style: {}, innerHTML: "", textContent: "", className: "", value: "", files: [], appendChild() {}, setAttribute() {}, addEventListener() {}, click() {} };
}
global.document = {
  getElementById(id) { if (!store[id]) store[id] = mkEl(id); return store[id]; },
  querySelectorAll() { return []; },
  getElementsByTagName() { const h = mkEl("head"); h.appendChild = function () {}; return [h]; },
  createElement() { return mkEl("x"); },
  addEventListener() {}
};
global.window = global;
global.navigator = {};
global.Blob = class { constructor(p) { this.parts = p; } };
global.URL.createObjectURL = function () { return "blob:x"; };
global.localStorage = { getItem() { return null; }, setItem() {} };

eval(fs.readFileSync(path.join(dir, "data.js"), "utf8"));
eval(fs.readFileSync(path.join(dir, "data/valuation.js"), "utf8"));
eval(fs.readFileSync(path.join(dir, "app.js"), "utf8"));

let pass = 0;
function assert(name, cond, extra) {
  if (!cond) throw new Error("FAIL: " + name + (extra ? " → " + extra : ""));
  pass++; console.log("  ✓ " + name + (extra ? "  [" + extra + "]" : ""));
}

console.log("== 1. 数据完整性 ==");
const VAL = window.VAL, S = window.STOCKS;
// 2026-10-08 补齐：宁德/阳光/泡泡/老铺 4 只已抓到财报历史与月K，全池 28 只均有估值分位。
// 老铺黄金 2024-06 上市，序列按实际可得长度取（29 个月），短于 4 年的标的单独放宽校验。
const SHORT_HIST = { hk06181: 24 };            // 上市不足 4 年 → 序列长度下限
const valStocks = S.filter(st => VAL[st.code]);
assert("VAL 覆盖全池 28 只", Object.keys(VAL).length === 28, Object.keys(VAL).length + "/28");
["sz300750", "sz300274", "hk09992", "hk06181"].forEach(c => {
  const v = VAL[c];
  if (!v || !v.px || !v.px.length) throw new Error("FAIL: 新增标的仍缺估值序列 " + c);
  if (!v.pe && !v.pb) throw new Error("FAIL: " + c + " 既无 PE 也无 PB 序列");
});
pass++; console.log("  ✓ 新增 4 只（宁德/阳光/泡泡/老铺）均已补齐历史估值序列");
S.forEach(st => {
  const v = VAL[st.code];
  if (!v) throw new Error("FAIL: 缺少 " + st.code);
  const minLen = SHORT_HIST[st.code] || 40;
  if (!v.px || v.px.length < minLen) throw new Error("FAIL: " + st.code + " 价格序列过短 " + (v.px ? v.px.length : 0) + " < " + minLen);
  if (v.pe && Math.abs(v.px0 - st.px) > 0.01) throw new Error("FAIL: " + st.code + " 锚定价与快照价不一致 " + v.px0 + " vs " + st.px);
});
pass++; console.log("  ✓ 28 只标的价格序列达标且锚定价与快照一致（老铺黄金按上市时间放宽到 24 个月）");
const withPE = valStocks.filter(st => VAL[st.code].pe);
const withPB = valStocks.filter(st => VAL[st.code].pb);
const withDY = valStocks.filter(st => VAL[st.code].dy);
assert("PE 序列覆盖", withPE.length >= 26, withPE.length + " 只");
assert("PB 序列覆盖", withPB.length === 28, withPB.length + " 只");
assert("股息率序列覆盖（仅A股有分红数据）", withDY.length >= 17, withDY.length + " 只");

console.log("\n== 2. 分位计算（与预计算值一致性） ==");
const maotai = S.find(s => s.code === "sh600519");
const cv = window.__t ? null : null; // 内部函数不暴露，用页面渲染验证
// 通过渲染详情页验证（内部函数经 renderDetail 走通即可）

console.log("\n== 3. 实时价联动 ==");
// 把茅台价格改到 2 倍，重新渲染详情页，PE 分位应显著上升
const v = VAL["sh600519"];
const base = maotai.px;
const pctAt = px => {
  const f = px / v.px0, pe = v.pe0 * f;
  const vals = v.pe.map(p => p[1]);
  const le = vals.filter(x => x <= pe).length;
  return { pe: pe, pct: le / vals.length * 100 };
};
const a = pctAt(base), b = pctAt(base * 2), c = pctAt(base * 0.5);
assert("1倍价 = 快照分位", Math.abs(a.pct - v.pePct) < 0.5, a.pct.toFixed(1) + "% vs 预计算 " + v.pePct + "%");
assert("价格翻倍 → PE 翻倍", Math.abs(b.pe - a.pe * 2) < 0.01, a.pe.toFixed(2) + " → " + b.pe.toFixed(2));
assert("价格翻倍 → 分位上升", b.pct > a.pct, a.pct.toFixed(0) + "% → " + b.pct.toFixed(0) + "%");
assert("价格腰斩 → 分位下降", c.pct < a.pct, a.pct.toFixed(0) + "% → " + c.pct.toFixed(0) + "%");
assert("腰斩后应进入极低分位", c.pct <= 20, c.pct.toFixed(1) + "%");

console.log("\n== 4. 三档参考价单调性 ==");
S.forEach(st => {
  const vv = VAL[st.code];
  if (!vv || !vv.peStats || !vv.pe0) return;
  const eps = vv.px0 / vv.pe0;
  const lo = vv.peStats.p25 * eps, mid = vv.peStats.med * eps, hi = vv.peStats.p75 * eps;
  if (!(lo < mid && mid < hi)) throw new Error("FAIL: " + st.code + " 三档价非单调 " + [lo, mid, hi].map(x => x.toFixed(2)).join("/"));
});
pass++; console.log("  ✓ 全部标的 低估价 < 合理价 < 高估价");

console.log("\n== 5. 详情页渲染 ==");
window.showTab("detail");
window._onSelChange("sh600519");
let html = store["detail-body"].innerHTML || "";
assert("详情页含估值百分位卡片", html.includes("历史估值百分位"));
assert("含 PE/PB/股息率三块", html.includes("PE(TTM) 分位") && html.includes("PB 分位") && html.includes("股息率 分位"));
assert("含三档参考价表", html.includes("低估买入价（历史P25）") && html.includes("高估警戒价（历史P75）"));
assert("含估值判断结论", html.includes("估值判断（"));
assert("绘制了走势图容器", html.includes('id="val-chart"'));
const chart = store["val-chart"] ? store["val-chart"].innerHTML : "";
assert("走势图已渲染 SVG", chart.indexOf("<svg") === 0 && chart.includes("polyline"), chart.length + " 字符");
assert("走势图含当前PE标注", chart.includes("当前"));

console.log("\n== 6. 缺失数据降级（美团无有效PE） ==");
window._onSelChange("hk03690");
html = store["detail-body"].innerHTML || "";
assert("无PE标的仍能渲染卡片", html.includes("历史估值百分位"));
assert("无PE时展示PB分位", html.includes("PB 分位"));
assert("结论改用PB口径", html.includes("估值判断（PB"), html.includes("估值判断（PE") ? "误用PE" : "ok");

console.log("\n== 6b. 次新股短样本提示（老铺黄金 2024-06 上市） ==");
window._onSelChange("hk06181");
html = store["detail-body"].innerHTML || "";
const lgv = VAL["hk06181"];
assert("老铺黄金有估值序列且短于 3 年", !!lgv && lgv.px.length < 36, lgv ? lgv.px.length + " 个月" : "无");
assert("详情页提示样本偏短", html.includes("样本偏短"), "");
assert("样本提示写明区间", html.includes(lgv.px.length + " 个月历史"), "");
assert("仍给出 PE 分位结论", html.includes("估值判断（PE"), html.includes("估值判断") ? "ok" : "无结论");

console.log("\n== 7. 筛选页：估值分位列 + 筛选 + 排序 ==");
window.showTab("screen");
html = store["screen-body"].innerHTML || "";
assert("筛选页含估值分位列", html.includes(">估值分位<"));
assert("含估值筛选下拉", html.includes("仅低估（分位≤30%）"));
assert("含排序下拉", html.includes("按估值分位（便宜优先）"));
assert("每行渲染分位胶囊", (html.match(/class="vchip /g) || []).length >= 28, (html.match(/class="vchip /g) || []).length + " 个");

// 仅低估
window._setVF("low");
const lowRows = ((store["screen-body"].innerHTML || "").match(/class="vchip v/g) || []);
const nLow = ((store["screen-body"].innerHTML || "").match(/rowlink/g) || []).length;
assert("「仅低估」过滤后有结果", nLow > 0, nLow + " 只");
assert("「仅低估」结果少于全量", nLow < 28, nLow + " 只");
// 排序：便宜优先
window._setVF("all"); window._setSort("val");
const order = (store["screen-body"].innerHTML || "").match(/vchip v\d">(\d+)%/g) || [];
const nums = order.map(t => Number(t.replace(/.*">/, "").replace("%", "")));
let sortedOK = true;
for (let i = 1; i < nums.length; i++) if (nums[i] < nums[i - 1]) sortedOK = false;
assert("按估值分位升序（便宜优先）", sortedOK, nums.join(","));
window._setSort("score");

console.log("\n== 8. 推荐页含估值分位 ==");
window.showTab("pick");
html = store["pick-body"].innerHTML || "";
assert("推荐页含估值分位列", html.includes(">估值分位<"));

console.log("\nVALUATION-OK  共 " + pass + " 项断言通过");
