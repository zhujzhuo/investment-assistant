// 腾讯可比估值数据管道：对标 Google/Meta/微软 → 加权 PE → 腾讯合理价与加仓档
// 数据源：腾讯公开行情 qt.gtimg.cn（三巨头 PE-TTM + 汇率 + 腾讯现价/PE）
// 用法: node fetch-comps.js    # 每日刷新链调用（云端 qt 模式同样可用，无 westock 依赖）
//
// 口径（2026-10-23 与用户确认的方案）：
//  - 权重按业务重合度：Google 40%（广告+云+AI平台+同受反垄断）/ Meta 30%（社交广告变现）/ 微软 30%（云+企服）
//  - 腾讯 EPS(TTM) = 现价 / PE-TTM 反推（行情接口自洽口径；美股 finance NetIncome 单位不可靠，勿用）
//  - 合计估值 = EPS(TTM) × 加权可比 PE × (1 − 折价)；折价三档 0 / 10% / 20%
//  - 加仓档以 10% 折价合理价为基准：×50% 理想买点 / ×60% 二档 / ×70% 三档（对齐老唐式安全边际）
//  - 盘中实时联动由 app.js applyLive 做（三巨头 PE 与腾讯价按锚定法重算），本脚本只出收盘锚
const fs = require("fs");
const path = require("path");
const https = require("https");

const DIR = __dirname;
const OUT = path.join(DIR, "data", "comps.js");

const TARGET = "hk00700";                                   // 腾讯控股
const COMPS = [
  { key: "goog", code: "usGOOG", name: "Google", w: 0.40, why: "业务结构最像：广告+云+AI平台，同受反垄断监管" },
  { key: "meta", code: "usMETA", name: "Meta", w: 0.30, why: "社交广告变现对标（微信生态 vs 社交矩阵）" },
  { key: "msft", code: "usMSFT", name: "微软", w: 0.30, why: "云+企业服务对标（腾讯云/AI），业务重合度最低" }
];
const DISCOUNTS = [0, 0.10, 0.20];                          // 无折价 / 常规 / 悲观
const BUY_MULTS = [0.50, 0.60, 0.70];                       // 理想买点 / 二档 / 三档（基准=10%折价）
const BASE_DISC = 0.10;

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      const bufs = [];
      res.on("data", (d) => bufs.push(d));
      res.on("end", () => resolve(Buffer.concat(bufs)));
    }).on("error", reject);
  });
}
function parseQuote(text) {
  const out = {};
  for (const ln of String(text).split("\n")) {
    const m = ln.match(/^v_([a-zA-Z0-9]+)="(.*)";?\s*$/);
    if (!m) continue;
    const f = m[2].split("~");
    out[m[1]] = { name: f[1], px: parseFloat(f[3]), pe: parseFloat(f[39]), time: f[30] || "" };
  }
  return out;
}

(async function () {
  const codes = COMPS.map((c) => c.code).concat([TARGET, "whUSDHKD"]);
  const buf = await get("https://qt.gtimg.cn/q=" + codes.join(","));
  const q = parseQuote(new TextDecoder("gbk").decode(buf));
  const fx = q["whUSDHKD"];
  const tx = q[TARGET];
  if (!tx || !fx || !(fx.px > 5)) { console.error("comps: 行情/汇率获取失败"); process.exit(1); }

  // 三巨头 PE 与加权
  let wpe = 0, wsum = 0;
  const items = COMPS.map((c) => {
    const x = q[c.code] || {};
    wpe += (x.pe || 0) * c.w; wsum += c.w;
    return { key: c.key, code: c.code, name: c.name, w: c.w, px: x.px || null, pe: x.pe || null, why: c.why };
  });
  if (wsum > 0) wpe = wpe / wsum;
  if (!(wpe > 5)) { console.error("comps: 加权 PE 异常 " + wpe); process.exit(1); }

  // 腾讯锚：px 用 qt 实时价；PE 用站内 data.js 的 TTM 口径（qt f[39] 对港股是静态口径 14.19，
  // 与三巨头美股 TTM 口径混算会抬高 epsTTM 估值 → 统一用 TTM）
  const g = { window: {} };
  new Function("window", fs.readFileSync(path.join(DIR, "data.js"), "utf8"))(g.window);
  const txInPool = (g.window.STOCKS || []).find((s) => s.code === TARGET);
  const txPx = tx.px, txPE = (txInPool && txInPool.pe > 0) ? txInPool.pe : tx.pe;
  const epsTTM = txPE > 0 ? txPx / txPE : null;             // HKD

  // 估值与加仓档
  const fair = DISCOUNTS.map((d) => epsTTM != null ? +(epsTTM * wpe * (1 - d)).toFixed(1) : null);
  const base = fair[1];                                      // 10% 折价
  const buys = BUY_MULTS.map((m) => base != null ? +(base * m).toFixed(1) : null);

  const out = {
    asOf: new Date().toISOString().slice(0, 10),
    target: { code: TARGET, name: tx.name, px: txPx, pe: txPE, peTTM: true, epsTTM: epsTTM != null ? +epsTTM.toFixed(2) : null },
    fx: { usdHkd: fx.px, asOf: (fx.time || "").slice(0, 10) },
    items: items, wpe: +wpe.toFixed(2),
    discounts: DISCOUNTS,
    fair: { none: fair[0], d10: fair[1], d20: fair[2] },
    buys: { ideal: buys[0], tier2: buys[1], tier3: buys[2] },
    buyMults: BUY_MULTS, baseDisc: BASE_DISC
  };

  const body = "// 腾讯可比估值（fetch-comps.js 自动生成，勿手改；2026-10-23 方案固化）\n" +
    "// 对标 Google40%/Meta30%/微软30%（业务重合度权重）；腾讯 EPS=现价/PE-TTM 反推；\n" +
    "// fair = EPS×加权PE×(1−折价) 三档（0/10%/20%）；buys 以 10% 折价为基准 ×50%/60%/70%；盘中实时联动见 app.js applyLive\n" +
    "window.COMPS = " + JSON.stringify(out, null, 1) + ";\n";
  fs.writeFileSync(OUT, body, "utf8");
  console.log("comps: 加权PE=" + wpe.toFixed(2) + " 腾讯px=" + txPx + " pe=" + txPE +
    " 合理(10%折价)=" + out.fair.d10 + "HKD 买点=" + buys.join("/") +
    " USDHKD=" + fx.px);
})();
