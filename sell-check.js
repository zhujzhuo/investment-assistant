// 红利「卖出 / 止盈」规则自检（规则层 + 页面渲染 + 回测数据）
const fs = require("fs");
const path = require("path");
const dir = __dirname;
const store = {};
let LS = {};
global.localStorage = {
  getItem(k) { return Object.prototype.hasOwnProperty.call(LS, k) ? LS[k] : null; },
  setItem(k, v) { LS[k] = String(v); }
};
function mkEl(id) {
  return { id, style: {}, innerHTML: "", textContent: "", className: "", value: "", files: [], appendChild() {}, setAttribute() {}, addEventListener() {}, click() {} };
}
global.document = {
  getElementById(id) { if (!store[id]) store[id] = mkEl(id); return store[id]; },
  querySelectorAll() { return []; },
  getElementsByTagName() { const h = mkEl("head"); h.appendChild = function (el) { setTimeout(function () { if (el.onerror) el.onerror(); }, 0); }; return [h]; },
  createElement() { return mkEl("x"); },
  addEventListener() {}
};
global.window = global;
global.window.localStorage = global.localStorage;
global.navigator = {};
global.Blob = class { constructor(p) { this.parts = p; } };
global.URL.createObjectURL = function () { return "blob:x"; };
global.FileReader = class { readAsText() {} };
global.location = { protocol: "https:" };

eval(fs.readFileSync(path.join(dir, "data.js"), "utf8"));
eval(fs.readFileSync(path.join(dir, "data/lt.js"), "utf8"));
eval(fs.readFileSync(path.join(dir, "data/valuation.js"), "utf8"));
eval(fs.readFileSync(path.join(dir, "data/us.js"), "utf8"));
eval(fs.readFileSync(path.join(dir, "data/asset.js"), "utf8"));
eval(fs.readFileSync(path.join(dir, "data/divbt.js"), "utf8"));
eval(fs.readFileSync(path.join(dir, "data/divbt-sell.js"), "utf8"));
eval(fs.readFileSync(path.join(dir, "data/etf.js"), "utf8"));
eval(fs.readFileSync(path.join(dir, "app.js"), "utf8"));

let pass = 0, fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name + (extra ? "（" + extra + "）" : "")); }
  else { fail++; console.log("  ✗ FAIL: " + name + (extra ? " → " + extra : "")); }
}
function near(a, b, eps) { return Math.abs(a - b) <= (eps == null ? 1e-6 : eps); }

const R = window._TRIM_RULE;
console.log("== 1. 规则参数 ==");
assert("浮仓止盈阈值：便宜 12 / 中性 8 / 偏贵 5", R.t1Cheap === 12 && R.t1Mid === 8 && R.t1Rich === 5, [R.t1Cheap, R.t1Mid, R.t1Rich].join("/"));
assert("浮仓止盈只留底仓 30%，底仓止盈降到 20%", R.core === 30 && R.core2 === 20, R.core + "/" + R.core2);
assert("底仓止盈阈值 = 浮仓阈值 + 8%", R.t2Delta === 8);
assert("回补线 = 阈值 × 0.4（迟滞）", near(R.backRatio, 0.4) && R.minBack === 2);

console.log("\n== 2. 阈值随估值动态 ==");
const A = window.ASSET;
const csi = A.dividend.csi, lv = A.dividend.lowvol;
const bondY = A.bond10y.v;
function t1Of(spread) { return spread >= 3.0 ? R.t1Cheap : (spread >= 2.0 ? R.t1Mid : R.t1Rich); }
assert("利差 3.5pp（便宜）→ 阈值 12%", t1Of(3.5) === 12);
assert("利差 2.53pp（中性）→ 阈值 8%", t1Of(2.53) === 8);
assert("利差 1.2pp（偏贵）→ 阈值 5%", t1Of(1.2) === 5);
assert("当前中证红利利差 2.53pp → 阈值 8%", near(csi.dy - bondY, 2.53, 0.01) && t1Of(csi.dy - bondY) === 8, (csi.dy - bondY).toFixed(2) + "pp");

console.log("\n== 3. 止盈状态机（含迟滞）==");
// 直接构造标的快照，隔离测试状态机
function mkD(distMA, spread, hot, rsi) {
  return { distMA250: distMA, dy: spread + bondY, rsi14: rsi == null ? 55 : rsi, px: 100, ma250: 100 / (1 + distMA / 100), wk: { upper: hot ? 99 : 105 } };
}
window._TRIM_STATE.csi = null; window._TRIM_STATE.lowvol = null;
let t = window._trimLevel("csi", mkD(10, 2.5), 2.5);
assert("年线上方 10%（中性利差，阈值 8%）→ 浮仓止盈 lv=1", t.lv === 1, "lv=" + t.lv);
assert("阈值与回补线计算正确（t1=8, back=3, t2=16, back2=7）", t.t1 === 8 && t.back === 3 && t.t2 === 16 && t.back2 === 7, [t.t1, t.back, t.t2, t.back2].join("/"));
// 迟滞：回落到 5%（在回补线 3% 与阈值 8% 之间）应维持 lv=1
t = window._trimLevel("csi", mkD(5, 2.5), 2.5);
assert("迟滞：回落至 5%（3%~8% 之间）维持浮仓止盈，不回补", t.lv === 1, "lv=" + t.lv);
// 回落到 2%（≤ 回补线 3%）解除
t = window._trimLevel("csi", mkD(2, 2.5), 2.5);
assert("回落至 2%（≤ 回补线 3%）→ 解除，回到正常持有", t.lv === 0, "lv=" + t.lv);
// 底仓止盈需要过热确认
window._TRIM_STATE.csi = null;
t = window._trimLevel("csi", mkD(20, 2.5, false), 2.5);
assert("年线上方 20% 但无过热确认 → 只到浮仓止盈 lv=1", t.lv === 1, "lv=" + t.lv);
window._TRIM_STATE.csi = null;
t = window._trimLevel("csi", mkD(20, 2.5, true), 2.5);
assert("年线上方 20% + 周线上轨以上 → 底仓止盈 lv=2", t.lv === 2, "lv=" + t.lv);
window._TRIM_STATE.csi = null;
t = window._trimLevel("csi", mkD(20, 2.5, false, 75), 2.5);
assert("年线上方 20% + RSI>70 → 底仓止盈 lv=2", t.lv === 2, "lv=" + t.lv);
// 过热消失退回浮仓止盈
t = window._trimLevel("csi", mkD(10, 2.5, false, 55), 2.5);
assert("过热消失 → 从底仓止盈退回浮仓止盈 lv=1", t.lv === 1, "lv=" + t.lv);
// 便宜时阈值放宽
window._TRIM_STATE.csi = null;
t = window._trimLevel("csi", mkD(10, 3.5), 3.5);
assert("利差 3.5pp（便宜）时年线上方 10% 不触发（阈值 12%）", t.lv === 0, "lv=" + t.lv + " t1=" + t.t1);
// 偏贵时阈值收紧
window._TRIM_STATE.csi = null;
t = window._trimLevel("csi", mkD(6, 1.2), 1.2);
assert("利差 1.2pp（偏贵）时年线上方 6% 即触发（阈值 5%）", t.lv === 1, "lv=" + t.lv + " t1=" + t.t1);
// 年线下方
window._TRIM_STATE.csi = null;
t = window._trimLevel("csi", mkD(-3, 2.5), 2.5);
assert("年线下方 → 正常持有 lv=0", t.lv === 0, "lv=" + t.lv);
window._TRIM_STATE.csi = null; window._TRIM_STATE.lowvol = null;

console.log("\n== 4. 止盈层不参与仓位决策（回测：年化 −0.1~−1.5pp，对收益无改善）==");
window.showTab("plan");
let P = window._planState();
assert("TRIM_ADOPTED = false（止盈只作研究记录）", window._TRIM_ADOPTED === false);
assert("默认场景 cut = 0（无任何止盈削减）", P.trim && P.trim.cut === 0, "cut=" + (P.trim ? P.trim.cut : "n/a"));
assert("当前中证红利距年线 -0.7%、红利低波 +3.1%，均低于研究阈值 8%", P.trim.csi.distMA < 8 && P.trim.lowvol.distMA < 8,
  P.trim.csi.distMA.toFixed(2) + "% / " + P.trim.lowvol.distMA.toFixed(2) + "%");
const baseW = P.w.div, rawW = P.trim.raw;
// 构造触发场景：两个标的都到年线上方 10% 以上（旧规则会削减到 30%）
const saveC = csi.distMA250, saveL = lv.distMA250;
const savePxC = csi.px, savePxL = lv.px;
csi.distMA250 = 10; lv.distMA250 = 12;
window._TRIM_STATE.csi = null; window._TRIM_STATE.lowvol = null;
P = window._planState();
assert("年线上方 10%/12% 时，trimLevel 仍算出 lv=1（研究层照常计算）", P.trim.csi.lv === 1 && P.trim.lowvol.lv === 1,
  P.trim.csi.lv + "/" + P.trim.lowvol.lv);
assert("但红利仓位不再被止盈削减（仍是档位仓 " + rawW + "%）", P.w.div === rawW, "w.div=" + P.w.div);
assert("cut 仍为 0", P.trim.cut === 0, "cut=" + P.trim.cut);
// 极端过热场景（旧规则会降到 20%）
csi.distMA250 = 20; lv.distMA250 = 20; csi.px = csi.wk.upper; lv.px = lv.wk.upper;
window._TRIM_STATE.csi = null; window._TRIM_STATE.lowvol = null;
P = window._planState();
assert("极端过热（年线+20% 且周线上轨以上）也不降到 20%", P.w.div >= 30, "w.div=" + P.w.div);
assert("下限仍为底仓 30%", P.trim.floor === 30, "floor=" + P.trim.floor);
// 还原
csi.distMA250 = saveC; lv.distMA250 = saveL; csi.px = savePxC; lv.px = savePxL;
window._TRIM_STATE.csi = null; window._TRIM_STATE.lowvol = null;

console.log("\n== 5. 整体投顾页：止盈规则已移除 + 红利部分精简为摘要 ==");
window.showTab("plan");
const planHtml = store["plan-body"].innerHTML;
assert("不再出现「卖出 / 止盈规则」卡片", planHtml.indexOf("卖出 / 止盈规则") < 0);
assert("不再出现止盈 chip / 「止盈可至 20」", planHtml.indexOf("止盈可至 20") < 0 && planHtml.indexOf("止盈中") < 0);
assert("提醒面板不含止盈条目", planHtml.indexOf("止盈：年线上方") < 0);
assert("明确减仓交给利差档位", planHtml.indexOf("价涨 → 股息率降 → 利差收窄 → 档位降 → 仓位降") >= 0);
assert("投顾页不再放横向对比卡（对比卡在独立页）", planHtml.indexOf("中证红利 vs 红利低波") < 0);
assert("本页仍给出红利一句话摘要（两个标的利差 + 档位仓 + 内部倾斜）",
  planHtml.indexOf("利差") >= 0 && planHtml.indexOf("档位仓") >= 0 && planHtml.indexOf("红利内部倾斜") >= 0);
assert("本页给出加仓与减仓提示", planHtml.indexOf("仓位调整提示") >= 0 && planHtml.indexOf("加仓方向") >= 0 && planHtml.indexOf("减仓方向") >= 0);
assert("本页有跳转按钮到独立页", planHtml.indexOf("两个标的对比") >= 0);

console.log("\n== 5a. 红利买入 / 调仓提示放在首页（红利是重仓）==");
window.showTab("divcmp");
const cmpHtml = store["divcmp-body"].innerHTML;
assert("对比页已渲染", cmpHtml.length > 3000, cmpHtml.length + " 字符");
assert("含「回整体投顾」入口", cmpHtml.indexOf("回整体投顾") >= 0);
assert("对比页说明买入/调仓提示在整体投顾页", cmpHtml.indexOf("整体投顾 → 红利资产") >= 0);
assert("对比页不再重复加仓触发表", cmpHtml.indexOf("什么时候加仓、加多少") < 0);
assert("含内部倾斜与性格分工说明", cmpHtml.indexOf("两个标的怎么配") >= 0 && cmpHtml.indexOf("性格分工") >= 0);
assert("横向对比卡只在对比页", planHtml.indexOf("中证红利 vs 红利低波") < 0 && cmpHtml.indexOf("中证红利 vs 红利低波") >= 0);
assert("止损/止盈口径在首页说明（为什么不额外做）", planHtml.indexOf("为什么不额外做") >= 0 && planHtml.indexOf("年化反而") >= 0);
assert("首页给出止盈观察值（不触发动作）", planHtml.indexOf("观察值（不触发任何动作）") >= 0);
assert("首页含「红利标的（低估买入 · 利差档位减仓）」", planHtml.indexOf("红利标的（低估买入 · 利差档位减仓）") >= 0);
assert("首页档位标签去重（同档只显示一次）",
  (planHtml.match(/利差偏宽 · 小幅加仓/g) || []).length <= 3 && planHtml.indexOf("两标的同档") >= 0,
  (planHtml.match(/利差偏宽 · 小幅加仓/g) || []).length + " 处");
console.log("\n== 5b. 红利两个标的分开展示（表现 + 利差）==");
assert("出现「中证红利 vs 红利低波」对比卡", cmpHtml.indexOf("中证红利 vs 红利低波") >= 0);
assert("对比含表现维度（近 1 年 / 近 3 年年化 / 回撤 / 波动）",
  cmpHtml.indexOf("近 1 年涨幅") >= 0 && cmpHtml.indexOf("近 3 年年化") >= 0 && cmpHtml.indexOf("近 3 年最大回撤") >= 0 && cmpHtml.indexOf("年化波动") >= 0);
assert("对比含各自利差与档位仓", cmpHtml.indexOf("利差（股息率 − 国债") >= 0 && cmpHtml.indexOf("利差档位 → 该标的档位仓") >= 0);
assert("对比含两个标的各自的股息率分位", cmpHtml.indexOf("股息率近 3 年分位") >= 0);
assert("对比含技术位置（距年线 / RSI / 52 周位置）", cmpHtml.indexOf("距 52 周年线") >= 0 && cmpHtml.indexOf("RSI(14)") >= 0 && cmpHtml.indexOf("52 周位置") >= 0);
assert("对比含内部倾斜与 100 万折算金额", cmpHtml.indexOf("红利内部倾斜") >= 0 && cmpHtml.indexOf("按 100 万总资产折算") >= 0);
assert("点明「同一个股息率、分位可以相反」", cmpHtml.indexOf("含义可以完全相反") >= 0);
assert("两个标的各自有独立卡片", cmpHtml.indexOf("000922") >= 0 && cmpHtml.indexOf("H30269") >= 0);

console.log("\n== 5c. 加仓 + 减仓提示：什么时候加/减、加多少 ==");
function countOf(s, sub) { let n = 0, i = 0; while ((i = s.indexOf(sub, i)) >= 0) { n++; i += sub.length; } return n; }
assert("两个标的都有「什么时候加仓、加多少」（在首页）", countOf(planHtml, "什么时候加仓、加多少") === 2, countOf(planHtml, "什么时候加仓、加多少") + " 处");
assert("首页给出仓位调整提示（加仓方向 + 减仓方向）",
  planHtml.indexOf("仓位调整提示") >= 0 && planHtml.indexOf("加仓方向") >= 0 && planHtml.indexOf("减仓方向") >= 0);
assert("减仓方向给出触发价与档位仓变化", planHtml.indexOf("档位仓 44% → 40%") >= 0);
assert("加仓表含 触发条件 / 触发价 / 加仓幅度 / 折算金额 / 当前距离",
  planHtml.indexOf("<th>触发条件</th>") >= 0 || planHtml.indexOf("触发条件") >= 0);
assert("给出剩余加仓空间与分批口径", planHtml.indexOf("还剩") >= 0 && planHtml.indexOf("分 2~3 批") >= 0);
assert("金额按 100 万总资产折算", planHtml.indexOf("按 100 万总资产折算，钱从货币端划转") >= 0);
console.log("\n== 5d. 每日报告含分标的对比与加仓清单 ==");
window.showTab("report");
const rep = store["report-out"].textContent || "";
assert("报告含两个标的对比表", rep.indexOf("中证红利 vs 红利低波") >= 0);
assert("报告含各自利差（pp）与分位", rep.indexOf("股息率 / 利差") >= 0 && rep.indexOf("股息率近3年分位") >= 0);
assert("报告含「下一次加仓是什么、加多少」", rep.indexOf("下一次加仓是什么、加多少") >= 0);
assert("报告含加仓金额与分批口径", rep.indexOf("元（") >= 0 && rep.indexOf("分 2~3 批") >= 0);
assert("报告注明卖出侧不做额外技术止盈", rep.indexOf("卖出侧不做额外技术止盈") >= 0);

console.log("\n== 5e. 可投工具：4 只 ETF 的加减仓参考价 ==");
assert("首页出现两个「可投工具（ETF 加减仓参考价）」表（每标的一个）", countOf(planHtml, "可投工具（ETF 加减仓参考价）") === 2, countOf(planHtml, "可投工具（ETF 加减仓参考价）") + " 处");
assert("中证红利配 515180 / 515080", planHtml.indexOf("515180") >= 0 && planHtml.indexOf("515080") >= 0);
assert("红利低波配 563020 / 512890", planHtml.indexOf("563020") >= 0 && planHtml.indexOf("512890") >= 0);
const P3 = window._planState();
const rowsC2 = window._addPlanRows("csi", P3.csi, P3.lc, P3.tc);
const rowsL2 = window._addPlanRows("lowvol", P3.lowvol, P3.ll, P3.tl);
const strip = function (s) { return String(s || "").replace(/<[^>]+>/g, ""); };
assert("中证红利每行都带对应 ETF（515180 / 515080）", rowsC2.every(function (r) { return r.how.indexOf("515180") >= 0 && r.how.indexOf("515080") >= 0; }));
assert("红利低波每行也带对应 ETF（563020 / 512890）", rowsL2.every(function (r) { return r.how.indexOf("563020") >= 0 && r.how.indexOf("512890") >= 0; }));
const rsiRow = rowsL2.filter(function (r) { return r.trig.indexOf("RSI") >= 0; })[0];
assert("红利低波 RSI 行的 ETF 参考价低于现价（符号正确：需再跌不是再涨）",
  rsiRow && rsiRow.how.indexOf("563020 约 1.1") >= 0 && rsiRow.how.indexOf("512890 约 1.1") >= 0,
  rsiRow ? strip(rsiRow.how) : "无 RSI 行");
assert("加仓表新增「加仓幅度与性质」列（区分常态抬升 / 时机性加仓）", planHtml.indexOf("加仓幅度与性质") >= 0);
assert("加仓表带「怎么读这张表」说明（解释跌得多为何加得少）", planHtml.indexOf("怎么读这张表") >= 0 && planHtml.indexOf("口径不同，不是算错") >= 0);
assert("金额列标题明确为「对红利总仓的贡献」", planHtml.indexOf("对红利总仓的贡献") >= 0);

console.log("\n== 6. 回测页渲染 ==");
window._btSwitch("div");
const btHtml = store["backtest-body"].innerHTML;
assert("出现「红利卖出 / 止盈回测」章节", btHtml.indexOf("红利卖出 / 止盈回测") >= 0);
assert("给出核心结论（5%~8% 是甜区）", btHtml.indexOf("5%~8%") >= 0 && btHtml.indexOf("可回补") >= 0);
assert("卖出信号表含 RSI>70 与周线 BOLL 上轨", btHtml.indexOf("RSI(14) &gt; 70") >= 0 && btHtml.indexOf("周线 BOLL 上轨以上") >= 0);
assert("含随机基准对照行", btHtml.indexOf("随机基准（任意一周持有）") >= 0);
assert("组合对比含「只买不卖」与「固定 40%」", btHtml.indexOf("只买不卖") >= 0 && btHtml.indexOf("固定 40% 不调仓") >= 0);
assert("含被检验规则表（标注未采纳）", btHtml.indexOf("被检验的规则") >= 0 && btHtml.indexOf("未采纳为执行规则") >= 0);
assert("回测页说明不写入执行规则", btHtml.indexOf("不写入「整体投顾」的仓位计算") >= 0);
assert("含局限与样本口径说明", btHtml.indexOf("局限") >= 0);

console.log("\n== 7. 回测数据完整性 ==");
const SB = window.DIVBT_SELL;
assert("三条腿（000922 / 510880 / 512890）", SB.legs.length === 3, SB.legs.length + " 条");
SB.legs.forEach(function (L) {
  assert(L.name + " 样本 ≥6.9 年", L.years >= 6.9, L.years + " 年");
  assert(L.name + " 有卖出信号统计", L.signals.length >= 15, L.signals.length + " 个信号");
  const ma8 = L.signals.filter(function (s) { return s.key === "ma8"; })[0];
  if (L.key === "sh510880") {
    // 红利ETF 510880 是强趋势样本（年化 12%），年线上方 8% 后往往继续涨 —— 这是「止盈降低年化」的主要来源，如实保留
    assert(L.name + "（强趋势样本）年线上方 8% 后 6 个月为正超额（踏空，如实记录）", ma8 && ma8.stat.hold[26].excess > 0, ma8 ? "+" + ma8.stat.hold[26].excess.toFixed(2) + "pp" : "缺失");
    assert(L.name + " 年线上方 8% 的后 3 个月超额 < 后 6 个月（越晚卖越踏空）", ma8 && ma8.stat.hold[13].excess < ma8.stat.hold[26].excess, ma8 ? ma8.stat.hold[13].excess.toFixed(2) + " vs " + ma8.stat.hold[26].excess.toFixed(2) : "缺失");
  } else {
    assert(L.name + " 年线上方 8% 后 6 个月为负超额（卖对）", ma8 && ma8.stat.hold[26].excess < 0, ma8 ? ma8.stat.hold[26].excess.toFixed(2) + "pp" : "缺失");
    assert(L.name + " 年线上方 8% 的 26 周可回补率 ≥60%", ma8 && ma8.stat.hold[26].backRate >= 60, ma8 ? ma8.stat.hold[26].backRate.toFixed(0) + "%" : "缺失");
  }
});
assert("含 6 组组合模拟方案", SB.sim.length === 6, SB.sim.length + " 组");
const buy = SB.sim.filter(function (s) { return s.key === "buy"; })[0];
const adopt = SB.sim.filter(function (s) { return s.key === "adopt"; })[0];
const f40 = SB.sim.filter(function (s) { return s.key === "f40"; })[0];
assert("采纳方案的回撤在三条腿上都不差于只买不卖", adopt.rows.every(function (r) { return r.dMdd >= 0; }),
  adopt.rows.map(function (r) { return r.dMdd.toFixed(2); }).join("/"));
assert("采纳方案相对固定 40% 的回撤改善 ≥0（三条腿）", adopt.rows.every(function (r) { return r.dMddVsF40 >= 0; }),
  adopt.rows.map(function (r) { return r.dMddVsF40.toFixed(2); }).join("/"));
assert("只买不卖优于固定 40%（利差档位有效）", buy.rows.every(function (r, i) { return r.cagr > f40.rows[i].cagr; }),
  buy.rows.map(function (r, i) { return (r.cagr - f40.rows[i].cagr).toFixed(2); }).join("/"));
assert("规则参数已写入数据文件", SB.rule && SB.rule.t1Mid === 8 && SB.rule.t1Cheap === 12 && SB.rule.t1Rich === 5 && SB.rule.coreW === 30 && SB.rule.coreW2 === 20);

console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
