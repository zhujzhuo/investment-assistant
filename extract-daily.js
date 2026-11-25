// 日报数据提取（一次性脚本，不入测试套件）
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
["data.js", "data/lt.js", "data/valuation.js", "data/us.js", "data/asset.js", "data/etf.js", "data/divbt.js", "data/index.js", "app.js"].forEach(f => eval(fs.readFileSync(f, "utf8")));

window._setValMode("band");
const SPL = window._stockPickListExpose();
const PS = window._planState();
const out = {};

out.rfUS = window.MKT ? (window.MKT.rfUS) : null;
out.asOfA = window.MKT ? window.MKT.asOfA : null;
out.asOfHK = window.MKT ? window.MKT.asOfHK : null;

// 正式名单
out.formal = (SPL && SPL.picks || []).map(o => ({
  code: o.code, name: o.name, px: o.px, catKey: o.catKey, score: Math.round(o.score * 10) / 10,
  moat: o.s && o.s.moat, mid: o.mid, buy: o.buy, hi: o.hi, dist: Math.round(o.dist * 10) / 10,
  div: o.div, pe: o.pe, core: o.core
}));

// 备选（候选未入正式名单的：观察窗内但没进配额的）——用 plan 页渲染文本反推较繁，跳过，改用全池 audit
out.audit = {};
["sh600519","sz300750","sh601899","sh600036","sz002415","sz000333","sh603259","sz300274","hk00700","hk09992","hk06181","sh600887","sh601318","sh600900","sz000651","sh688981","sz002594","sh600276","sz300760","sz000568","sz000858"].forEach(c => {
  const a = window._stockAuditExpose(c);
  if (a && a.exists !== false) out.audit[c] = { name: a.name, dist: a.dist != null ? Math.round(a.dist * 10) / 10 : null, score: a.score != null ? Math.round(a.score * 10) / 10 : null, moat: a.moat, premise: a.premise || null };
});

// planState 关键字段
function rnd(v, n) { return v == null ? null : Math.round(v * Math.pow(10, n || 2)) / Math.pow(10, n || 2); }
out.plan = {
  w: PS.w, base: PS.base, add: PS.add, why: PS.why,
  tilt: PS.tilt,
  csi: { px: PS.csi.px, dy: PS.csi.dy, spread: PS.csi.spread, ma250: PS.csi.ma250, distMA: PS.csi.distMA, wkMid: PS.csi.wkMid, wkLow: PS.csi.wkLow, wkUp: PS.csi.wkUp, distWkMid: PS.csi.distWkMid, distWkLow: PS.csi.distWkLow, rsi: PS.csi.rsi },
  lowvol: { px: PS.lowvol.px, dy: PS.lowvol.dy, spread: PS.lowvol.spread, ma250: PS.lowvol.ma250, distMA: PS.lowvol.distMA, wkMid: PS.lowvol.wkMid, wkLow: PS.lowvol.wkLow, wkUp: PS.lowvol.wkUp, distWkMid: PS.lowvol.distWkMid, distWkLow: PS.lowvol.distWkLow, rsi: PS.lowvol.rsi },
  nas: { peEff: PS.nas.peEff, distMA250: PS.nas.distMA250, rsi14: PS.nas.rsi14, pos52: PS.nas.pos52, px: PS.nas.px },
  nasLv: PS.nasLv, nasNote: PS.nasNote,
  trim: { cap: PS.trim.cap, floor: PS.trim.floor, raw: PS.trim.raw, cut: PS.trim.cut, csi: PS.trim.csi, lowvol: PS.trim.lowvol },
  alerts: PS.alerts,
  exec: PS.exec
};

// ETF 参考价
try {
  const etfRaw = fs.readFileSync("data/etf.js", "utf8");
  const m = etfRaw.match(/window\.ETF_DATA\s*=\s*(\{[\s\S]*?\});?\s*$/);
  eval("var ETF_DATA=" + (m ? m[1] : "null"));
  out.etfAsOf = (window.ETF_DATA && window.ETF_DATA.asOf) || null;
  out.etf = {};
  if (window.ETF_DATA && window.ETF_DATA.items) for (const k in window.ETF_DATA.items) { const it = window.ETF_DATA.items[k]; out.etf[k] = { px: it.px, chg: it.chg }; }
} catch (e) { out.etfErr = String(e); }

// divbt（买入侧回测 + 中性/乐观年化）
try {
  const db = window.DIVBT || (window.DIVBT_DATA || null);
  if (db) out.divbt = { asOf: db.asOf, summary: db.summary || db.stats || null, keys: Object.keys(db) };
} catch (e) {}

console.log(JSON.stringify(out, null, 1));
