// 抓取红利两个标的的「可投 ETF」行情，用于页面给出加减仓份额示例。
// 数据源：腾讯公开行情 qt.gtimg.cn（与 fetch-asset.js 同源）+ westock etf nav（净值→溢价）
// 产出：data/etf.js = window.DIV_ETF
//
// 标的口径（用户指定）：
//   中证红利 → 515180（红利ETF易方达）、515080（中证红利ETF招商）
//   红利低波 → 563020（红利低波ETF易方达）、512890（红利低波ETF华泰柏瑞）
//   纳斯达克 → 513100（国泰）/ 513300（华夏）/ 513870（富国）/ 159632（华安）/ 159941（广发）/ 159513（大成）
// 纳指组额外计算「溢价率」= 现价 / 最新净值 − 1（QDII 额度紧张时场内常出现高溢价，是选择工具的关键维度）
// 注：中证红利在页面里是「指数点位 000922」，红利低波用的是 ETF 512890 的价格，
//     所以只有指数口径的标的才需要把「需再跌 %」换算成 ETF 触发价。
const fs = require("fs");
const path = require("path");
const https = require("https");
const { execFileSync } = require("child_process");

const DIR = __dirname;
const OUT = path.join(DIR, "data", "etf.js");
const WS_BIN = "/Users/didi/.local/bin/westock";

const GROUPS = [
  { key: "csi", name: "中证红利", codes: ["sh515180", "sh515080"] },
  { key: "lowvol", name: "红利低波", codes: ["sh563020", "sh512890"] }
];

// 纳指100 场内 QDII ETF（费率/规模等静态信息也一并写入，页面表格直接渲染）
// 静态字段来源：westock etf profile（2026-10-17）+ 基金公司官网费率页（华夏 513300 管理费 0.60%）
const NAS_ETFS = [
  { c: "sh513100", n: "纳指ETF国泰", fee: 0.80, mgr: "国泰基金", scale: 195, note: "T+0 交易；一二级市场均暂停申购时只能场内买入" },
  { c: "sh513300", n: "纳斯达克ETF华夏", fee: 0.60, mgr: "华夏基金", scale: 133, note: "T+0；管理费 0.60% 为六只中最低档之一" },
  { c: "sh513870", n: "纳指ETF富国", fee: 0.60, mgr: "富国基金", scale: 25, note: "T+0；管理费 0.50%（另档口径 0.60 总费率），规模较小" },
  { c: "sz159632", n: "纳斯达克ETF华安", fee: 0.60, mgr: "华安基金", scale: 113, note: "T+0；管理费 0.60%，规模百亿档" },
  { c: "sz159941", n: "纳指ETF广发", fee: 1.00, mgr: "广发基金", scale: 347, note: "T+0；规模最大流动性最好，但管理费 0.80% 最高档" },
  { c: "sz159513", n: "纳斯达克100ETF大成", fee: 1.00, mgr: "大成基金", scale: 75, note: "T+0；管理费 0.80%" }
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
  NAS_ETFS.forEach((e) => { if (all.indexOf(e.c) < 0) all.push(e.c); });   // 纳指组也拉行情
  let quotes = {};
  try {
    const buf = await get("https://qt.gtimg.cn/q=" + all.join(","));
    quotes = parseQuote(new TextDecoder("gbk").decode(buf));
  } catch (e) {
    console.error("抓取失败：", e.message);
    process.exit(1);
  }

  // 纳指 ETF 净值（算溢价率）：westock etf nav，逐只调用（带间隔防限频）
  function navOf(code) {
    const y = new Date().getFullYear(), m = String(new Date().getMonth() + 1).padStart(2, "0"), d = String(new Date().getDate()).padStart(2, "0");
    for (let a = 0; a < 2; a++) {
      try {
        const out = execFileSync(WS_BIN, ["etf", "nav", code, "--start", y + "-" + m + "-" + d, "--end", y + "-" + m + "-" + d], { encoding: "utf8", timeout: 60000 });
        const line = String(out).split("\n").find((l) => /^\|\s*\d{4}-/.test(l));
        if (line) {
          const f = line.split("|").map((s) => s.trim());
          return { nav: parseFloat(f[2]), date: f[1] };
        }
        // 当日无净值（美股未收盘）→ 回退查最近 5 天
        const out2 = execFileSync(WS_BIN, ["etf", "nav", code, "--start", y + "-" + m + "-" + String(Math.max(1, new Date().getDate() - 5)).padStart(2, "0"), "--end", y + "-" + m + "-" + d], { encoding: "utf8", timeout: 60000 });
        const lines = String(out2).split("\n").filter((l) => /^\|\s*\d{4}-/.test(l));
        if (lines.length) {
          const f = lines[lines.length - 1].split("|").map((s) => s.trim());
          return { nav: parseFloat(f[2]), date: f[1] };
        }
      } catch (e) { /* 限频重试 */ }
    }
    return null;
  }

  const out = { asOf: "", csi: [], lowvol: [], nas: [] };
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
  // 纳指组：行情 + 净值 → 溢价率（静态费率/规模来自 NAS_ETFS 定义）
  for (const e of NAS_ETFS) {
    const q = quotes[e.c];
    const nv = navOf(e.c);
    const prem = (q && nv && nv.nav > 0) ? Number(((q.px / nv.nav - 1) * 100).toFixed(2)) : null;
    out.nas.push({
      code: e.c.replace(/^(sh|sz)/, ""), name: e.n, mkt: e.c.slice(0, 2),
      px: q ? q.px : null, chg: q ? q.chg : null, chgPct: q ? q.chgPct : null,
      nav: nv ? nv.nav : null, navDate: nv ? nv.date : null, prem: prem,
      fee: e.fee, mgr: e.mgr, scale: e.scale, note: e.note
    });
    console.log("  纳指 " + e.c + " " + e.n + " → px=" + (q ? q.px : "-") + " nav=" + (nv ? nv.nav : "-") + " 溢价=" + (prem == null ? "-" : prem + "%"));
    await new Promise((r) => setTimeout(r, 1500));
  }
  out.asOf = t;
  out.generatedAt = new Date().toISOString().slice(0, 10);

  const body = "// 红利/纳指可投 ETF 行情（fetch-etf.js 自动生成，勿手改）\n" +
    "// 中证红利：515180 / 515080；红利低波：563020 / 512890；纳指：513100/513300/513870/159632/159941/159513\n" +
    "// nas 组溢价率 = 现价/最新净值 − 1；净值日期见 navDate（QDII 净值 T+1 披露，当日为预估值口径）\n" +
    "window.DIV_ETF = " + JSON.stringify(out, null, 1) + ";\n";
  fs.writeFileSync(OUT, body, "utf8");
  console.log("写出 " + path.relative(process.cwd(), OUT) + "（" + (body.length / 1024).toFixed(1) + " KB）行情时间 " + t);
})();
