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
  v_sz399006: mkQuote("1", "创业板指", "399006", "3200.00", "3135.28", "3150.00", "20261004153000", ["64.72", "2.06", "3210.00", "3130.00"])
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
const snap = {};
window.STOCKS.forEach(s => { snap[s.code] = { px: s.px, pe: s.pe, pb: s.pb, div: s.div }; });
eval(fs.readFileSync(path.join(dir, "app.js"), "utf8"));

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

(async function () {
  // 1) 正常加载
  await wait(200);
  const moutai = window.STOCKS.find(s => s.code === "sh600519");
  const tx = window.STOCKS.find(s => s.code === "hk00700");
  console.log("茅台 现价", snap.sh600519.px, "→", moutai.px, "| 涨跌", moutai.chg.toFixed(2) + "%");
  console.log("腾讯 现价", snap.hk00700.px, "→", tx.px, "| 涨跌", tx.chg.toFixed(2) + "%");

  const f = moutai.px / snap.sh600519.px;
  const checks = [
    ["价格更新", Math.abs(moutai.px - 1300) < 0.01],
    ["涨跌计算", Math.abs(moutai.chg - (1300 / 1258.62 - 1) * 100) < 0.01],
    ["PE 等比缩放", Math.abs(moutai.pe - snap.sh600519.pe * f) < 0.01],
    ["PB 等比缩放", Math.abs(moutai.pb - snap.sh600519.pb * f) < 0.01],
    ["股息率反向", Math.abs(moutai.div - snap.sh600519.div / f) < 0.01],
    ["指数更新", Math.abs(window.MKT.indices[0].close - 3900) < 0.01],
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
  window.refreshLive();
  await wait(200);
  if (Math.abs(moutai.pe - pe1) > 0.01) throw new Error("FAIL: 重复刷新导致估值累积缩放 " + pe1 + " → " + moutai.pe);
  console.log("  ✓ 重复刷新不累积缩放（PE 稳定在 " + moutai.pe.toFixed(2) + "）");

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
