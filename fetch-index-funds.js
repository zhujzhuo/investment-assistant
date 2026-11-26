#!/usr/bin/env node
// 宽基指数「定投标的推荐」数据复核脚本（季度手动运行，不进每日刷新链）
//
// 用法：
//   node fetch-index-funds.js            联网重拉全部数据（约 80 次请求，1~2 分钟）
//   node fetch-index-funds.js --cache   复用 /tmp/ia-funds-cache 缓存，秒级重算
//
// 输出：index-funds-src.json —— 由 fetch-index.js 内联进 data/index.js 的 BROAD.funds
//
// 数据口径（全部为实测/公开披露，不使用估算）：
//   · 规模 scale：东财基金 FundMNBasicInformation 的 ENDNAV（期末净资产，元 → 亿元）
//   · 费率 fee：天天基金 F10「基本概况」的管理费率 + 托管费率（年率，%）
//   · 跟踪误差 te：近 250 交易日「基金日净值增长率 − 对应全收益指数日收益」的
//     样本标准差 × √250（年化，%）。全收益指数 H00300/H00905/H00906/H00852/H00016，
//     科创50 用 N00688（上证科创板50成份净收益指数，中证官网无 H00688）。
//   · 偏离 dev：近 1 年基金累计净值增长率 − 指数累计收益率（百分点）
//   · 场外只取 A 类：长期定投 C 类要另付 0.2%~0.4%/年销售服务费，成本更高
//
// 复核频率：费率/清单变动慢，季度复核即可；规模与跟踪误差随行情滚动，重跑即更新。

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const DIR = __dirname;
const OUT = path.join(DIR, "index-funds-src.json");
const CACHE = "/tmp/ia-funds-cache";
const USE_CACHE = process.argv.indexOf("--cache") >= 0;

// 6 个宽基 × 各 2 只场内 ETF + 2 只场外联接（A 类）；按「费率 → 规模 → 跟踪误差」择优
const SEL = {
  "000300": { name: "沪深300", etf: ["510300", "510310"], otc: ["110020", "000051"],
    note: "最成熟的宽基 ETF：主流产品费率都降到 0.20%/年，场内跟踪误差 0.17%~0.20% 属全市场最低一档，按规模/流动性任选其一即可。" },
  "000905": { name: "中证500", etf: ["510500", "159922"], otc: ["160119", "001052"],
    note: "场外联接跟踪误差 1.4%~1.6%，明显高于场内的 0.44%~0.52%（联接需留现金应对申赎）；有证券账户优先场内。" },
  "000906": { name: "中证800", etf: ["515800", "515810"], otc: ["007856", "012596"],
    note: "⚠ 场外联接规模均不足 1 亿，流动性与清盘风险显著；场内 515800（45.6 亿）是唯一大规模选择，优先场内。" },
  "000852": { name: "中证1000", etf: ["512100", "159845"], otc: ["006486", "011860"],
    note: "小盘波动大，场外联接跟踪误差约 1.8%~2.0%，是场内的 4 倍；长期定投优先场内 ETF。" },
  "000016": { name: "上证50", etf: ["510050", "510100"], otc: ["001051", "001237"],
    note: "注意避开仍收 0.60%/年的老产品（如天弘 530000/001548），长期定投 0.4pp/年的费率差会明显侵蚀收益。" },
  "000688": { name: "科创50", etf: ["588000", "588080"], otc: ["011608", "011612"],
    note: "⚠ 科创板波动大，场外联接实测跟踪误差 2.3%+，已超基金合同「年化 ≤2%」的目标；长期定投优先场内 ETF。" }
};
const TAG = {
  "510300": "规模最大·流动性最好", "510310": "跟踪最紧·费率 0.20%", "110020": "场外规模最大", "000051": "场外跟踪最紧",
  "510500": "场内规模最大", "159922": "深市·规模次之", "160119": "LOF·场外规模最大", "001052": "场外费率低",
  "515800": "场内唯一大规模", "515810": "备选·规模偏小", "007856": "场外相对最大(仍<1亿)", "012596": "场外·跟踪尚可",
  "512100": "场内规模最大", "159845": "跟踪误差最低", "006486": "场外规模最大", "011860": "场外跟踪较优",
  "510050": "场内规模最大·成立最早", "510100": "费率低·次选", "001051": "场外跟踪最紧", "001237": "场外·费率低",
  "588000": "场内规模最大", "588080": "跟踪误差最低", "011608": "场外规模最大", "011612": "场外·跟踪略优"
};
const IDX_TR = { "000300": "H00300", "000905": "H00905", "000906": "H00906", "000852": "H00852", "000016": "H00016", "000688": "N00688" };
const UA = "Mozilla/5.0";

function grab(url, name) {
  const f = path.join(CACHE, name);
  if (USE_CACHE && fs.existsSync(f)) return fs.readFileSync(f, "utf8");
  for (let i = 0; i < 3; i++) {
    try {
      const txt = execFileSync("curl", ["-sS", "--max-time", "30", "-H", "User-Agent: " + UA, url],
        { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
      if (txt && txt.length > 50) { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(f, txt); return txt; }
    } catch (e) { /* 限频，退避后重试 */ }
    try { execFileSync("sleep", ["1"]); } catch (e) {}
  }
  throw new Error("拉取失败 " + name);
}
const jget = (url, name) => JSON.parse(grab(url, name));

function basic(code) {
  const j = jget("https://fundmobapi.eastmoney.com/FundMNewApi/FundMNBasicInformation?FCODE=" + code +
    "&deviceid=1&plat=Android&product=EFund&version=6.2.8", "basic-" + code + ".json");
  const D = j.Datas || {};
  return { code: code, name: D.SHORTNAME, gs: D.JJGS, idxName: D.INDEXNAME,
    scale: +(Number(D.ENDNAV || 0) / 1e8).toFixed(1), asOf: D.FSRQ,
    estab: (D.ESTABDATE || "").slice(0, 10), mkt: D.ISEXCHG };
}
function fee(code) {
  const s = grab("https://fundf10.eastmoney.com/jbgk_" + code + ".html", "f10-" + code + ".html");
  const g = (re) => { const m = s.match(re); return m ? parseFloat(m[1]) : 0; };
  return { mgrFee: g(/管理费率<\/th><td>([\d.]+)%/), trusFee: g(/托管费率<\/th><td>([\d.]+)%/) };
}
function teOf(code, idxCode) {
  let his;
  try { his = jget("https://fundmobapi.eastmoney.com/FundMNewApi/FundMNHisNetList?FCODE=" + code +
    "&pageIndex=1&pageSize=260&deviceid=1&plat=Android&product=EFund&version=6.2.8", "his-" + code + ".json").Datas || []; }
  catch (e) { return { te: null, dev: null, n: 0 }; }
  const fm = {};
  his.forEach((x) => { if (x.FSRQ && x.JZZZL != null && x.JZZZL !== "--" && !isNaN(Number(x.JZZZL))) fm[x.FSRQ.replace(/-/g, "")] = Number(x.JZZZL) / 100; });
  const end = new Date(); const start = new Date(end.getTime() - 400 * 86400000);
  const pad = (n) => ("0" + n).slice(-2);
  const sd = start.getFullYear() + pad(start.getMonth() + 1) + pad(start.getDate());
  const ed = end.getFullYear() + pad(end.getMonth() + 1) + pad(end.getDate());
  let idx;
  try { idx = jget("https://www.csindex.com.cn/csindex-home/perf/index-perf?indexCode=" + idxCode +
    "&startDate=" + sd + "&endDate=" + ed, "idx-" + idxCode + ".json").data || []; }
  catch (e) { return { te: null, dev: null, n: 0 }; }
  const im = {}; idx.filter((x) => x && x.close > 0).forEach((x) => { im[x.tradeDate] = x.close; });
  const dates = Object.keys(im).sort();
  const diffs = [], fCum = [], iCum = [];
  for (let k = 1; k < dates.length; k++) {
    const d0 = dates[k - 1], d1 = dates[k];
    if (fm[d1] == null || im[d0] == null || im[d1] == null) continue;
    const ir = im[d1] / im[d0] - 1;
    diffs.push(fm[d1] - ir); fCum.push(fm[d1]); iCum.push(ir);
  }
  const use = diffs.slice(-250);
  if (use.length < 60) return { te: null, dev: null, n: use.length };
  const mean = use.reduce((a, b) => a + b, 0) / use.length;
  const varr = use.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (use.length - 1);
  const te = Math.sqrt(varr) * Math.sqrt(250) * 100;
  const fc = fCum.slice(-250).reduce((a, b) => a * (1 + b), 1) - 1;
  const ic = iCum.slice(-250).reduce((a, b) => a * (1 + b), 1) - 1;
  return { te: +te.toFixed(2), dev: +((fc - ic) * 100).toFixed(2), n: use.length };
}

const out = {
  asOf: "", feeAsOf: new Date().toISOString().slice(0, 10), teWindow: "近 250 交易日",
  source: "规模：东财基金期末净资产(ENDNAV)｜费率：天天基金 F10 基本概况(管理+托管, 年率)｜跟踪误差：基金日净值增长率 vs 对应全收益/净收益指数日收益，日差标准差×√250(年化)",
  method: "跟踪误差=近250交易日「基金日增长率−全收益指数日收益」的年化标准差；偏离=近1年基金累计净值增长−指数累计收益。全收益指数：H00300/H00905/H00906/H00852/H00016，科创50 用 N00688 净收益指数。",
  groups: {}
};
for (const [code, g] of Object.entries(SEL)) {
  out.groups[code] = { name: g.name, note: g.note, etf: [], otc: [] };
  for (const [kind, codes] of [["etf", g.etf], ["otc", g.otc]]) {
    for (const c of codes) {
      const b = basic(c), f = fee(c), t = teOf(c, IDX_TR[code]);
      if (!out.asOf) { out.asOf = b.asOf; out.source = out.source.replace("(ENDNAV)", "(ENDNAV, " + b.asOf + ")"); }
      out.groups[code][kind].push({
        code: c, name: b.name, gs: b.gs,
        mgrFee: f.mgrFee, trusFee: f.trusFee, fee: +(f.mgrFee + f.trusFee).toFixed(2),
        scale: b.scale, te: t.te, dev: t.dev, estab: b.estab, tag: TAG[c] || "",
        channel: kind === "etf" ? "证券账户·二级市场买入" : "基金平台/银行·场外申购",
        costNote: kind === "etf" ? "无申购费，仅券商佣金（约万1~万3）" : "A 类：申购费平台常 1 折（约 0.1%~0.15%），持有满 2 年赎回费多为 0"
      });
      console.log("  " + code + " " + c + " " + b.name + " | " + b.scale + "亿 | 费" + (f.mgrFee + f.trusFee).toFixed(2) + "% | TE " + t.te + "% | " + t.n + "日");
    }
  }
}
fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
console.log("→ 写出 " + OUT + "（" + Object.keys(out.groups).length + " 组 / 24 只，锚 " + out.asOf + "）");
