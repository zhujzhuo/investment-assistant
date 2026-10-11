// provider.js —— 数据源适配层（本地 westock / 云端腾讯公开行情接口 qt.gtimg.cn 双实现）
//
// 背景：westock CLI 与 NeoData 是 WorkBuddy 本地技能生态，云端服务器/GitHub Actions 上不存在。
// 本模块把「取行情」抽成统一接口，同一套数据脚本（refresh-data.js 等）在两种环境都能跑：
//   · westock 实现：本地优先，字段最全（含前瞻 PE、港股 PB/股息、美债十年期、披露日）；
//   · qt 实现：腾讯公开行情接口（页面实时刷新同源），云端可用，覆盖主链路所需字段；
//     缺失字段（前瞻 PE、港股 PB/股息、美债、披露日）返回 null，由调用方「保留旧值」。
//
// 数据源选择：环境变量 IA_PROVIDER=qt|westock 显式指定；未指定时自动探测——westock 可执行则用 westock，否则 qt。
// 用法：
//   const P = require("./provider.js");
//   P.pick();                                  // → "westock" | "qt"
//   const { quotes, source } = await P.quotes(codes);   // quotes[code] = 同构行情对象（字段名与 westock 对齐）
//   const rf = await P.rfUS();                 // 美债十年期 { v, asOf } | null
//
// qt 接口字段映射（2026-10-11 实测校准，westock 同值对照）：
//   A股: px=[3] 涨跌%=[32] PE=[39] PB=[46] 股息TTM=[64] 总市值亿=[45] 52周高/低=[67]/[68] 年内=[62] 成交额万元=[37] 时间=[30]
//   港股: px=[3] 涨跌%=[32] PE-TTM=[57] 总市值亿=[45] 52周高/低=[48]/[49] 年内=[61] 时间=[30]（PB/股息无对应字段→null）
//   指数: close=[3] 涨跌%=[32] 成交额万元=[37]（A股价位 [47]/[48] 是涨跌停价不是52周，勿取）
const fs = require("fs");
const { execFileSync } = require("child_process");

const WESTOCK_BIN = process.env.WESTOCK_BIN || "/Users/didi/.local/bin/westock";

function westockOK() {
  try { fs.accessSync(WESTOCK_BIN, fs.constants.X_OK); return true; } catch (e) { return false; }
}

function pick() {
  const env = String(process.env.IA_PROVIDER || "").toLowerCase();
  if (env === "qt" || env === "westock") return env;
  return westockOK() ? "westock" : "qt";
}

// ---------- westock 实现（原 refresh-data.js 逻辑平移） ----------
function parsePipe(raw) {
  // 与 refresh-data.js 原逻辑一致：line0=表头、line1=分隔行；额外过滤 [Batch] 状态行（disclosure 输出有，防串位）
  const lines = String(raw).trim().split("\n").filter(l => l.indexOf("|") >= 0 && l.indexOf("[Batch]") < 0);
  if (lines.length < 3) return [];
  const head = lines[0].split("|").map(s => s.trim());
  return lines.slice(2).map(l => {
    const cells = l.split("|").map(s => s.trim());
    const o = {};
    head.forEach((k, i) => { o[k] = cells[i]; });
    return o;
  });
}
function westockQuotes(codes) {
  const quotes = {};
  const BATCH = 6;
  for (let i = 0; i < codes.length; i += BATCH) {
    const batch = codes.slice(i, i + BATCH);
    let rows = [];
    try {
      rows = parsePipe(execFileSync(WESTOCK_BIN, ["quote", batch.join(",")], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
    } catch (e) {
      for (const one of batch) {
        try { rows = rows.concat(parsePipe(execFileSync(WESTOCK_BIN, ["quote", one], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }))); }
        catch (e2) { console.error("  ✗ " + one + " 获取失败: " + e2.message); }
      }
    }
    for (const r of rows) quotes[r.code] = r;
    if (i + BATCH < codes.length) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
  }
  return { quotes, source: "westock" };
}

// ---------- qt 实现（腾讯公开行情接口） ----------
// 行情时间归一：20261009161459 / 2026/10/09 16:08:14 / 2026-10-09 16:00:01 → "2026-10-09 16:08"
function normTime(t) {
  const s = String(t || "");
  let m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/);            // A股 14 位
  if (m) return m[1] + "-" + m[2] + "-" + m[3] + " " + m[4] + ":" + m[5];
  m = s.match(/^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})/);   // 港美 "2026/10/09 16:08" / "2026-10-09 16:00"
  if (m) return m[1] + "-" + m[2] + "-" + m[3] + " " + m[4] + ":" + m[5];
  return null;
}
function num(v) {
  if (v == null) return null;
  const s = String(v).replace(/[%+,]/g, "").trim();
  if (s === "" || s === "-") return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
}
// 单条 v_xxx="..." 解析为 westock 同构字段；isHK 按代码前缀区分字段位置（A/HK 列布局不同）
function qtParse(code, raw) {
  if (!raw || typeof raw !== "string" || raw.indexOf("~") < 0) return null;
  const f = raw.split("~");
  const isHK = code.indexOf("hk") === 0;
  const isIX = /^(sh000\d{3}|sz399\d{3})$/.test(code);   // 指数：sh000001/sz399001 等（个股是 sh60/sz00/sz30/sh68 开头）
  const px = num(f[3]);
  if (px == null || px <= 0) return null;
  const o = {
    code: code,
    price: px,
    change_percent: num(f[32]),
    pe_ratio: isHK ? num(f[57]) : num(f[39]),
    pe_fwd: null,                                   // qt 无前瞻 PE → 调用方保留旧值
    pb_ratio: isHK ? null : num(f[46]),             // 港股无 PB 字段 → 保留旧值
    dividend_ratio_ttm: isHK ? null : num(f[64]),   // 港股无股息字段 → 保留旧值
    time: normTime(f[30])
  };
  const capYi = num(f[45]);
  if (capYi != null && capYi > 0 && !isIX) o.total_market_cap = capYi * 1e8;
  if (isIX) {
    const amtWan = num(f[37]);                       // 指数成交额（万元）
    if (amtWan != null) o.amount = amtWan * 1e4;
  } else if (isHK) {
    o.high_52week = num(f[48]); o.low_52week = num(f[49]); o.chg_ytd = num(f[61]);
  } else {
    o.high_52week = num(f[67]); o.low_52week = num(f[68]); o.chg_ytd = num(f[62]);
  }
  return o;
}
async function qtFetch(codes) {
  const out = {};
  const BATCH = 40;
  for (let i = 0; i < codes.length; i += BATCH) {
    const batch = codes.slice(i, i + BATCH);
    let txt = null;
    for (let attempt = 0; attempt < 3 && txt == null; attempt++) {
      if (attempt) {
        console.error("  qt 批次失败，" + attempt * 5 + "s 后重试: " + batch.join(",").slice(0, 40) + "…");
        await new Promise(r => setTimeout(r, attempt * 5000));
      }
      try {
        const buf = Buffer.from(await (await fetch("https://qt.gtimg.cn/q=" + batch.join(","), {
          headers: { "User-Agent": "Mozilla/5.0" }
        })).arrayBuffer());
        txt = new TextDecoder("gbk").decode(buf);
      } catch (e) { console.error("  qt 请求异常: " + e.message); }
    }
    if (txt == null) continue;
    for (const line of txt.split(";")) {
      const m = String(line).match(/v_(\S+?)="([^"]*)"/);
      if (!m) continue;
      const q = qtParse(m[1], m[2]);
      if (q) out[m[1]] = q;
    }
    if (i + BATCH < codes.length) await new Promise(r => setTimeout(r, 500));
  }
  return out;
}
async function qtQuotes(codes) {
  return { quotes: await qtFetch(codes), source: "qt" };
}

// ---------- 统一入口 ----------
async function quotes(codes) {
  const which = pick();
  if (which === "westock") return westockQuotes(codes);
  return qtQuotes(codes);
}

// 美债十年期收益率：westock macro 有；qt 数据源无此数据 → 返回 null 由调用方保留旧值
async function rfUS() {
  if (pick() !== "westock") return null;
  try {
    const raw = execFileSync(WESTOCK_BIN, ["macro", "indicator", "us_yield_curve"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    const rows = parsePipe(raw);
    const v = rows.length ? num(rows[0].YIELD_10Y) : null;
    const ed = rows.length ? num(rows[0].EndDate) : null;
    if (v != null && ed != null) {
      const s = String(ed).replace(/\D/g, "").slice(0, 8);
      return { v: v, asOf: s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8) };
    }
    return null;
  } catch (e) { return null; }
}

module.exports = { pick, westockOK, quotes, rfUS, qtParse, normTime };
