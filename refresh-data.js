// 刷新 data.js 的行情快照（价格/涨跌/PE/PB/股息/市值/52周/年内/三大指数/asOf 日期）
// 用法: node refresh-data.js
// 数据源：provider.js 适配层 —— 本地 westock CLI（字段最全）；云端（无 westock）自动降级为
//        腾讯公开行情接口 qt.gtimg.cn（页面实时刷新同源）。可用 IA_PROVIDER=qt|westock 强制指定。
// 每个交易日 18:00 由自动化运行，修复「页面日期停留在旧快照」——即使浏览器实时行情不可用，回退快照也是最新收盘。
// 注意：只刷新「行情类」字段；基本面（npg/roe/moat 评分/fairPE）与池子成员不在此处改，
//       它们由每月 1 日的月度复核（fetch-finance / fetch-lt / calc-valuation）统一更新。
// 缺字段策略：qt 数据源没有的字段（前瞻 PE / 港股 PB/股息）一律「保留旧值」，不写 null——
//        这些是慢变数据，冻结旧值远比写错/清空安全。
const fs = require("fs");
const path = require("path");
const DIR = __dirname;
const DATA_F = path.join(DIR, "data.js");
const P = require("./provider.js");

function numOrNull(v) { const n = Number(v); return (v == null || v === "-" || v === "" || !isFinite(n)) ? null : n; }

(async function main() {

// ---------- 1. 读取股票池代码（主池 + 观察池 WATCH） ----------
const sb = { window: {} };
new Function("window", fs.readFileSync(DATA_F, "utf8"))(sb.window);
const STOCKS = sb.window.STOCKS || [];
const WATCH = sb.window.WATCH || [];          // 观察池：与主池同结构，行情字段同样每日刷新
const MKT = sb.window.MKT || { indices: [] };
if (!STOCKS.length) { console.error("data.js 无股票池，退出"); process.exit(1); }
const ALL = STOCKS.concat(WATCH);             // 行情刷新合并处理（去重：WATCH 不应与主池重复）
for (let w = WATCH.length - 1; w >= 0; w--) if (STOCKS.some(s => s.code === WATCH[w].code)) WATCH.splice(w, 1);

// ---------- 2. 拉取行情（provider 适配层：本地 westock / 云端 qt.gtimg.cn） ----------
const codes = ALL.map(s => s.code);
const IX = [["sh000001", "上证指数"], ["sz399001", "深证成指"], ["sz399006", "创业板指"]];
for (const c of IX) codes.push(c[0]);
const { quotes, source } = await P.quotes(codes);
console.log("行情数据源: " + source);
const got = ALL.filter(s => quotes[s.code]).length;
console.log("行情获取: " + got + "/" + ALL.length + " 只股票（主池 " + STOCKS.length + " + 观察池 " + WATCH.length + "）+ 指数 " + IX.filter(x => quotes[x[0]]).length + "/3");

// ---------- 3. 计算各市场 asOf ----------
let asOfA = MKT.asOfA || "", asOfHK = MKT.asOfHK || "";
for (const s of ALL) {
  const q = quotes[s.code]; if (!q || !q.time) continue;
  const d = String(q.time).slice(0, 10);
  if (s.mkt === "HK") { if (d > asOfHK) asOfHK = d; }
  else { if (d > asOfA) asOfA = d; }
}

// ---------- 4. 重写 data.js（逐行定点替换行情字段，保留其余格式与内容） ----------
let src = fs.readFileSync(DATA_F, "utf8");
const fmt = (v, d) => (v == null ? "null" : Number(v).toFixed(d == null ? 2 : d));
let updCount = 0;
for (const s of ALL) {
  const q = quotes[s.code];
  const re = new RegExp('(\\{ code: "' + s.code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"[^\\n]*)');
  const m = src.match(re);
  if (!m) { console.error("  ✗ 未找到行: " + s.code); continue; }
  if (!q) { console.error("  - 无行情，保留原值: " + s.code); continue; }
  let line = m[1];
  const set = (key, val) => {
    const re2 = new RegExp("(" + key + ": )(null|[-\\d.]+)");
    if (!re2.test(line)) return;
    line = line.replace(re2, "$1" + val);
  };
  const setN = (key, v) => { if (v != null) set(key, fmt(v)); };   // 缺字段（qt 模式的 peF/港股 pb/div）保留旧值
  setN("px", numOrNull(q.price));
  setN("chg", numOrNull(q.change_percent));
  setN("pe", numOrNull(q.pe_ratio));
  setN("peF", numOrNull(q.pe_fwd));
  setN("pb", numOrNull(q.pb_ratio));
  setN("div", numOrNull(q.dividend_ratio_ttm));
  const cap = numOrNull(q.total_market_cap);
  if (cap != null) set("cap", String(Math.round(cap / 1e8)));
  setN("hi52", numOrNull(q.high_52week));
  setN("lo52", numOrNull(q.low_52week));
  setN("ytd", numOrNull(q.chg_ytd));
  src = src.split(m[1]).join(line);   // split/join 避免替换串中的 $ 有特殊含义
  updCount++;
}
// 三大指数 close/chg
for (const [code, name] of IX) {
  const q = quotes[code]; if (!q) continue;
  const re = new RegExp('(\\{ name: "' + name + '", close: )[-\\d.]+(, chg: )[-\\d.]+');
  if (re.test(src)) src = src.replace(re, "$1" + fmt(numOrNull(q.price)) + "$2" + fmt(numOrNull(q.change_percent)));
}
// 顺带刷新成交额（沪+深，单位亿）——数值合理才写
const amtA = numOrNull(quotes["sh000001"] && quotes["sh000001"].amount);
const amtB = numOrNull(quotes["sz399001"] && quotes["sz399001"].amount);
if (amtA != null && amtB != null) {
  const yi = (amtA + amtB) / 1e8;
  if (yi > 5000 && yi < 60000) src = src.replace(/(turnoverYi: )[\d.]+/, "$1" + yi.toFixed(2));
}
// asOf 与文件头注释
src = src.replace(/(asOfA: ")[^"]*(")/, "$1" + asOfA + "$2");
src = src.replace(/(asOfHK: ")[^"]*(")/, "$1" + asOfHK + "$2");
// 美债十年期收益率（老唐估值法的无风险收益率锚）——westock macro 有此数据；qt 数据源无，保留原值
const rf = await P.rfUS();
if (rf && rf.v > 0.5 && rf.v < 15) {
  const rfLine = "rfUS: { v: " + rf.v.toFixed(2) + ', asOf: "' + rf.asOf + '" },';
  if (/rfUS: \{ v: [\d.]+, asOf: "[^"]*" \},/.test(src)) src = src.replace(/rfUS: \{ v: [\d.]+, asOf: "[^"]*" \},/, rfLine);
  else src = src.replace(/(asOfHK: "[^"]*",)/, "$1\n  " + rfLine);
  console.log("美债10Y 已刷新: " + rf.v.toFixed(2) + "%（" + rf.asOf + "）");
} else {
  console.log(source === "qt" ? "美债10Y：qt 数据源无美债接口，保留原值（本地 westock 环境每日刷新）" : "美债10Y 获取失败，保留原值");
}
const today = new Date(); const pad = n => ("0" + n).slice(-2);
const genAt = today.getFullYear() + "-" + pad(today.getMonth() + 1) + "-" + pad(today.getDate());
src = src.replace(/(generatedAt: ")[^"]*(")/, "$1" + genAt + "$2");
src = src.replace(/(\/\/ A股行情截至 )[^；]*(；港股行情截至 )[^；]*(；)/, "$1" + asOfA + " 收盘$2" + asOfHK + " 收盘$3");

fs.writeFileSync(DATA_F, src, "utf8");
console.log("data.js 已刷新: " + updCount + " 只 · A股 " + asOfA + " / 港股 " + asOfHK + " · 生成于 " + genAt);

// ---------- 5. 同步刷新 data/valuation.js 的锚定基准 ----------
// VAL 的联动公式为 curPE = pe0 × (现价/px0)，锚（px0/pe0/pb0/div0）必须与 data.js 快照同源同日，
// 否则估值分位会随快照刷新失真（val-check.js 校验两者一致）。
// 缺字段（qt 模式的港股 pb/div）不覆盖旧锚，避免把锚清成 null。
const VAL_F = path.join(DIR, "data", "valuation.js");
if (fs.existsSync(VAL_F)) {
  const vw = { window: {} };
  new Function("window", fs.readFileSync(VAL_F, "utf8"))(vw.window);
  const VAL = vw.window.VAL;
  if (VAL) {
    // 与 calc-valuation.js 的 pctOf 同口径（升序序列，计数「≤ 当前值」，保留 1 位小数）
    const pctOfSeries = (series, v) => {
      if (!series || !series.length || v == null) return null;
      const vals = series.map(p => p[1]).sort((a, b) => a - b);
      let le = 0;
      for (let i = 0; i < vals.length; i++) if (vals[i] <= v) le++;
      return Math.round(le / vals.length * 1000) / 10;
    };
    let anchor = 0;
    for (const s of ALL) {
      const v = VAL[s.code]; const q = quotes[s.code];
      if (!v || !q) continue;
      const px = numOrNull(q.price);
      if (px != null) { v.px0 = px; anchor++; }
      const pe = numOrNull(q.pe_ratio), pb = numOrNull(q.pb_ratio), dv = numOrNull(q.dividend_ratio_ttm);
      // 锚点变了 → 快照分位必须同步重算，否则「1 倍价 = 快照分位」不再成立（val-check.js 校验该一致性）
      if (pe != null) { v.pe0 = pe; v.peNow = pe; if (v.pe) v.pePct = pctOfSeries(v.pe, pe); }
      if (pb != null) { v.pb0 = pb; v.pbNow = pb; if (v.pb) v.pbPct = pctOfSeries(v.pb, pb); }
      if (dv != null) { v.div0 = dv; if (v.dy) v.dyPct = pctOfSeries(v.dy, dv); }
    }
    const head = "// 历史估值百分位数据（calc-valuation.js 自动生成，勿手改；锚定基准由 refresh-data.js 每日同步）\n" +
      "// 口径：以行情接口当前 PE/PB/股息率为锚，结合真实财报(EPSTTM/BasicEPS/NAPS)与不复权月K回推逐月估值序列\n" +
      "// px0/pe0/pb0/div0 = 快照基准；实时价联动公式 curPE = pe0 * (现价/px0)\n";
    fs.writeFileSync(VAL_F, head + "window.VAL = " + JSON.stringify(VAL) + ";\n", "utf8");
    console.log("valuation.js 锚定基准已同步: " + anchor + " 只");
  }
}

// ---------- 6. 顺带刷新财报披露日历（data/reports.js，westock disclosure 预约披露日） ----------
// 披露日与行情一样属于「会变的数据」：公司可能改期预约，放进每日刷新保持新鲜；
// fetch-reports.js 自带限频退避与合并式更新（失败代码保留旧值），失败不影响行情刷新主流程。
// qt 数据源没有披露日接口 → 云端模式跳过（保留旧值），披露日仍在本地 westock 环境每日刷新。
try {
  if (source === "westock") {
    const okRep = require("./fetch-reports.js").refresh();
    if (!okRep) console.error("财报披露日覆盖率偏低（保留旧值，下次刷新时补齐）");
  } else {
    console.log("财报披露日：qt 数据源无披露日接口，保留旧值");
  }
} catch (e) { console.error("财报披露日刷新异常（保留旧值）: " + e.message); }

})();
