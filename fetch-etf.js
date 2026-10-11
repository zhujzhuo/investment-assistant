// 抓取红利两个标的的「可投 ETF」行情，用于页面给出加减仓份额示例。
// 数据源：腾讯公开行情 qt.gtimg.cn（与 fetch-asset.js 同源）
// 产出：data/etf.js = window.DIV_ETF
//
// 标的口径（用户指定）：
//   中证红利 → 515180（红利ETF易方达）、515080（中证红利ETF招商）
//   红利低波 → 563020（红利低波ETF易方达）、512890（红利低波ETF华泰柏瑞）
// 注：中证红利在页面里是「指数点位 000922」，红利低波用的是 ETF 512890 的价格，
//     所以只有指数口径的标的才需要把「需再跌 %」换算成 ETF 触发价。
const fs = require("fs");
const path = require("path");
const https = require("https");

const DIR = __dirname;
const OUT = path.join(DIR, "data", "etf.js");

const GROUPS = [
  { key: "csi", name: "中证红利", codes: ["sh515180", "sh515080"] },
  { key: "lowvol", name: "红利低波", codes: ["sh563020", "sh512890"] }
];

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
  const lines = String(text).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^v_([a-zA-Z0-9]+)="(.*)";?\s*$/);
    if (!m) continue;
    const f = m[2].split("~");
    const px = parseFloat(f[3]);
    if (!isFinite(px) || px <= 0) continue;
    out[m[1]] = {
      code: f[2],
      name: f[1],
      px: px,
      prev: parseFloat(f[4]) || null,
      chg: parseFloat(f[31]) || 0,
      chgPct: parseFloat(f[32]) || 0,
      time: f[30] || ""
    };
  }
  return out;
}

(async function main() {
  const all = [];
  GROUPS.forEach((g) => g.codes.forEach((c) => { if (all.indexOf(c) < 0) all.push(c); }));
  let quotes = {};
  try {
    const buf = await get("https://qt.gtimg.cn/q=" + all.join(","));
    quotes = parseQuote(new TextDecoder("gbk").decode(buf));
  } catch (e) {
    console.error("抓取失败：", e.message);
    process.exit(1);
  }

  const out = { asOf: "", csi: [], lowvol: [] };
  let t = "";
  GROUPS.forEach((g) => {
    g.codes.forEach((c) => {
      const q = quotes[c];
      if (!q) { console.warn("  未取到", c); return; }
      if (!t && q.time) t = q.time;
      out[g.key].push({ code: q.code, name: q.name, px: q.px, chg: q.chg, chgPct: q.chgPct, mkt: c.slice(0, 2) });
      console.log("  " + g.name + " " + q.code + " " + q.name + " → " + q.px + " (" + (q.chgPct > 0 ? "+" : "") + q.chgPct + "%)");
    });
  });
  out.asOf = t;
  out.generatedAt = new Date().toISOString().slice(0, 10);

  const body = "// 红利可投 ETF 行情（fetch-etf.js 自动生成，勿手改）\n" +
    "// 中证红利：515180 / 515080；红利低波：563020 / 512890\n" +
    "window.DIV_ETF = " + JSON.stringify(out, null, 1) + ";\n";
  fs.writeFileSync(OUT, body, "utf8");
  console.log("写出 " + path.relative(process.cwd(), OUT) + "（" + (body.length / 1024).toFixed(1) + " KB）行情时间 " + t);
})();
