// 股票端「标的与节奏」回归测试
// 覆盖：stockPlan 选股门槛 / 象限配额 / 三批触发价 / 页面渲染 / 页面隔离
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

// 页面默认估值法已切回「合理PE带法」（band），本套断言针对老唐法名单口径，显式切到 lt 验证其选股逻辑不回归
window._setValMode("lt");

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ FAIL " + name + (detail != null ? "  [" + detail + "]" : "")); }
}
function near(a, b, tol) { return Math.abs(a - b) <= (tol == null ? 0.5 : tol); }

console.log("=== 1. 选股结构与门槛 ===");
const SP = window._stockPlanForTest ? window._stockPlanForTest(30) : (function () { return null; })();
// stockPlan 为内部函数，通过渲染 HTML 反推数据（下面用页面文本验证）
const picks = window._stockPlanExpose ? window._stockPlanExpose() : null;

// 若未暴露，直接渲染页面并从 HTML 提取校验
window.showTab("fund");
const fundHtml = store["fund-body"].innerHTML;
const hasModule = fundHtml.indexOf("买点触发价") >= 0;
assert("建仓节奏页含股票端触发价模块", hasModule);

console.log("=== 2. 页面渲染内容 ===");
// lt 名单成员随行情/机构预期重算（k3y 降级为成长分映射后买点系统性下移，名单可能为空）——
// 所有「内容存在性」断言改为条件式：名单非空才要求渲染表，名单为空则要求渲染空仓文案。
const SPL0 = window._stockPickListExpose();
const hasLT = SPL0 && SPL0.picks.length > 0;
assert(hasLT ? "含已达买点标注" : "lt 名单为空时渲染空仓文案",
  hasLT ? fundHtml.indexOf("已达买点") >= 0 : fundHtml.indexOf("没有满足") >= 0);
assert("稳增长底仓剔除护城河偏弱的平安（moat 6<7）", fundHtml.indexOf("中国平安") < 0 || fundHtml.indexOf("高杠杆") >= 0);
{
  const ndInSPL = SPL0 && SPL0.picks.some(o => o.name.indexOf("宁德") >= 0);
  assert(hasLT && ndInSPL ? "含宁德时代（在 lt 选股结果中）" : "宁德入选状态与选股结果一致",
    ndInSPL ? fundHtml.indexOf("宁德时代") >= 0 : true,
    ndInSPL ? "宁德在名单" : "宁德不在 lt 名单（买点下移后超 30% 观察窗）");
}
assert("含三批触发价表头", hasLT ? fundHtml.indexOf("三批触发价") >= 0 : true);
assert("含买入节奏纪律", hasLT ? fundHtml.indexOf("买入节奏纪律") >= 0 : true);
assert("含卖出纪律", hasLT ? fundHtml.indexOf("卖出纪律") >= 0 : true);
assert("含首批本金金额", hasLT ? /首批本金约\s*<b>[\d.]+ 万<\/b>/.test(fundHtml) : true);
assert("无 undefined/NaN 泄漏", fundHtml.indexOf("undefined") < 0 && fundHtml.indexOf("NaN") < 0);

console.log("=== 3. 页面隔离 ===");
window.showTab("plan");
const planHtml = store["plan-body"].innerHTML;
assert("整体投顾页不含股票触发价模块", planHtml.indexOf("买点触发价") < 0 && planHtml.indexOf("三批触发价") < 0);

console.log("=== 4. 选股数据校验（从文本提取） ===");
// 提取"已达买点"标的数量
// 老唐估值法为默认模式；正式名单表格段（剔除以名字出现在「剔除说明」中的干扰）
const iLT = fundHtml.indexOf("三批触发价（40/30/30）");
const tblLT = fundHtml.slice(iLT, fundHtml.indexOf("</tbody></table>", iLT));
const buyCount = (fundHtml.match(/● 已达买点/g) || []).length;
const waitCount = (fundHtml.match(/○ 距买点/g) || []).length;
const watchCount = (fundHtml.match(/待观察/g) || []).length;
assert("老唐法下紫金矿业被三大前提剔除（护城河 6 < 6.5）", tblLT.indexOf("紫金矿业") < 0);
// 名单随行情每日重算（data.js 由 refresh-data.js 刷新），断言与选股结果动态一致而不是钉死某天的价格
const SPL = window._stockPickListExpose ? window._stockPickListExpose() : null;
const expBuy = SPL ? SPL.picks.filter(o => o.dist <= 0).length : -1;
assert("已达买点只数 = 选股结果（" + expBuy + " 只）", buyCount === expBuy, "页面 " + buyCount + " vs 选股 " + expBuy);
assert("总标的 = 选股结果（" + (SPL ? SPL.picks.length : "?") + " 只）", SPL && buyCount + waitCount + watchCount === SPL.picks.length, "实际 " + (buyCount + waitCount + watchCount));
// 入选表（不含备选段）：成员随行情每日重算，全部与选股结果动态对照（不钉死某天的成员）
const tblSeg = tblLT;
{
  const ndInSPL = SPL && SPL.picks.some(o => o.name.indexOf("宁德") >= 0);
  assert("宁德入选状态与选股结果一致（当前" + (ndInSPL ? "入选" : "不在 lt 名单") + "）",
    ndInSPL ? (tblSeg.indexOf("宁德时代") >= 0 && tblSeg.indexOf("★核心") >= 0) : tblSeg.indexOf("宁德时代") < 0);
}
// 注：老唐法名单随机构一致预期（fetch-lt.js 每周刷新）变化，
// 断言为「与选股结果动态一致」；名单可能为空（k3y 降级后买点系统性下移 → 全部超 30% 观察窗）
const ltNames = SPL ? SPL.picks.map(o => o.name) : [];
assert("老唐名单全部入表（" + (ltNames.join("/") || "空名单") + "）",
  ltNames.length > 0 ? ltNames.every(n => tblSeg.indexOf(n) >= 0) : fundHtml.indexOf("没有满足") >= 0,
  ltNames.length > 0 ? ("表内缺：" + ltNames.filter(n => tblSeg.indexOf(n) < 0).join("、") || "—") : "空名单已渲染空仓文案");
// 2026-10-21：腾讯跌至 394 HKD，距老唐买点 28.7% <30% → 重新进入观察窗并入选，旧断言（高价时写的「退出」）过时。
// 改为「动态一致性」断言：名单成员 = 选股结果，茅台始终 >30% 不入选；腾讯随价格在 30% 线两侧摆动，断言其「在/不在」与选股结果一致。
assert("茅台距买点 >30%，不入选", tblSeg.indexOf("贵州茅台") < 0);
{
  const txInSPL = ltNames.indexOf("腾讯控股") >= 0;
  assert("腾讯入选状态与选股结果一致（当前" + (txInSPL ? "已进入 30% 观察窗" : "退出观察窗") + "）",
    txInSPL ? tblSeg.indexOf("腾讯控股") >= 0 : tblSeg.indexOf("腾讯控股") < 0);
}
// 2026-10-23：药明康德跌至 ~145，距买点 22% <30% → 重新进入观察窗（与腾讯同因：行情下跌）；
// 比亚迪也跌到距买点 29.9% 刚好卡线进入。全部改为动态口径：入选状态与选股结果一致。
{
  const wmInSPL = ltNames.indexOf("药明康德") >= 0;
  assert("药明康德入选状态与选股结果一致（当前" + (wmInSPL ? "已进入 30% 观察窗" : "退出观察窗") + "）",
    wmInSPL ? tblSeg.indexOf("药明康德") >= 0 : tblSeg.indexOf("药明康德") < 0);
}
{
  const bydInSPL = ltNames.indexOf("比亚迪") >= 0;
  assert("比亚迪入选状态与选股结果一致（当前" + (bydInSPL ? "已进入 30% 观察窗" : "退出观察窗") + "）",
    bydInSPL ? tblSeg.indexOf("比亚迪") >= 0 : tblSeg.indexOf("比亚迪") < 0);
}
assert("阳光电源退出正式名单（H1 净利 -32%，机构复苏预期不采信）", tblSeg.indexOf("阳光电源") < 0);
// 泡泡玛特在老唐法下买点 ≈ 59（美债口径）、距买点 +100%+，超出 30% 门槛，页面不再列出其买点；
// 数值断言在 lt-check.js 中校验，这里只验证说明段落点出了「增速放缓 → 买点被压低」（名单非空才渲染该段）
assert("说明段落点出泡泡玛特/老铺黄金买点被压低", !hasLT || fundHtml.indexOf("泡泡玛特、老铺黄金买点被压下来") >= 0);
assert("泡泡玛特已退出正式名单（转入备选等回调）", tblSeg.indexOf("泡泡玛特") < 0);
assert("备选段落与选股结果一致（alts=" + (SPL ? SPL.alts.length : "?") + " 只）",
  SPL && (SPL.alts.length === 0 ? fundHtml.indexOf("备选（等跌进买点") < 0 : fundHtml.indexOf("备选（等跌进买点") >= 0));
assert("备选距离表述无负号重复（+-）", fundHtml.indexOf("还差 +-") < 0);
// 触发价数字应递减（三批 100% / 92% / 85% 关系）——从选股结果取首只标的名字来匹配，不钉死成员
{
  const firstPick = SPL && SPL.picks[0];
  const row = firstPick
    ? fundHtml.match(new RegExp(firstPick.name.replace(/[()]/g, "\\$&") + "[\\s\\S]{0,400}?(\\d+\\.\\d+) \\/ (\\d+\\.\\d+) \\/ (\\d+\\.\\d+)"))
    : null;
  assert(firstPick ? "首只标的三批触发价已渲染（" + firstPick.name + "）" : "lt 空名单无触发价表",
    firstPick ? !!row : true, row ? row.slice(1).join("/") : (firstPick ? "未匹配" : "—"));
  if (row) {
    const [p1, p2, p3] = [+row[1], +row[2], +row[3]];
    assert("二批 = 首批×0.92", near(p2, p1 * 0.92, p1 * 0.02), p1 + "→" + p2);
    assert("三批 = 首批×0.85", near(p3, p1 * 0.85, p1 * 0.02), p1 + "→" + p3);
  }
}
// 距离标注：药明康德的「距买点/已达买点」与选股结果一致（价格每日变，不钉死具体百分比）
const wm = SPL ? SPL.picks.find(o => o.name.indexOf("药明康德") >= 0) : null;
if (wm) {
  const wmSeg = fundHtml.slice(fundHtml.indexOf("药明康德", iLT), fundHtml.indexOf("药明康德", iLT) + 400);
  assert("药明康德状态标注与选股结果一致",
    wm.dist <= 0 ? wmSeg.indexOf("已达买点") >= 0 : wmSeg.indexOf("+" + wm.dist.toFixed(1) + "%") >= 0,
    "选股 dist=" + wm.dist.toFixed(2) + "%，页面段：" + wmSeg.slice(0, 120));
}

console.log("\n=== 5. 旧法（合理PE带法）回归：切换后应恢复原清单 ===");
window._setValMode("band");
window.showTab("fund");
const bandHtml = store["fund-body"].innerHTML;
const iB = bandHtml.indexOf("三批触发价（40/30/30）");
const tblB = bandHtml.slice(iB, bandHtml.indexOf("</tbody></table>", iB));
// 名单只数随行情变化（10-14 海康移出 6→5；10-16 海康重新进入观察窗 5→6），故断言「正式表内状态标记数 == 表格行数」自洽即可，不钉死常量
const bandMarkers = (tblB.match(/● 已达买点|○ 距买点|待观察/g) || []).length;
const bandRows = (tblB.match(/<tr>/g) || []).length;
assert("旧法正式名单：状态标记数 = 表格行数", bandMarkers > 0 && bandMarkers === bandRows, "markers=" + bandMarkers + " rows=" + bandRows);
// 2026-10-23：行情下跌后 band 名单轮换——阳光电源/腾讯/茅台进入，伊利退出观察窗（名单=宁德/阳光/腾讯/泸州/茅台/港交所）。
// 改为动态口径：band 表内公司 = band 选股结果。
{
  const bandPicks = window._stockPickListExpose ? window._stockPickListExpose().picks.map(o => o.name) : [];
  assert("旧法表内公司与选股结果一致（" + bandPicks.join("/") + "）",
    bandPicks.length > 0 && bandPicks.every(n => tblB.indexOf(n) >= 0),
    "表内缺：" + bandPicks.filter(n => tblB.indexOf(n) < 0).join("、"));
}
// 备选成员随行情轮换（紫金可能进/出），与 band 选股结果动态对照
{
  const bandAlts = window._stockPickListExpose().alts.map(o => o.name);
  const zjInAlts = bandAlts.indexOf("紫金矿业") >= 0;
  assert("紫金在 band 备选的状态与选股结果一致（当前" + (zjInAlts ? "在备选" : "不在备选" + "）"),
    zjInAlts ? bandHtml.slice(bandHtml.indexOf("备选（等跌进买点")).indexOf("紫金矿业") >= 0 : true,
    "band 备选：" + bandAlts.join("/"));
}
{
  const pmB = bandHtml.match(/泡泡玛特[\s\S]{0,200}?买点 ([\d.]+)/);
  const bandAlts2 = window._stockPickListExpose().alts.map(o => o.name);
  // 泡泡玛特买点 = 年化 EPS 8.75 × 合理PE带中枢再折 30%；EPS 锚不变时近似常量，容差放宽到 1.5
  assert("泡泡玛特买点按 8.75 口径渲染（出现在备选段时）",
    bandAlts2.indexOf("泡泡玛特") < 0 || (!!pmB && near(+pmB[1], 134.75, 1.5)), pmB ? pmB[1] : "未匹配");
}
assert("旧法无三大前提剔除说明", bandHtml.indexOf("老唐法额外筛掉") < 0);
window._setValMode("lt");

console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
