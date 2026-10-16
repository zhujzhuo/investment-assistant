// 抓取「整体投顾组合」所需数据：红利（中证红利 / 红利低波）、纳斯达克100、货币、股票组合
// 数据源：腾讯公开行情 qt.gtimg.cn（实时/收盘快照） + web.ifzq.gtimg.cn（K线）
// 产出：data/asset-raw.json（原始留档）+ data/asset.js（前端可直接引用的计算结果）
//
// 口径说明：
//  - 回测用「前复权(qfq)月K」：含分红再投效果，最贴近真实持有收益
//  - 技术面（52周线/RSI/周线BOLL）用「不复权日K/周K」：与行情软件看到的价格一致
//  - 股息率历史用「锚定法」：股息率(t) = 当前股息率 × (现价/价格t) × (DPS_t/DPS_now)
//    DPS 增长按 中证红利 3%/年、红利低波 3.5%/年 假设（红利指数成分分红稳定低速增长）
const fs = require("fs");
const path = require("path");
const https = require("https");
const { execFileSync } = require("child_process");

// 2026-10-13：腾讯 K 线接口 web.ifzq.gtimg.cn 已被 WAF 拦截（HTTP 501 HTML），
// 改为优先走 westock CLI（与 MCP 同源）；CLI 不可用的周期再从日K本地聚合。
const WS_BIN = "/Users/didi/.local/bin/westock";

const DIR = __dirname;
const RAW = path.join(DIR, "data", "asset-raw.json");
const OUT = path.join(DIR, "data", "asset.js");

// ---- 已知外部权威口径（人工核对后写入，脚本不抓取）----
// 股息率 / PE：红利查 honglicha.com（2026-09-30 更新）
// 纳斯达克100 PE-TTM：界面新闻 / 新浪财经（2026-09-21，易方达、富国纳指ETF 披露）
const REF = {
  asOfDy: "2026-09-30",
  csi: { name: "中证红利", code: "000922", dy: 4.28, pe: 8.83, dpsGrowth: 0.03, vehicle: "515080 中证红利ETF（招商）" },
  lowvol: { name: "红利低波", code: "H30269", dy: 4.39, pe: 8.24, dpsGrowth: 0.035, vehicle: "512890 红利低波ETF（华泰柏瑞）" },
  nasdaq: { name: "纳斯达克100", code: "NDX", pe: 28.99, peAsOf: "2026-09-21", pePct1y: 11.56, epsGrowth: 0.18, vehicle: "513100 纳指ETF（国泰）/ QQQ" },
  cash: { name: "货币基金 / 自由现金流", rate: 1.5, note: "以余额宝等货币基金 7 日年化 ≈1.4%~1.6% 估算，随利率环境浮动" },
  bond10y: { v: 1.75, note: "中国 10 年期国债收益率 ≈1.7%~1.8%（2026 年区间），用于计算股息率-国债利差" }
};

// 回测与展示用到的标的
const CODES = {
  csiIdx: "sh000922",      // 中证红利（价格指数，用于股息率锚定 / 52周线）
  csiEtf: "sh515080",      // 中证红利ETF（招商）—— 回测用前复权
  lowvolEtf: "sh512890",   // 红利低波ETF（华泰柏瑞）
  nasEtf: "sh513100",      // 纳指ETF（国泰，跟踪纳斯达克100，人民币计价）
  nasIdx: "usNDX",         // 纳斯达克100（点位 / 52周线）
  nasEtfUs: "usQQQ",       // QQQ（美股侧技术面兜底）——westock CLI 不认 "usQQQ.OQ"
  hs300Etf: "sh510300",    // 沪深300ETF（回测基准）
  hs300Idx: "sh000300"
};

// 个股回测样本（巴菲特式选股的代表：护城河 / 高股息 / 现金流）
const STOCKS = [
  { c: "sh600519", n: "贵州茅台" },
  { c: "sh600900", n: "长江电力" },
  { c: "sh601088", n: "中国神华" },
  { c: "sh600036", n: "招商银行" },
  { c: "hk00700", n: "腾讯控股" }
];

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error("timeout")));
  });
}
function gbk(buf) { try { return new TextDecoder("gbk").decode(buf); } catch (e) { return buf.toString("utf8"); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseQuote(text) {
  const out = {};
  text.split(";").forEach((line) => {
    const m = line.match(/v_([A-Za-z0-9_.]+)="([^"]*)"/);
    if (!m) return;
    const f = m[2].split("~");
    if (f.length < 10) return;
    out[m[1]] = {
      name: f[1], code: f[2], px: Number(f[3]), prev: Number(f[4]), open: Number(f[5]),
      chg: Number(f[32]), chgAmt: Number(f[31]),
      pe: f[39] ? Number(f[39]) : null, pb: f[46] ? Number(f[46]) : null,
      hi52: f[47] ? Number(f[47]) : null, lo52: f[48] ? Number(f[48]) : null,
      date: String(f[30] || "").replace(/\D/g, "").slice(0, 8)   // 形如 20261005，便于统一格式化
    };
  });
  return out;
}

// westock CLI 返回 markdown 表格；解析成 [{d,o,c,h,l}]，按时间升序
function parseCLIKline(out) {
  const rows = [];
  for (const ln of String(out).split("\n")) {
    if (!/^\|\s*\d{4}-\d{2}-\d{2}\s*\|/.test(ln)) continue;
    const f = ln.split("|").map((s) => s.trim());   // f[1]=date f[2]=open f[3]=last f[4]=high f[5]=low
    const d = f[1], o = Number(f[2]), c = Number(f[3]), h = Number(f[4]), l = Number(f[5]);
    if (!d || !isFinite(c) || c <= 0) continue;
    rows.push({ d: d.slice(0, 10), o, c, h, l });
  }
  rows.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  return rows;
}
// 日K → 周K/月K 聚合（美股 ETF 的周/月K 接口不可用时使用）
function aggregateKline(daily, period) {
  if (!daily || !daily.length) return [];
  const keyOf = (d) => {
    if (period === "month") return d.slice(0, 7);
    const dt = new Date(d + "T00:00:00Z");
    dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));   // 周一为周首
    return dt.toISOString().slice(0, 10);
  };
  const groups = new Map();
  for (const r of daily) {
    const k = keyOf(r.d);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const arr of groups.values()) {
    arr.sort((a, b) => (a.d < b.d ? -1 : 1));
    out.push({
      d: arr[arr.length - 1].d,
      o: arr[0].o,
      c: arr[arr.length - 1].c,
      h: Math.max.apply(null, arr.map((r) => r.h)),
      l: Math.min.apply(null, arr.map((r) => r.l))
    });
  }
  out.sort((a, b) => (a.d < b.d ? -1 : 1));
  return out;
}
function klineViaCLI(code, period, n, fq) {
  const run = (per, lim) => {
    const args = ["kline", String(code), "--period", per, "--limit", String(lim)];
    if (fq) args.push("--fq", fq);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const out = execFileSync(WS_BIN, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 60000 });
        const rows = parseCLIKline(out);
        if (rows.length) return rows;
      } catch (e) { /* 限频/瞬时失败 */ }
      try { execFileSync("/bin/sleep", [String(2.5 + attempt * 1.5)]); } catch (e) { }
    }
    return [];
  };
  let rows = run(period, n);
  if (!rows.length && (period === "week" || period === "month")) {
    rows = aggregateKline(run("day", 900), period);
  }
  return rows;
}
async function kline(code, period, n, fq) {
  try {
    const url = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=" + code + "," + period + ",,," + n + "," + (fq || "");
    const j = JSON.parse(await get(url));
    const d = j.data && j.data[code];
    if (d) {
      const arr = d[period] || d["qfq" + period] || [];
      const out = arr
        .filter((r) => r && r[0] && r[2] != null)
        .map((r) => ({ d: String(r[0]).slice(0, 10), o: Number(r[1]), c: Number(r[2]), h: Number(r[3]), l: Number(r[4]) }))
        .filter((r) => isFinite(r.c) && r.c > 0);
      // 数量合理性校验（2026-10-16 踩坑）：ifzq 对 usQQQ 会返回 HTTP 200 但只有 2 条残缺数据
      // （首日 2011-06-02 + 最近一天），"有数据就采信" 会绕过 CLI 兜底 → 纳指 MA250/RSI 全废。
      // 规则：至少要到请求条数的一半，且周/月K至少 20 条；否则视为接口异常，落 CLI。
      if (out.length >= Math.min(n, 20) && (period === "day" || out.length >= 20)) return out;
      if (out.length >= Math.floor(n / 2)) return out;
    }
  } catch (e) { /* ifzq 已被 WAF 拦截 → 落到 CLI */ }
  return klineViaCLI(code, period, n, fq);
}

// ---------- 指标 ----------
function ma(arr, n) { if (arr.length < n) return null; let s = 0; for (let i = arr.length - n; i < arr.length; i++) s += arr[i]; return s / n; }
function rsiWilder(closes, n) {
  if (closes.length < n + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) gain += d; else loss -= d; }
  gain /= n; loss /= n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + (d > 0 ? d : 0)) / n;
    loss = (loss * (n - 1) + (d < 0 ? -d : 0)) / n;
  }
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}
// 用历史经验估算「RSI14 跌破 30」对应的价位：
// 扫描历史，找出每次 RSI14 由上而下穿越 30 的时点，统计当时收盘价相对近 60 日高点的回撤幅度，
// 再用当前近 60 日高点外推 —— 得到「再跌多少才可能触发 RSI<30」的经验参考价
function rsiTrigger(closes, target) {
  if (!closes || closes.length < 80) return { samples: 0, avgDrop: null, price: null, distPct: null };
  var drops = [], prev = null;
  for (var i = 70; i < closes.length; i++) {
    var r = rsiWilder(closes.slice(0, i + 1), 14);
    if (r == null) continue;
    if (prev != null && prev > target && r <= target) {
      var hi = Math.max.apply(null, closes.slice(Math.max(0, i - 59), i + 1));
      drops.push((closes[i] / hi - 1) * 100);
    }
    prev = r;
  }
  var hi60 = Math.max.apply(null, closes.slice(-60));
  var last = closes[closes.length - 1];
  if (!drops.length) return { samples: 0, avgDrop: null, price: null, distPct: null };
  var avg = drops.reduce((a, b) => a + b, 0) / drops.length;
  var p = hi60 * (1 + avg / 100);
  return { samples: drops.length, avgDrop: avg, price: p, distPct: (p / last - 1) * 100 };
}
function boll(closes, n, k) {
  if (closes.length < n) return null;
  const win = closes.slice(-n);
  const mid = win.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(win.reduce((a, b) => a + (b - mid) * (b - mid), 0) / n);
  return { mid: mid, upper: mid + k * sd, lower: mid - k * sd, sd: sd };
}
// 历史分位：当前值在序列中的百分位（0=最低 100=最高）
function pctRank(series, v) {
  if (!series.length) return null;
  let below = 0;
  for (let i = 0; i < series.length; i++) if (series[i] < v) below++;
  return below / series.length * 100;
}
function stats(series) {
  const s = series.slice().sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
  return { min: s[0], p25: q(0.25), med: q(0.5), p75: q(0.75), max: s[s.length - 1] };
}
// 锚定法：由当前股息率 + 价格序列 + DPS 增速假设，回推历史股息率序列
function yieldSeries(prices, dpsGrowthPerYear, months) {
  const n = prices.length, last = prices[n - 1];
  const out = [];
  for (let i = 0; i < n; i++) {
    const yearsBack = (n - 1 - i) / 12;
    out.push(prices[i] ? (1 / prices[i]) * Math.pow(1 + dpsGrowthPerYear, -yearsBack) : null);
  }
  // 归一化：让最后一个点等于 1（相对系数），调用方再乘当前股息率
  const base = out[n - 1];
  return out.map((v) => v == null ? null : v / base);
}
// 锚定法：由当前 PE + 价格 + EPS 增速假设，回推历史 PE 序列（系数）
// PE(t) = P(t) / EPS(t)，EPS(t) = EPS(now) / (1+g)^年数  ⇒  PE(t) = P(t) × (1+g)^年数 / EPS(now)
function peSeries(prices, epsGrowthPerYear) {
  const n = prices.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const yearsBack = (n - 1 - i) / 12;
    out.push(prices[i] * Math.pow(1 + epsGrowthPerYear, yearsBack));
  }
  const base = out[n - 1];
  return out.map((v) => v / base);
}

// ---------- 主流程 ----------
(async function () {
  const raw = { fetchedAt: new Date().toISOString(), quotes: {}, kline: {} };

  const qCodes = [CODES.csiIdx, CODES.csiEtf, CODES.lowvolEtf, CODES.nasEtf, CODES.nasIdx, "usQQQ", "usIXIC", CODES.hs300Etf, CODES.hs300Idx]
    .concat(STOCKS.map((s) => s.c));
  raw.quotes = parseQuote(gbk(await get("https://qt.gtimg.cn/q=" + qCodes.join(","))));
  console.log("quotes:", Object.keys(raw.quotes).length);

  const jobs = [
    ["csiIdxM", CODES.csiIdx, "month", 48, ""],      // 不复权：股息率锚定
    ["csiEtfM", CODES.csiEtf, "month", 48, "qfq"],   // 前复权：回测
    ["lowvolM", CODES.lowvolEtf, "month", 48, ""],   // 不复权：股息率锚定
    ["lowvolEtfM", CODES.lowvolEtf, "month", 48, "qfq"], // 前复权：回测
    ["nasEtfM", CODES.nasEtf, "month", 48, "qfq"],
    ["hs300EtfM", CODES.hs300Etf, "month", 48, "qfq"],
    ["qqqM", CODES.nasEtfUs, "month", 48, "qfq"],
    ["csiD", CODES.csiIdx, "day", 400, ""],
    ["lowvolD", CODES.lowvolEtf, "day", 400, ""],
    ["csiW", CODES.csiIdx, "week", 130, ""],
    ["lowvolW", CODES.lowvolEtf, "week", 130, ""],
    ["nasD", CODES.nasEtfUs, "day", 400, "qfq"],
    ["nasW", CODES.nasEtfUs, "week", 130, "qfq"],
    ["nasM", CODES.nasEtfUs, "month", 48, "qfq"]
  ];
  for (const [key, code, per, n, fq] of jobs) {
    try {
      const arr = await kline(code, per, n, fq);
      raw.kline[key] = arr;
      console.log(key, code, per, fq || "raw", "n=" + arr.length, arr.length ? arr[arr.length - 1].d + " c=" + arr[arr.length - 1].c : "");
    } catch (e) { console.log(key, "ERR", e.message); raw.kline[key] = []; }
    await sleep(1300);
  }
  raw.kline.stocks = {};
  for (const s of STOCKS) {
    try { raw.kline.stocks[s.c] = await kline(s.c, "month", 48, "qfq"); console.log("stock", s.c, "n=" + raw.kline.stocks[s.c].length); }
    catch (e) { console.log("stock", s.c, "ERR", e.message); raw.kline.stocks[s.c] = []; }
    await sleep(1300);
  }
  fs.writeFileSync(RAW, JSON.stringify(raw));

  // ---------- 计算 ----------
  const K = raw.kline;
  const Q = raw.quotes;
  const monthLabels = (K.csiEtfM || []).map((r) => r.d.slice(0, 7));
  // 与现有 MONTHS（36 个月，2023-10 ~ 2026-09）对齐
  const MONTHS = fs.readFileSync(path.join(DIR, "data.js"), "utf8").match(/window\.MONTHS\s*=\s*(\[[^\]]*\])/)[1];
  const months = JSON.parse(MONTHS);
  function align(arr) { // 把任意月度序列对齐到 months
    const map = {};
    arr.forEach((r) => { map[r.d.slice(0, 7)] = r.c; });
    return months.map((m) => map[m] != null ? map[m] : null);
  }
  function fill(arr) { // 前值填充 + 反向填充
    const out = arr.slice();
    let last = null;
    for (let i = 0; i < out.length; i++) { if (out[i] == null) out[i] = last; else last = out[i]; }
    let first = null;
    for (let i = 0; i < out.length; i++) { if (out[i] != null) { first = out[i]; break; } }
    for (let i = 0; i < out.length; i++) { if (out[i] == null) out[i] = first; }
    return out;
  }
  const series = {};
  for (const key of ["csiEtfM", "lowvolEtfM", "nasEtfM", "hs300EtfM"]) series[key] = fill(align(K[key] || []));
  const stockSeries = {};
  STOCKS.forEach((s) => { stockSeries[s.c] = fill(align(K.stocks[s.c] || [])); });

  // 股票组合（巴菲特式 10% 仓位）：等权
  const stockCombo = months.map((m, i) => {
    let s = 0, n = 0;
    STOCKS.forEach((st) => { const v = stockSeries[st.c][i]; if (v != null) { s += v / stockSeries[st.c][0]; n++; } });
    return n ? s / n * 100 : 100;
  });

  // ---------- 红利两兄弟 ----------
  // 未完月防护：月中运行时月K最后一条是「本月至今」的不完整K线（如 2026-10-16 只走了11个交易日）。
  // 用它回推股息率历史会让 dyHist 尾部混入未完月数据 → dyPct 分位无谓跳动（10-15→10-16 从 22.2% 跳到 16.7% 的原因之一）。
  // 规则：月K最后一条若不是本月最后一个自然日（简化：日期非 28~31 号，且下一条不存在），视为未完月，锚定序列剔除它。
  // 注意：日K/周K（技术面）不受影响——它们本来就是「至今为止」的口径，且 liveDiv 用实时价现算，天然覆盖当月最新价。
  function dropIncompleteMonth(arr) {
    if (!arr || arr.length < 2) return arr;
    const out = arr.slice();
    const last = out[out.length - 1];
    const d = +last.d.slice(8, 10);
    if (d < 28) out.pop();                     // 月中：丢弃未完月
    return out;
  }
  function buildDiv(key, ref, mRaw, dArr, wArr, quoteCode) {
    const prices = dropIncompleteMonth(mRaw || []).map((r) => r.c);
    const coef = yieldSeries(prices, ref.dpsGrowth);
    const dyHist = coef.map((c) => c * ref.dy);
    const dyPct = pctRank(dyHist.slice(-36), ref.dy);
    const st = stats(dyHist.slice(-36));
    const closes = (dArr || []).map((r) => r.c);
    const wcloses = (wArr || []).map((r) => r.c);
    const q = Q[quoteCode] || {};
    const px = q.px || (closes.length ? closes[closes.length - 1] : null);
    const m250 = ma(closes, 250);
    const wb = boll(wcloses, 20, 2);
    return {
      name: ref.name, code: ref.code, vehicle: ref.vehicle,
      px: px, chg: q.chg != null ? q.chg : null, pe: ref.pe, peLive: q.pe || null,
      dy: ref.dy, dyAsOf: REF.asOfDy, dyPct: dyPct, dyStats: st, dyHist: dyHist.slice(-36).map((v) => Number(v.toFixed(3))),
      ma250: m250, distMA250: (px && m250) ? (px / m250 - 1) * 100 : null,
      rsi14: rsiWilder(closes, 14),
      rsi30: rsiTrigger(closes, 30),
      wk: wb ? { mid: wb.mid, upper: wb.upper, lower: wb.lower } : null,
      wkUp: wcloses.length >= 2 ? wcloses[wcloses.length - 1] >= wcloses[wcloses.length - 2] : null,
      wkLast: wcloses.length ? wcloses[wcloses.length - 1] : null,
      distWkMid: (px && wb) ? (px / wb.mid - 1) * 100 : null,
      distWkLow: (px && wb) ? (px / wb.lower - 1) * 100 : null,
      hi52: q.hi52 && q.hi52 > 0 ? q.hi52 : (closes.length ? Math.max.apply(null, closes.slice(-250)) : null),
      lo52: q.lo52 && q.lo52 > 0 ? q.lo52 : (closes.length ? Math.min.apply(null, closes.slice(-250)) : null),
      pos52: (function () {
        const hi = q.hi52 && q.hi52 > 0 ? q.hi52 : (closes.length ? Math.max.apply(null, closes.slice(-250)) : null);
        const lo = q.lo52 && q.lo52 > 0 ? q.lo52 : (closes.length ? Math.min.apply(null, closes.slice(-250)) : null);
        return (px && hi && lo && hi > lo) ? (px - lo) / (hi - lo) * 100 : null;
      })(),
      months: months
    };
  }
  const csi = buildDiv("csi", REF.csi, K.csiIdxM, K.csiD, K.csiW, CODES.csiIdx);
  const lowvol = buildDiv("lowvol", REF.lowvol, K.lowvolM, K.lowvolD, K.lowvolW, CODES.lowvolEtf);

  // ---------- 纳斯达克 ----------
  // 估值用纳斯达克100 指数（PE 与点位）；技术面用可直接买卖的 QQQ（美股账户）/ 513100（QDII）
  const nasPrices = dropIncompleteMonth(K.nasM || []).map((r) => r.c);   // QQQ 前复权月K（剔未完月，同红利口径）
  const peCoef = peSeries(nasPrices, REF.nasdaq.epsGrowth);
  const peHist = peCoef.map((c) => c * REF.nasdaq.pe);
  // PE 分位对 EPS 增速假设很敏感，给出 15% / 20% / 25% 三档情景
  function pePctAt(g) {
    const h = peSeries(nasPrices, g).map((c) => c * REF.nasdaq.pe).slice(-36);
    return pctRank(h, REF.nasdaq.pe);
  }
  const peScen = { g15: pePctAt(0.15), g20: pePctAt(0.20), g25: pePctAt(0.25), g30: pePctAt(0.30) };
  const peStats = stats(peHist.slice(-36));
  const nasCloses = (K.nasD || []).map((r) => r.c);
  const nasW = (K.nasW || []).map((r) => r.c);
  const nq = Q[CODES.nasIdx] || {};
  const nasPx = nasCloses.length ? nasCloses[nasCloses.length - 1] : null; // QQQ
  const nasMA = ma(nasCloses, 250);
  const nasHi = nasCloses.length ? Math.max.apply(null, nasCloses.slice(-250)) : null;
  const nasLo = nasCloses.length ? Math.min.apply(null, nasCloses.slice(-250)) : null;
  const nasWb = boll(nasW, 20, 2);
  const nas = {
    name: REF.nasdaq.name, code: "NDX", vehicle: REF.nasdaq.vehicle,
    idxPx: nq.px || null, chg: nq.chg != null ? nq.chg : null,
    px: nasPx, pxName: "QQQ（美股可交易标的）",
    pe: REF.nasdaq.pe, peAsOf: REF.nasdaq.peAsOf, pePct: peScen.g25, pePct1y: REF.nasdaq.pePct1y, peScen: peScen, peStats: peStats,
    peHist: peHist.slice(-36).map((v) => Number(v.toFixed(2))),
    epsGrowth: REF.nasdaq.epsGrowth,
    ma250: nasMA, distMA250: (nasPx && nasMA) ? (nasPx / nasMA - 1) * 100 : null,
    rsi14: rsiWilder(nasCloses, 14),
    rsi30: rsiTrigger(nasCloses, 30),
    wk: nasWb ? { mid: nasWb.mid, upper: nasWb.upper, lower: nasWb.lower } : null,
    wkUp: nasW.length >= 2 ? nasW[nasW.length - 1] >= nasW[nasW.length - 2] : null,
    distWkMid: (nasPx && nasWb) ? (nasPx / nasWb.mid - 1) * 100 : null,
    distWkLow: (nasPx && nasWb) ? (nasPx / nasWb.lower - 1) * 100 : null,
    hi52: nasHi, lo52: nasLo,
    pos52: (nasPx && nasHi && nasLo && nasHi > nasLo) ? (nasPx - nasLo) / (nasHi - nasLo) * 100 : null,
    months: months
  };

  const asset = {
    generatedAt: new Date().toISOString().slice(0, 10),
    asOfA: (K.csiD && K.csiD.length ? K.csiD[K.csiD.length - 1].d : ""),
    asOfUS: (nq.date ? nq.date.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3") : ""),
    bond10y: REF.bond10y,
    ref: REF,
    codes: CODES,
    dividend: { csi: csi, lowvol: lowvol },
    nasdaq: nas,
    cash: REF.cash,
    stockComboNames: STOCKS.map((s) => s.n),
    kline: {
      months: months,
      csi: series.csiEtfM.map((v) => v == null ? null : Number(v.toFixed(4))),
      lowvol: series.lowvolEtfM.map((v) => v == null ? null : Number(v.toFixed(4))),
      nasdaq: series.nasEtfM.map((v) => v == null ? null : Number(v.toFixed(4))),
      hs300: series.hs300EtfM.map((v) => v == null ? null : Number(v.toFixed(4))),
      stock: stockCombo.map((v) => v == null ? null : Number(v.toFixed(3))),
      stocks: (function () { const o = {}; STOCKS.forEach((s) => { o[s.c] = { n: s.n, px: stockSeries[s.c].map((v) => v == null ? null : Number(v.toFixed(4))) }; }); return o; })()
    }
  };

  const banner = "// 整体投顾组合数据（自动生成，勿手改）\n"
    + "// 生成脚本：fetch-asset.js | 数据源：腾讯公开行情 qt.gtimg.cn + westock CLI（K线，ifzq 已被 WAF 拦截时的替代）\n"
    + "// 股息率 / PE 现值与历史分位：锚定法模型估算（假设见 ref.dpsGrowth / ref.epsGrowth）\n";
  fs.writeFileSync(OUT, banner + "window.ASSET = " + JSON.stringify(asset, null, 1) + ";\n");
  console.log("\nWROTE", OUT);
  console.log("中证红利: px=" + csi.px + " dy=" + csi.dy + "% 分位=" + (csi.dyPct || 0).toFixed(0) + "% MA250=" + (csi.ma250 || 0).toFixed(0) + " 距年线=" + (csi.distMA250 || 0).toFixed(1) + "% RSI=" + (csi.rsi14 || 0).toFixed(1) + " 距周BOLL中轨=" + (csi.distWkMid || 0).toFixed(1) + "%");
  console.log("红利低波: px=" + lowvol.px + " dy=" + lowvol.dy + "% 分位=" + (lowvol.dyPct || 0).toFixed(0) + "% MA250=" + (lowvol.ma250 || 0).toFixed(3) + " 距年线=" + (lowvol.distMA250 || 0).toFixed(1) + "% RSI=" + (lowvol.rsi14 || 0).toFixed(1));
  console.log("纳斯达克: NDX=" + nas.idxPx + " PE=" + nas.pe + " 近1年分位=" + nas.pePct1y + "% 锚定分位(15/20/25/30%)=" +
    [nas.peScen.g15, nas.peScen.g20, nas.peScen.g25, nas.peScen.g30].map((v) => (v || 0).toFixed(0) + "%").join("/") +
    " QQQ=" + nas.px + " 距年线=" + (nas.distMA250 || 0).toFixed(1) + "% RSI=" + (nas.rsi14 || 0).toFixed(1) +
    " 52周位置=" + (nas.pos52 || 0).toFixed(0) + "%");
  console.log("10年国债=" + REF.bond10y.v + "% 股息率利差：中证红利 " + (csi.dy - REF.bond10y.v).toFixed(2) + "pp / 红利低波 " + (lowvol.dy - REF.bond10y.v).toFixed(2) + "pp");
})();
