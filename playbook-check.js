// 「📋 个股操作手册」自检（playbook，2026-11-03）：
//   ① 页面骨架与四块内容（建仓档位 / 止盈阶梯 / 财报重估 / 现在做什么）齐备
//   ② 数学一致性：三批触发价 = 买点 ×1/0.92/0.85，止盈 T2/T3 = 卖出参考 ×1.10/1.20（与 expose 交叉验证）
//   ③ 财报重估分级（超预期·改善 / 低于预期·恶化 / 不可靠 / 符合预期）与持仓录入链路
//   ④ 隔离：其他 tab 不含本模块内容；无 undefined/NaN 泄漏
// 断言全部数据驱动（从 _playbookExpose / 当前行情反推期望值，不写死行情数字）。
const fs = require("fs");
const path = require("path");
const dir = __dirname;
const store = {};
global.document = {
  getElementById: (id) => store[id] || (store[id] = { id, innerHTML: "", style: {}, value: "", className: "", addEventListener() {}, appendChild() {}, querySelectorAll: () => [] }),
  querySelectorAll: () => [], querySelector: () => null, createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }), body: { appendChild() {} }
};
global.localStorage = { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = v; }, removeItem(k) { delete this._d[k]; } };
global.window = global; global.Blob = function () {}; global.FileReader = function () {};
global.location = { href: "", search: "" }; global.setTimeout = () => 0; global.requestAnimationFrame = () => 0;
["data.js", "data/lt.js", "data/valuation.js", "data/us.js", "data/asset.js", "data/divbt.js", "data/etf.js", "data/earnings.js", "app.js"].forEach(f => {
  eval(fs.readFileSync(path.join(dir, f), "utf8"));
});
let pass = 0, fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name + (extra ? "  [" + extra + "]" : "")); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  [" + extra + "]" : "")); }
}
const T = window._pbTools;
console.log("\n=== 个股操作手册自检 ===\n");

// ---------- 1. 页面骨架 ----------
window.showTab("playbook");
const H = store["playbook-body"].innerHTML;
assert("页面渲染非空", H.length > 3000, H.length + " 字符");
assert("含四块内容标题", ["建仓档位", "止盈阶梯", "财报重估", "现在做什么"].every(s => H.indexOf(s) >= 0));
assert("含口径声明（名单不是买卖信号）", H.indexOf("名单只是观察范围") >= 0 || H.indexOf("只代表观察范围") >= 0);
assert("nav 与 section 已注册", fs.readFileSync(path.join(dir, "index.html"), "utf8").indexOf("nav-playbook") >= 0
  && fs.readFileSync(path.join(dir, "index.html"), "utf8").indexOf('id="tab-playbook"') >= 0);
assert("tabs 数组含 playbook（showTab 可达）", typeof window._playbookExpose === "function");

const D = window._playbookExpose();
assert("入选名单非空", D.picks.length >= 1, D.picks.length + " 只");
assert("备选与财报锚就绪", Array.isArray(D.alts) && D.eAsOf && D.eAsOf !== "—", D.eAsOf);

// ---------- 2. 数学一致性 ----------
for (const p of D.picks) {
  const br = T.pbBuildRows(p);
  assert(p.name + " 三批触发价 = 买点 ×1/0.92/0.85",
    br.length === 3 &&
    Math.abs(br[0].p - p.buy) < 0.01 &&
    Math.abs(br[1].p - p.buy * 0.92) < 0.01 &&
    Math.abs(br[2].p - p.buy * 0.85) < 0.01,
    num2(br[0].p) + "/" + num2(br[1].p) + "/" + num2(br[2].p));
  assert(p.name + " 三批金额 = 目标×40/30/30",
    Math.abs(br[0].amt - p.amt * 0.4) < 0.01 && Math.abs(br[1].amt - p.amt * 0.3) < 0.01 && Math.abs(br[2].amt - p.amt * 0.3) < 0.01);
  if (p.hi) {
    const tr = T.pbTrimRows(p);
    assert(p.name + " 止盈阶梯 T1/T2/T3 = hi ×1/1.10/1.20",
      tr.length === 3 &&
      Math.abs(tr[0].p - p.hi) < 0.01 && Math.abs(tr[1].p - p.hi * 1.10) < 0.01 && Math.abs(tr[2].p - p.hi * 1.20) < 0.01,
      num2(tr[0].p) + "→" + num2(tr[2].p));
    assert(p.name + " 页面含 T2 价位（渲染与数据一致）", H.indexOf(num2(p.hi * 1.10)) >= 0);
  }
  // 页面含每只标的的买点
  assert(p.name + " 页面含其买点 " + num2(p.buy), H.indexOf(num2(p.buy)) >= 0);
}
const corePick = D.picks.find(p => p.core && p.hi);
assert("★核心资产 T3 留 1/3 长持（核心存在时）", !corePick || T.pbTrimRows(corePick)[2].act.indexOf("长持") >= 0,
  corePick ? corePick.name : "当前无核心入选");
const coreCard = corePick ? H.slice(H.indexOf(corePick.name)) : "";
if (corePick) assert("核心标的手册卡含「留 1/3 长持」", coreCard.slice(0, coreCard.indexOf("</div>") > 0 ? 8000 : 8000).indexOf("留 1/3 长持") >= 0 || H.indexOf("留 1/3 长持") >= 0);

// ---------- 3. 财报重估分级（单元） ----------
const ev1 = T.earningsVerdict({ q: "2026Q3", npYoY: 30, npQoQ: 5, vsCons: 12 });
assert("超预期+改善 → 上修结论", ev1.tag === "up" && ev1.label === "超预期·改善" && ev1.act.indexOf("不动买点") >= 0, ev1.label);
const ev2 = T.earningsVerdict({ q: "2026Q3", npYoY: -15, npQoQ: -5, vsCons: -11 });
assert("低于预期+恶化 → 逻辑预警", ev2.tag === "down" && ev2.act.indexOf("证伪") >= 0, ev2.label);
const ev3 = T.earningsVerdict({ q: "2026Q3", npYoY: 5, npQoQ: 2, vsCons: 0 });
assert("±5pp 内 → 符合预期", ev3.tag === "hold", ev3.label);
const ev4 = T.earningsVerdict({ q: "2026Q3", npYoY: 20, npQoQ: 5, vsCons: null });
assert("无机构预期覆盖 → 只看趋势", ev4.tag === "good" && ev4.act.indexOf("无年度一致预期") >= 0, ev4.label);
const ev5 = T.earningsVerdict({ q: "2026Q3", qUnreliable: true });
assert("差分不可靠 → 不参与重估", ev5.tag === "na" && ev5.act.indexOf("不参与重估") >= 0);
// 每只 pick 的财报结论都落在已知集合
assert("全部 pick 的财报标签合法", D.picks.every(p => !p.ev || ["up", "up2", "down", "down2", "weak", "good", "hold", "na"].indexOf(p.ev.tag) >= 0));

// ---------- 4. 持仓录入链路 ----------
assert("持仓录入输入框存在", H.indexOf("window._pbSetHold(") >= 0);
// 保存一只不在名单的持仓（如 sh600519）→ 出现「复核去留」区
window._pbSetHold("sh600519", "mv", 5);
window._pbSetHold("sh600519", "cost", 1500);
const D2 = window._playbookExpose();
assert("持仓保存后 outOfList 出现", D2.outOfList.some(o => o.code === "sh600519" && o.mv === 5),
  D2.outOfList.map(o => o.name).join(",") || "空");
window.showTab("playbook");
const H2 = store["playbook-body"].innerHTML;
assert("页面出现「已持仓但不在当前名单」复核区", H2.indexOf("已持仓但不在当前名单") >= 0);
assert("浮盈出现在录入表", /c-up|c-down/.test(H2));
// 在名单内的持仓 → 补仓额度
const pick1 = D2.picks[0];
window._pbSetHold(pick1.code, "mv", Math.max(0.1, (pick1.amt || 3) * 0.3));
window._pbSetHold(pick1.code, "cost", pick1.px);
const D3 = window._playbookExpose();
const p3 = D3.picks.find(x => x.code === pick1.code);
assert("名单内持仓记录被识别", p3.hold.has && p3.hold.mv > 0 && p3.hold.cost > 0, p3.name + " " + p3.hold.mv + "万");
assert("补仓额度 = 目标 − 持仓", Math.abs(p3.hold.room - (p3.amt - p3.hold.mv)) < 0.01, num2(p3.hold.room));
assert("−15% 复核线 = 成本 × 0.85", Math.abs(p3.hold.cutLine - p3.hold.cost * 0.85) < 0.01, num2(p3.hold.cutLine));
// 超配判定
window._pbSetHold(pick1.code, "mv", p3.amt * 2);
const D4 = window._playbookExpose();
assert("持仓 > 目标 1.5× → 超配标记", D4.picks.find(x => x.code === pick1.code).hold.over === true);
// 清理
window._pbSetHold(pick1.code, "mv", 0); window._pbSetHold(pick1.code, "cost", 0);
window._pbSetHold("sh600519", "mv", 0); window._pbSetHold("sh600519", "cost", 0);

// ---------- 5. 动作文案 ----------
const deepPick = D.picks.find(p => p.dist != null && p.dist < -25);
assert("深跌标的动作含「拉开 3 周」（存在时）", !deepPick || T.pbAction(deepPick, deepPick.hold, deepPick.ev).join("").indexOf("3 周") >= 0,
  deepPick ? deepPick.name + " " + num2(deepPick.dist) + "%" : "当前无深跌标的");
const buyPick = D.picks.find(p => p.state === "buy");
assert("已达买点标的动作含批次金额（存在时）", !buyPick || T.pbAction(buyPick, buyPick.hold, buyPick.ev).join("").indexOf("万") >= 0,
  buyPick ? buyPick.name : "当前无已达标");
assert("未到买点标的动作含条件单", D.picks.filter(p => p.state !== "buy").every(p => T.pbAction(p, p.hold, p.ev).join("").indexOf("条件单") >= 0),
  D.picks.filter(p => p.state !== "buy").map(p => p.name).join(",") || "全部已达");

// ---------- 6. 隔离与泄漏 ----------
window.showTab("plan");
assert("其他 tab 不含本模块内容", store["plan-body"].innerHTML.indexOf("建仓档位") < 0);
window.showTab("playbook");
const HF = store["playbook-body"].innerHTML;
assert("无 undefined/NaN 泄漏", HF.indexOf("undefined") < 0 && HF.indexOf("NaN") < 0);

console.log("\n结果：" + (fail ? "✗ " + fail + " 失败；" : "") + pass + " 通过 / " + fail + " 失败\n");
process.exit(fail ? 1 : 0);

function num2(v) { return Number(v).toFixed(2); }
