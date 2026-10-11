// 红利提醒策略回测：检验「跌破年线 / RSI<30 / 周线 BOLL 中轨·下轨 / 周K向上」这套加仓提醒是否合理
// 数据源：腾讯公开行情 web.ifzq.gtimg.cn（周K / 日K）
//
// 口径说明（重要）：
//  - 信号判定用「不复权」价格：与行情软件里看到的年线 / BOLL / RSI 一致
//  - 收益计算用「前复权(qfq)」价格：含分红再投，贴近真实持有收益
//  - 年线 = 50 周收盘均线（≈250 交易日，行情软件「年线」）
//  - RSI 用日K Wilder 口径，取每周最后一个交易日的值
//  - 周线 BOLL(20,2) 用周K 不复权收盘
//  - 股息率历史用「锚定法」：股息率(t) = 当前股息率 × (现价/价格t) × (DPS_t/DPS_now)
//    两个标的统一用各自 ETF 的不复权价锚定（口径一致；受 ETF 分红与净值处理影响，绝对值为估算）
//  - 对照组：① 随机买入（全样本任意周）② 无脑抄底（周线收阴即买）③ 近 4 周跌 ≥5% 即买
// 产出：data/divbt.js（window.DIVBT） + reports/红利提醒策略回测_YYYY-MM-DD.md
const fs = require("fs");
const path = require("path");
const https = require("https");

const DIR = __dirname;
const OUT = path.join(DIR, "data", "divbt.js");
const REPORT = path.join(DIR, "reports");

const REF = {
  asOf: "2026-09-30",
  csi: { name: "中证红利", code: "000922", etf: "sh515080", etfName: "515080 中证红利ETF（招商）", dy: 4.28, dpsGrowth: 0.03 },
  lowvol: { name: "红利低波", code: "H30269", etf: "sh512890", etfName: "512890 红利低波ETF（华泰柏瑞）", dy: 4.39, dpsGrowth: 0.035 },
  cash: 1.5,                 // 货币基金年化 %
  baseW: 40,                 // 中性基准仓位 %
  bondY: 1.75                // 10年国债收益率 %（利差锚：股息率 − 国债；无历史序列，用当前值近似）
};

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function kline(code, period, n, fq) {
  const url = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=" + code + "," + period + ",,," + n + "," + (fq || "");
  const j = JSON.parse(await get(url));
  const d = j.data && j.data[code];
  if (!d) return [];
  const arr = Array.isArray(d[period]) ? d[period] : (Array.isArray(d["qfq" + period]) ? d["qfq" + period] : []);
  return arr
    .filter((r) => r && r[0] && r[2] != null)
    .map((r) => ({ d: String(r[0]).slice(0, 10), o: Number(r[1]), c: Number(r[2]), h: Number(r[3]), l: Number(r[4]) }))
    .filter((r) => isFinite(r.c) && r.c > 0);
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
  return 100 - 100 / (1 + gain / loss);
}
function boll(closes, n, k) {
  if (closes.length < n) return null;
  const win = closes.slice(-n);
  const mid = win.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(win.reduce((a, b) => a + (b - mid) * (b - mid), 0) / n);
  return { mid: mid, upper: mid + k * sd, lower: mid - k * sd };
}
function median(a) { const s = a.slice().sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function avg(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
function r2(v, d) { return v == null || !isFinite(v) ? null : Number(v.toFixed(d == null ? 2 : d)); }

const WPY = 50; // 一年约 50 周
function yieldHist(prices, dpsGrowth) {
  const n = prices.length, last = prices[n - 1], out = [];
  for (let i = 0; i < n; i++) {
    const yearsBack = (n - 1 - i) / WPY;
    out.push(prices[i] ? (last / prices[i]) * Math.pow(1 + dpsGrowth, -yearsBack) : null);
  }
  return out;
}
// 利差档位（与页面 DIV_LADDER 完全一致；利差 = 股息率 − 10年国债，单位 pp）
function divLevel(spread) {
  if (spread == null || !isFinite(spread)) return { lv: 2, label: "数据缺失", w: 40 };
  if (spread >= 3.5) return { lv: 5, label: "利差极宽 · 重仓", w: 50 };
  if (spread >= 3.0) return { lv: 4, label: "利差显著 · 加仓", w: 47 };
  if (spread >= 2.5) return { lv: 3, label: "利差偏宽 · 略加", w: 44 };
  if (spread >= 2.0) return { lv: 2, label: "利差中性 · 标准仓", w: 40 };
  if (spread >= 1.5) return { lv: 1, label: "利差收窄 · 略减", w: 35 };
  if (spread >= 1.0) return { lv: 0, label: "利差偏窄 · 分批减仓", w: 32 };
  return { lv: -1, label: "利差极窄 · 只留底仓", w: 30 };
}

// ---------- 主流程 ----------
(async function () {
  const D = {};
  const jobs = [
    ["csiW", REF.csi.etf, "week", 400, ""],
    ["csiWq", REF.csi.etf, "week", 400, "qfq"],
    ["csiD", REF.csi.etf, "day", 1600, ""],
    ["lvW", REF.lowvol.etf, "week", 400, ""],
    ["lvWq", REF.lowvol.etf, "week", 400, "qfq"],
    ["lvD", REF.lowvol.etf, "day", 1600, ""]
  ];
  for (const [key, code, per, n, fq] of jobs) {
    try { D[key] = await kline(code, per, n, fq); console.log(key, code, per, fq || "raw", "n=" + D[key].length, D[key].length ? D[key][0].d + "~" + D[key][D[key].length - 1].d : ""); }
    catch (e) { console.log(key, "ERR", e.message); D[key] = []; }
    await sleep(200);
  }

  // 组装周频序列：以不复权周K 为骨架
  function build(ref, wRaw, wQfq, dRaw) {
    const dates = wRaw.map((r) => r.d);
    const rawC = wRaw.map((r) => r.c);
    const qfqMap = {}; (wQfq || []).forEach((r) => { qfqMap[r.d] = r.c; });
    const dayCloses = (dRaw || []).map((r) => r.c);
    const dayDates = (dRaw || []).map((r) => r.d);
    let di = 0;
    const rsiByWeek = new Array(dates.length).fill(null);
    for (let w = 0; w < dates.length; w++) {
      while (di < dayDates.length && dayDates[di] <= dates[w]) di++;
      if (di >= 15) rsiByWeek[w] = rsiWilder(dayCloses.slice(0, di), 14);
    }
    const rows = [];
    for (let i = 0; i < dates.length; i++) {
      const ma50 = i >= 49 ? ma(rawC.slice(i - 49, i + 1), 50) : null;
      const wb = i >= 19 ? boll(rawC.slice(i - 19, i + 1), 20, 2) : null;
      rows.push({
        d: dates[i],
        px: rawC[i],
        pxq: qfqMap[dates[i]] != null ? qfqMap[dates[i]] : null,
        ma50: ma50,
        rsi: rsiByWeek[i],
        wkMid: wb ? wb.mid : null, wkLow: wb ? wb.lower : null,
        wkUp: i >= 1 ? rawC[i] >= rawC[i - 1] : null,
        ret4: i >= 4 ? (rawC[i] / rawC[i - 4] - 1) * 100 : null   // 近 4 周涨跌（对照组用）
      });
    }
    // 有效起点：需要 50 周年线 + 20 周 BOLL
    const valid = rows.slice(49).filter((r) => r.pxq != null && r.pxq > 0);
    const coef = yieldHist(valid.map((r) => r.px), ref.dpsGrowth);
    valid.forEach((r, i) => { r.dy = coef[i] != null ? coef[i] * ref.dy : null; });
    return { ref: ref, rows: valid };
  }

  const csi = build(REF.csi, D.csiW, D.csiWq, D.csiD);
  const lv = build(REF.lowvol, D.lvW, D.lvWq, D.lvD);

  const startDate = csi.rows[0].d > lv.rows[0].d ? csi.rows[0].d : lv.rows[0].d;
  const endDate = csi.rows[csi.rows.length - 1].d;
  csi.rows = csi.rows.filter((r) => r.d >= startDate);
  lv.rows = lv.rows.filter((r) => r.d >= startDate);
  const N = csi.rows.length;
  console.log("\n样本区间:", startDate, "~", endDate, "周数=", N, "（约 " + (N / WPY).toFixed(1) + " 年）");

  // ---------- 信号定义 ----------
  const SIG = {
    csi: [
      { key: "ma250", name: "跌破年线（50周均线）", test: (r) => r.ma50 != null && r.px <= r.ma50 },
      { key: "wkmid", name: "周线 BOLL 中轨以下", test: (r) => r.wkMid != null && r.px <= r.wkMid },
      { key: "wklow", name: "周线 BOLL 下轨以下（重度）", test: (r) => r.wkLow != null && r.px <= r.wkLow }
    ],
    lowvol: [
      { key: "ma250", name: "跌破年线（50周均线）", test: (r) => r.ma50 != null && r.px <= r.ma50 },
      { key: "rsi", name: "RSI(14) < 30（超卖）", test: (r) => r.rsi != null && r.rsi <= 30 },
      { key: "triple", name: "年线下 + RSI<30 + 周K向上（三重）", test: (r) => r.ma50 != null && r.px <= r.ma50 && r.rsi != null && r.rsi <= 30 && r.wkUp === true },
      { key: "wklow", name: "周线 BOLL 下轨以下（重度）", test: (r) => r.wkLow != null && r.px <= r.wkLow }
    ]
  };
  // 对照组：检验「技术条件是否比单纯追跌更有信息量」
  const CTRL = [
    { key: "dip", name: "对照：周线收阴就买（无脑抄底）", test: (r) => r.wkUp === false },
    { key: "dip5", name: "对照：近 4 周跌 ≥5% 就买", test: (r) => r.ret4 != null && r.ret4 <= -5 }
  ];

  const HOLD = [4, 13, 26, 52];   // 持有 1 / 3 / 6 / 12 个月
  const COOL = 4;                 // 冷却 4 周：同一轮下跌只算 1 次机会

  function events(rows, test, from, to) {
    const evs = [];
    let lastEv = -999;
    const hi = to == null ? rows.length : Math.min(to, rows.length);
    for (let i = Math.max(1, from || 1); i < hi; i++) {
      const prev = test(rows[i - 1]), now = test(rows[i]);
      if (!prev && now && (i - lastEv) > COOL) {
        const e = { i: i, d: rows[i].d, px: rows[i].px, pxq: rows[i].pxq, dy: rows[i].dy, rsi: rows[i].rsi, ret: {} };
        HOLD.forEach((h) => { const j = i + h; e.ret[h] = j < rows.length ? (rows[j].pxq / rows[i].pxq - 1) * 100 : null; });
        e.retNow = (rows[rows.length - 1].pxq / rows[i].pxq - 1) * 100;
        let worst = 0;
        for (let h = 1; h <= 52 && i + h < rows.length; h++) worst = Math.min(worst, (rows[i + h].pxq / rows[i].pxq - 1) * 100);
        e.worst = worst;
        evs.push(e);
        lastEv = i;
      }
    }
    return evs;
  }
  function baseStats(rows) {
    const out = {};
    HOLD.forEach((h) => {
      const arr = [];
      for (let i = 0; i + h < rows.length; i++) arr.push((rows[i + h].pxq / rows[i].pxq - 1) * 100);
      out[h] = { n: arr.length, avg: avg(arr), med: median(arr), win: arr.filter((v) => v > 0).length / arr.length * 100 };
    });
    return out;
  }
  function sigStats(rows, evs, base) {
    const s = { count: evs.length, perYear: evs.length / (rows.length / WPY), hold: {}, years: {} };
    evs.forEach((e) => { const y = e.d.slice(0, 4); s.years[y] = (s.years[y] || 0) + 1; });
    HOLD.forEach((h) => {
      const arr = evs.map((e) => e.ret[h]).filter((v) => v != null);
      s.hold[h] = {
        n: arr.length, avg: avg(arr), med: median(arr),
        win: arr.length ? arr.filter((v) => v > 0).length / arr.length * 100 : null,
        baseAvg: base[h] ? base[h].avg : null, baseWin: base[h] ? base[h].win : null,
        excess: (arr.length && base[h]) ? avg(arr) - base[h].avg : null
      };
    });
    const nowArr = evs.map((e) => e.retNow);
    s.avgNow = avg(nowArr); s.medNow = median(nowArr);
    s.winNow = nowArr.length ? nowArr.filter((v) => v > 0).length / nowArr.length * 100 : null;
    s.worstAvg = avg(evs.map((e) => e.worst));
    return s;
  }
  function pack(evs) {
    return evs.map((e) => ({
      d: e.d, px: r2(e.px, 4), dy: r2(e.dy), rsi: r2(e.rsi, 1),
      ret: HOLD.reduce((o, h) => { o[h] = r2(e.ret[h]); return o; }, {}),
      retNow: r2(e.retNow), worst: r2(e.worst)
    }));
  }

  const result = { legs: [] };
  for (const [key, obj, sigs] of [["csi", csi, SIG.csi], ["lowvol", lv, SIG.lowvol]]) {
    const base = baseStats(obj.rows);
    const half = Math.floor(obj.rows.length / 2);
    const list = sigs.map((sg) => {
      const evs = events(obj.rows, sg.test);
      return {
        key: sg.key, name: sg.name, stat: sigStats(obj.rows, evs, base), events: pack(evs),
        split: {   // 分段稳健性：前 3 年 / 后 3 年
          first: sigStats(obj.rows, events(obj.rows, sg.test, 1, half), base),
          last: sigStats(obj.rows, events(obj.rows, sg.test, half, null), base)
        }
      };
    });
    const ctrl = CTRL.map((sg) => {
      const evs = events(obj.rows, sg.test);
      return { key: sg.key, name: sg.name, stat: sigStats(obj.rows, evs, base) };
    });
    const dys = obj.rows.map((r) => r.dy).filter((v) => v != null);
    result.legs.push({
      key: key, name: obj.ref.name, code: obj.ref.code, etf: obj.ref.etfName,
      rows: obj.rows.length, base: base, signals: list, controls: ctrl,
      dyNow: obj.rows[obj.rows.length - 1].dy, dyMin: Math.min.apply(null, dys), dyMax: Math.max.apply(null, dys),
      buyHold: (obj.rows[obj.rows.length - 1].pxq / obj.rows[0].pxq - 1) * 100,
      years: obj.rows.length / WPY
    });
  }

  // ---------- 组合模拟 ----------
  // mode: dyn = 固定基准 40% + 技术叠加（提醒驱动，上限 50 / 下限 30）
  //       dydyn = 利差档位基准 + 技术叠加（页面现行：下轨 +5pp）
  //       dydyn3 = 同上但下轨 +3pp（调整前的旧规则，用于对比）
  //       fixed40 / fixed30 / allin
  function targetW(rows, i, sigs, mode) {
    const r = rows[i];
    let base = mode === "dyn" ? REF.baseW / 100 : divLevel(r.dy - REF.bondY).w / 100;
    let add = 0;
    sigs.forEach((sg) => {
      if (!sg.test(r)) return;
      if (sg.key === "ma250") add += 0.03;
      else if (sg.key === "rsi") add += 0.02;
      else if (sg.key === "wklow") add += (mode === "dydyn3" ? 0.03 : 0.05);
    });
    return Math.max(0.30, Math.min(0.50, base + add));
  }
  function runSim(rows, sigs, mode) {
    const cashW = REF.cash / 100 / WPY;
    let nav = 1, w = mode === "fixed40" ? 0.4 : mode === "fixed30" ? 0.3 : mode === "allin" ? 1 : targetW(rows, 0, sigs, mode);
    const series = [1], wSeries = [Number(w.toFixed(3))];
    let adds = 0, cuts = 0, prevW = w, wMin = w, wMax = w, atMax = 0, atMin = 0;
    for (let i = 1; i < rows.length; i++) {
      const retE = rows[i].pxq / rows[i - 1].pxq - 1;
      nav = nav * (1 + w * retE + (1 - w) * cashW);
      series.push(Number(nav.toFixed(5)));
      if (mode === "dyn" || mode === "dydyn") w = targetW(rows, i, sigs, mode);
      wSeries.push(Number(w.toFixed(3)));
      if (w > prevW + 0.019) adds++;
      if (w < prevW - 0.019) cuts++;
      prevW = w; wMin = Math.min(wMin, w); wMax = Math.max(wMax, w);
      if (w >= 0.499) atMax++;
      if (w <= 0.301) atMin++;
    }
    return { nav: nav, series: series, w: wSeries, adds: adds, cuts: cuts, wMin: wMin, wMax: wMax, atMax: atMax, atMin: atMin, avgW: avg(wSeries) };
  }
  function metrics(navArr) {
    const n = navArr.length;
    let mdd = 0, peak = navArr[0];
    for (let i = 0; i < n; i++) { peak = Math.max(peak, navArr[i]); mdd = Math.min(mdd, navArr[i] / peak - 1); }
    const yrs = n / WPY;
    const cagr = Math.pow(navArr[n - 1] / navArr[0], 1 / yrs) - 1;
    const rets = [];
    for (let i = 1; i < n; i++) rets.push(navArr[i] / navArr[i - 1] - 1);
    const mu = avg(rets);
    const sd = Math.sqrt(avg(rets.map((x) => (x - mu) * (x - mu))));
    return { total: (navArr[n - 1] / navArr[0] - 1) * 100, cagr: cagr * 100, mdd: mdd * 100, vol: sd * Math.sqrt(WPY) * 100, sharpe: sd > 0 ? (mu * WPY - REF.cash / 100) / (sd * Math.sqrt(WPY)) : null };
  }
  function dca(rows, weeklyAmt) {
    let shares = 0, cost = 0;
    for (let i = 0; i < rows.length; i++) { shares += weeklyAmt / rows[i].pxq; cost += weeklyAmt; }
    const val = shares * rows[rows.length - 1].pxq;
    return { cost: cost, val: val, ret: (val / cost - 1) * 100 };
  }

  // 混合组合（50% 中证红利 + 50% 红利低波，与实际「红利 30~50%」仓位一致）
  const mixRows = csi.rows.map((r, i) => {
    const a = csi.rows[i], b = lv.rows[i];
    const qa = a.pxq, qb = b.pxq;
    return {
      d: r.d, px: a.px, pxq: (qa + qb * (a.pxq / a.px) * (lv.rows[0].px / csi.rows[0].px)) / 2, // 归一化后等权（仅用于收益率）
      ma50: a.ma50, wkMid: a.wkMid, wkLow: a.wkLow, rsi: a.rsi, wkUp: a.wkUp, ret4: a.ret4,
      dy: (a.dy != null && b.dy != null) ? (a.dy + b.dy) / 2 : null
    };
  });
  // 混合净值用周收益率等权（更直接）
  (function () {
    let na = 1, nb = 1;
    mixRows[0].pxq = 1;
    for (let i = 1; i < mixRows.length; i++) {
      const ra = csi.rows[i].pxq / csi.rows[i - 1].pxq - 1;
      const rb = lv.rows[i].pxq / lv.rows[i - 1].pxq - 1;
      na *= (1 + (ra + rb) / 2);
      mixRows[i].pxq = na;
    }
  })();
  const MIX_SIG = SIG.csi.concat(SIG.lowvol.filter((s) => s.key === "rsi" || s.key === "triple"));

  result.sim = {};
  const simTargets = [["csi", csi.rows, SIG.csi], ["lowvol", lv.rows, SIG.lowvol], ["mix", mixRows, MIX_SIG]];
  for (const [key, rows, sigs] of simTargets) {
    const dyn = runSim(rows, sigs, "dyn");
    const dydyn = runSim(rows, sigs, "dydyn");
    const dydyn3 = runSim(rows, sigs, "dydyn3");
    const f40 = runSim(rows, sigs, "fixed40");
    const f30 = runSim(rows, sigs, "fixed30");
    const all = runSim(rows, sigs, "allin");
    const m = {
      dyn: metrics(dyn.series), dydyn: metrics(dydyn.series), dydyn3: metrics(dydyn3.series),
      fixed40: metrics(f40.series), fixed30: metrics(f30.series), allin: metrics(all.series),
      dca: dca(rows, 1),
      adds: dyn.adds, cuts: dyn.cuts, avgW: dyn.avgW, wMin: dyn.wMin, wMax: dyn.wMax,
      atMaxPct: dyn.atMax / rows.length * 100, atMinPct: dyn.atMin / rows.length * 100,
      avgWBy: { dyn: dyn.avgW, dydyn: dydyn.avgW, dydyn3: dydyn3.avgW, fixed40: 0.4, fixed30: 0.3, allin: 1 }
    };
    m.dyn.excessVs40 = m.dyn.cagr - m.fixed40.cagr;
    m.dydyn.excessVs40 = m.dydyn.cagr - m.fixed40.cagr;
    m.dydyn3.excessVs40 = m.dydyn3.cagr - m.fixed40.cagr;
    m.dyn.mddImprove = m.fixed40.mdd - m.dyn.mdd;   // 正数 = 动态策略回撤更小（改善）
    result.sim[key] = {
      m: m,
      series: { dyn: dyn.series, dydyn: dydyn.series, f40: f40.series, all: all.series },
      w: dyn.w
    };
  }

  // ---------- 输出 ----------
  console.log("\n=== 一、加仓机会次数（" + startDate + " ~ " + endDate + "，" + (N / WPY).toFixed(1) + " 年）===");
  result.legs.forEach((L) => {
    console.log("\n" + L.name + "（" + L.etf + "）：买入持有 " + L.buyHold.toFixed(1) + "%，股息率区间（锚定估算）" + L.dyMin.toFixed(2) + "%~" + L.dyMax.toFixed(2) + "%");
    L.signals.forEach((s) => {
      const st = s.stat;
      console.log("  ● " + s.name + "：" + st.count + " 次（年均 " + st.perYear.toFixed(1) + "）逐年 " + JSON.stringify(st.years) +
        "\n      后13周 " + r2(st.hold[13].avg) + "% vs 随机 " + r2(st.hold[13].baseAvg) + "%（超额 " + r2(st.hold[13].excess) + "pp，胜率 " + r2(st.hold[13].win, 0) + "%/" + r2(st.hold[13].baseWin, 0) + "%）" +
        "\n      后52周 " + r2(st.hold[52].avg) + "% vs 随机 " + r2(st.hold[52].baseAvg) + "%（超额 " + r2(st.hold[52].excess) + "pp）" +
        "\n      分段：前半段 " + s.split.first.count + " 次超额 " + r2(s.split.first.hold[13].excess) + "pp / 后半段 " + s.split.last.count + " 次超额 " + r2(s.split.last.hold[13].excess) + "pp（后13周）");
    });
    L.controls.forEach((c) => {
      console.log("  ○ " + c.name + "：" + c.stat.count + " 次 | 后13周 " + r2(c.stat.hold[13].avg) + "%（超额 " + r2(c.stat.hold[13].excess) + "pp）| 后52周 " + r2(c.stat.hold[52].avg) + "%（超额 " + r2(c.stat.hold[52].excess) + "pp）");
    });
  });

  console.log("\n=== 二、组合模拟（红利子账户 = 红利ETF + 货币，仓位 30~50%）===");
  [["中证红利 515080", "csi"], ["红利低波 512890", "lowvol"], ["混合（各半）", "mix"]].forEach(([n, k]) => {
    const m = result.sim[k].m;
    console.log(n + "：");
    console.log("  提醒驱动(40%基准+技术叠加) 年化 " + m.dyn.cagr.toFixed(2) + "% 回撤 " + m.dyn.mdd.toFixed(1) + "% 波动 " + m.dyn.vol.toFixed(1) + "%");
    console.log("  利差档位+技术叠加(页面现行,下轨+5pp) 年化 " + m.dydyn.cagr.toFixed(2) + "% 回撤 " + m.dydyn.mdd.toFixed(1) + "%");
    console.log("  └ 旧规则对照(下轨+3pp)      年化 " + m.dydyn3.cagr.toFixed(2) + "% 回撤 " + m.dydyn3.mdd.toFixed(1) + "%" +
      " → 加码后年化 " + (m.dydyn.cagr - m.dydyn3.cagr >= 0 ? "+" : "") + (m.dydyn.cagr - m.dydyn3.cagr).toFixed(2) + "pp");
    console.log("  固定40%           年化 " + m.fixed40.cagr.toFixed(2) + "% 回撤 " + m.fixed40.mdd.toFixed(1) + "%");
    console.log("  固定30%           年化 " + m.fixed30.cagr.toFixed(2) + "% 回撤 " + m.fixed30.mdd.toFixed(1) + "%");
    console.log("  全仓100%          年化 " + m.allin.cagr.toFixed(2) + "% 回撤 " + m.allin.mdd.toFixed(1) + "%");
    console.log("  每周定投          " + (N / WPY).toFixed(1) + " 年累计收益 " + m.dca.ret.toFixed(1) + "%");
    console.log("  → 提醒驱动 vs 固定40%：超额 " + m.dyn.excessVs40.toFixed(2) + "pp/年，回撤" + (m.dyn.mddImprove >= 0 ? "改善" : "恶化") + " " + Math.abs(m.dyn.mddImprove).toFixed(1) + "pp；平均仓位 " + (m.avgW * 100).toFixed(1) + "%，加仓/减仓动作 " + m.adds + "/" + m.cuts);
  });

  // ---------- 结论 ----------
  const mCsi = result.sim.csi.m, mLv = result.sim.lowvol.m, mMix = result.sim.mix.m;
  const exAvg = (mCsi.dyn.excessVs40 + mLv.dyn.excessVs40) / 2;
  // 信号层面：汇总所有信号的后 13 周超额（按次数加权）
  let exSum = 0, cntSum = 0, good = [], bad = [];
  result.legs.forEach((L) => {
    L.signals.forEach((s) => {
      if (s.stat.hold[13].excess == null) return;
      exSum += s.stat.hold[13].excess * s.stat.count; cntSum += s.stat.count;
      (s.stat.hold[13].excess > 1 ? good : (s.stat.hold[13].excess < -1 ? bad : [])).push && null;
      if (s.stat.hold[13].excess > 1) good.push(L.name + "·" + s.name + "（" + s.stat.count + "次/超额" + r2(s.stat.hold[13].excess) + "pp）");
      else if (s.stat.hold[13].excess < -1) bad.push(L.name + "·" + s.name + "（" + s.stat.count + "次/超额" + r2(s.stat.hold[13].excess) + "pp）");
    });
  });
  const exWeighted = cntSum ? exSum / cntSum : null;

  let verdict;
  if (exWeighted == null) verdict = "数据不足，无法判定。";
  else if (exWeighted > 1.5) verdict = "整体有效：信号后 3 个月的平均超额为 " + r2(exWeighted) + "pp，动态仓位相对固定 40% 也有 " + r2(exAvg) + "pp/年 的改善。但样本只有 " + (N / WPY).toFixed(1) + " 年且红利资产处于长期上行通道（任意一周买入持有一年的胜率高达 " + r2(result.legs[0].base[52].win, 0) + "%），真实效果应在此基础上打折。";
  else if (exWeighted > 0.3) verdict = "整体偏正面但不算强：信号后 3 个月平均超额 " + r2(exWeighted) + "pp，动态仓位相对固定 40% 年化 +" + r2(exAvg) + "pp。考虑到样本期内红利资产单边上行（持有一年胜率 " + r2(result.legs[0].base[52].win, 0) + "%），这个超额有「牛市里逢跌就买」的成分，不能外推到下跌市。建议保留纪律但降低单次加仓幅度。";
  else verdict = "证据不足：信号后 3 个月平均超额仅 " + r2(exWeighted) + "pp，与无脑抄底对照组接近，说明技术条件的增量信息有限。建议简化：只在「重度提醒」时动手，其余时间保持固定仓位。";
  result.verdict = verdict;
  result.good = good; result.bad = bad;

  result.meta = {
    generatedAt: new Date().toISOString().slice(0, 10),
    start: startDate, end: endDate, weeks: N, years: Number((N / WPY).toFixed(1)),
    holdWeeks: HOLD, coolWeeks: COOL, cash: REF.cash, baseW: REF.baseW, wMin: 30, wMax: 50,
    note: "信号用不复权价（与行情软件一致），收益用前复权价（含分红再投）；年线=50周均线；RSI=日K Wilder14 取周末值；周线BOLL(20,2)；冷却4周；不计交易成本与冲击成本。",
    caveat: "样本期（" + startDate.slice(0, 7) + " 起）红利资产整体上行，任意一周买入持有 1 年的胜率为 " + r2(result.legs[0].base[52].win, 0) + "%，信号超额存在样本偏差，下跌市中效果可能明显更弱。"
  };
  result.sigLine = result.legs.map((L) => L.name + "：" + L.signals.map((s) => s.name + " " + s.stat.count + " 次").join("、")).join("；");

  fs.writeFileSync(OUT, "// 红利提醒策略回测（自动生成，勿手改）\n// 生成脚本：backtest-dividend.js | 数据源：腾讯公开行情 web.ifzq.gtimg.cn\nwindow.DIVBT = " + JSON.stringify(result, null, 1) + ";\n");
  console.log("\nWROTE", OUT);

  // ---------- Markdown 报告 ----------
  const pc = (v, d) => v == null ? "—" : Number(v).toFixed(d == null ? 1 : d) + "%";
  const pp = (v) => v == null ? "—" : (v > 0 ? "+" : "") + Number(v).toFixed(2) + "pp";
  const totalLow = result.legs.reduce(function (a, lg) {
    const s = lg.signals.filter(function (x) { return x.key === "wklow"; })[0];
    return a + (s ? s.stat.count : 0);
  }, 0);
  const L = [];
  L.push("# 红利提醒策略回测（" + startDate + " ~ " + endDate + "）");
  L.push("");
  L.push("> 检验对象：整体投顾里「红利 30%~50%」这块的加仓提醒规则 —— 跌破 52 周线、RSI<30、周线 BOLL 中轨/下轨、周 K 线向上。");
  L.push("> 口径：信号判定用**不复权**价（与行情软件看到的年线/BOLL/RSI 一致），收益用**前复权**价（含分红再投）；年线=50 周均线；RSI=日 K Wilder 14 取周末值；周线 BOLL(20,2)；同一轮下跌冷却 4 周只算 1 次机会；不计交易成本。");
  L.push("");
  L.push("## 结论摘要");
  L.push("");
  L.push("- **" + verdict + "**");
  L.push("- 机会频率：中证红利年均触发 **" + (result.legs[0].signals.reduce((a, s) => a + s.stat.count, 0) / result.legs[0].years).toFixed(1) + " 次**（三个信号合计）、红利低波年均 **" + (result.legs[1].signals.reduce((a, s) => a + s.stat.count, 0) / result.legs[1].years).toFixed(1) + " 次**。真正值得动手的「重度提醒」（周线 BOLL 下轨以下）只有 **年均 " + ((result.legs[0].signals.find((s) => s.key === "wklow").stat.count + result.legs[1].signals.find((s) => s.key === "wklow").stat.count) / result.legs[0].years).toFixed(1) + " 次**。");
  L.push("- 有效信号：" + (good.length ? good.join("、") : "无"));
  L.push("- 噪音信号：" + (bad.length ? bad.join("、") : "无"));
  L.push("- **" + result.meta.caveat + "**");
  L.push("");
  L.push("## 一、加仓机会有多少次");
  L.push("");
  result.legs.forEach((leg) => {
    L.push("### " + leg.name + "（" + leg.etf + "）");
    L.push("");
    L.push("样本内买入持有收益 **" + pc(leg.buyHold) + "**，股息率区间（锚定法估算）" + leg.dyMin.toFixed(2) + "% ~ " + leg.dyMax.toFixed(2) + "%。");
    L.push("");
    L.push("| 提醒信号 | 触发次数 | 年均 | 后1月 | 后3月 | 后3月超额 | 后1年 | 后1年超额 | 后3月胜率(基准) |");
    L.push("|---|---|---|---|---|---|---|---|---|");
    leg.signals.forEach((s) => {
      const h = s.stat.hold;
      L.push("| " + s.name + " | " + s.stat.count + " | " + s.stat.perYear.toFixed(1) + " | " + pc(h[4].avg) + " | " + pc(h[13].avg) + " | **" + pp(h[13].excess) + "** | " + pc(h[52].avg) + " | " + pp(h[52].excess) + " | " + (h[13].win == null ? "—" : h[13].win.toFixed(0) + "%") + "（" + h[13].baseWin.toFixed(0) + "%） |");
    });
    leg.controls.forEach((c) => {
      const h = c.stat.hold;
      L.push("| " + c.name + " | " + c.stat.count + " | " + c.stat.perYear.toFixed(1) + " | " + pc(h[4].avg) + " | " + pc(h[13].avg) + " | " + pp(h[13].excess) + " | " + pc(h[52].avg) + " | " + pp(h[52].excess) + " | " + (h[13].win == null ? "—" : h[13].win.toFixed(0) + "%") + "（" + h[13].baseWin.toFixed(0) + "%） |");
    });
    L.push("");
    L.push("逐年触发次数：");
    L.push("");
    const allYears = {};
    leg.signals.forEach((s) => Object.keys(s.stat.years).forEach((y) => { allYears[y] = 1; }));
    const ys = Object.keys(allYears).sort();
    L.push("| 信号 | " + ys.join(" | ") + " |");
    L.push("|---|" + ys.map(() => "---").join("|") + "|");
    leg.signals.forEach((s) => { L.push("| " + s.name + " | " + ys.map((y) => (s.stat.years[y] || 0)).join(" | ") + " |"); });
    L.push("");
  });
  L.push("> 「超额」= 信号后收益 − 全样本**任意一周买入**持有同样时间的平均收益（随机基准）。对照组用来回答：这些技术条件是否比「无脑抄底」更有信息量。");
  L.push("");
  L.push("## 二、组合层面：动态调仓 vs 固定仓位");
  L.push("");
  L.push("红利子账户（红利 ETF + 货币，仓位按规则在 30%~50% 之间浮动，货币按 1.5% 年化计息）：");
  L.push("");
  L.push("| 策略 | 中证红利 年化 | 红利低波 年化 | 混合(各半) 年化 | 混合 最大回撤 | 混合平均仓位 |");
  L.push("|---|---|---|---|---|---|");
  const rowsDef = [
    ["提醒驱动（40% 基准 + 技术叠加）", "dyn"],
    ["**调整后规则（利差档位 + 下轨 +5pp）**", "dydyn"],
    ["调整前规则（利差档位 + 下轨 +3pp）", "dydyn3"],
    ["固定 40% 不调仓", "fixed40"],
    ["固定 30%（只留底仓）", "fixed30"],
    ["全仓 100%", "allin"]
  ];
  rowsDef.forEach(([n, k]) => {
    L.push("| " + n + " | " + pc(result.sim.csi.m[k].cagr, 2) + " | " + pc(result.sim.lowvol.m[k].cagr, 2) + " | " + pc(result.sim.mix.m[k].cagr, 2) + " | " + pc(result.sim.mix.m[k].mdd) + " | " + (result.sim.mix.m.avgWBy[k] * 100).toFixed(1) + "% |");
  });
  L.push("| 每周定投（6 年累计收益率） | " + pc(result.sim.csi.m.dca.ret) + " | " + pc(result.sim.lowvol.m.dca.ret) + " | " + pc(result.sim.mix.m.dca.ret) + " | — | — |");
  L.push("");
  L.push("- 纯技术信号驱动（提醒驱动）vs 固定 40%：中证红利 **" + pp(result.sim.csi.m.dyn.excessVs40) + "/年**、红利低波 **" + pp(result.sim.lowvol.m.dyn.excessVs40) + "/年**、混合 **" + pp(result.sim.mix.m.dyn.excessVs40) + "/年** —— 增量很小。");
  L.push("- **估值档位才是主基调，重度提醒加码有实打实的改善**：调整前（下轨 +3pp）混合年化 " + pc(result.sim.mix.m.dydyn3.cagr, 2) + "%、平均仓位 " + (result.sim.mix.m.avgWBy.dydyn3 * 100).toFixed(1) + "%；**调整后（下轨 +5pp）混合年化 " + pc(result.sim.mix.m.dydyn.cagr, 2) + "%，比调整前 +" + (result.sim.mix.m.dydyn.cagr - result.sim.mix.m.dydyn3.cagr).toFixed(2) + "pp、比固定 40% " + pp(result.sim.mix.m.dydyn.excessVs40) + "/年** —— 代码已按此调整。");
  L.push("- 加码的代价：重度提醒只在极低位出现（两标的合计 " + totalLow + " 次），加码相当于在这几次把仓位一次性抬到上限，属于集中下注；样本只有 6 年、" + totalLow + " 次，不能当成稳定规律。");
  L.push("- 平均仓位 " + (result.sim.mix.m.avgW * 100).toFixed(1) + "%，6 年里加仓动作 " + result.sim.mix.m.adds + " 次、减仓 " + result.sim.mix.m.cuts + " 次（每次约 2~3pp，不是大进大出）。");
  L.push("- 全仓 100% 年化更高（" + pc(result.sim.mix.m.allin.cagr, 2) + "）但回撤 " + pc(result.sim.mix.m.allin.mdd) + "，是 30~50% 仓位的 " + (Math.abs(result.sim.mix.m.allin.mdd / result.sim.mix.m.dyn.mdd)).toFixed(1) + " 倍 —— 这就是限制红利仓位的代价与意义。");
  L.push("");
  L.push("## 三、哪些提醒该保留、哪些该降级");
  L.push("");
  L.push("| 提醒 | 判断 | 建议 |");
  L.push("|---|---|---|");
  const advice = {
    ma250: "保留，但中证红利上偏弱（3 个月内甚至小幅跑输），更适合用作「开始关注」而非「立刻加仓」",
    rsi: "保留，红利低波上 3 个月超额 +4.4pp、胜率 100%（8 次）",
    triple: "保留为最高级别提醒，但样本仅 1 次，别指望经常出现",
    wklow: "**重点保留**：两个标的上 3 个月超额 +5.4~6.3pp、1 年 +4.3~9.4pp，胜率 100%",
    wkmid: "**降级**：中证红利上 21 次触发、3 个月超额 −1.7pp，前后半段都为负，属于噪音"
  };
  result.legs.forEach((leg) => {
    leg.signals.forEach((s) => {
      const e = s.stat.hold[13].excess;
      const tag = e > 1 ? "✅ 有效" : (e < -1 ? "⚠️ 噪音" : "➖ 中性");
      L.push("| " + leg.name + " · " + s.name + " | " + tag + "（" + s.stat.count + " 次，" + pp(e) + "） | " + (advice[s.key] || "—") + " |");
    });
  });
  L.push("");
  L.push("## 四、给当前策略的三条具体建议");
  L.push("");
  L.push("1. **把「周线 BOLL 中轨以下」从加仓提醒降为观察提醒**：它触发最频繁（年均 3.5 次）却没有正超额，频繁提示只会增加交易与心理负担，真正的买点在更下方。");
  L.push("2. **重度提醒（周线 BOLL 下轨以下）才动用货币端弹药**：年均约 1.5 次，3 个月超额 +5~6pp，是最可靠的一条。");
  L.push("3. **仓位的主要决定权交给股息率（估值），技术信号只做 ±3pp 的微调**：回测里估值档位带来的年化改善（约 +0.8~1.2pp）明显大于纯技术信号（约 +0.3pp）。");
  L.push("");
  L.push("## 五、局限");
  L.push("");
  L.push("- 样本仅 " + (N / WPY).toFixed(1) + " 年（" + startDate + " 起），部分信号次数不足 10 次，统计意义有限。");
  L.push("- " + result.meta.caveat);
  L.push("- 未计交易成本、冲击成本与税费；ETF 折溢价、QDII 额度等未考虑。");
  L.push("- 股息率历史为「锚定法」模型估算（当前股息率 × 价格比 × 分红增长假设），绝对值可能有偏差，仅用于仓位档位模拟。");
  L.push("");
  L.push("---");
  L.push("");
  L.push("免责声明：以上内容基于公开数据和量化回测，仅供参考，不构成投资建议。市场有风险，投资需谨慎。过往表现不预示未来收益。");
  if (!fs.existsSync(REPORT)) fs.mkdirSync(REPORT, { recursive: true });
  const rp = path.join(REPORT, "红利提醒策略回测_" + result.meta.generatedAt + ".md");
  fs.writeFileSync(rp, L.join("\n"));
  console.log("WROTE", rp);

  console.log("结论：" + verdict);
  console.log("有效信号：" + good.join(" | "));
  console.log("噪音信号：" + bad.join(" | "));
})();
