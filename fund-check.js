// 建仓节奏（周维度）独立页自检 —— 数据层 + 前端渲染
const fs = require("fs");
const path = require("path");
const dir = __dirname;
const store = {};
let LS = {};
global.localStorage = {
  getItem(k) { return Object.prototype.hasOwnProperty.call(LS, k) ? LS[k] : null; },
  setItem(k, v) { LS[k] = String(v); }
};
const { URL: RU } = require("url");
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
RU.createObjectURL = function () { return "blob:x"; };
global.URL = RU;
global.FileReader = class { readAsText() {} };
global.location = { protocol: "https:" };

["data.js", "data/valuation.js", "data/us.js", "data/asset.js", "data/divbt.js", "app.js"].forEach(function (f) {
  eval(fs.readFileSync(path.join(dir, f), "utf8"));
});

let pass = 0, fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name + (extra ? "（" + extra + "）" : "")); }
  else { fail++; console.log("  ✗ FAIL: " + name + (extra ? " → " + extra : "")); }
}
const near = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 0.05 : eps);
const strip = (h) => h.replace(/<br>/g, " | ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/\s+/g, " ");

console.log("=== 1. 页面拆分：整体投顾保持干爽 ===");
window.showTab("plan");
const planHtml = store["plan-body"].innerHTML;
const planTxt = strip(planHtml);
assert("投顾页不含资金落地模块", planTxt.indexOf("资金落地") < 0, planTxt.indexOf("资金落地") >= 0 ? "仍残留" : "");
assert("投顾页不含建仓节奏字样", planTxt.indexOf("建仓节奏") < 0);
assert("投顾页不含周时间表", planHtml.indexOf("本周投入") < 0 && planHtml.indexOf("W1") < 0);
assert("投顾页仍含四模块建议配置", planTxt.indexOf("当前建议配置") >= 0);
assert("投顾页仍不含回测模块", planTxt.indexOf("红利提醒策略回测") < 0);
window.showTab("fund");
const fundHtml = store["fund-body"].innerHTML;
const fundTxt = strip(fundHtml);
assert("建仓节奏页已渲染", fundHtml.length > 1500, fundHtml.length + " 字符");
assert("建仓节奏页含标题", fundTxt.indexOf("建仓节奏") >= 0);
assert("建仓节奏页含免责声明", fundTxt.indexOf("不构成投资建议") >= 0);

console.log("\n=== 2. 周维度（而非月维度）===");
assert("标题标注按周执行", fundTxt.indexOf("按周执行") >= 0);
assert("时间表以周次为单位", fundHtml.indexOf("W1<br>") >= 0 && fundHtml.indexOf("W12<br>") >= 0);
assert("表头为「周次 / 本周投入」", fundTxt.indexOf("周次") >= 0 && fundTxt.indexOf("本周投入") >= 0);
assert("无「本月投入 / 月份」旧表头", fundTxt.indexOf("本月投入") < 0 && fundHtml.indexOf("<th>月份</th>") < 0);
const wkRe = /<tr><td class="small">W(\d+)<br><span class="muted">(\d{1,2}\/\d{2})<\/span><\/td>/g;
const wkLabels = [];
let wkM;
while ((wkM = wkRe.exec(fundHtml)) !== null) wkLabels.push({ wk: +wkM[1], d: wkM[2] });
assert("逐周行连续 W1~W12", wkLabels.length === 12 && wkLabels.every((x, i) => x.wk === i + 1), wkLabels.map(x => "W" + x.wk).join(","));
assert("每周带起始日期", wkLabels.every(x => /^\d{1,2}\/\d{2}$/.test(x.d)), wkLabels[0] && wkLabels[0].d);
// 相邻周日期间隔 7 天（W12 落在次年 1 月，需先把日期序列整体换算再比较，否则跨年会算出负间隔）
let gapOk = true, yearCursor = 2026, prevMon = null;
const wkDates = wkLabels.map(function (x) {
  const p = x.d.split("/"), m = Number(p[0]), d = Number(p[1]);
  if (prevMon != null && m < prevMon) yearCursor++;
  prevMon = m;
  return new Date(yearCursor, m - 1, d);
});
for (let i = 1; i < wkDates.length; i++) {
  const g = (wkDates[i] - wkDates[i - 1]) / 86400000;
  if (Math.abs(g - 7) > 1) gapOk = false;
}
assert("相邻周间隔 7 天", gapOk, wkLabels[0].d + " → " + wkLabels[1].d);

console.log("\n=== 3. 资金拆分守恒（300 万）===");
const capDefault = (function () {
  const m = fundHtml.match(/value="(\d+)"\s+onchange="window\._setCap/);
  return m ? Number(m[1]) : null;
})();
assert("输入框默认值为 300", capDefault === 300, String(capDefault));
const tm = fundTxt.match(/红利 (\d+) 万 （(\d+)%）· 纳斯达克 ([\d.]+) 万 （(\d+)%）· 巴菲特式股票 ([\d.]+) 万 （(\d+)%）· 货币弹药 ([\d.]+) 万 （(\d+)%）/);
assert("解析出四模块金额", !!tm, tm ? tm.slice(1).join("/") : "未匹配");
if (tm) {
  const a = [Number(tm[1]), Number(tm[3]), Number(tm[5]), Number(tm[7])];
  const p = [Number(tm[2]), Number(tm[4]), Number(tm[6]), Number(tm[8])];
  assert("四模块金额合计 = 本金", near(a.reduce((x, y) => x + y, 0), 300, 1), a.join("+"));
  assert("四模块占比合计 = 100%", p.reduce((x, y) => x + y, 0) === 100, p.join("+"));
  assert("金额与占比一致", near(a[0], 300 * p[0] / 100, 1) && near(a[1], 300 * p[1] / 100, 1));
  assert("纳指 = 20% / 股票 = 10%", p[1] === 20 && p[2] === 10, p[1] + "/" + p[2]);
  assert("红利在 30~50 区间", p[0] >= 30 && p[0] <= 50, p[0] + "%");
}

console.log("\n=== 4. 周度时间表自洽 ===");
const rowRe = /<tr><td class="small">W(\d+)<br><span class="muted">[\d/]+<\/span><\/td><td>([\d.]+)<\/td><td>([\d.]+)<\/td><td>([\d.]+)<\/td><td><b>([\d.]+)<\/b><\/td><td>([\d.]+)<\/td><td>([\d.]+)<\/td>/g;
const rows = [];
let mm;
while ((mm = rowRe.exec(fundHtml)) !== null) {
  rows.push({ wk: +mm[1], div: +mm[2], nas: +mm[3], stk: +mm[4], wkAmt: +mm[5], cum: +mm[6], cash: +mm[7] });
}
assert("解析出 12 周明细行", rows.length === 12, rows.length + " 行");
if (rows.length === 12) {
  assert("每周投入 = 红利+纳指+股票", rows.every(r => near(r.wkAmt, r.div + r.nas + r.stk, 0.15)), "显示层保留 1 位，容许 ±0.15");
  assert("剩余货币 = 300 − 累计投入", rows.every(r => near(r.cash, 300 - r.cum, 0.15)));
  let c = 0, cumOk = true;
  rows.forEach(r => { c += r.wkAmt; if (Math.abs(c - r.cum) > 0.6) cumOk = false; });   // 显示层保留 1 位，允许舍入累积
  assert("累计投入逐周累加正确", cumOk, "W12 累计 " + rows[11].cum + " / 逐周相加 " + c.toFixed(1));
  assert("纳指每周等额（匀速定投）", near(Math.max.apply(null, rows.map(r => r.nas)), Math.min.apply(null, rows.map(r => r.nas)), 0.1), rows[0].nas + " 万/周");
  assert("首周红利最大（首周 2/9）", rows[0].div > rows[1].div, "W1 " + rows[0].div + " > W2 " + rows[1].div);
}
const segRe = /<tr class="muted"><td class="small wrapcol">W(\d+)~W(\d+)<br><span class="muted">([^<]*)<\/span><\/td><td>([\d.—]+)<\/td><td>([\d.]+)<\/td><td>([\d.—]+)<\/td><td><b>([\d.]+)<\/b><\/td><td>([\d.]+)<\/td><td>([\d.]+)<\/td>/g;
const segs = [];
let sm;
while ((sm = segRe.exec(fundHtml)) !== null) segs.push({ a: +sm[1], b: +sm[2], tag: sm[3], amt: +sm[7], cum: +sm[8], cash: +sm[9] });
assert("含 3 段汇总行（W13~W14 / W15~W26 / W27~W78）", segs.length === 3, segs.map(s => "W" + s.a + "~W" + s.b).join(" "));
if (segs.length === 3 && rows.length === 12) {
  assert("汇总段周次连续衔接", segs[0].a === 13 && segs[1].a === 15 && segs[1].b === 26 && segs[2].a === 27 && segs[2].b === 78, segs.map(s => s.a + "-" + s.b).join(","));
  assert("汇总段累计单调不减", segs.every((s, i) => s.cum > (i === 0 ? rows[11].cum : segs[i - 1].cum)), segs.map(s => s.cum).join(","));
  const last = segs[2];
  assert("末期累计 + 货币 = 本金", near(last.cum + last.cash, 300, 0.5), last.cum + "+" + last.cash);
  if (tm) {
    const tgt = [Number(tm[1]), Number(tm[3]), Number(tm[5])];
    assert("末期投入 = 目标三模块合计", near(last.cum, tgt[0] + tgt[1] + tgt[2], 0.5), last.cum + " vs " + (tgt[0] + tgt[1] + tgt[2]));
  }
}
const tailM = fundTxt.match(/第 (\d+) 周（[\d/]+ 当周）全部到位：红利 ([\d.]+) \+ 纳指 ([\d.]+) \+ 股票 ([\d.]+) = ([\d.]+) 万.*?货币 ([\d.]+) 万/);
assert("含末期四模块金额说明", !!tailM, tailM ? tailM.slice(1).join("/") : "未匹配");
if (tailM) {
  assert("末期三项合计 = 累计", near(Number(tailM[5]), Number(tailM[2]) + Number(tailM[3]) + Number(tailM[4]), 0.1));
  assert("期末周次 = 78", Number(tailM[1]) === 78, tailM[1]);
  assert("末期货币 = 弹药池（27%）", near(Number(tailM[6]), 300 - Number(tailM[5]), 0.2), tailM[6] + " 万");
}

console.log("\n=== 5. 四层拆分与应对分支 ===");
assert("含底仓/估值仓/信号仓/弹药仓四层", ["底仓", "估值仓", "信号仓", "弹药仓"].every(k => fundTxt.indexOf(k) >= 0));
assert("四层「何时投」为周表述（信号仓待触发）", /第 1~8 周/.test(fundTxt) && /第 9~14 周/.test(fundTxt) && (fundTxt.indexOf("待技术信号触发才投") >= 0 || /第 3~4 周/.test(fundTxt)), "底仓/估值仓/信号仓");
assert("弹药仓以 52 周为兜底", /52 周未触发则按利差档位补足/.test(fundTxt));
assert("说明为何不一次买满（纳指位置高）", fundTxt.indexOf("不要一次性买满") >= 0 && fundTxt.indexOf("52 周位置") >= 0);
assert("纳指定投以周为单位", /78 周/.test(fundTxt) && /每周约 [\d.]+ 万/.test(fundTxt));
assert("股票端给出参考周数", /26 周内/.test(fundTxt) && fundTxt.indexOf("买点触发价") >= 0);
assert("含三种行情应对（先涨/先跌/横盘）", ["先涨", "先跌", "横盘"].every(k => fundTxt.indexOf(k) >= 0));
assert("先跌分支提到弹药仓分批", /弹药仓 [\d.]+ 万 分 3 批/.test(fundTxt));
assert("横盘分支改为周度执行", /严格按上表周度执行/.test(fundTxt));

console.log("\n=== 6. 数值健康度 ===");
assert("无 undefined/NaN 泄漏", fundHtml.indexOf("undefined") < 0 && fundHtml.indexOf("NaN") < 0);
assert("无负金额", !/-\d+\.\d 万/.test(fundTxt));
const expB = fundTxt.match(/建仓期前 52 周（1 年）年化约 ([\d.]+)%/);
const expS = fundTxt.match(/稳态（第 78 周后）中性 ([\d.]+)%、乐观 ([\d.]+)%/);
assert("建仓期年化在 0~10%", expB && Number(expB[1]) > 0 && Number(expB[1]) < 10, expB && expB[1] + "%");
assert("稳态中性 < 乐观", expS && Number(expS[1]) < Number(expS[2]), expS && expS[1] + "% vs " + expS[2] + "%");
assert("建仓期年化 < 稳态中性（现金拖累）", expB && expS && Number(expB[1]) < Number(expS[1]), expB && expB[1] + " < " + expS[1]);
assert("纪律清单为周频", /每周固定一天投纳指/.test(fundTxt) && /每 13 周/.test(fundTxt));

console.log("\n=== 7. 本金可切换（100 万 / 1000 万）===");
[100, 1000].forEach(function (v) {
  window._setCap(v);
  const h2 = store["fund-body"].innerHTML;
  const t2 = strip(h2);
  const m2 = t2.match(/本金 (\d+) 万 → 目标配置/);
  assert("本金切换为 " + v + " 万生效", m2 && Number(m2[1]) === v, m2 ? m2[1] : "未匹配");
  const rows2 = [];
  const re2 = /<tr><td class="small">W(\d+)<br><span class="muted">[\d/]+<\/span><\/td><td>([\d.]+)<\/td><td>([\d.]+)<\/td><td>([\d.]+)<\/td><td><b>([\d.]+)<\/b><\/td><td>([\d.]+)<\/td><td>([\d.]+)<\/td>/g;
  let m3;
  while ((m3 = re2.exec(h2)) !== null) rows2.push(+m3[6]);
  assert("本金 " + v + " 万时 12 周累计单调且不超本金", rows2.length === 12 && rows2[11] < v && rows2.every((x, i) => i === 0 || x > rows2[i - 1]), rows2[11] + " < " + v);
  assert("本金 " + v + " 万无 NaN", h2.indexOf("NaN") < 0 && h2.indexOf("undefined") < 0);
});
window._setCap(300);
assert("本金重置回 300 后页面恢复", strip(store["fund-body"].innerHTML).indexOf("本金 300 万") >= 0);

console.log("\n=== 8. 与其它模块共存 ===");
window.showTab("plan");
assert("投顾页渲染不受影响", store["plan-body"].innerHTML.indexOf("当前建议配置") >= 0);
window.showTab("backtest");
assert("策略回测页未受影响", store["backtest-body"].innerHTML.indexOf('id="bt-asset"') >= 0);
window._btSwitch("div");
assert("回测子视图仍可渲染", store["backtest-body"].innerHTML.indexOf("红利提醒策略回测") >= 0);
window._btSwitch("main");
window.showTab("fund");
assert("返回建仓节奏页仍正常", store["fund-body"].innerHTML.indexOf("建仓节奏") >= 0);

console.log("\n" + (fail === 0 ? "✅ 全部通过：" : "❌ 存在失败：") + pass + " 通过 / " + fail + " 失败");
process.exit(fail === 0 ? 0 : 1);
