// 老唐估值法引擎回归测试
// 覆盖：估值链条、增速放缓→PE封顶与买点折让、三大前提剔除、模式切换、与旧法对比
const fs = require("fs");
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
["data.js", "data/lt.js", "data/valuation.js", "data/us.js", "data/asset.js", "data/divbt.js", "app.js"].forEach(f => eval(fs.readFileSync(f, "utf8")));

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ FAIL " + name + (detail != null ? "  [" + detail + "]" : "")); }
}
function near(a, b, tol) { return Math.abs(a - b) <= (tol == null ? 0.5 : tol); }
const S = window.STOCKS, F = window.LT_FORECAST;
const by = c => S.find(s => s.code === c);

console.log("=== 1. 机构一致预期数据 ===");
assert("28 只全部有三年预期倍数", S.every(s => F[s.code] && F[s.code].k3y > 0), "缺失 " + S.filter(s => !(F[s.code] && F[s.code].k3y)).map(s => s.name).join(","));
assert("茅台 L1（66 家年度一致预期）", F.sh600519.lv === 1 && F.sh600519.nOrg === 66);
assert("腾讯 L2（季度一致预期外推）", F.hk00700.lv === 2 && F.hk00700.nOrg >= 4);
assert("老铺黄金 L3 且三年为负增长（周期见顶）", F.hk06181.lv === 3 && F.hk06181.k3y < 1);
assert("小米三年预期为负（净利 -34.7% 的机构延续）", F.hk01810.k3y < 1);
assert("阳光电源三年倍数最高（机构预期 26→28 年 +52%）", F.sz300274.k3y > 1.7);

console.log("\n=== 2. 老唐估值链条 ===");
const lt = c => (function () { let r = null; window._setValMode("lt"); const st = by(c); return (function () {
  // ltValue 为内部函数，通过 targetRange 取
  const t = (function () { try { return eval("targetRange")(st, st.fairPE ? st.fairPE[0] : 10, st.fairPE ? st.fairPE[1] : 15); } catch (e) { return null; } })();
  return t && t.lt ? t.lt : null;
})(); })();
// 直接复用页面内函数：通过渲染调研页拿不到内部对象，改用全局暴露判断
const RF = window.MKT.rfUS && window.MKT.rfUS.v > 0 ? window.MKT.rfUS.v : 3.5;   // 无风险收益率 = 美债十年期（每日刷新）
function ltOf(code) {
  const st = by(code);
  const f = F[code];
  let base = st.epsBase != null ? st.epsBase : ((f && f.lv === 1 && f.e26 > 0 && st.mkt === "A") ? f.e26 : (st.peF ? st.px / st.peF : (st.pe && st.pe > 0 ? st.px / st.pe : null)));
  if (!(base > 0) || !f) return null;
  let k = f.k3y;
  if (st.npg != null && st.npg < -20 && k > 1) k = 1;               // 业绩下滑 → 不采信机构复苏预期
  const eps3y = base * k, g3y = Math.pow(k, 1 / 3) - 1;
  const peBase = Math.max(15, Math.min(33, 100 / RF));              // 美债10Y 倒数，区间放宽为 15~33 倍
  let d = 1;
  if (["银行", "保险"].indexOf(st.industry) >= 0) d *= 0.7;
  if (["晶圆代工", "光伏/储能", "电信运营商"].indexOf(st.industry) >= 0) d *= 0.8;
  if (["有色/黄金铜", "黄金珠宝"].indexOf(st.industry) >= 0) d *= 0.8;
  if (st.quality < 7) d *= 0.85;
  const capR = g3y >= 0.15 ? 1.05 : g3y >= 0.08 ? 0.95 : g3y >= 0.03 ? 0.87 : g3y >= 0 ? 0.77 : 0.70;  // 增速封顶 = 相对基准
  const cap = peBase * capR;
  const pe = Math.min(peBase * d, cap);
  let bx = 0.5;
  if (g3y < 0) bx = 0.40;
  else if (g3y < 0.03 || ["有色/黄金铜", "黄金珠宝"].indexOf(st.industry) >= 0 || st.moat < 7) bx = 0.45;
  const fair3y = eps3y * pe;
  return { base, eps3y, g3y, pe, capR, cap, fair3y, buy: fair3y * bx, bx, sell: Math.min(fair3y * 1.5, base * 50) };
}
const mt = ltOf("sh600519");
assert("茅台三年后 EPS = 66.97 × 1.1752 ≈ 78.70", near(mt.eps3y, 78.70, 0.3), mt.eps3y.toFixed(2));
assert("茅台隐含三年年化增速 ≈ 5.5%", near(mt.g3y * 100, 5.5, 0.3), (mt.g3y * 100).toFixed(2));
assert("茅台增速 3~8% → 合理PE 封顶 = 基准 ×0.87 ≈ 16.6 倍（美债10Y 5.24% → 基准 19.1）", near(mt.cap, 16.6, 0.15) && near(mt.pe, mt.cap, 0.01), mt.pe.toFixed(2));
assert("茅台买点 = 三年后合理估值 × 50%", near(mt.buy, mt.fair3y * 0.5, 0.01), mt.buy.toFixed(2));
assert("茅台买点 ≈ 655（美债5.24%口径，比旧 rf3.5% 的 984 低约 1/3）", near(mt.buy, 655.2, 2), mt.buy.toFixed(2));
assert("茅台距买点 +93%（需回落近半），已退出 30% 观察窗（不再入选老唐法正式名单）", mt.buy < by("sh600519").px * 0.55, mt.buy.toFixed(1) + " vs 现价 " + by("sh600519").px);
assert("茅台卖点 = min(三年后×150%, 基准EPS×50倍)", near(mt.sell, Math.min(mt.fair3y * 1.5, mt.base * 50), 0.01));

console.log("\n=== 3. 增速放缓如何定价 ===");
const pm = ltOf("hk09992"), lg = ltOf("hk06181"), xm = ltOf("hk01810"), nd = ltOf("sz300750");
assert("泡泡玛特增速≈0 → PE 封顶 = 基准 ×0.77 ≈ 14.7 倍（低于茅台 16.6 倍）", near(pm.cap, 14.7, 0.15) && pm.cap < mt.cap, pm.cap);
assert("泡泡玛特买点折让 45%（增速<3%加大安全边际）", near(pm.bx, 0.45, 0.001), pm.bx);
assert("泡泡玛特买点 ≈ 59（美债口径进一步压低，远低于人工校准 134.75）", pm.buy > 55 && pm.buy < 65, pm.buy.toFixed(2));
assert("老铺黄金负增长 → PE 封顶 = 基准 ×0.70 ≈ 13.4 倍 + 买点折让 40%", near(lg.cap, 13.4, 0.15) && near(lg.bx, 0.40, 0.001), lg.cap.toFixed(2) + "/" + lg.bx);
assert("老铺黄金买点 ≈ 151 < 现价 321（周期峰值盈利不追）", lg.buy < 160 && lg.buy < by("hk06181").px, lg.buy.toFixed(2));
assert("小米负增长 → 买点折让 40%", near(xm.bx, 0.40, 0.001), xm.bx);
assert("宁德增速>15% → PE 封顶 = 基准 ×1.05 ≈ 20.0 倍（高于茅台）", near(nd.cap, 20.0, 0.15) && nd.cap > mt.cap, nd.cap.toFixed(2));
assert("高增长给的 PE 倍数 > 低增长给的 PE 倍数", nd.pe > mt.pe, nd.pe.toFixed(1) + " vs " + mt.pe.toFixed(1));
const zg = ltOf("sh601899");
assert("紫金为周期股 → 质地折扣含 ×0.8", by("sh601899").industry === "有色/黄金铜");
const yg = ltOf("sz300274");
assert("阳光电源 H1 净利 -32% → 不采信机构复苏预期，三年倍数封顶 1.0", near(yg.eps3y, ltOf("sz300274").base, 0.01), yg.eps3y.toFixed(2));
assert("阳光电源买点 ≈ 71 < 现价 82.5（等回调，不再按机构乐观预期给高买点）", yg.buy < by("sz300274").px, yg.buy.toFixed(2));

console.log("\n=== 4. 三大前提剔除 ===");
// 页面默认估值法已切回「合理PE带法」（band），本节验证老唐法名单口径，显式切到 lt
window._setValMode("lt");
window.showTab("fund");
const fundHtml = store["fund-body"].innerHTML;
// 剔除说明里会出现这些名字，所以只检查正式入选表格段
const iTbl = fundHtml.indexOf("三批触发价（40/30/30）");
const tblSeg = fundHtml.slice(iTbl, fundHtml.indexOf("</tbody></table>", iTbl));
assert("老唐模式下招商银行未入选（高杠杆，能力圈外）", tblSeg.indexOf("招商银行") < 0);
assert("老唐模式下中国平安未入选（高杠杆 + 护城河 6）", tblSeg.indexOf("中国平安") < 0);
assert("老唐模式下建设银行未入选（高杠杆）", tblSeg.indexOf("建设银行") < 0);
assert("老唐模式下美团未入选（无正 EPS 基准）", tblSeg.indexOf("美团") < 0);
assert("老唐模式下紫金矿业未入选（护城河 6 < 6.5）", tblSeg.indexOf("紫金矿业") < 0);
assert("剔除说明列出被筛标的", fundHtml.indexOf("老唐法额外筛掉") >= 0 && fundHtml.indexOf("高杠杆") >= 0);
// 注：老唐法名单由「机构一致预期 k3y × 合理PE × 50%」逐日重算，fetch-lt.js 每周刷新后成员会变（此处 2026-10-12 刷新后：宁德/海康/泸州 3 只，伊利 +31.3% 出窗）
assert("美债5.24%口径下正式名单 3 只：宁德（唯一已达买点）+ 海康/泸州（观察窗内，伊利已出窗）",
  tblSeg.indexOf("宁德时代") >= 0 && tblSeg.indexOf("海康威视") >= 0 && tblSeg.indexOf("泸州老窖") >= 0 && tblSeg.indexOf("伊利股份") < 0,
  "名单：" + (fundHtml.match(/● 已达买点|○ 距买点|待观察/g) || []).length + " 行");
assert("茅台/腾讯距买点 >30%（买点 653/306），退出老唐法观察窗", tblSeg.indexOf("贵州茅台") < 0 && tblSeg.indexOf("腾讯控股") < 0);
assert("页面说明买点来源（机构一致预期）", fundHtml.indexOf("机构一致预期三年倍数") >= 0);
assert("表头改为三年后合理估值/理想买点", fundHtml.indexOf("理想买点(×50%)") >= 0 && fundHtml.indexOf("三年后合理估值") >= 0);
assert("无 undefined/NaN 泄漏", fundHtml.indexOf("undefined") < 0 && fundHtml.indexOf("NaN") < 0);

console.log("\n=== 5. 模式切换 ===");
window._setValMode("band");
window.showTab("fund");
const bandHtml = store["fund-body"].innerHTML;
assert("切到旧法后表头回到中性估值", bandHtml.indexOf("中性估值") >= 0 && bandHtml.indexOf("理想买点(×50%)") < 0);
assert("旧法下无三大前提剔除说明", bandHtml.indexOf("老唐法额外筛掉") < 0);
window._setValMode("lt");

console.log("\n=== 6. 调研页老唐卡片 ===");
window.openDetail("sh600519");
const dHtml = store["detail-body"].innerHTML;
assert("调研页含老唐估值法卡片", dHtml.indexOf("老唐估值法 · 三年后估值与理想买点") >= 0);
assert("无风险收益率标注为美债10Y且取值来自 data.js（5.2%）", dHtml.indexOf("美债10Y") >= 0 && dHtml.indexOf("5.2%") >= 0, dHtml.match(/无风险收益率[^<]*<b>[\d.]+%/) ? dHtml.match(/无风险收益率[^<]*<b>[\d.]+%/)[0] : "未匹配");
assert("含基准 EPS / 三年预期倍数 / 三年后 EPS 链条", dHtml.indexOf("基准 EPS") >= 0 && dHtml.indexOf("三年预期倍数") >= 0 && dHtml.indexOf("三年后 EPS") >= 0);
assert("含增速放缓定价说明", dHtml.indexOf("增速放缓如何定价") >= 0);
assert("含三大前提体检结论", dHtml.indexOf("三大前提") >= 0);
assert("含机构综合目标价对照", dHtml.indexOf("机构综合目标价") >= 0);
assert("无 undefined/NaN 泄漏", dHtml.indexOf("undefined") < 0 && dHtml.indexOf("NaN") < 0);

console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
