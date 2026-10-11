// 归档「推荐名单基线」并生成与上期的变动对比（data/baseline.js = window.IA_BASELINE）
// 用法: node gen-baseline.js
// 每日 18:00 由自动化运行（在 refresh-data.js 之后）：
//   1. 用当前数据（data.js 已刷新到当日收盘）计算四套名单：
//      picks  = 每日推荐四象限（steady/growth/rotate/tenx top-N）
//      formal = 建仓节奏「③ 股票端」正式名单 + 备选
//      usPicks= 美股四象限推荐名单
//      pool   = 筛选池成员（A股/港股 + 美股）
//   2. 与上一次归档对比，生成 changes（移入/移出 + 一句话原因，机械生成、保持简短）
//   3. 覆盖写出 data/baseline.js —— 它既是页面展示的变动来源，也是下一次对比的基线
const fs = require("fs");
const path = require("path");
const DIR = __dirname;

// ---------- 与 stock-check.js 相同的最小 DOM 引导 ----------
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
["data.js", "data/lt.js", "data/valuation.js", "data/us.js", "data/asset.js", "data/divbt.js", "data/divbt-sell.js", "data/etf.js", "app.js"].forEach(f => eval(fs.readFileSync(path.join(DIR, f), "utf8")));

const CAT_LABEL = { steady: "稳增长", growth: "高增长", rotate: "热点轮动", tenx: "十倍空间" };
const OUT = path.join(DIR, "data", "baseline.js");

// ---------- 计算本期名单 ----------
const P = window._picksExpose();
const picksLists = {};
for (const k of ["steady", "growth", "rotate", "tenx"]) {
  picksLists[k] = P[k].map(it => ({ code: it.s.code, name: it.s.name, reason: it.reason }));
}
const FSP = window._stockPickListExpose();
const formal = {
  picks: FSP.picks.map(o => ({ code: o.code, name: o.name, dist: +o.dist.toFixed(1), score: +o.score.toFixed(1) })),
  alts: FSP.alts.map(o => ({ code: o.code, name: o.name, dist: +o.dist.toFixed(1) }))
};
const U = window._usPicksExpose();
const usLists = {};
for (const k of ["steady", "growth", "rotate", "tenx"]) {
  usLists[k] = (U[k] || []).map(it => ({ code: it.s.code, name: it.s.name, reason: it.reason }));
}
const pool = {
  stocks: (window.STOCKS || []).map(s => ({ code: s.code, name: s.name, industry: s.industry })),
  us: (window.US_STOCKS || []).map(s => ({ code: s.code, name: s.name, industry: s.industry }))
};

// ---------- 读取上期基线 ----------
let prev = null;
const prevF = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
if (prevF) {
  const holder = {};                       // new Function 的 "window" 形参即 holder 本身
  try { new Function("window", prevF)(holder); prev = holder.IA_BASELINE || null; } catch (e) { prev = null; }
  if (!prev && holder.window && holder.window.IA_BASELINE) prev = holder.window.IA_BASELINE;
}

const today = new Date(); const pad = n => ("0" + n).slice(-2);
const asOf = today.getFullYear() + "-" + pad(today.getMonth() + 1) + "-" + pad(today.getDate());
const sameDay = !!(prev && prev.asOf === asOf);            // 同日重跑：保留当日已生成的变动，只刷新名单
const prevAsOf = prev ? (sameDay ? (prev.prevAsOf || null) : prev.asOf) : null;

// ---------- 生成变动与原因 ----------
function diffList(cur, old, keyFn, mkIn, mkOut) {
  const out = [];
  if (!old) return out;
  const curKeys = cur.map(keyFn), oldKeys = old.map(keyFn);
  for (const c of cur) if (oldKeys.indexOf(keyFn(c)) < 0) out.push(Object.assign({ dir: "in" }, mkIn(c)));
  for (const o of old) if (curKeys.indexOf(keyFn(o)) < 0) out.push(Object.assign({ dir: "out" }, mkOut(o)));
  return out;
}
const num = (v, d) => (v == null ? "—" : Number(v).toFixed(d == null ? 1 : d));

// ① 每日推荐四象限
const chPicks = [];
for (const k of ["steady", "growth", "rotate", "tenx"]) {
  const cur = picksLists[k], old = prev && prev.lists && prev.lists.picks ? prev.lists.picks[k] : null;
  if (!old) continue;
  const curC = cur.map(x => x.code), oldC = old.map(x => x.code);
  for (const c of cur) if (oldC.indexOf(c.code) < 0)
    chPicks.push({ dir: "in", scope: "picks", cat: k, tag: CAT_LABEL[k], name: c.name, reason: (c.reason || "象限内排序进入前列").slice(0, 60) });
  for (const o of old) if (curC.indexOf(o.code) < 0) {
    const a = window._stockAuditExpose(o.code);
    let reason;
    if (!a.exists) reason = "已移出筛选池（月度复核调整）";
    else {
      const last = cur[cur.length - 1];
      reason = "象限内排序跌出前 " + cur.length + " 名（本期末位：" + (last ? last.name : "无") + "）";
      if (a.dist != null && a.dist > 30) reason = "距老唐买点 +" + num(a.dist, 0) + "%，超出 30% 观察窗，优先级下降";
    }
    chPicks.push({ dir: "out", scope: "picks", cat: k, tag: CAT_LABEL[k], name: o.name, reason });
  }
}

// ② 正式名单（建仓节奏 ③ 股票端）
const chFormal = [];
if (prev && prev.lists && prev.lists.formal) {
  const curC = formal.picks.map(x => x.code), oldC = prev.lists.formal.picks.map(x => x.code);
  for (const c of formal.picks) if (oldC.indexOf(c.code) < 0)
    chFormal.push({ dir: "in", scope: "formal", tag: c.dist <= 0 ? "已达买点" : "进入观察窗", name: c.name, reason: "距老唐买点 " + (c.dist <= 0 ? "已跌进（" + num(c.dist, 1) + "%）" : "+" + num(c.dist, 1) + "%") + "，综合分 " + num(c.score) });
  for (const o of prev.lists.formal.picks) if (curC.indexOf(o.code) < 0) {
    const a = window._stockAuditExpose(o.code);
    let reason;
    if (!a.exists) reason = "已移出筛选池（月度复核调整）";
    else if (a.premise && a.premise.length) reason = "触发三大前提剔除：" + a.premise[0];
    else if (a.dist != null && a.dist > 30) reason = "距老唐买点 +" + num(a.dist, 0) + "%，超出 30% 观察窗（26 周内够不着）";
    else if (a.score < 6.5) reason = "综合分 " + num(a.score) + " 低于 6.5 门槛";
    else if (a.moat < 6.5) reason = "护城河 " + num(a.moat) + " 低于象限门槛";
    else reason = "象限配额内被反超，转入备选池（距买点 +" + num(a.dist, 1) + "%）";
    chFormal.push({ dir: "out", scope: "formal", name: o.name, reason });
  }
}

// ③ 美股四象限
const chUs = [];
for (const k of ["steady", "growth", "rotate", "tenx"]) {
  const cur = usLists[k], old = prev && prev.lists && prev.lists.usPicks ? prev.lists.usPicks[k] : null;
  if (!old) continue;
  const curC = cur.map(x => x.code), oldC = old.map(x => x.code);
  for (const c of cur) if (oldC.indexOf(c.code) < 0)
    chUs.push({ dir: "in", scope: "us", tag: CAT_LABEL[k], name: c.name, reason: (c.reason || "象限内排序进入前列").slice(0, 60) });
  for (const o of old) if (curC.indexOf(o.code) < 0) {
    const last = cur[cur.length - 1];
    chUs.push({ dir: "out", scope: "us", tag: CAT_LABEL[k], name: o.name, reason: "象限内排序跌出前 " + cur.length + " 名（本期末位：" + (last ? last.name : "无") + "）" });
  }
}

// ④ 筛选池成员（月度复核才会变）
const chPool = [];
if (prev && prev.lists && prev.lists.pool) {
  for (const mkt of ["stocks", "us"]) {
    const cur = pool[mkt], old = prev.lists.pool[mkt] || [];
    const curC = cur.map(x => x.code), oldC = old.map(x => x.code);
    for (const c of cur) if (oldC.indexOf(c.code) < 0)
      chPool.push({ dir: "in", scope: "pool", mkt: mkt === "us" ? "US" : "AH", name: c.name, reason: "月度复核新入池（" + (c.industry || "—") + "），详见当日日报" });
    for (const o of old) if (curC.indexOf(o.code) < 0)
      chPool.push({ dir: "out", scope: "pool", mkt: mkt === "us" ? "US" : "AH", name: o.name, reason: "月度复核移出池，详见当日日报" });
  }
}

// ---------- 写出基线 ----------
const B = {
  version: 1, asOf, prevAsOf,
  lists: { picks: picksLists, formal, usPicks: usLists, pool },
  changes: sameDay ? (prev.changes || { picks: [], formal: [], us: [], pool: [] })
                   : { picks: chPicks, formal: chFormal, us: chUs, pool: chPool }
};
const js = "// 名单归档基线 + 与上期变动（gen-baseline.js 自动生成，每日 18:00 覆盖；请勿手改）\n" +
  "window.IA_BASELINE = " + JSON.stringify(B, null, 1) + ";\n";
fs.writeFileSync(OUT, js, "utf8");

const n = arr => arr.length;
console.log("基线归档 " + asOf + "（上期 " + (prevAsOf || "无") + "）：");
console.log("  每日推荐变动 " + n(chPicks) + " 条 · 正式名单变动 " + n(chFormal) + " 条 · 美股变动 " + n(chUs) + " 条 · 池子变动 " + n(chPool) + " 条");
for (const c of chPicks.concat(chFormal, chUs, chPool)) {
  console.log("  " + (c.dir === "in" ? "▲ 移入" : "▽ 移出") + " " + c.name + (c.tag ? " [" + c.tag + "]" : "") + " —— " + c.reason);
}

// ---------- 归档当日数据快照（历史数据按日期回看的生成端） ----------
// 挂在基线写出之后，保证快照里的名单是当日最新归档；失败不影响基线主流程。
try { require("./archive-snap.js").archive(); }
catch (e) { console.error("快照归档失败（不影响基线）: " + e.message); }
