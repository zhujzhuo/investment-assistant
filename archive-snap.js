#!/usr/bin/env node
// 每日数据快照归档（archive-snap.js）—— 「历史数据」功能的生成端
//
// 做两件事（幂等，同日重跑覆盖当日）：
// ① 紧凑快照合并进 data/snap-all.js（window.SNAPS[日期] = 快照），
//    供页面「🗂 历史留档 → 历史数据（按日期查看）」回看任意一天的行情与名单；
// ② 全量原始数据副本写入 ../investment-assistant-archive/<日期>/（项目目录之外，不随站点发布），
//    供未来基于这些数据写新代码时直接复用（data.js / 各 data/*.js 完整文件级快照）。
//
// 挂载点：gen-baseline.js 末尾（每日 18:00 自动化），保证名单是当日最新归档；
// 也可手动执行：<NODE> archive-snap.js
const fs = require("fs");
const path = require("path");
const DIR = __dirname;
const SNAP_F = path.join(DIR, "data", "snap-all.js");
const ARCHIVE_DIR = path.join(DIR, "..", "investment-assistant-archive");

function load(file, prop) {
  const w = { window: {} };
  new Function("window", fs.readFileSync(path.join(DIR, file), "utf8"))(w.window);
  return w.window[prop];
}

function todayStr() {
  const d = new Date();
  const p2 = n => ("0" + n).slice(-2);
  return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
}

function archive() {
  const STOCKS = load("data.js", "STOCKS");
  const MKT = load("data.js", "MKT");
  const US = load("data/us.js", "US_STOCKS");
  const VAL = load("data/valuation.js", "VAL");
  let BASE = null;
  try { BASE = load("data/baseline.js", "IA_BASELINE"); } catch (e) { /* 基线缺失时名单记 null */ }

  const date = todayStr();

  // ---------- ① 紧凑快照 ----------
  const valPct = {};
  for (const s of STOCKS) {
    const v = VAL[s.code];
    if (v) valPct[s.code] = { pe: v.pePct == null ? null : Math.round(v.pePct), pb: v.pbPct == null ? null : Math.round(v.pbPct) };
  }
  let lists = null;
  if (BASE && BASE.lists) {
    const L = BASE.lists;
    const names = arr => (arr || []).map(x => ({ n: x.name, r: x.reason || (x.dist != null ? "距买点 " + x.dist + "%" : "") }));
    lists = {
      picks: { steady: names(L.picks.steady), growth: names(L.picks.growth), rotate: names(L.picks.rotate), tenx: names(L.picks.tenx) },
      formal: (L.formal && L.formal.picks ? L.formal.picks : []).map(x => ({ n: x.name, d: x.dist, sc: x.score })),
      usPicks: { steady: names(L.usPicks.steady), growth: names(L.usPicks.growth), rotate: names(L.usPicks.rotate), tenx: names(L.usPicks.tenx) },
      pool: {
        AH: (L.pool.stocks || []).map(x => x.name),
        US: (L.pool.us || []).map(x => x.name)
      }
    };
  }
  const snap = {
    date: date,
    asOfA: MKT.asOfA, asOfHK: MKT.asOfHK,
    rfUS: MKT.rfUS ? { v: MKT.rfUS.v, asOf: MKT.rfUS.asOf } : null,
    turnoverYi: MKT.turnoverYi == null ? null : MKT.turnoverYi,
    indices: MKT.indices || [],
    ah: STOCKS.map(s => ({ c: s.code, n: s.name, px: s.px, chg: s.chg, pe: s.pe, peF: s.peF, pb: s.pb, div: s.div, ytd: s.ytd, hi52: s.hi52, lo52: s.lo52 })),
    us: US.map(s => ({ c: s.code, n: s.name, px: s.px, chg: s.chg, pe: s.pe, ytd: s.ytd, pos52: s.pos52, mc: s.mcapYi })),
    valPct: valPct,
    lists: lists
  };

  // 合并进 SNAPS（保留历史日期）
  let SNAPS = {};
  if (fs.existsSync(SNAP_F)) {
    try { SNAPS = load("data/snap-all.js", "SNAPS") || {}; } catch (e) { SNAPS = {}; }
  }
  const kept = {};
  for (const k of Object.keys(SNAPS)) if (k < date) kept[k] = SNAPS[k];   // 只保留更早日期，当日重跑覆盖
  kept[date] = snap;
  const head = "// 每日数据快照归档（archive-snap.js 自动生成，勿手改）\n" +
    "// window.SNAPS[YYYY-MM-DD] = 当日行情与名单紧凑快照；页面「历史数据」按日期回看；\n" +
    "// 全量原始文件级快照在 ../investment-assistant-archive/<日期>/（不随站点发布）\n";
  fs.writeFileSync(SNAP_F, head + "window.SNAPS = " + JSON.stringify(kept) + ";\n", "utf8");

  // ---------- ② 全量原始副本（项目外目录） ----------
  const dayDir = path.join(ARCHIVE_DIR, date);
  fs.mkdirSync(dayDir, { recursive: true });
  const rawFiles = ["data.js", "data/lt.js", "data/valuation.js", "data/baseline.js", "data/us.js",
    "data/asset.js", "data/etf.js", "data/reports.js", "data/snap-all.js"];
  let copied = 0;
  for (const f of rawFiles) {
    const src = path.join(DIR, f);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(dayDir, f.replace(/\//g, "__"));
    fs.copyFileSync(src, dst);
    copied++;
  }

  console.log("快照归档 " + date + "：紧凑快照 " + Object.keys(kept).length + " 天（A股港股 " + snap.ah.length +
    " + 美股 " + snap.us.length + " 只，名单 " + (lists ? "已含" : "缺失") + "）· 原始副本 " + copied + " 个文件 → " + path.relative(DIR, dayDir));
  return true;
}

module.exports = { archive };

if (require.main === module) archive();
