// 抓取宽基指数的「历史市盈率 + 分位 + 股债性价比」，供新「宽基指数」页与低估定投提醒使用。
// 数据源：中证指数官网 csindex-home/perf/index-perf（每日收盘 close + 滚动市盈率 peg，官方口径）
//   例：https://www.csindex.com.cn/csindex-home/perf/index-perf?indexCode=000300&startDate=20160101&endDate=20261125
// 产出：data/index.js = window.BROAD
//
// 口径说明（与站内其它页保持一致）：
//   · 分位 = 历史日频 PE 序列中「≤ 当前 PE」的占比（0=最便宜、100=最贵），与 refresh-data.js pctOfSeries 同式
//   · 10 年为主口径，5 年 / 3 年 / 1 年为辅助；样本不足 3 年（750 交易日）标 sampleShort，不给档位结论
//   · ERP（股债性价比）= 盈利收益率 100/PE − 中国 10Y 国债收益率，单位百分点；越大越有吸引力
//   · 52 周位置 = (现价 − 近 1 年最低) / (近 1 年最高 − 近 1 年最低)
//   · peHist 为「月末最后一个交易日」采样，仅用于页面画 10 年 PE 走势，不参与分位计算
//
// 降级：任一指数请求失败或有效样本 < 100 条 → 保留现有 data/index.js 不覆盖（打印警告），避免云端偶发网络失败把快照冲空。
const fs = require("fs");
const path = require("path");
const https = require("https");

const DIR = __dirname;
const OUT = path.join(DIR, "data", "index.js");
const RAW = path.join(DIR, "data", "index-raw.json");

// 6 个宽基 + 各自场内可投 ETF（代码均已在 qt.gtimg.cn 验证）
const IDX = [
  { code: "000300", name: "沪深300",  qt: "sh000300", etf: "sh510300", etfName: "沪深300ETF",  cat: "大盘蓝筹" },
  { code: "000905", name: "中证500",  qt: "sh000905", etf: "sh510500", etfName: "中证500ETF",  cat: "中盘" },
  { code: "000906", name: "中证800",  qt: "sh000906", etf: "sh515800", etfName: "中证800ETF",  cat: "大中盘" },
  { code: "000852", name: "中证1000", qt: "sh000852", etf: "sh512100", etfName: "中证1000ETF", cat: "小盘" },
  { code: "000016", name: "上证50",   qt: "sh000016", etf: "sh510050", etfName: "上证50ETF",   cat: "超大盘价值" },
  { code: "000688", name: "科创50",   qt: "sh000688", etf: "sh588000", etfName: "科创50ETF",   cat: "科创成长" }
];

// 定投档位表：前端页面与 alert-check.js 共用此表（唯一真源，避免两处口径漂移）
const LADDER = [
  { max: 20,  level: 0, label: "显著低估", mult: 2.0, action: "加倍扣款" },
  { max: 40,  level: 1, label: "偏低估",   mult: 1.5, action: "加一份" },
  { max: 60,  level: 2, label: "适中",     mult: 1.0, action: "正常扣款" },
  { max: 80,  level: 3, label: "偏高",     mult: 0.5, action: "减半扣款" },
  { max: 100, level: 4, label: "高估",     mult: 0,   action: "暂停定投，只持有" }
];

// 定投标的推荐（每指数 2 只场内 ETF + 2 只场外联接 A 类）：
// 由 fetch-index-funds.js 季度复核生成 index-funds-src.json（费率 / 规模 / 实测跟踪误差），
// 静态快照内联进 BROAD.funds，不随每日行情刷新；页面「宽基指数 → 定投标的推荐」读取。
const FUNDS = JSON.parse(fs.readFileSync(path.join(DIR, "index-funds-src.json"), "utf8"));

const START = "20160101";
const MIN_SAMPLE = 750;   // ≈3 年交易日，低于此不给定投档位结论

function todayStr() {
  const d = new Date();
  return String(d.getFullYear()) + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
}
function shiftYear(ymd, n) {
  return String(Number(ymd.slice(0, 4)) - n) + ymd.slice(4);
}
function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      const bufs = [];
      res.on("data", (d) => bufs.push(d));
      res.on("end", () => resolve(Buffer.concat(bufs).toString("utf8")));
    });
    req.setTimeout(45000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}
async function fetchIndex(code, end, retry) {
  const url = "https://www.csindex.com.cn/csindex-home/perf/index-perf?indexCode=" + code +
    "&startDate=" + START + "&endDate=" + end;
  for (let i = 0; i <= retry; i++) {
    try {
      const txt = await get(url);
      const j = JSON.parse(txt);
      const d = (j && j.data) || [];
      if (d.length >= 100) return d;
      throw new Error("样本仅 " + d.length + " 条");
    } catch (e) {
      if (i === retry) throw e;
      await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
    }
  }
}
function pctOf(series, v) {
  if (!series.length || v == null || !isFinite(v)) return null;
  let le = 0;
  for (let i = 0; i < series.length; i++) if (series[i] <= v) le++;
  return Math.round(le / series.length * 1000) / 10;
}
function quantile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))];
}
function bond10y() {
  // 与红利策略共用同一个国债锚（data/asset.js）
  try {
    const g = { window: {} };
    new Function("window", fs.readFileSync(path.join(DIR, "data", "asset.js"), "utf8"))(g.window);
    const v = g.window.ASSET && g.window.ASSET.bond10y && g.window.ASSET.bond10y.v;
    return (typeof v === "number" && v > 0) ? v : 1.75;
  } catch (e) { return 1.75; }
}

(async function () {
  const end = todayStr();
  const bond = bond10y();
  const list = [], raw = {};
  for (const ix of IDX) {
    let d;
    try { d = await fetchIndex(ix.code, end, 2); }
    catch (e) {
      console.error("✗ " + ix.name + " 拉取失败：" + e.message);
      console.error("  保留现有 data/index.js 不覆盖（本次不更新快照）");
      process.exit(0);
    }
    raw[ix.code] = d.length;
    const arr = d.filter((x) => x && typeof x.peg === "number" && x.peg > 0 && x.close > 0)
      .sort((a, b) => String(a.tradeDate).localeCompare(String(b.tradeDate)));
    if (arr.length < 100) {
      console.error("✗ " + ix.name + " 有效样本仅 " + arr.length + " 条，保留现有快照");
      process.exit(0);
    }
    const last = arr[arr.length - 1], asOf = String(last.tradeDate);
    const pe = last.peg, close = last.close;
    const since = (n) => arr.filter((x) => x.tradeDate >= shiftYear(asOf, n));
    const h10 = arr.map((x) => x.peg);
    const h5 = since(5).map((x) => x.peg), h3 = since(3).map((x) => x.peg), h1 = since(1).map((x) => x.peg);
    const sorted = [...h10].sort((a, b) => a - b);
    const peStats = {
      min: Math.round(sorted[0] * 100) / 100,
      p25: Math.round(quantile(sorted, 0.25) * 100) / 100,
      med: Math.round(quantile(sorted, 0.5) * 100) / 100,
      p75: Math.round(quantile(sorted, 0.75) * 100) / 100,
      max: Math.round(sorted[sorted.length - 1] * 100) / 100
    };
    // 月末采样（10 年 PE 走势）
    const monthMap = new Map();
    for (const x of arr) monthMap.set(String(x.tradeDate).slice(0, 6), Math.round(x.peg * 100) / 100);
    const peHist = [...monthMap.entries()].map(([ym, v]) => [ym.slice(0, 4) + "-" + ym.slice(4), v]);
    // 52 周位置 / 区间涨跌
    const win1 = since(1);
    const hi52 = Math.max(...win1.map((x) => x.close)), lo52 = Math.min(...win1.map((x) => x.close));
    const pos52 = (hi52 > lo52) ? Math.round((close - lo52) / (hi52 - lo52) * 100) : null;
    const yrAgo = win1[0];
    const chg1y = (yrAgo && yrAgo.close > 0) ? Math.round((close / yrAgo.close - 1) * 1000) / 10 : null;
    const w60 = arr.slice(-61);
    const chg60d = (w60.length > 1 && w60[0].close > 0) ? Math.round((close / w60[0].close - 1) * 1000) / 10 : null;
    const p10 = pctOf(h10, pe);
    const sampleShort = arr.length < MIN_SAMPLE;
    let tierIdx = null;
    if (!sampleShort && p10 != null) {
      tierIdx = LADDER.findIndex((t) => p10 <= t.max);
      if (tierIdx < 0) tierIdx = LADDER.length - 1;
    }
    list.push({
      code: ix.code, name: ix.name, qt: ix.qt, etf: ix.etf, etfName: ix.etfName, cat: ix.cat,
      asOf: asOf.slice(0, 4) + "-" + asOf.slice(4, 6) + "-" + asOf.slice(6, 8),
      close: Math.round(close * 100) / 100,
      chg: (typeof last.changePct === "number") ? Math.round(last.changePct * 100) / 100 : null,
      pe: Math.round(pe * 100) / 100,
      pePct10y: p10,
      pePct5y: pctOf(h5, pe),
      pePct3y: pctOf(h3, pe),
      pePct1y: pctOf(h1, pe),
      peStats: peStats,
      peHist: peHist,
      erp: Math.round((100 / pe - bond) * 100) / 100,
      pos52: pos52,
      chg1y: chg1y,
      chg60d: chg60d,
      sampleDays: arr.length,
      sampleFrom: arr[0].tradeDate,
      sampleShort: sampleShort,
      tierIdx: tierIdx
    });
    console.log("✓ " + ix.name + " PE " + pe + " · 10y分位 " + p10 + "% · ERP " + (100 / pe - bond).toFixed(2) +
      "pp · 样本 " + arr.length + "日" + (sampleShort ? "（样本不足，不定档）" : ""));
  }
  const asOf = list[0].asOf;
  const out = {
    generatedAt: asOf,
    asOf: asOf,
    source: "中证指数官网 index-perf（每日收盘 + 滚动市盈率 peg）｜国债锚 data/asset.js bond10y",
    bond10y: bond,
    minSampleDays: MIN_SAMPLE,
    ladder: LADDER,
    funds: FUNDS,
    list: list
  };
  fs.writeFileSync(OUT, "// 宽基指数估值与定投档位（自动生成，勿手改）\n" +
    "// 生成脚本：fetch-index.js ｜ 数据源：中证指数官网 + data/asset.js 国债锚\n" +
    "window.BROAD = " + JSON.stringify(out, null, 1) + ";\n");
  try { fs.writeFileSync(RAW, JSON.stringify({ asOf: asOf, rawCounts: raw })); } catch (e) {}
  console.log("→ 写出 " + OUT + "（" + list.length + " 个指数，锚 " + asOf + "）");
})().catch((e) => {
  console.error("✗ fetch-index 失败：" + e.message + "；保留现有 data/index.js 不覆盖");
  process.exit(0);   // 不阻断每日刷新链
});
