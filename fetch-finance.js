// 抓取财报历史（EPS / 每股净资产 / 分红），供 calc-valuation.js 计算历史估值百分位
// 用法: node fetch-finance.js            只补 data.js 中缺失的标的
//       node fetch-finance.js sz300750 hk09992   指定代码（会覆盖已有）
// 数据源：westock CLI（腾讯自选股同源）；A股取 EPSTTM（滚动口径），港股取 BasicEPS（累计口径，由 calc 换算 TTM）
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const DIR = __dirname;

const WESTOCK = process.env.WESTOCK_BIN || "/Users/didi/.local/bin/westock";
const PERIODS = 20;                                   // 最多取 20 期（约 5 年）
const EPS_F = path.join(DIR, "data/eps-history.json");
const NAPS_F = path.join(DIR, "data/naps-history.json");

// 载入股票池
const sb = { window: {} };
new Function("window", fs.readFileSync(path.join(DIR, "data.js"), "utf8"))(sb.window);
const STOCKS = sb.window.STOCKS || [];

const epsDb = JSON.parse(fs.readFileSync(EPS_F, "utf8"));
const napsDb = JSON.parse(fs.readFileSync(NAPS_F, "utf8"));

const only = process.argv.slice(2);
let targets = only.length
  ? STOCKS.filter(s => only.indexOf(s.code) >= 0)
  : STOCKS.filter(s => !epsDb.data[s.code] || !napsDb.data[s.code]);

function run(args) {
  return execFileSync(WESTOCK, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}
// 解析 westock 输出的 markdown 表格
function parseTable(txt) {
  const lines = txt.split("\n").filter(l => l.trim().indexOf("|") === 0);
  if (lines.length < 3) return [];
  const head = lines[0].split("|").map(s => s.trim()).filter((s, i, a) => i > 0 && i < a.length - 1);
  const out = [];
  for (let i = 2; i < lines.length; i++) {
    const cells = lines[i].split("|").map(s => s.trim());
    if (cells.length < head.length + 2) continue;
    const row = {};
    head.forEach((h, j) => { row[h] = cells[j + 1]; });
    out.push(row);
  }
  return out;
}
function numOf(v) {
  if (v == null) return null;
  const s = String(v).replace(/,/g, "").trim();
  if (!s || s === "-" || s === "null") return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
}
// 财报披露日：接口不返回，按报告期 + 市场取经验值（与既有 24 只的口径一致，误差 ±2 周不影响月度序列）
function pubOf(endDate, mkt) {
  const y = Number(endDate.slice(0, 4)), mm = endDate.slice(5, 7);
  const isHK = mkt === "HK";
  if (mm === "12") return (y + 1) + (isHK ? "-03-20" : "-04-15");
  if (mm === "03") return y + (isHK ? "-05-13" : "-04-28");
  if (mm === "06") return y + (isHK ? "-08-25" : "-08-25");
  if (mm === "09") return y + (isHK ? "-11-13" : "-10-28");
  return endDate;
}

function fetchOne(code, type) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return parseTable(run(["finance", code, "--type", type, "--limit", String(PERIODS)]));
    } catch (e) {
      const msg = String(e.message || e);
      if (/频繁|rate|limit/i.test(msg)) {                 // 限频：退避后重试
        const wait = 45000 * (attempt + 1);
        console.log("  " + code + " " + type + " 限频，等待 " + (wait / 1000) + "s 后重试…");
        execFileSync("sleep", [String(wait / 1000)]);
        continue;
      }
      console.log("  " + code + " " + type + " ERROR " + msg.slice(0, 120));
      return [];
    }
  }
  return [];
}

(function main() {
  if (!targets.length) { console.log("无需要补抓的标的"); return; }
  console.log("待抓取 " + targets.length + " 只：" + targets.map(s => s.name).join("、"));
  let ok = 0;
  targets.forEach((st, idx) => {
    const isHK = st.mkt === "HK";
    const inc = fetchOne(st.code, "income");
    const bal = fetchOne(st.code, "balance");
    if (!inc.length && !bal.length) { console.log(st.name + " 抓取失败，跳过"); return; }
    const epsRows = [], napsRows = [];
    inc.forEach(r => {
      if (!r.EndDate) return;
      const v = numOf(isHK ? r.BasicEPS : r.EPSTTM);       // A股滚动口径 / 港股累计口径
      if (v == null) return;
      const d = r.EndDate.length === 7 ? r.EndDate + "-31" : r.EndDate;
      const div = numOf(r.DividendTTM);                     // 分红总额（港股通常无）
      epsRows.push({ d: d, pub: pubOf(d, st.mkt), eps: v, div: div });
    });
    bal.forEach(r => {
      if (!r.EndDate) return;
      // 港股资产负债表不提供每股净资产(NAPS)，只有权益总额：
      // 用「当前 NAPS = 现价 / 快照PB」定绝对水平，再按归母权益的相对变化回推历史，
      // 与 calc-valuation 的锚定口径一致（它只需要相对变化）。
      const v = numOf(r.NAPS), eq = numOf(r.SeWithoutMinority) || numOf(r.TotalEquity);
      if (v == null && eq == null) return;
      const d = r.EndDate.length === 7 ? r.EndDate + "-31" : r.EndDate;
      napsRows.push({ d: d, pub: pubOf(d, st.mkt), naps: v, eq: eq });
    });
    if (napsRows.length && napsRows[0].naps == null) {
      const shares = (st.px && st.pb) ? st.px / st.pb : null;      // 当前每股净资产（锚）
      const baseEq = napsRows[0].eq;
      if (shares && baseEq) {
        napsRows.forEach(r => { r.naps = r.eq ? shares * (r.eq / baseEq) : null; });
        console.log("  " + st.name + " 港股无 NAPS 字段，改用归母权益相对变化 × 当前每股净资产 " + shares.toFixed(2) + " 回推");
      }
    }
    napsRows.forEach(r => { delete r.eq; });

    if (epsRows.length) { epsDb.data[st.code] = epsRows; console.log(st.name + " EPS " + epsRows.length + " 期（" + epsRows[0].d + " ~ " + epsRows[epsRows.length - 1].d + "）"); }
    if (napsRows.length) { napsDb.data[st.code] = napsRows; console.log(st.name + " NAPS " + napsRows.length + " 期"); }
    if (epsRows.length && napsRows.length) ok++;
    if (idx < targets.length - 1) execFileSync("sleep", ["3"]);   // 限速
  });

  epsDb.generatedAt = new Date().toISOString().slice(0, 10);
  napsDb.generatedAt = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(EPS_F, JSON.stringify(epsDb));
  fs.writeFileSync(NAPS_F, JSON.stringify(napsDb));
  console.log("\nWROTE eps-history.json / naps-history.json  成功 " + ok + " 只  eps codes=" + Object.keys(epsDb.data).length + "  naps codes=" + Object.keys(napsDb.data).length);
})();
