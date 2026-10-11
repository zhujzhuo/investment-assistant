// 抓取「老唐估值法」所需的机构一致预期盈利预测
// 数据源：NeoData 金融搜索（机构评级目标价与盈利预测）
// 产出：data/lt-raw.json（原始留档）+ data/lt.js（前端引用：三年预期倍数 k3y / 机构家数 / 目标价）
//
// 口径说明：
//  - 老唐估值法要的是「三年后净利润/每股收益」。
//  - A股数据源给年度一致预期（2026E/2027E/2028E）→ 一级数据：k3y = EPS2028E/EPS2026E × (1+g29)
//  - 港股数据源只给季度口径（滚动 5 季，含 1 个预测季）→ 二级数据：取近 4 季「净利润同比」均值 g0，
//    按老唐「保守估计」衰减外推三年：g1=g0、g2=g0×0.75、g3=g0×0.5（封顶 20%/年，封底 -10%/年）
//  - 只用「比值/增速」，不用绝对值：A股人民币、港股港币预测相除后币种自动抵消，
//    再乘到与股价同币种的基准 EPS（epsBase > peF > pe）上，避免汇率口径污染。
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const DIR = __dirname;
const RAW = path.join(DIR, "data", "lt-raw.json");
const OUT = path.join(DIR, "data", "lt.js");
const SKILL = "/Users/didi/.workbuddy/plugins/cache/cb_teams_marketplace/finance-data/1.6.0/skills/neodata-financial-search";
const PY = "/Users/didi/.workbuddy/binaries/python/versions/3.13.12/bin/python3";

// 载入 data.js 的股票池
const g = { window: {} };
eval(fs.readFileSync(path.join(DIR, "data.js"), "utf8").replace(/window\./g, "g.window."));
const STOCKS = g.window.STOCKS;

function sym(code) {
  const m = /^(sh|sz|hk)(\d+)$/.exec(code);
  if (!m) return code;
  return m[1] === "hk" ? m[2] + ".HK" : m[2] + "." + m[1].toUpperCase();
}
function query(q) {
  const out = execFileSync(PY, [path.join(SKILL, "scripts", "query.py"), "--query", q], {
    cwd: SKILL, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120000
  });
  return JSON.parse(out);
}
function cell(s) {
  s = String(s == null ? "" : s).replace(/[,，\s]/g, "").trim();
  if (!s || s === "—" || s === "-" || s === "null" || s === "None") return null;
  const v = Number(s);
  return isFinite(v) ? v : null;
}
function pctCell(s) {
  const m = /(-?[\d.]+)\s*%/.exec(String(s == null ? "" : s));
  return m ? Number(m[1]) : null;
}

// 年度表：| 年份 | 机构数(家) | 每股收益(元) | 净利润 | 营业收入 | 净利润同比 | 营收同比 |
function parseYear(text) {
  const by = {};
  text.split("\n").forEach(function (ln) {
    const m = /^\|\s*(\d{4})年\s*\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|/.exec(ln.trim());
    if (!m) return;
    by[+m[1]] = { nOrg: cell(m[2]), eps: cell(m[3]), net: cell(m[4]), npg: pctCell(m[6]) };
  });
  return Object.keys(by).length ? by : null;
}
// 季度表：| 季度 | 机构数 | EPS | 预测EPS | 净利润(亿) | 预测净利润(亿) | 营收 | 预测营收 | 净利润同比 | 营收同比 |
function parseQuarter(text) {
  const rows = [];
  text.split("\n").forEach(function (ln) {
    const m = /^\|\s*(\d{4})Q(\d)/.exec(ln.trim());
    if (!m) return;
    const c = ln.trim().split("|").map(function (x) { return x.trim(); });
    // c = ['', 季度, 机构数, EPS, 预测EPS, 净利润, 预测净利润, 营收, 预测营收, 同比, 营收同比, '']
    rows.push({
      q: m[1] + "Q" + m[2],
      nOrg: /(\d+)\s*\//.test(c[2] || "") ? +/(\d+)/.exec(c[2])[1] : cell(c[2]),
      epsAct: cell(c[3]), epsFc: cell(c[4]),
      netAct: cell(c[5]), netFc: cell(c[6]),
      npg: pctCell(c[9])
    });
  });
  return rows.length ? rows : null;
}
function parseBlock(text) {
  if (!text) return null;
  const y = parseYear(text), q = parseQuarter(text);
  let target = null, nTgt = null;
  let m = /目标均价([\d,\.]+)/.exec(text);
  if (m) { target = Number(m[1].replace(/,/g, "")); const n = /目标价（(\d+)家机构）/.exec(text); nTgt = n ? +n[1] : null; }
  if (target == null) { m = /综合目标价为([\d,\.]+)元/.exec(text); if (m) target = Number(m[1].replace(/,/g, "")); }
  if (!y && !q && target == null) return null;
  return { year: y, quarter: q, target: target, nTarget: nTgt };
}
function pickBlock(rec) {
  if (!rec) return null;
  const ad = rec.data ? rec.data.apiData : null;
  const list = (ad && Array.isArray(ad.apiRecall)) ? ad.apiRecall : [];
  for (let i = 0; i < list.length; i++) {
    var b = list[i];
    if (!b || !b.type) continue;
    if (b.type.indexOf("盈利预测") >= 0 || b.type.indexOf("评级目标价") >= 0) return b.content;
  }
  for (let i = 0; i < list.length; i++) {
    var b2 = list[i];
    if (b2 && b2.content && b2.content.indexOf("盈利预测") >= 0) return b2.content;
  }
  return null;
}

// 由年度一致预期推三年倍数
function kFromYear(by) {
  const e26 = by[2026] && by[2026].eps, e27 = by[2027] && by[2027].eps, e28 = by[2028] && by[2028].eps;
  if (!(e26 > 0) || !(e28 > 0)) return null;
  const g2 = Math.pow(e28 / e26, 1 / 2) - 1;
  const g28 = (e27 > 0 ? e28 / e27 - 1 : g2);
  const g29 = Math.max(-0.05, Math.min(0.15, (isFinite(g28) ? g28 : g2) * 0.75));
  return {
    k: (e28 / e26) * (1 + g29),
    note: "机构年度一致预期 " + e26 + "(2026E) → " + e28 + "(2028E)，第三年增速衰减至 " + (g29 * 100).toFixed(1) + "% 后外推 2029E",
    lv: 1, e26: e26, e28: e28,
    nOrg: by[2026].nOrg || by[2027].nOrg || by[2028].nOrg
  };
}
// 季度口径可靠性：同比序列必须平稳（剔除低基数/投资收益造成的 |同比|>80% 异常行；
// 有效行≥3；近 4 期极差≤60pp；EPS 覆盖机构数均值≥4）。阿里（财年错位）、美团（亏损转盈同比失真）
// 等会被自动判为不可靠，改走模型保守假设。
function kFromQuarter(rows) {
  const last4 = rows.slice(-4);
  const clean = last4.filter(function (r) { return r.npg != null && Math.abs(r.npg) <= 80; });
  if (clean.length < 3) return null;
  const vals = clean.map(function (r) { return r.npg; });
  const spread = Math.max.apply(null, vals) - Math.min.apply(null, vals);
  if (spread > 60) return null;
  const orgs = last4.map(function (r) { return r.nOrg || 0; }).filter(function (x) { return x > 0; });
  const nAvg = orgs.length ? orgs.reduce(function (a, b) { return a + b; }, 0) / orgs.length : 0;
  if (nAvg < 4) return null;
  let g0 = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length / 100;
  g0 = Math.max(-0.12, Math.min(0.15, g0));
  const k = (1 + g0) * (1 + g0 * 0.75) * (1 + g0 * 0.5);
  return {
    k: k, lv: 2,
    note: "机构季度一致预期近 " + clean.length + " 期净利同比均值 " + (g0 * 100).toFixed(1) + "%（" + clean.map(function (r) { return r.q + " " + r.npg + "%"; }).join("、") + "，覆盖 " + nAvg.toFixed(0) + " 家），按 100%/75%/50% 衰减外推三年",
    e26: null, e28: null, nOrg: Math.round(nAvg)
  };
}

// 三级兜底：数据源无可用一致预期时，按「成长分 + 人工核定」给保守增速，并打 0.9 系数（老唐：宁可低估）
const MODEL_G = {
  hk09988: { g: 0.06, why: "港股季度预测受财年错位与投资收益扰动（同比 -72%~+327% 失真），弃用；云+AI 驱动取 6%" },
  hk00941: { g: 0.04, why: "港股季度预测仅 1~2 家覆盖，弃用；运营商稳态取 4%" },
  sh688981: { g: 0.08, why: "数据源无年度一致预期；先进制程扩产+国产替代取 8%" },
  hk01299: { g: 0.07, why: "数据源季度预测陈旧（起于 2023Q2），弃用；NBV 复利取 7%" },
  hk00939: { g: 0.03, why: "数据源无盈利预测表；银行规模低速增长取 3%" },
  hk09992: { g: 0.06, why: "数据源仅有 22 家目标价、无盈利预测；2026H1 增速已由 +303% 降至 +14%，取 6%" },
  hk06181: { g: 0.00, why: "数据源仅有 18 家目标价、无盈利预测；金价高位回落，周期股不给增长，取 0%" },
  hk03690: { g: 0.08, why: "数据源仅有 37 家目标价；当前亏损无正 EPS 基准，老唐法不估值（仅列示）" }
};
function kFromModel(code, st) {
  const m = MODEL_G[code];
  const g = m ? m.g : Math.max(0.02, Math.min(0.12, (st.growth - 3) * 0.025));
  const k = (1 + g) * (1 + g * 0.75) * (1 + g * 0.5) * 0.9;
  return {
    k: k, lv: 3, e26: null, e28: null, nOrg: null,
    note: (m ? m.why : "按成长分 " + st.growth + " 映射") + "；三年增速按 100%/75%/50% 衰减后 ×0.9 保守系数"
  };
}

const only = process.argv[2] ? process.argv.slice(2) : null;
const list = only ? STOCKS.filter(function (s) { return only.indexOf(s.code) >= 0 || only.indexOf(s.name) >= 0; }) : STOCKS;
const prev = fs.existsSync(RAW) ? JSON.parse(fs.readFileSync(RAW, "utf8")).data : {};
const out = {};
for (let i = 0; i < list.length; i++) {
  const s = list[i];
  const q = s.name + " " + sym(s.code) + " 机构评级目标价与盈利预测 一致预期";
  let rec = null, err = "";
  for (let a = 0; a < 2 && !rec; a++) { try { rec = query(q); } catch (e) { err = String(e.message || e).slice(0, 160); } }
  const block = rec ? pickBlock(rec) : null;
  const p = block ? parseBlock(block) : null;
  let est = null;
  if (p) {
    est = (p.year ? kFromYear(p.year) : null) || (p.quarter ? kFromQuarter(p.quarter) : null);
    if (est && p.target != null) { est.target = p.target; est.nTarget = p.nTarget; }
  }
  if (!est) est = kFromModel(s.code, s);      // 三级兜底：模型保守假设（老唐「宁可低估」）
  if (est && p && p.target != null) { est.target = p.target; est.nTarget = p.nTarget; }
  out[s.code] = { name: s.name, sym: sym(s.code), ok: !!est, err: err, est: est, raw: block };
  console.log((est ? "✓" : "✗") + " " + s.name + " [" + (est ? "L" + est.lv : "-") + "] k=" + (est ? est.k.toFixed(3) : "-") +
    "  n=" + (est && est.nOrg ? est.nOrg : "-") + "  tp=" + (est && est.target ? est.target : "-") + (err ? "  " + err : ""));
}

fs.writeFileSync(RAW, JSON.stringify({ asOf: new Date().toISOString().slice(0, 10), source: "NeoData 机构评级目标价与盈利预测", data: out }, null, 2));
console.log("\n原始留档 → " + RAW);

const LT = {};
Object.keys(out).forEach(function (code) {
  const o = out[code], e = o.est;
  if (!e) { LT[code] = null; return; }
  LT[code] = {
    k3y: +e.k.toFixed(4),
    g3y: +(Math.pow(e.k, 1 / 3) - 1).toFixed(4),
    lv: e.lv, nOrg: e.nOrg || null, target: e.target || null, nTarget: e.nTarget || null,
    e26: e.e26 || null, e28: e.e28 || null, note: e.note
  };
});
fs.writeFileSync(OUT, "window.LT_FORECAST = " + JSON.stringify(LT, null, 2) + ";\n");
console.log("前端数据 → " + OUT + "  有效 " + Object.keys(LT).filter(function (c) { return LT[c]; }).length + "/" + Object.keys(LT).length);
