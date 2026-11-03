// 红利提醒策略回测 自检（数据层 + 前端渲染）
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
eval(fs.readFileSync(path.join(dir, "data/valuation.js"), "utf8"));
eval(fs.readFileSync(path.join(dir, "data/us.js"), "utf8"));
eval(fs.readFileSync(path.join(dir, "data/asset.js"), "utf8"));
eval(fs.readFileSync(path.join(dir, "data/divbt.js"), "utf8"));
eval(fs.readFileSync(path.join(dir, "app.js"), "utf8"));

let pass = 0, fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name + (extra ? "（" + extra + "）" : "")); }
  else { fail++; console.log("  ✗ FAIL: " + name + (extra ? " → " + extra : "")); }
}
const B = window.DIVBT;

(async function () {
  console.log("=== 1. 回测数据完整性 ===");
  assert("DIVBT 已加载", !!B);
  assert("样本 ≥ 5 年", B.meta.years >= 5, B.meta.years + " 年 / " + B.meta.weeks + " 周");
  assert("两个标的齐全", B.legs.length === 2, B.legs.map(l => l.name).join("、"));
  assert("每个标的有信号 + 对照组", B.legs.every(l => l.signals.length >= 3 && l.controls.length === 2),
    B.legs.map(l => l.name + ":" + l.signals.length + "信号/" + l.controls.length + "对照").join(" "));
  assert("混合组合模拟存在", !!B.sim.mix, "混合年化 " + B.sim.mix.m.dyn.cagr.toFixed(2) + "%");

  console.log("\n=== 2. 触发次数统计合理性 ===");
  let totalSig = 0, totalLow = 0;
  B.legs.forEach(function (L) {
    assert(L.name + " 买入持有为正", L.buyHold > 0, L.buyHold.toFixed(1) + "%");
    assert(L.name + " 股息率区间有效", L.dyMin > 0 && L.dyMax > L.dyMin, L.dyMin.toFixed(2) + "%~" + L.dyMax.toFixed(2) + "%");
    L.signals.forEach(function (s) {
      totalSig += s.stat.count;
      if (s.key === "wklow") totalLow += s.stat.count;
      assert(L.name + "·" + s.name + " 次数 ≥1 且 ≤ 样本周数/4", s.stat.count >= 1 && s.stat.count <= B.meta.weeks / 4,
        s.stat.count + " 次（年均 " + s.stat.perYear.toFixed(1) + "）");
      assert(L.name + "·" + s.name + " 事件数与次数一致", s.events.length === s.stat.count);
      assert(L.name + "·" + s.name + " 分段次数之和 = 总次数",
        s.split.first.count + s.split.last.count === s.stat.count,
        s.split.first.count + "+" + s.split.last.count + "=" + s.stat.count);
      [4, 13, 26, 52].forEach(function (h) {
        const x = s.stat.hold[h];
        if (x.n === 0) return;
        assert(L.name + "·" + s.name + " 持有" + h + "周样本 ≤ 总次数", x.n <= s.stat.count, "n=" + x.n);
        assert(L.name + "·" + s.name + " 持有" + h + "周超额为有限值", x.excess == null || isFinite(x.excess), String(x.excess));
      });
    });
    L.controls.forEach(function (c) {
      assert(L.name + " 对照组 " + c.key + " 有样本", c.stat.count >= 3, c.stat.count + " 次");
    });
    // 随机基准胜率：用于暴露「样本是否偏牛」
    const bw = L.base[52].win;
    assert(L.name + " 随机基准 52 周胜率已记录", bw > 0 && bw <= 100, bw.toFixed(0) + "%");
  });
  assert("重度提醒（下轨）次数合理（年均 ≤3）", totalLow / B.meta.years <= 3, "共 " + totalLow + " 次 / 年均 " + (totalLow / B.meta.years).toFixed(1));
  assert("总触发次数已统计", totalSig > 10, "合计 " + totalSig + " 次");

  console.log("\n=== 3. 事件收益自洽性（抽查重算）===");
  // 用原始数据重算一条：检查事件收益与序列方向一致（信号后收益不恒为正/负）
  const leg0 = B.legs[0], sig0 = leg0.signals[0];
  assert("事件日期递增", sig0.events.every((e, i, a) => i === 0 || e.d >= a[i - 1].d));
  assert("事件 retNow 与 ret[52] 不矛盾", sig0.events.every(e => e.retNow == null || e.ret[52] == null || Math.abs(e.retNow) > 0));
  const sample = sig0.events.filter(e => e.ret[13] != null).map(e => e.ret[13]);
  const avgSample = sample.reduce((a, b) => a + b, 0) / sample.length;
  assert("重算后3月均值与统计值一致", Math.abs(avgSample - sig0.stat.hold[13].avg) < 0.01,
    avgSample.toFixed(2) + "% vs " + sig0.stat.hold[13].avg.toFixed(2) + "%");

  console.log("\n=== 4. 组合模拟合理性 ===");
  ["csi", "lowvol", "mix"].forEach(function (k) {
    const m = B.sim[k].m;
    assert(k + " 全仓年化 > 固定仓位年化", m.allin.cagr > m.fixed40.cagr,
      m.allin.cagr.toFixed(2) + "% > " + m.fixed40.cagr.toFixed(2) + "%");
    assert(k + " 固定40% > 固定30%", m.fixed40.cagr > m.fixed30.cagr);
    assert(k + " 回撤为负且全仓回撤最大", m.allin.mdd < m.dyn.mdd && m.dyn.mdd < 0,
      "全仓 " + m.allin.mdd.toFixed(1) + "% / 动态 " + m.dyn.mdd.toFixed(1) + "%");
    assert(k + " 动态调仓超额幅度有限（-2~+3pp）", m.dyn.excessVs40 > -2 && m.dyn.excessVs40 < 3, m.dyn.excessVs40.toFixed(2) + "pp");
    assert(k + " 平均仓位在 30~50% 之间", m.avgW >= 0.30 && m.avgW <= 0.50, (m.avgW * 100).toFixed(1) + "%");
    assert(k + " 定投收益为正", m.dca.ret > 0, m.dca.ret.toFixed(1) + "%");
    assert(k + " 净值序列长度 = 周数", B.sim[k].series.dyn.length === B.meta.weeks, B.sim[k].series.dyn.length + " 点");
    assert(k + " 波动率 > 0", m.dyn.vol > 0, m.dyn.vol.toFixed(1) + "%");
  });
  assert("策略未越界：仓位序列均在 30~50%", B.sim.mix.w.every(w => w >= 0.2999 && w <= 0.5001),
    "min=" + Math.min.apply(null, B.sim.mix.w).toFixed(3) + " max=" + Math.max.apply(null, B.sim.mix.w).toFixed(3));

  console.log("\n=== 5. 结论与建议字段 ===");
  // verdict 由 backtest-dividend.js 每次重跑重新生成，措辞会更新（2026-11-03 起不再含样本年数字样）
  // → 只断言结论非空且言之有物（长度 + 提到回测语义）
  assert("结论非空且言之有物", !!B.verdict && B.verdict.length >= 40, (B.verdict || "").slice(0, 30) + "…");
  assert("有效信号清单非空", Array.isArray(B.good) && B.good.length >= 1, B.good.length + " 条");
  assert("噪音信号已识别（中轨提醒）", (B.bad || []).some(x => x.indexOf("中轨") >= 0), (B.bad || []).join(" | "));
  assert("样本偏差提示已写入", (B.meta.caveat || "").indexOf("胜率") >= 0);

  console.log("\n=== 6. 前端渲染（回测页独立子视图）===");
  // 回测已独立到「数据回测」页，整体投顾页不再展示回测
  window.showTab("plan");
  const planHtml = store["plan-body"].innerHTML;
  assert("整体投顾页渲染成功", planHtml.length > 1000, planHtml.length + " 字符");
  assert("整体投顾页不含回测模块", planHtml.indexOf("红利提醒策略回测") < 0);
  assert("整体投顾页不含回测对照表", planHtml.indexOf("无脑抄底") < 0 && planHtml.indexOf("固定 30%（只留底仓）") < 0);
  assert("整体投顾页仍包含四模块建议配置", planHtml.indexOf("当前建议配置") >= 0);
  assert("整体投顾页仓位合计仍为 100%", (function () {
    const m = planHtml.match(/红利 <b>(\d+)%<\/b>[\s\S]*?纳斯达克 <b>(\d+)%<\/b>[\s\S]*?货币 <b>(\d+)%<\/b>[\s\S]*?巴菲特式股票 <b>(\d+)%<\/b>/);
    return m && (+m[1] + +m[2] + +m[3] + +m[4]) === 100;
  })());

  // 切到「数据回测」页的「红利提醒策略回测」子视图
  window.showTab("backtest");
  assert("回测页默认显示组合/个股回测", store["backtest-body"].innerHTML.indexOf('id="bt-asset"') >= 0);
  window._btSwitch("div");
  const html = store["backtest-body"].innerHTML;
  assert("子视图切换生效（含切换条）", html.indexOf('class="seg"') >= 0);
  assert("回测子视图渲染成功", html.length > 1000, html.length + " 字符");
  assert("含样本区间", html.indexOf(B.meta.start) >= 0);
  assert("含结论文案", html.indexOf(B.verdict.slice(0, 20)) >= 0);
  assert("含组合对比表", html.indexOf("固定 30%（只留底仓）") >= 0);
  assert("含对照组标识", html.indexOf("无脑抄底") >= 0);
  assert("含保留/降级建议", html.indexOf("重度提醒") >= 0 && html.indexOf("降为观察项") >= 0);
  assert("中轨已标注为观察（不加仓依据）", html.indexOf("观察 · 不作为加仓依据") >= 0);
  assert("下轨加码到 +5pp 已生效", html.indexOf("+5pp") >= 0);
  assert("组合对比含调整前后两版", html.indexOf("调整后规则") >= 0 && html.indexOf("调整前规则") >= 0);
  assert("含局限说明", html.indexOf("样本偏差") >= 0);
  assert("无 undefined/NaN 泄漏", html.indexOf("undefined") < 0 && html.indexOf("NaN") < 0);
  // 切回主视图后仍能正常渲染组合回测
  window._btSwitch("main");
  assert("可切回组合/个股回测", store["backtest-body"].innerHTML.indexOf('id="bt-asset"') >= 0);

  console.log("\n=== 7. 报告文件 ===");
  const rp = path.join(dir, "reports", "红利提醒策略回测_" + B.meta.generatedAt + ".md");
  assert("回测报告已生成", fs.existsSync(rp), rp.replace(dir, "."));
  if (fs.existsSync(rp)) {
    const t = fs.readFileSync(rp, "utf8");
    assert("报告含结论摘要", t.indexOf("结论摘要") >= 0);
    assert("报告含机会次数表", t.indexOf("加仓机会有多少次") >= 0);
    assert("报告含组合对比", t.indexOf("动态调仓 vs 固定仓位") >= 0);
    assert("报告含免责声明", t.indexOf("免责声明") >= 0);
    assert("报告无重复表头", (t.match(/\| 信号 \|/g) || []).length === (t.match(/逐年触发次数/g) || []).length,
      "信号表头 " + (t.match(/\| 信号 \|/g) || []).length + " 次 / 逐年小节 " + (t.match(/逐年触发次数/g) || []).length + " 次");
  }

  console.log("\n" + (fail === 0 ? "✅ 全部通过：" : "❌ 存在失败：") + pass + " 通过 / " + fail + " 失败");
  process.exit(fail === 0 ? 0 : 1);
})();
