// 实时行情模块自检：模拟腾讯行情接口返回，验证价格/PE/PB/股息联动与降级
const fs = require("fs");
const path = require("path");
const dir = __dirname;
const store = {};

function mkEl(id) {
  return {
    id, style: {}, innerHTML: "", textContent: "", className: "", value: "",
    appendChild() {}, setAttribute() {}, addEventListener() {}
  };
}

// 构造腾讯行情返回串：时间字段必须落在第 30 位（A股 20261004153000 / 港股 2026\/10\/04 16:00:00）
function mkQuote(prefix, name, code, px, prev, open, time, tail) {
  var f = [prefix, name, code, px, prev, open];
  for (var i = 6; i < 30; i++) f.push("0");
  f.push(time);
  return f.concat(tail).join("~") + "~";
}
const FIXTURE = {
  v_sh600519: mkQuote("1", "贵州茅台", "600519", "1300.00", "1258.62", "1260.00", "20261004153000", ["41.38", "3.29", "1310.00", "1250.00"]),
  v_hk00700: mkQuote("100", "腾讯控股", "00700", "450.000", "421.200", "430.000", "2026/10/04 16:00:00", ["28.80", "6.84", "455.000", "425.000"]),
  v_sh000001: mkQuote("1", "上证指数", "000001", "3900.00", "3842.19", "3850.00", "20261004153000", ["57.81", "1.50", "3910.00", "3840.00"]),
  v_sz399001: mkQuote("1", "深证成指", "399001", "13000.00", "12887.62", "12900.00", "20261004153000", ["112.38", "0.87", "13050.00", "12800.00"]),
  v_sz399006: mkQuote("1", "创业板指", "399006", "3200.00", "3135.28", "3150.00", "20261004153000", ["64.72", "2.06", "3210.00", "3130.00"]),
  v_sh000922: mkQuote("1", "中证红利", "000922", "5608.72", "5601.34", "5612.23", "20261012120545", ["7.38", "0.13", "5656.61", "5600.30"]),
  v_sh512890: mkQuote("1", "红利低波ETF华泰柏瑞", "512890", "1.224", "1.208", "1.208", "20261012120535", ["0.016", "1.32", "1.228", "1.207"]),
  v_sh515180: mkQuote("1", "红利ETF易方达", "515180", "1.446", "1.443", "1.443", "20261012120530", ["0.003", "0.21", "1.458", "1.444"]),
  v_sh515080: mkQuote("1", "中证红利ETF招商", "515080", "1.583", "1.578", "1.580", "20261012120531", ["0.005", "0.32", "1.593", "1.577"]),
  v_sh563020: mkQuote("1", "红利低波ETF易方达", "563020", "1.208", "1.188", "1.186", "20261012120532", ["0.020", "1.68", "1.210", "1.186"])
};
let scriptMode = "ok"; // ok | fail | empty

global.document = {
  getElementById(id) { if (!store[id]) store[id] = mkEl(id); return store[id]; },
  querySelectorAll() { return []; },
  getElementsByTagName() {
    const head = mkEl("head");
    head.appendChild = function (el) {
      // 模拟浏览器加载并执行该外部脚本文本
      setTimeout(function () {
        if (scriptMode === "fail") { if (el.onerror) el.onerror(); return; }
        if (scriptMode === "ok") { Object.keys(FIXTURE).forEach(k => { global.window[k] = FIXTURE[k]; }); }
        if (el.onload) el.onload();
      }, 0);
    };
    return [head];
  },
  createElement(tag) { return mkEl(tag); },
  addEventListener() {}
};
global.window = {};
global.navigator = {};

eval(fs.readFileSync(path.join(dir, "data.js"), "utf8"));
eval(fs.readFileSync(path.join(dir, "data/lt.js"), "utf8"));
eval(fs.readFileSync(path.join(dir, "data/us.js"), "utf8"));
eval(fs.readFileSync(path.join(dir, "data/asset.js"), "utf8"));
eval(fs.readFileSync(path.join(dir, "data/etf.js"), "utf8"));
// 模拟盘价格与当日快照解耦：live px 由快照价折算生成（保证「确已变更」恒成立），prev_close 取快照价（今日涨跌口径与页面一致）
const csiSnapPx = window.ASSET.dividend.csi.px, lvSnapPx = window.ASSET.dividend.lowvol.px;
const etfLivePx = {};
["csi", "lowvol"].forEach(k => (window.DIV_ETF[k] || []).forEach(e => {
  etfLivePx[e.code] = +(e.px * 1.005).toFixed(3);
  FIXTURE["v_sh" + e.code] = mkQuote("1", e.name, e.code, String(etfLivePx[e.code]), String(e.px), String(e.px), "20261012120530", ["0", "0", "0", "0"]);
}));
const csiLivePx = +(csiSnapPx * 0.9985).toFixed(2), lvLivePx = etfLivePx["512890"];
FIXTURE.v_sh000922 = mkQuote("1", "中证红利", "000922", String(csiLivePx), String(csiSnapPx), "5612.23", "20261012120545", ["7.38", "0.13", "5656.61", "5600.30"]);
const snap = {};
window.STOCKS.forEach(s => { snap[s.code] = { px: s.px, pe: s.pe, pb: s.pb, div: s.div }; });
eval(fs.readFileSync(path.join(dir, "app.js"), "utf8"));
// 记录红利刷新前的快照值，用于验证实时行情覆盖了哪些字段（loadLive 为异步，此刻尚未执行 applyLive）
const snapDiv = {
  csiPx: window.ASSET.dividend.csi.px, csiChg: window.ASSET.dividend.csi.chg, csiDy: window.ASSET.dividend.csi.dy, csiDyPct: window.ASSET.dividend.csi.dyPct, csiMA: window.ASSET.dividend.csi.distMA250, csiPos: window.ASSET.dividend.csi.pos52, csiPe: window.ASSET.dividend.csi.pe,
  lvPx: window.ASSET.dividend.lowvol.px, lvChg: window.ASSET.dividend.lowvol.chg, lvDy: window.ASSET.dividend.lowvol.dy, lvDyPct: window.ASSET.dividend.lowvol.dyPct, lvMA: window.ASSET.dividend.lowvol.distMA250, lvPos: window.ASSET.dividend.lowvol.pos52, lvPe: window.ASSET.dividend.lowvol.pe
};
// 可投工具 4 只 ETF 的快照现价（首页「ETF 加/减仓参考价」由它折算）
const snapEtf = {};
["csi", "lowvol"].forEach(k => (window.DIV_ETF[k] || []).forEach(e => { snapEtf[e.code] = e.px; }));

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

(async function () {
  // 1) 正常加载
  await wait(200);
  const moutai = window.STOCKS.find(s => s.code === "sh600519");
  const tx = window.STOCKS.find(s => s.code === "hk00700");
  console.log("茅台 现价", snap.sh600519.px, "→", moutai.px, "| 涨跌", moutai.chg.toFixed(2) + "%");
  console.log("腾讯 现价", snap.hk00700.px, "→", tx.px, "| 涨跌", tx.chg.toFixed(2) + "%");

  const f = moutai.px / snap.sh600519.px;
  // 快照锚随「日级刷新」每天变化 → 期望值一律由当日快照锚独立推算（DPS/EPS 锚定法），不再硬编码快照价，避免换了快照日就误报
  const csiF = csiLivePx / csiSnapPx, lvF = lvLivePx / lvSnapPx;
  function dyPctOf(kind, dy) {
    const d = window.ASSET.dividend[kind]; let b = 0;
    for (let i = 0; i < d.dyHist.length; i++) if (d.dyHist[i] < dy) b++;
    return b / d.dyHist.length * 100;
  }
  const csiExpDy = snapDiv.csiDy / csiF, lvExpDy = snapDiv.lvDy / lvF;
  const checks = [
    ["价格更新", Math.abs(moutai.px - 1300) < 0.01],
    ["涨跌计算", Math.abs(moutai.chg - (1300 / 1258.62 - 1) * 100) < 0.01],
    ["PE 等比缩放", Math.abs(moutai.pe - snap.sh600519.pe * f) < 0.01],
    ["PB 等比缩放", Math.abs(moutai.pb - snap.sh600519.pb * f) < 0.01],
    ["股息率反向", Math.abs(moutai.div - snap.sh600519.div / f) < 0.01],
    ["指数更新", Math.abs(window.MKT.indices[0].close - 3900) < 0.01],
    // 红利实时刷新：现价/涨跌 + 全部随价格日变的派生字段（股息率/分位/利差锚/PE/技术距离/52周位置）都按实时价重算
    ["红利·中证现价刷新", Math.abs(window.ASSET.dividend.csi.px - csiLivePx) < 0.01],
    ["红利·中证涨跌刷新", Math.abs(window.ASSET.dividend.csi.chg - (csiF - 1) * 100) < 0.01],
    ["红利·中证确已变更", window.ASSET.dividend.csi.px !== snapDiv.csiPx],
    ["红利·低波现价刷新", Math.abs(window.ASSET.dividend.lowvol.px - lvLivePx) < 0.001],
    ["红利·低波涨跌刷新", Math.abs(window.ASSET.dividend.lowvol.chg - (lvF - 1) * 100) < 0.01],
    ["红利·低波确已变更", window.ASSET.dividend.lowvol.px !== snapDiv.lvPx],
    // 派生字段（期望值由快照锚 + 实时价独立推算：DPS/EPS 锚定法）
    ["红利·中证股息率随价反向", Math.abs(window.ASSET.dividend.csi.dy - csiExpDy) < 0.0001],
    ["红利·中证股息率分位重算", Math.abs(window.ASSET.dividend.csi.dyPct - dyPctOf("csi", csiExpDy)) < 1e-6],
    ["红利·中证距年线重算", Math.abs(window.ASSET.dividend.csi.distMA250 - (csiLivePx / window.ASSET.dividend.csi.ma250 - 1) * 100) < 0.001],
    ["红利·中证52周位置重算", Math.abs(window.ASSET.dividend.csi.pos52 - (csiLivePx - window.ASSET.dividend.csi.lo52) / (window.ASSET.dividend.csi.hi52 - window.ASSET.dividend.csi.lo52) * 100) < 0.001],
    ["红利·中证PE随价缩放", Math.abs(window.ASSET.dividend.csi.pe - snapDiv.csiPe * csiF) < 0.0001],
    ["红利·低波股息率随价反向", Math.abs(window.ASSET.dividend.lowvol.dy - lvExpDy) < 0.0001],
    ["红利·低波股息率分位重算", Math.abs(window.ASSET.dividend.lowvol.dyPct - dyPctOf("lowvol", lvExpDy)) < 1e-6],
    ["红利·低波距年线重算", Math.abs(window.ASSET.dividend.lowvol.distMA250 - (lvLivePx / window.ASSET.dividend.lowvol.ma250 - 1) * 100) < 0.001],
    ["红利·低波52周位置重算", Math.abs(window.ASSET.dividend.lowvol.pos52 - (lvLivePx - window.ASSET.dividend.lowvol.lo52) / (window.ASSET.dividend.lowvol.hi52 - window.ASSET.dividend.lowvol.lo52) * 100) < 0.001],
    ["红利·低波PE随价缩放", Math.abs(window.ASSET.dividend.lowvol.pe - snapDiv.lvPe * lvF) < 0.0001],
    ["红利·利差档位随实时股息率联动", (function () {
      if (!window._divLevel) throw new Error("_divLevel 未暴露");
      var sp = lvExpDy - window.ASSET.bond10y.v;   // 2.5~3.0pp → 「利差偏宽 · 小幅加仓」44%
      return window._divLevel(sp).w === 44;
    })()],
    // 可投工具 ETF 现价实时刷新（首页「ETF 加/减仓参考价」表的现价列 + 触发表里逐行标注的 ETF 参考价都由它折算）
    ["ETF·515180现价刷新", Math.abs(window.DIV_ETF.csi[0].px - etfLivePx["515180"]) < 0.001],
    ["ETF·515080现价刷新", Math.abs(window.DIV_ETF.csi[1].px - etfLivePx["515080"]) < 0.001],
    ["ETF·563020现价刷新", Math.abs(window.DIV_ETF.lowvol[0].px - etfLivePx["563020"]) < 0.001],
    ["ETF·512890现价刷新", Math.abs(window.DIV_ETF.lowvol[1].px - etfLivePx["512890"]) < 0.001],
    ["ETF·确已变更", snapEtf["515180"] !== etfLivePx["515180"] && snapEtf["563020"] !== etfLivePx["563020"]],
    ["ETF·涨跌刷新", Math.abs(window.DIV_ETF.lowvol[1].chgPct - (etfLivePx["512890"] / snapEtf["512890"] - 1) * 100) < 0.01],
    ["状态显示实时", (store["asof-line"].textContent || "").includes("实时行情")],
    // 行情时间归一化：A股 20261004153000 → 2026-10-04 15:30；港股 2026/10/04 16:00:00 → 2026-10-04 16:00
    ["A股行情时间归一", window.MKT.asOfA === "2026-10-04"],
    ["港股行情时间归一", window.MKT.asOfHK === "2026-10-04"],
    ["顶部展示行情时间", /A股 10-04 15:30/.test(store["asof-line"].textContent || "")],
    ["顶部展示港股时间", /港股 10-04 16:00/.test(store["asof-line"].textContent || "")]
  ];
  checks.forEach(([n, ok]) => { if (!ok) throw new Error("FAIL: " + n); console.log("  ✓ " + n); });

  // 2) 重复刷新不累积缩放
  const pe1 = moutai.pe;
  const divDy1 = window.ASSET.dividend.csi.dy, divMA1 = window.ASSET.dividend.csi.distMA250, divPos1 = window.ASSET.dividend.lowvol.pos52;
  window.refreshLive();
  await wait(200);
  if (Math.abs(moutai.pe - pe1) > 0.01) throw new Error("FAIL: 重复刷新导致估值累积缩放 " + pe1 + " → " + moutai.pe);
  console.log("  ✓ 重复刷新不累积缩放（PE 稳定在 " + moutai.pe.toFixed(2) + "）");
  if (Math.abs(window.ASSET.dividend.csi.dy - divDy1) > 1e-9 || Math.abs(window.ASSET.dividend.csi.distMA250 - divMA1) > 1e-9 || Math.abs(window.ASSET.dividend.lowvol.pos52 - divPos1) > 1e-9) {
    throw new Error("FAIL: 红利派生字段重复刷新后漂移（锚定失效）dy " + divDy1 + " → " + window.ASSET.dividend.csi.dy);
  }
  console.log("  ✓ 红利派生字段重复刷新稳定（锚定法幂等）");

  // 3) 网络失败降级
  scriptMode = "fail";
  window.refreshLive();
  await wait(200);
  const txt = store["asof-line"].textContent || "";
  if (!txt.includes("上次更新") || !txt.includes("网络不可达")) throw new Error("FAIL: 降级文案异常 → " + txt);
  console.log("  ✓ 网络失败降级提示：" + txt);

  // 4.5) 换日后刷新：各页「数据时点」必须跟着变，不能停留快照日
  window._liveTestHook({ A: "2026-10-08 16:14", HK: "2026-10-08 16:08", US: "2026-10-08 09:34" });
  window.showTab("radar");
  const t5 = store["asof-line"].textContent || "";
  const r5 = store["radar-body"].innerHTML || "";
  const d5 = [
    ["顶部同步到新交易日", t5.includes("A股 10-08 16:14") && t5.includes("港股 10-08 16:08"), t5],
    ["M.asOfA 回写行情日", window.MKT.asOfA === "2026-10-08", window.MKT.asOfA],
    ["M.asOfHK 回写行情日", window.MKT.asOfHK === "2026-10-08", window.MKT.asOfHK],
    ["雷达页时点跟随", r5.includes("10-08 16:14 最新"), "radar"],
    ["资产层快照日同步", window.ASSET.asOfA === "2026-10-08", window.ASSET.asOfA],
    ["美股时点同步", window.US_MKT.asOfUS === "2026-10-08", window.US_MKT.asOfUS]
  ];
  d5.forEach(([n, ok, v]) => { if (!ok) throw new Error("FAIL: " + n + " → " + v); console.log("  ✓ " + n); });

  // 4) 空数据降级（接口返回但无内容）
  const before = window.STOCKS.find(s => s.code === "sh600519").px;
  scriptMode = "empty";
  window.refreshLive();
  await wait(200);
  if (window.STOCKS.find(s => s.code === "sh600519").px !== before) throw new Error("FAIL: 空返回不应改动价格");
  console.log("  ✓ 空数据不污染现有价格（保持 " + before + "）");

  console.log("LIVE-QUOTE-OK");
  process.exit(0);
})();
