// 抓取美股标的行情 + 月K历史 + 全球指数行情，生成 data/us.js
// 数据源：腾讯公开行情接口 qt.gtimg.cn / web.ifzq.gtimg.cn
const fs = require("fs");
const path = require("path");
const https = require("https");

const DIR = __dirname;
const OUT = path.join(DIR, "data", "us.js");

// 标的池：巴菲特-芒格框架下的美股核心资产（四象限）
// fairPE 为估值假设区间（用于生成参考目标价），moat/quality/mgmt/growth/valuation 为 0-10 模型评估分
const POOL = [
  { c: "usBRK.B", n: "伯克希尔B", i: "综合/保险", cat: ["steady"], fairPE: [12, 16], m: 9.5, q: 8.5, mg: 9.5, g: 6.0, v: 8.0, note: "巴菲特本尊：浮存金+巨额现金，护城河来自低成本资金与长期复利文化" },
  { c: "usAAPL", n: "苹果", i: "消费电子/服务", cat: ["steady"], fairPE: [22, 30], m: 9.5, q: 9.5, mg: 8.5, g: 6.0, v: 5.0, note: "生态+品牌+转换成本，巴菲特第一大重仓；高 ROE + 巨额回购，现金流稳定" },
  { c: "usKO", n: "可口可乐", i: "饮料", cat: ["steady"], fairPE: [22, 28], m: 9.0, q: 9.0, mg: 8.0, g: 5.5, v: 6.0, note: "全球品牌+渠道壁垒，连续 60+ 年增股息，巴菲特持仓超 30 年" },
  { c: "usJNJ", n: "强生", i: "医药", cat: ["steady"], fairPE: [24, 30], m: 9.0, q: 8.5, mg: 8.0, g: 6.0, v: 5.5, note: "制药+器械双轮，AAA 级信用，股息贵族" },
  { c: "usCVX", n: "雪佛龙", i: "能源", cat: ["steady"], fairPE: [14, 20], m: 7.5, q: 7.0, mg: 7.5, g: 4.0, v: 8.0, note: "一体化油气+上游低成本储量，油价周期中的现金牛" },
  { c: "usVZ", n: "威瑞森", i: "电信", cat: ["steady"], fairPE: [9, 13], m: 7.0, q: 6.5, mg: 6.5, g: 3.5, v: 9.0, note: "高股息防御，估值低；但增长弱、负债重，属收息型标的" },

  { c: "usMSFT", n: "微软", i: "软件/云", cat: ["growth"], fairPE: [26, 34], m: 9.5, q: 9.5, mg: 9.0, g: 8.5, v: 5.0, note: "Azure+Office+Copilot 三层护城河，转换成本极高，现金流质量顶级" },
  { c: "usGOOGL", n: "谷歌-A", i: "互联网", cat: ["growth"], fairPE: [16, 24], m: 9.0, q: 9.0, mg: 8.0, g: 8.0, v: 8.5, note: "搜索广告垄断+YouTube+云，当前 PE 在大型科技股中最便宜" },
  { c: "usAMZN", n: "亚马逊", i: "电商/云", cat: ["growth"], fairPE: [22, 32], m: 9.0, q: 8.0, mg: 8.5, g: 8.5, v: 7.0, note: "AWS 利润引擎+零售规模效应，物流网络构成重资产壁垒" },
  { c: "usNVDA", n: "英伟达", i: "半导体", cat: ["growth"], fairPE: [25, 40], m: 9.5, q: 9.5, mg: 9.0, g: 9.5, v: 5.5, note: "CUDA 生态锁定，AI 算力事实标准；估值高度依赖 AI 资本开支延续" },
  { c: "usCOST", n: "好市多", i: "零售", cat: ["growth"], fairPE: [35, 48], m: 9.0, q: 8.5, mg: 8.5, g: 7.5, v: 3.5, note: "会员制模式极强，续费率>90%；估值长期溢价，需等回调" },
  { c: "usV", n: "Visa", i: "支付网络", cat: ["growth"], fairPE: [25, 35], m: 9.5, q: 9.5, mg: 8.5, g: 8.0, v: 5.0, note: "支付网络效应+转换成本，巴芒经典护城河；轻资产高 ROE" },
  { c: "usMA", n: "万事达", i: "支付网络", cat: ["growth"], fairPE: [28, 38], m: 9.5, q: 9.5, mg: 8.5, g: 8.5, v: 4.5, note: "与 Visa 双寡头，全球支付网络；轻资产高 ROE，现金牛" },

  { c: "usTSM", n: "台积电", i: "半导体", cat: ["rotate"], fairPE: [25, 38], m: 9.5, q: 9.0, mg: 8.5, g: 9.0, v: 5.0, note: "先进制程独供，AI 芯片必经关口；地缘风险为主要折价因素" },
  { c: "usAVGO", n: "博通", i: "半导体", cat: ["rotate"], fairPE: [30, 45], m: 9.0, q: 8.5, mg: 8.5, g: 9.0, v: 4.0, note: "定制 ASIC+网络芯片，绑定头部云厂商；估值已计入高预期" },
  { c: "usAMD", n: "超威半导体", i: "半导体", cat: ["rotate"], fairPE: [30, 55], m: 7.5, q: 7.5, mg: 8.5, g: 9.0, v: 2.0, note: "CPU 份额持续抢进+MI 系列加速卡；当前 PE 高企取决于预期兑现" },
  { c: "usORCL", n: "甲骨文", i: "软件/云", cat: ["rotate"], fairPE: [20, 30], m: 8.0, q: 7.5, mg: 8.0, g: 8.5, v: 6.0, note: "数据库存量客户黏性极强，OCI 承接 AI 云需求；负债需关注" },

  { c: "usPLTR", n: "Palantir", i: "软件/AI", cat: ["tenx"], fairPE: [50, 120], m: 7.0, q: 7.0, mg: 7.5, g: 9.5, v: 1.0, note: "政府+企业 AI 决策平台，AIP 渗透加速；估值极贵，属期权型仓位" },
  { c: "usARM", n: "安谋", i: "半导体IP", cat: ["tenx"], fairPE: [60, 150], m: 8.5, q: 8.0, mg: 8.0, g: 9.0, v: 1.0, note: "ARM 架构授权垄断，端侧 AI 受益；PE 数百倍，仅适合小仓位试探" },
  { c: "usHOOD", n: "Robinhood", i: "金融科技", cat: ["tenx"], fairPE: [30, 60], m: 6.0, q: 6.5, mg: 7.0, g: 9.0, v: 2.5, note: "年轻用户券商，资产规模高增；护城河较浅、强周期，波动极大" },
  { c: "usCOIN", n: "Coinbase", i: "加密交易", cat: ["tenx"], fairPE: [0, 0], m: 6.0, q: 5.5, mg: 6.5, g: 8.5, v: 1.0, note: "加密合规交易所龙头，业绩与币价强相关；当前盈利口径不适用 PE 法" }
];

// 全球指数
const INDEXES = [
  { c: "hkHSTECH", n: "恒生科技指数", short: "HSTECH", region: "中国香港" },
  { c: "hkHSI", n: "恒生指数", short: "HSI", region: "中国香港" },
  { c: "usIXIC", n: "纳斯达克综合", short: "IXIC", region: "美国" },
  { c: "usNDX", n: "纳斯达克100", short: "NDX", region: "美国" },
  { c: "usINX", n: "标普500", short: "INX", region: "美国" },
  { c: "usDJI", n: "道琼斯", short: "DJI", region: "美国" }
];

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(new Error("timeout")); });
  });
}

function decodeGBK(buf) {
  try {
    // 尝试用 TextDecoder 的 gbk（Node 需 full-icu，通常可用）
    return new TextDecoder("gbk").decode(buf);
  } catch (e) {
    return buf.toString("utf8");
  }
}

function parseQuote(text) {
  const out = {};
  text.split(";").forEach((line) => {
    const m = line.match(/v_([A-Za-z0-9_.]+)="([^"]*)"/);
    if (!m) return;
    const f = m[2].split("~");
    if (!f[3]) return;
    out[m[1]] = {
      name: f[1], symbol: f[2], px: Number(f[3]), prev: Number(f[4]),
      time: f[30], chgAmt: Number(f[31]), chg: Number(f[32]),
      hi: Number(f[33]), lo: Number(f[34]),
      pe: Number(f[39]) || null, mcapYi: Number(f[44]) || null,
      eps: Number(f[47]) || null, hi52: Number(f[48]) || null, lo52: Number(f[49]) || null,
      div: Number(f[52]) || null, currency: f[35] || "USD"
    };
  });
  return out;
}

async function main() {
  // ---------- 1. 行情 ----------
  const codes = POOL.map((p) => p.c).join(",");
  const idxCodes = INDEXES.map((p) => p.c).join(",");
  console.log("抓取美股行情…");
  const qUs = parseQuote(decodeGBK(await get("https://qt.gtimg.cn/q=" + codes)));
  console.log("抓取全球指数…");
  const qIx = parseQuote(decodeGBK(await get("https://qt.gtimg.cn/q=" + idxCodes)));

  const gotUs = Object.keys(qUs).length, gotIx = Object.keys(qIx).length;
  console.log(`行情：美股 ${gotUs}/${POOL.length}，指数 ${gotIx}/${INDEXES.length}`);

  // ---------- 2. 月K（需带 .OQ/.N 后缀） ----------
  console.log("抓取美股月K（48个月）…");
  const monthly = {};
  for (const p of POOL) {
    const meta = qUs[p.c];
    if (!meta || !meta.symbol) { console.log("  跳过(无行情):", p.c); continue; }
    const sym = "us" + meta.symbol; // usAAPL.OQ
    const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${sym},month,,,48,qfq`;
    try {
      const raw = JSON.parse((await get(url)).toString("utf8"));
      const arr = (((raw.data || {})[sym] || {}).month) || [];
      if (!arr.length) { console.log("  空月K:", p.c, sym); continue; }
      monthly[p.c] = arr.map((r) => ({ m: String(r[0]).slice(0, 7), o: Number(r[1]), c: Number(r[2]), h: Number(r[3]), l: Number(r[4]) }));
      console.log(`  ${p.n}(${sym}) ${arr.length} 条，最新 ${monthly[p.c][arr.length - 1].m} 收 ${monthly[p.c][arr.length - 1].c}`);
    } catch (e) {
      console.log("  月K失败:", p.c, e.message);
    }
  }

  // ---------- 3. 计算衍生指标 ----------
  function derive(code) {
    const q = qUs[code], mm = monthly[code];
    const d = { ytd: null, m1: null, m3: null, m12: null, vol12: null, pos52: null, klineN: mm ? mm.length : 0 };
    if (q && q.hi52 && q.lo52 && q.hi52 > q.lo52) {
      d.pos52 = ((q.px - q.lo52) / (q.hi52 - q.lo52)) * 100;
    }
    if (mm && mm.length >= 2) {
      const last = mm[mm.length - 1].c;
      const pick = (k) => (mm.length > k ? mm[mm.length - 1 - k].c : null);
      const b1 = pick(1), b3 = pick(3), b12 = pick(12);
      if (b1) d.m1 = (last / b1 - 1) * 100;
      if (b3) d.m3 = (last / b3 - 1) * 100;
      if (b12) d.m12 = (last / b12 - 1) * 100;
      // YTD：当年 1 月收盘 → 现价
      const year = String(mm[mm.length - 1].m).slice(0, 4);
      const jan = mm.find((x) => x.m === year + "-01");
      if (jan && jan.c) d.ytd = (last / jan.c - 1) * 100;
      // 年化波动率（近 12 个月月收益标准差）
      const rs = [];
      for (let i = Math.max(1, mm.length - 12); i < mm.length; i++) {
        if (mm[i - 1].c > 0) rs.push(mm[i].c / mm[i - 1].c - 1);
      }
      if (rs.length >= 3) {
        const mu = rs.reduce((a, b) => a + b, 0) / rs.length;
        const sd = Math.sqrt(rs.reduce((a, b) => a + (b - mu) * (b - mu), 0) / (rs.length - 1));
        d.vol12 = sd * Math.sqrt(12) * 100;
      }
    }
    return d;
  }

  const stocks = [];
  for (const p of POOL) {
    const q = qUs[p.c];
    if (!q) { console.log("!! 无行情，跳过:", p.c, p.n); continue; }
    const dv = derive(p.c);
    stocks.push({
      code: p.c, name: p.n, en: q.symbol, industry: p.i, cat: p.cat,
      px: q.px, chg: q.chg, pe: (q.pe && q.pe > 0) ? q.pe : null,
      eps: (q.eps && q.eps > 0) ? q.eps : null,
      div: q.div, mcapYi: q.mcapYi, hi52: q.hi52, lo52: q.lo52,
      fairPE: p.fairPE, moat: p.m, quality: p.q, mgmt: p.mg, growth: p.g, valuation: p.v,
      note: p.note, ytd: dv.ytd, m1: dv.m1, m3: dv.m3, m12: dv.m12,
      vol12: dv.vol12, pos52: dv.pos52, asOf: (q.time || "").slice(0, 10)
    });
  }

  const indices = [];
  for (const p of INDEXES) {
    const q = qIx[p.c];
    if (!q) { console.log("!! 无指数行情:", p.c); continue; }
    indices.push({
      code: p.c, name: p.n, short: String(q.symbol || "").replace(/^\./, ""), region: p.region,
      close: q.px, chg: q.chg, chgAmt: q.chgAmt,
      hi52: q.hi52, lo52: q.lo52, asOf: (q.time || "").replace(/\//g, "-").slice(0, 16)
    });
  }

  // ---------- 4. 落盘 ----------
  const r2 = (x) => (x === null || x === undefined || isNaN(x)) ? null : Math.round(x * 100) / 100;
  const slim = stocks.map((s) => ({
    code: s.code, name: s.name, en: s.en, industry: s.industry, cat: s.cat,
    px: s.px, chg: r2(s.chg), pe: r2(s.pe), eps: r2(s.eps), div: r2(s.div),
    mcapYi: r2(s.mcapYi), hi52: s.hi52, lo52: s.lo52,
    fairPE: s.fairPE, moat: s.moat, quality: s.quality, mgmt: s.mgmt,
    growth: s.growth, valuation: s.valuation, note: s.note,
    ytd: r2(s.ytd), m1: r2(s.m1), m3: r2(s.m3), m12: r2(s.m12),
    vol12: r2(s.vol12), pos52: r2(s.pos52), asOf: s.asOf
  }));

  const asOfUs = (stocks[0] && stocks[0].asOf) || "";
  const js = `// 美股组合 + 全球指数 —— 真实行情快照（腾讯公开行情接口）
// 美股行情截至 ${asOfUs} 收盘（美东时间）；基本面与评分说明见各字段注释
// 说明：pe=PE(TTM)、eps=EPS(TTM)、div=股息率(%)、mcapYi=总市值(亿美元)；
//       pos52=现价在 52 周高低区间中的位置(%，0=最低 100=最高)；vol12=近12月年化波动率(%)；
//       fairPE 为估值假设区间（用于生成参考目标价），moat/quality/mgmt/growth/valuation 为 0-10 模型评估分。
window.US_MKT = {
  asOfUS: "${asOfUs}",
  indices: ${JSON.stringify(indices, null, 2)}
};

window.US_STOCKS = ${JSON.stringify(slim, null, 2)};

window.US_PORTFOLIO_DEFAULT = { steady: 40, growth: 35, rotate: 20, tenx: 5 };
`;
  fs.mkdirSync(path.join(DIR, "data"), { recursive: true });
  fs.writeFileSync(OUT, js, "utf8");
  console.log(`\n✅ 写入 ${OUT}（${(js.length / 1024).toFixed(1)} KB）`);
  console.log(`   美股 ${slim.length} 只，指数 ${indices.length} 个，月K覆盖 ${Object.keys(monthly).length} 只`);
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
