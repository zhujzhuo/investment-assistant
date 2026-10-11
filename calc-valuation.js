// 计算「历史估值百分位」：真实财报(EPSTTM/BasicEPS/NAPS) + 不复权月K
// 关键方法：以行情接口的权威当前 PE/PB/股息率为「锚」，按盈利与净资产、价格的相对变化回推历史序列，
//          规避港股财年口径(如阿里3月结)与币种差异导致的系统性偏差，且天然支持实时价联动。
// 输出 data/valuation.js（window.VAL）
// 用法: node calc-valuation.js
const fs = require("fs");
const path = require("path");
const DIR = __dirname;

const dataSrc = fs.readFileSync(path.join(DIR, "data.js"), "utf8");
const sb = { window: {} };
new Function("window", dataSrc + "\n")(sb.window);
const S = {};
(sb.window.STOCKS || []).forEach(s => { S[s.code] = s; });

const EPS = JSON.parse(fs.readFileSync(path.join(DIR, "data/eps-history.json"), "utf8"));
const NAPS = JSON.parse(fs.readFileSync(path.join(DIR, "data/naps-history.json"), "utf8"));
const KL = JSON.parse(fs.readFileSync(path.join(DIR, "data/month-kline.json"), "utf8"));
const MKT = sb.window.MKT || { asOfA: "2026-09-30", asOfHK: "2026-10-02" };
const TODAY = "2026-10-08";

// 月K 最后一根是「当前未走完的月份」，不能与快照价混用：
// 按各市场快照日截断，保证序列末尾与 px0/pe0 锚定在同一时点。
function cutoffOf(snap) { return (snap.mkt === "HK" ? MKT.asOfHK : MKT.asOfA).slice(0, 7); }
function snapDateOf(snap) { return snap.mkt === "HK" ? MKT.asOfHK : MKT.asOfA; }

// 累计口径 -> 滚动12个月
function toTTM(rows, isHK) {
  const cum = {}, meta = {};
  rows.forEach(r => {
    if (r.eps == null || !r.d) return;
    const ym = r.d.slice(0, 7);
    cum[ym] = Number(r.eps);
    meta[ym] = { pub: r.pub || null, mm: r.d.slice(5, 7), year: r.d.slice(0, 4) };
  });
  const out = [];
  Object.keys(cum).sort().forEach(ym => {
    const m = meta[ym];
    let ttm = null;
    if (!isHK) ttm = cum[ym];
    else if (m.mm === "12") ttm = cum[ym];
    else {
      const ly = String(Number(m.year) - 1);
      const a = cum[ly + "-12"], b = cum[ly + "-" + m.mm];
      if (a != null && b != null) ttm = cum[ym] + a - b;
    }
    if (ttm == null) return;
    let avail = m.pub;
    if (!avail) {
      const dt = new Date(ym + "-01T00:00:00Z");
      dt.setUTCDate(dt.getUTCDate() + 92);
      avail = dt.toISOString().slice(0, 10);
    }
    out.push({ end: ym, avail: avail, v: ttm });
  });
  return out.sort((a, b) => a.avail.localeCompare(b.avail));
}

// 时点值序列（NAPS 无需 TTM 转换）
function toSeries(rows, key) {
  const out = [];
  rows.forEach(r => {
    if (r[key] == null || !r.d) return;
    let avail = r.pub;
    if (!avail) {
      const dt = new Date(r.d.slice(0, 7) + "-01T00:00:00Z");
      dt.setUTCDate(dt.getUTCDate() + 92);
      avail = dt.toISOString().slice(0, 10);
    }
    out.push({ end: r.d.slice(0, 7), avail: avail, v: Number(r[key]) });
  });
  return out.sort((a, b) => a.avail.localeCompare(b.avail));
}

function latestBy(series, date) {
  let use = null;
  for (let i = 0; i < series.length; i++) {
    if (series[i].avail <= date) use = series[i]; else break;
  }
  return use;
}
function q(sorted, p) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * p, lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function statsOf(vals) {
  const s = vals.slice().sort((a, b) => a - b);
  return { min: r2(s[0]), p25: r2(q(s, .25)), med: r2(q(s, .5)), p75: r2(q(s, .75)), max: r2(s[s.length - 1]), n: s.length };
}
function r2(v) { return v == null ? null : Math.round(v * 100) / 100; }
function pctOf(sorted, v) {
  if (!sorted.length || v == null) return null;
  let le = 0;
  for (let i = 0; i < sorted.length; i++) if (sorted[i] <= v) le++;
  return Math.round(le / sorted.length * 1000) / 10;
}

const VAL = {}, log = [];

Object.keys(KL.data).forEach(code => {
  const snap = S[code];
  let kl = KL.data[code] || [];
  if (!snap || !kl.length) return;
  const cut = cutoffOf(snap), snapDate = snapDateOf(snap);
  kl = kl.filter(k => k.d.slice(0, 7) <= cut);      // 丢弃快照月之后的未走完月份
  if (kl.length < 12) { log.push([code, (snap.name || code), "月K 不足 12 个月（" + kl.length + "），跳过"].join(" | ")); return; }
  const isHK = snap.mkt === "HK";
  const epsS = toTTM(EPS.data[code] || [], isHK);
  const napsS = toSeries(NAPS.data[code] || [], "naps");
  const epsRows = EPS.data[code] || [];

  const px0 = snap.px;                    // 快照价（锚定基准）
  const epsNow = latestBy(epsS, snapDate);   // 快照日可得的最新 TTM EPS（不用今天，避免用到尚未披露的财报）
  const napsNow = latestBy(napsS, snapDate);
  const divNowAmt = (epsRows.find(r => r.div != null) || {}).div;

  const peH = [], pbH = [], dyH = [], pxH = [];
  kl.forEach(k => {
    const ym = k.d.slice(0, 7);
    pxH.push([ym, Math.round(k.c * 1000) / 1000]);
    const e = latestBy(epsS, k.d), n = latestBy(napsS, k.d);

    // PE：以快照 PE 为锚，按「价格比 × EPS 反比」回推
    if (snap.pe > 0 && epsNow && e && e.v > 0) {
      const pe = snap.pe * (k.c / px0) * (epsNow.v / e.v);
      if (isFinite(pe) && pe > 0) peH.push([ym, r2(pe)]);
    }
    // PB：以快照 PB 为锚，按「价格比 × 每股净资产反比」回推
    if (snap.pb > 0 && napsNow && n && n.v > 0) {
      const pb = snap.pb * (k.c / px0) * (napsNow.v / n.v);
      if (isFinite(pb) && pb > 0) pbH.push([ym, r2(pb)]);
    }
    // 股息率：以快照股息率为锚，按「分红金额比 × 价格反比」回推
    if (snap.div != null && divNowAmt != null && e) {
      const amt = (epsRows.find(r => r.d && r.d.slice(0, 7) === e.end) || {}).div;
      if (amt != null) {
        const dy = snap.div * (amt / divNowAmt) * (px0 / k.c);
        if (isFinite(dy) && dy >= 0) dyH.push([ym, r2(dy)]);
      }
    }
  });

  const rec = {
    px0: px0, pe0: snap.pe, pb0: snap.pb, div0: snap.div,
    epsTTM: epsNow ? r2(epsNow.v) : null, epsEnd: epsNow ? epsNow.end : null,
    naps: napsNow ? r2(napsNow.v) : null,
    px: pxH, from: pxH[0][0], to: pxH[pxH.length - 1][0],
    note: isHK ? "港股财报为累计口径(港币)，已换算滚动值并与当前PE/PB校准" : "A股财报 EPSTTM/NAPS，已与当前PE/PB校准"
  };
  if (peH.length >= 12) {
    rec.pe = peH;
    rec.peStats = statsOf(peH.map(p => p[1]));
    rec.peNow = snap.pe;
    rec.pePct = pctOf(peH.map(p => p[1]).sort((a, b) => a - b), snap.pe);
  }
  if (pbH.length >= 12) {
    rec.pb = pbH;
    rec.pbStats = statsOf(pbH.map(p => p[1]));
    rec.pbNow = snap.pb;
    rec.pbPct = pctOf(pbH.map(p => p[1]).sort((a, b) => a - b), snap.pb);
  }
  if (dyH.length >= 12) {
    rec.dy = dyH;
    const vs = dyH.map(p => p[1]);
    rec.dyStats = statsOf(vs);
    rec.dyPct = pctOf(vs.slice().sort((a, b) => a - b), snap.div); // 股息率越高越便宜 → 分位含义相反
  }
  rec.pxStats = statsOf(pxH.map(p => p[1]));
  rec.pxPct = pctOf(pxH.map(p => p[1]).sort((a, b) => a - b), px0);
  VAL[code] = rec;

  log.push([code, snap.name,
    "PE " + (rec.peNow || "-") + " 分位" + (rec.pePct != null ? rec.pePct + "%" : "n/a"),
    "[" + (rec.peStats ? rec.peStats.min + "~" + rec.peStats.max : "-") + "]",
    "PB " + (rec.pbNow || "-") + " 分位" + (rec.pbPct != null ? rec.pbPct + "%" : "n/a"),
    "股息率分位" + (rec.dyPct != null ? rec.dyPct + "%" : "n/a"),
    "价格分位" + rec.pxPct + "%", "n=" + pxH.length].join(" | "));
});

const out = "// 历史估值百分位数据（calc-valuation.js 自动生成，勿手改）\n"
  + "// 口径：以行情接口当前 PE/PB/股息率为锚，结合真实财报(EPSTTM/BasicEPS/NAPS)与不复权月K回推逐月估值序列\n"
  + "// px0/pe0/pb0/div0 = 快照基准；实时价联动公式 curPE = pe0 * (现价/px0)\n"
  + "window.VAL = " + JSON.stringify(VAL) + ";\n";
fs.writeFileSync(path.join(DIR, "data/valuation.js"), out);
console.log(log.join("\n"));
console.log("\nWROTE data/valuation.js  codes=" + Object.keys(VAL).length + "  size=" + (out.length / 1024).toFixed(1) + "KB");
