// 红利「卖出 / 止盈」策略回测（探索版，用于确定阈值）
// 与 backtest-dividend.js（买入侧）分开，独立跑：node backtest-sell.js
//
// 解决的问题：
//  现行策略只有买入提醒（跌破年线 / RSI<30 / 周线 BOLL 下轨），没有卖出规则。
//  用户假设：红利与红利低波在年线上方 7~8% 时，止盈「浮动仓位」、保留底仓。
//
// 口径（与买入侧一致）：
//  - 信号判定用「不复权」价：与行情软件看到的年线 / BOLL / RSI 一致
//  - 收益计算用「全收益」序列：ETF 用前复权(qfq)；价格指数用「价格收益 + 股息再投」近似
//  - 年线 = 50 周收盘均线；RSI = 日K Wilder14 取周末值；周线 BOLL(20,2)
//  - 「卖出是否正确」= 信号后收益 低于 随机基准（负超额 = 卖对了）
//  - 「可回补」= 信号后 26 周内出现过比信号时更低的价格（有更低价格买回的机会）
const fs = require("fs");
const path = require("path");
const https = require("https");

const DIR = __dirname;
const WPY = 50;

// ---------- 数据抓取 ----------
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
function ma(a, n) { if (a.length < n) return null; let s = 0; for (let i = a.length - n; i < a.length; i++) s += a[i]; return s / n; }
function boll(a, n, k) {
  if (a.length < n) return null;
  const w = a.slice(-n);
  const mid = w.reduce((x, y) => x + y, 0) / n;
  const sd = Math.sqrt(w.reduce((x, y) => x + (y - mid) * (y - mid), 0) / n);
  return { mid: mid, upper: mid + k * sd, lower: mid - k * sd };
}
// 逐周 RSI（Wilder14），O(n) 增量实现，避免超长样本 O(n^2)
function rsiWeekly(dayCloses, dayDates, weekDates, n) {
  n = n || 14;
  const out = new Array(weekDates.length).fill(null);
  let wi = 0, cnt = 0, gain = 0, loss = 0, prev = null;
  const buf = [];
  for (let i = 0; i < dayCloses.length; i++) {
    while (wi < weekDates.length && dayDates[i] > weekDates[wi]) {
      out[wi] = cnt >= n ? (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)) : null;
      wi++;
    }
    const c = dayCloses[i];
    if (prev != null) {
      const d = c - prev;
      if (cnt < n) {
        buf.push(d); cnt++;
        if (cnt === n) {
          gain = buf.reduce((a, b) => a + (b > 0 ? b : 0), 0) / n;
          loss = buf.reduce((a, b) => a + (b < 0 ? -b : 0), 0) / n;
        }
      } else {
        gain = (gain * (n - 1) + (d > 0 ? d : 0)) / n;
        loss = (loss * (n - 1) + (d < 0 ? -d : 0)) / n;
      }
    }
    prev = c;
  }
  while (wi < weekDates.length) { out[wi] = cnt >= n ? (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)) : null; wi++; }
  return out;
}
function avg(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
function median(a) { const s = a.slice().sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function r2(v, d) { return v == null || !isFinite(v) ? null : Number(v.toFixed(d == null ? 2 : d)); }
// 锚定法历史股息率：dy(t) = dy_now × (P_now/P_t) × (1+g)^(-年数)
function dyHist(prices, dyNow, g) {
  const n = prices.length, last = prices[n - 1], out = [];
  for (let i = 0; i < n; i++) {
    const yb = (n - 1 - i) / WPY;
    out.push(prices[i] ? dyNow * (last / prices[i]) * Math.pow(1 + g, -yb) : null);
  }
  return out;
}

// ---------- 构造一条腿 ----------
// opt: { name, code, note, dyNow, dpsGrowth, isIndex }
//   isIndex=true  时没有可交易 ETF 的前复权序列，用「价格收益 + 股息/50」近似全收益
function build(name, code, note, wRaw, wQfq, dRaw, opt) {
  const dates = wRaw.map((r) => r.d);
  const rawC = wRaw.map((r) => r.c);
  const qfqMap = {}; (wQfq || []).forEach((r) => { qfqMap[r.d] = r.c; });
  const dayCloses = (dRaw || []).map((r) => r.c);
  const dayDates = (dRaw || []).map((r) => r.d);
  const rsis = rsiWeekly(dayCloses, dayDates, dates, 14);

  // 全收益序列 pxq
  const pxq = new Array(dates.length).fill(null);
  if (opt.isIndex) {
    // 价格指数：周收益 = 价格涨跌 + 当周股息（年股息率 / 50）
    const dys = dyHist(rawC, opt.dyNow, opt.dpsGrowth);
    let nav = 1; pxq[0] = nav;
    for (let i = 1; i < dates.length; i++) {
      const pr = rawC[i] / rawC[i - 1] - 1;
      nav = nav * (1 + pr + (dys[i] != null ? dys[i] / 100 / WPY : 0));
      pxq[i] = nav;
    }
  } else {
    for (let i = 0; i < dates.length; i++) pxq[i] = qfqMap[dates[i]] != null ? qfqMap[dates[i]] : null;
  }

  const rows = [];
  for (let i = 0; i < dates.length; i++) {
    const ma50 = i >= 49 ? ma(rawC.slice(i - 49, i + 1), 50) : null;
    const wb = i >= 19 ? boll(rawC.slice(i - 19, i + 1), 20, 2) : null;
    const hi52 = i >= 51 ? Math.max.apply(null, rawC.slice(i - 51, i + 1)) : null;
    const lo52 = i >= 51 ? Math.min.apply(null, rawC.slice(i - 51, i + 1)) : null;
    rows.push({
      d: dates[i], px: rawC[i], pxq: pxq[i],
      ma50: ma50, rsi: rsis[i],
      wkMid: wb ? wb.mid : null, wkUp: wb ? wb.upper : null, wkLow: wb ? wb.lower : null,
      distMA: ma50 ? (rawC[i] / ma50 - 1) * 100 : null,
      distWkUp: wb ? (rawC[i] / wb.upper - 1) * 100 : null,
      distWkMid: wb ? (rawC[i] / wb.mid - 1) * 100 : null,
      ret26: i >= 26 ? (rawC[i] / rawC[i - 26] - 1) * 100 : null,
      ret52: i >= 52 ? (rawC[i] / rawC[i - 52] - 1) * 100 : null,
      pos52: (hi52 && lo52 && hi52 > lo52) ? (rawC[i] - lo52) / (hi52 - lo52) * 100 : null
    });
  }
  const valid = rows.slice(49).filter((r) => r.pxq != null && r.pxq > 0 && r.ma50 != null);
  const dys = dyHist(valid.map((r) => r.px), opt.dyNow, opt.dpsGrowth);
  valid.forEach((r, i) => { r.dy = dys[i]; });
  return { name: name, code: code, note: note, rows: valid, dyNow: opt.dyNow };
}

// ---------- 主流程 ----------
(async function () {
  const jobs = [
    ["csiIdxW", "sh000922", "week", 1200, ""],
    ["csiIdxD", "sh000922", "day", 1600, ""],
    ["e880W", "sh510880", "week", 1200, ""],
    ["e880Wq", "sh510880", "week", 1200, "qfq"],
    ["e880D", "sh510880", "day", 1600, ""],
    ["lvW", "sh512890", "week", 1200, ""],
    ["lvWq", "sh512890", "week", 1200, "qfq"],
    ["lvD", "sh512890", "day", 1600, ""]
  ];
  const D = {};
  for (const [k, c, p, n, fq] of jobs) {
    try { D[k] = await kline(c, p, n, fq); console.log(k, c, p, fq || "raw", "n=" + D[k].length, D[k].length ? D[k][0].d + "~" + D[k][D[k].length - 1].d : ""); }
    catch (e) { console.log(k, "ERR", e.message); D[k] = []; }
    await sleep(200);
  }

  const legs = [
    build("中证红利指数 000922", "sh000922", "价格指数 + 股息再投近似（成分分红按锚定法回推）", D.csiIdxW, null, D.csiIdxD, { isIndex: true, dyNow: 4.28, dpsGrowth: 0.03 }),
    build("红利ETF 510880", "sh510880", "跟踪上证红利 000015，前复权含分红再投", D.e880W, D.e880Wq, D.e880D, { isIndex: false, dyNow: 4.28, dpsGrowth: 0.03 }),
    build("红利低波ETF 512890", "sh512890", "前复权含分红再投", D.lvW, D.lvWq, D.lvD, { isIndex: false, dyNow: 4.39, dpsGrowth: 0.035 })
  ];
  legs.forEach((L) => console.log("\n" + L.name + "：" + L.rows.length + " 周，" + L.rows[0].d + " ~ " + L.rows[L.rows.length - 1].d));

  // ---------- 卖出信号定义 ----------
  const HOLD = [4, 13, 26, 52];
  const COOL = 4;   // 同一轮上涨只算 1 次止盈机会

  function sellSigGrid() {
    const out = [];
    [5, 6, 7, 8, 10, 12, 15].forEach((x) => out.push({ key: "ma" + x, name: "年线上方 ≥" + x + "%", test: (r) => r.distMA != null && r.distMA >= x }));
    out.push({ key: "wkup", name: "周线 BOLL 上轨以上", test: (r) => r.distWkUp != null && r.distWkUp >= 0 });
    out.push({ key: "rsi70", name: "RSI(14) > 70（超买）", test: (r) => r.rsi != null && r.rsi > 70 });
    out.push({ key: "pos90", name: "52 周位置 > 90%", test: (r) => r.pos52 != null && r.pos52 > 90 });
    out.push({ key: "r2620", name: "近 26 周涨 ≥20%", test: (r) => r.ret26 != null && r.ret26 >= 20 });
    [8, 10, 12].forEach((x) => out.push({ key: "ma" + x + "rsi", name: "年线上方 ≥" + x + "% 且 RSI>60", test: (r) => r.distMA != null && r.distMA >= x && r.rsi != null && r.rsi > 60 }));
    [8, 10, 12].forEach((x) => out.push({ key: "ma" + x + "wkup", name: "年线上方 ≥" + x + "% 且 周线 BOLL 上轨以上", test: (r) => r.distMA != null && r.distMA >= x && r.distWkUp != null && r.distWkUp >= 0 }));
    return out;
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
  // 卖出信号事件：上升沿触发（false -> true），冷却 4 周
  function sellEvents(rows, test) {
    const evs = []; let lastEv = -999;
    for (let i = 1; i < rows.length; i++) {
      if (!test(rows[i - 1]) && test(rows[i]) && (i - lastEv) > COOL) {
        const e = { i: i, d: rows[i].d, px: rows[i].px, distMA: rows[i].distMA, rsi: rows[i].rsi, ret: {}, back: {} };
        HOLD.forEach((h) => { const j = i + h; e.ret[h] = j < rows.length ? (rows[j].pxq / rows[i].pxq - 1) * 100 : null; });
        // 回补机会：之后 h 周内最低价相对触发价
        HOLD.forEach((h) => {
          let lo = Infinity;
          for (let k = 1; k <= h && i + k < rows.length; k++) lo = Math.min(lo, rows[i + k].px);
          e.back[h] = lo === Infinity ? null : (lo / rows[i].px - 1) * 100;
        });
        // 踏空：52 周内最高价相对触发价
        let hi = -Infinity;
        for (let k = 1; k <= 52 && i + k < rows.length; k++) hi = Math.max(hi, rows[i + k].px);
        e.maxUp = hi === -Infinity ? null : (hi / rows[i].px - 1) * 100;
        evs.push(e); lastEv = i;
      }
    }
    return evs;
  }
  function sellStats(rows, evs, base) {
    const s = { count: evs.length, perYear: evs.length / (rows.length / WPY), hold: {}, years: {} };
    evs.forEach((e) => { const y = e.d.slice(0, 4); s.years[y] = (s.years[y] || 0) + 1; });
    HOLD.forEach((h) => {
      const arr = evs.map((e) => e.ret[h]).filter((v) => v != null);
      s.hold[h] = {
        n: arr.length, avg: avg(arr), med: median(arr),
        win: arr.length ? arr.filter((v) => v > 0).length / arr.length * 100 : null,
        baseAvg: base[h] ? base[h].avg : null,
        excess: (arr.length && base[h]) ? avg(arr) - base[h].avg : null,
        backAvg: avg(evs.map((e) => e.back[h])),
        backRate: arr.length ? evs.filter((e) => e.back[h] != null && e.back[h] < -2).length / evs.filter((e) => e.back[h] != null).length * 100 : null
      };
    });
    s.maxUpAvg = avg(evs.map((e) => e.maxUp));
    return s;
  }

  console.log("\n\n================ 一、卖出信号：触发后收益（负超额 = 卖对了） ================");
  const gridRes = [];
  legs.forEach((L) => {
    const base = baseStats(L.rows);
    console.log("\n### " + L.name + "（" + L.rows[0].d + " ~ " + L.rows[L.rows.length - 1].d + "，" + (L.rows.length / WPY).toFixed(1) + " 年）");
    console.log("    随机基准：后1月 " + r2(base[4].avg) + "% / 后3月 " + r2(base[13].avg) + "% / 后6月 " + r2(base[26].avg) + "% / 后1年 " + r2(base[52].avg) + "%");
    console.log("    信号                         次数 年均  后3月   超额    后6月   超额    后1年   超额   26周可回补率(<-2%)  52周最大踏空");
    sellSigGrid().forEach((sg) => {
      const evs = sellEvents(L.rows, sg.test);
      const st = sellStats(L.rows, evs, base);
      gridRes.push({ leg: L.name, key: sg.key, name: sg.name, st: st });
      console.log("    " + sg.name.padEnd(28) + " " + String(st.count).padStart(3) + " " + st.perYear.toFixed(1).padStart(4) +
        "  " + String(r2(st.hold[13].avg)).padStart(6) + "% " + String(r2(st.hold[13].excess)).padStart(6) + "pp" +
        "  " + String(r2(st.hold[26].avg)).padStart(6) + "% " + String(r2(st.hold[26].excess)).padStart(6) + "pp" +
        "  " + String(r2(st.hold[52].avg)).padStart(6) + "% " + String(r2(st.hold[52].excess)).padStart(6) + "pp" +
        "   " + String(r2(st.hold[26].backRate, 0)).padStart(3) + "%" +
        " (均深 " + String(r2(st.hold[26].backAvg)).padStart(6) + "%)" +
        "  " + String(r2(st.maxUpAvg)).padStart(6) + "%");
    });
  });

  // ---------- 阈值网格：组合层面模拟 ----------
  console.log("\n\n================ 二、组合模拟：加入止盈规则后的年化/回撤 ================");
  const bondY = 1.75, cashRate = 1.5;
  function divLevel(spread) {
    if (spread == null || !isFinite(spread)) return { lv: 2, w: 40 };
    if (spread >= 3.5) return { lv: 5, w: 50 };
    if (spread >= 3.0) return { lv: 4, w: 47 };
    if (spread >= 2.5) return { lv: 3, w: 44 };
    if (spread >= 2.0) return { lv: 2, w: 40 };
    if (spread >= 1.5) return { lv: 1, w: 35 };
    if (spread >= 1.0) return { lv: 0, w: 32 };
    return { lv: -1, w: 30 };
  }
  // 仓位规则：base = 利差档位；买入叠加（沿用现行）；卖出层：
  //   mode = "buy"     ：只买不卖（现行）
  //   mode = "trim"    ：浮仓止盈 → 触发后只留底仓 coreW；回到回补阈值以下解除
  //   mode = "trim2"   ：浮仓止盈 + 底仓止盈（极端时降到 coreW2）
  // 统一的目标仓位规则：买入侧（利差档位 + 重度提醒）与卖出侧（两级止盈 + 迟滞回补）合并
  // cfg = { mode, buyAdd, t1, b1, coreW, t2, b2, coreW2, dyn }
  //   dyn: 止盈阈值随利差档位浮动 —— 便宜时晚卖（阈值高），贵时早卖（阈值低）
  function targetAt(r, cfg, state) {
    const spread = r.dy != null ? r.dy - bondY : null;
    const lv = divLevel(spread);
    let base = cfg.fixedW != null ? cfg.fixedW : lv.w / 100;
    let buyAdd = 0;
    if (r.wkLow != null && r.px <= r.wkLow) buyAdd += cfg.buyAdd == null ? 0.05 : cfg.buyAdd;
    let target = Math.max(0.30, Math.min(0.50, base + buyAdd));
    let t1 = cfg.t1, t2 = cfg.t2;
    if (cfg.dyn) {   // 利差越宽（越便宜）阈值越高：不轻易在便宜时下车
      t1 = spread == null ? cfg.t1 : (spread >= 3.0 ? cfg.t1 + 4 : (spread >= 2.0 ? cfg.t1 : Math.max(4, cfg.t1 - 3)));
      if (cfg.t2 != null) t2 = cfg.t2 + (t1 - cfg.t1);
    }
    const d = r.distMA;
    const hot = r.distWkUp != null && r.distWkUp >= 0;   // 周线 BOLL 上轨以上（过热确认）
    if (cfg.mode !== "buy" && d != null) {
      if (cfg.t2 != null && t2 != null && d >= t2 && (cfg.t2NeedHot ? (hot || (r.rsi != null && r.rsi > 70)) : true)) state = 2;
      else if (d >= t1) { if (state < 1) state = 1; }
      else if (d <= (cfg.b1 != null ? cfg.b1 : Math.max(2, Math.round(t1 * 0.4)))) state = 0;
      else if (cfg.t2 != null && state === 2 && d <= (cfg.b2 != null ? cfg.b2 : Math.round(t2 * 0.45))) state = 1;
      if (cfg.t2 != null && state === 2 && !hot && cfg.t2NeedHot && !(r.rsi != null && r.rsi > 70)) state = 1;
    }
    if (cfg.mode !== "buy") {
      if (state === 1) target = Math.min(target, cfg.coreW == null ? 0.30 : cfg.coreW);
      if (state === 2) target = Math.min(target, cfg.coreW2 == null ? 0.20 : cfg.coreW2);
    }
    return { w: target, state: state, lv: lv, base: base + buyAdd };
  }
  function sim2(rows, cfg) {
    const cashW = cashRate / 100 / WPY;
    const series = [1]; const wS = [];
    let nav = 1, state = 0, w = null, prevW = null, adds = 0, cuts = 0;
    let trimWeeks = 0, trimDeepWeeks = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const o = targetAt(r, cfg, state);
      state = o.state;
      if (w == null) w = o.w;
      if (i > 0) nav = nav * (1 + w * (rows[i].pxq / rows[i - 1].pxq - 1) + (1 - w) * cashW);
      series.push(nav);
      w = o.w; wS.push(w);
      if (state >= 1) trimWeeks++;
      if (state === 2) trimDeepWeeks++;
      if (prevW != null) { if (w > prevW + 0.019) adds++; if (w < prevW - 0.019) cuts++; }
      prevW = w;
    }
    let mdd = 0, peak = series[0];
    for (let i = 0; i < series.length; i++) { peak = Math.max(peak, series[i]); mdd = Math.min(mdd, series[i] / peak - 1); }
    const yrs = (series.length - 1) / WPY;
    const cagr = (Math.pow(series[series.length - 1] / series[0], 1 / yrs) - 1) * 100;
    const rets = [];
    for (let i = 1; i < series.length; i++) rets.push(series[i] / series[i - 1] - 1);
    const mu = avg(rets);
    const sd = Math.sqrt(avg(rets.map((x) => (x - mu) * (x - mu))));
    const vol = sd * Math.sqrt(WPY) * 100;
    return { cagr: cagr, mdd: mdd * 100, vol: vol, sharpe: sd > 0 ? (mu * WPY - cashRate / 100) / (sd * Math.sqrt(WPY)) : null, avgW: avg(wS), adds: adds, cuts: cuts, total: (series[series.length - 1] - 1) * 100, trimPct: trimWeeks / rows.length * 100, trimDeepPct: trimDeepWeeks / rows.length * 100 };
  }

  legs.forEach((L) => {
    const base = sim2(L.rows, { mode: "buy", buyAdd: 0.05 });
    console.log("\n### " + L.name + "（" + (L.rows.length / WPY).toFixed(1) + " 年）");
    console.log("    现行（只买不卖）        年化 " + base.cagr.toFixed(2) + "%  回撤 " + base.mdd.toFixed(1) + "%  平均仓位 " + (base.avgW * 100).toFixed(1) + "%  加/减仓 " + base.adds + "/" + base.cuts);
    const cfgs = [];
    // ① 静态单级：只做浮仓止盈，留底仓 30%
    [5, 7, 8, 10, 12].forEach((t1) => cfgs.push({ n: "浮仓止盈 年线+" + t1 + "%（回补+" + Math.max(2, Math.round(t1 * 0.4)) + "%，留 30%）", cfg: { mode: "trim", t1: t1, b1: Math.max(2, Math.round(t1 * 0.4)), coreW: 0.30, buyAdd: 0.05 } }));
    // ② 静态两级：浮仓 + 底仓（过热确认：年线上方 t1 且周线 BOLL 上轨以上 → 降到 20%）
    [[8, 16], [8, 20], [10, 20]].forEach(([t1, t2]) => cfgs.push({ n: "两级 浮仓+" + t1 + "%/底仓+" + t2 + "%+上轨（回补 " + Math.max(2, Math.round(t1 * 0.4)) + "/" + Math.round(t2 * 0.45) + "）", cfg: { mode: "trim", t1: t1, b1: Math.max(2, Math.round(t1 * 0.4)), t2: t2, b2: Math.round(t2 * 0.45), coreW: 0.30, coreW2: 0.20, t2NeedHot: true, buyAdd: 0.05 } }));
    // ③ 动态阈值：便宜时晚卖（+4pp 阈值）、贵时早卖（−3pp）
    [6, 8, 10].forEach((t1) => cfgs.push({ n: "动态阈值 基准+" + t1 + "%（贵→" + Math.max(4, t1 - 3) + "%/便宜→" + (t1 + 4) + "%）", cfg: { mode: "trim", t1: t1, b1: Math.max(2, Math.round(t1 * 0.4)), coreW: 0.30, dyn: true, buyAdd: 0.05 } }));
    [8, 10].forEach((t1) => cfgs.push({ n: "动态阈值+两级 基准+" + t1 + "%", cfg: { mode: "trim", t1: t1, b1: Math.max(2, Math.round(t1 * 0.4)), t2: t1 + 8, b2: Math.round((t1 + 8) * 0.45), coreW: 0.30, coreW2: 0.20, t2NeedHot: true, dyn: true, buyAdd: 0.05 } }));
    // ④ 对照组：固定 40% 不调仓（去掉利差档位），单独检验「止盈」的增量价值
    const f40 = sim2(L.rows, { mode: "buy", fixedW: 0.40, buyAdd: 0 });
    console.log("    ---- 对照：固定 40% 不调仓（无利差档位） 年化 " + f40.cagr.toFixed(2) + "% 回撤 " + f40.mdd.toFixed(1) + "%");
    [[8], [10]].forEach(([t1]) => {
      const m1 = sim2(L.rows, { mode: "trim", fixedW: 0.40, buyAdd: 0, t1: t1, b1: Math.max(2, Math.round(t1 * 0.4)), coreW: 0.30 });
      const m2 = sim2(L.rows, { mode: "trim", fixedW: 0.40, buyAdd: 0, t1: t1, b1: Math.max(2, Math.round(t1 * 0.4)), coreW: 0.30, dyn: true });
      console.log("        固定40% + 浮仓止盈 年线+" + t1 + "%        年化 " + m1.cagr.toFixed(2) + "%（" + (m1.cagr - f40.cagr >= 0 ? "+" : "") + (m1.cagr - f40.cagr).toFixed(2) + "pp） 回撤 " + m1.mdd.toFixed(1) + "%（" + (m1.mdd - f40.mdd >= 0 ? "+" : "") + (m1.mdd - f40.mdd).toFixed(1) + "pp） 平均仓 " + (m1.avgW * 100).toFixed(1) + "%");
      console.log("        固定40% + 动态止盈 基准+" + t1 + "%       年化 " + m2.cagr.toFixed(2) + "%（" + (m2.cagr - f40.cagr >= 0 ? "+" : "") + (m2.cagr - f40.cagr).toFixed(2) + "pp） 回撤 " + m2.mdd.toFixed(1) + "%（" + (m2.mdd - f40.mdd >= 0 ? "+" : "") + (m2.mdd - f40.mdd).toFixed(1) + "pp） 平均仓 " + (m2.avgW * 100).toFixed(1) + "%");
    });
    cfgs.forEach((c) => {
      const m = sim2(L.rows, c.cfg);
      console.log("    " + c.n.padEnd(40) + " 年化 " + m.cagr.toFixed(2) + "%（" + (m.cagr - base.cagr >= 0 ? "+" : "") + (m.cagr - base.cagr).toFixed(2) + "pp） 回撤 " + m.mdd.toFixed(1) + "%（" + (m.mdd - base.mdd >= 0 ? "+" : "") + (m.mdd - base.mdd).toFixed(1) + "pp） 平均仓 " + (m.avgW * 100).toFixed(1) + "% 加/减 " + m.adds + "/" + m.cuts + " 止盈态占比 " + m.trimPct.toFixed(0) + "%（深 " + m.trimDeepPct.toFixed(0) + "%）");
    });
  });

  // ---------- 收集结构化结果 ----------
  const RULE = {
    // 采纳规则（2026-10-09 定稿）：动态阈值两级止盈
    desc: "浮仓止盈（只留底仓 30%）+ 底仓止盈（降到 20%）+ 迟滞回补",
    t1Base: 8, t1Mid: 8, t1Cheap: 12, t1Rich: 5,      // 中性 8%；利差≥3.0pp 放宽到 12%；利差<2.0pp 收紧到 5%
    backRatio: 0.4,                          // 回补阈值 = t1 × 0.4（最低 2%）
    coreW: 30, coreW2: 20,
    t2Delta: 8, t2BackRatio: 0.45,           // 底仓止盈阈值 = t1 + 8%，回补 = ×0.45
    t2Cond: "周线 BOLL 上轨以上 或 RSI(14)>70"
  };
  const OUT = {
    meta: {
      generatedAt: new Date().toISOString().slice(0, 10),
      bondY: bondY, cashRate: cashRate, note:
        "信号判定用不复权价（与行情软件一致）；收益用全收益序列（ETF 前复权 / 价格指数加股息再投近似）；" +
        "年线=50周均线；RSI=日K Wilder14 取周末值；周线BOLL(20,2)；冷却4周；不计交易成本。",
      caveat: "中证红利指数 000922 为价格指数 + 股息再投近似（股息率由锚定法回推，绝对值有偏差）；" +
        "510880 跟踪上证红利 000015、512890 跟踪红利低波，与页面实际持仓标的不完全相同，仅作长样本交叉验证。",
      reach: "日K 接口最多返回 1600 根（约 6.4 年），故 RSI 仅在最近 6 年有效。"
    },
    legs: [], sim: [], rule: RULE
  };
  legs.forEach((L) => {
    const base = baseStats(L.rows);
    OUT.legs.push({
      key: L.code, name: L.name, code: L.code, note: L.note,
      start: L.rows[0].d, end: L.rows[L.rows.length - 1].d,
      weeks: L.rows.length, years: Number((L.rows.length / WPY).toFixed(1)),
      base: base,
      signals: sellSigGrid().map((sg) => {
        const evs = sellEvents(L.rows, sg.test);
        const st = sellStats(L.rows, evs, base);
        // 事件明细不写入产物：页面不展示，且会让单文件版增大约 200KB
        return { key: sg.key, name: sg.name, stat: st };
      })
    });
  });
  // 组合模拟：固定方案集（含现行 / 采纳规则 / 主要对照），在三条腿上各跑一遍
  const SIM_DEFS = [
    { key: "buy", n: "现行：只买不卖（利差档位 + 重度提醒）", cfg: { mode: "buy", buyAdd: 0.05 } },
    { key: "trim8", n: "浮仓止盈 固定 年线+8%（留底仓 30%）", cfg: { mode: "trim", t1: 8, b1: 3, coreW: 0.30, buyAdd: 0.05 } },
    { key: "dyn8", n: "浮仓止盈 动态阈值 基准+8%（贵5 / 中8 / 便宜12）", cfg: { mode: "trim", t1: 8, b1: 3, coreW: 0.30, dyn: true, buyAdd: 0.05 } },
    { key: "adopt", n: "★采纳：动态阈值 + 两级（浮仓30 / 底仓20）", cfg: { mode: "trim", t1: 8, b1: 3, t2: 16, b2: 7, coreW: 0.30, coreW2: 0.20, t2NeedHot: true, dyn: true, buyAdd: 0.05 } },
    { key: "f40", n: "对照：固定 40% 不调仓", cfg: { mode: "buy", fixedW: 0.40, buyAdd: 0 } },
    { key: "f40trim", n: "对照：固定 40% + 浮仓止盈 年线+8%", cfg: { mode: "trim", fixedW: 0.40, buyAdd: 0, t1: 8, b1: 3, coreW: 0.30 } }
  ];
  OUT.sim = SIM_DEFS.map((d) => {
    const rows = legs.map((L) => {
      const m = sim2(L.rows, d.cfg);
      return { leg: L.code, cagr: r2(m.cagr), mdd: r2(m.mdd), vol: r2(m.vol), sharpe: r2(m.sharpe), avgW: r2(m.avgW * 100, 1), adds: m.adds, cuts: m.cuts, trimPct: r2(m.trimPct, 0), trimDeepPct: r2(m.trimDeepPct, 0) };
    });
    const base = sim2(legs[0].rows, SIM_DEFS[0].cfg);
    const baseF40 = sim2(legs[0].rows, SIM_DEFS[4].cfg);
    rows.forEach((r, i) => {
      const ref = sim2(legs[i].rows, SIM_DEFS[0].cfg);
      r.dCagr = r2(r.cagr - ref.cagr); r.dMdd = r2(r.mdd - ref.mdd);
      const rf = sim2(legs[i].rows, SIM_DEFS[4].cfg);
      r.dCagrVsF40 = r2(r.cagr - rf.cagr); r.dMddVsF40 = r2(r.mdd - rf.mdd);
    });
    return { key: d.key, name: d.n, rows: rows };
  });
  fs.writeFileSync(path.join(DIR, "data", "divbt-sell.js"),
    "// 红利「卖出 / 止盈」策略回测（自动生成，勿手改）\n// 生成脚本：backtest-sell.js | 数据源：腾讯公开行情 web.ifzq.gtimg.cn\nwindow.DIVBT_SELL = " + JSON.stringify(OUT, null, 1) + ";\n");
  console.log("\nWROTE data/divbt-sell.js");

  fs.writeFileSync(path.join(DIR, "data", "sell-grid.json"), JSON.stringify(gridRes, null, 1));
})();
