// 财报速览数据管道：池子股票最新财报 → 单季环比/同比 + 一致预期对照 → data/earnings.js
// 数据源：westock CLI（finance income 利润表近5期 + consensus 一致预期）
// 用法: node fetch-earnings.js [代码1,代码2...]   # 不传参数跑全池（STOCKS + WATCH）
//
// 设计目标（用户口径：简明扼要，回答三个问题）：
//   ① 最新一期财报的核心数字（营收/归母净利，单季口径）
//   ② 较上一季度改善还是恶化（单季环比 = 本期累计 − 上期累计，中报/三季报是累计值，必须还原成单季）
//   ③ 机构预期怎么判（年度一致预期净利增速 vs 本期累计实际增速 → 超上/低于预期）
// 注意：westock finance 的 A股 NPParentCompanyYOY 是「累计同比」，Q3 报告期的同比也是累计口径；
//      单季同比 = 本季单季净利 / 去年同季单季净利 − 1，需要 5 期数据还原（本脚本按报告期差值计算）。
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const DIR = __dirname;
const OUT = path.join(DIR, "data", "earnings.js");
const WS_BIN = "/Users/didi/.local/bin/westock";

// 载入主池 + 观察池
const g = { window: {} };
new Function("window", fs.readFileSync(path.join(DIR, "data.js"), "utf8"))(g.window);
const STOCKS = (g.window.STOCKS || []).concat(g.window.WATCH || []);

// 日期与季度工具
function endQ(end) {  // '2026-06-30' → '2026Q2'
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(end);
  if (!m) return null;
  const q = Math.ceil(Number(m[2]) / 3);
  return m[1] + "Q" + q;
}
function prevQ(q) {   // '2026Q2' → '2026Q1'；'2026Q1' → '2025Q4'
  const m = /^(\d{4})Q(\d)$/.exec(q);
  if (!m) return null;
  let y = Number(m[1]), qn = Number(m[2]) - 1;
  if (qn === 0) { y -= 1; qn = 4; }
  return y + "Q" + qn;
}
function yoyQ(q) {    // '2026Q2' → '2025Q2'（去年同期）
  return (Number(q.slice(0, 4)) - 1) + q.slice(4);
}
const YI = 1e8;
const yi = (v) => v == null ? null : +(v / YI).toFixed(1);

// 单季还原：累计值序列 → 单季值 map
// rows 按报告期升序 [{end, rev, np}]，rev/np 为累计（如 Q3 报的 1~9 月累计）
// 防护（2026-10-21 踩坑）：部分港股/财年错位公司（如阿里 4 月财年）数据源给的就是单季值而非累计，
// 差分会得到「负数或绝对值超过累计」的荒谬结果 —— 此时判定为非累计口径，弃用单季计算（返回 null 字段），
// 页面只展示累计值，避免给出错误的环比/同比。
function toQuarterly(rows) {
  const byQ = {};
  for (const r of rows) { const q = endQ(r.end); if (q) byQ[q] = r; }
  const out = {};
  const qs = Object.keys(byQ).sort();
  for (const q of qs) {
    const cur = byQ[q], p = prevQ(q);
    // Q1 本身就是单季
    if (q.endsWith("Q1")) { out[q] = { rev: cur.rev, np: cur.np }; continue; }
    const pr = p && byQ[p];
    if (pr) {
      const dRev = (cur.rev != null && pr.rev != null) ? cur.rev - pr.rev : null;
      const dNp = (cur.np != null && pr.np != null) ? cur.np - pr.np : null;
      // 口径防护：累计序列的差分不该为负（盈利可为负但「累计-上期累计」为负且绝对值>累计×1.5 = 数据口径错）
      const badNp = dNp != null && (dNp < 0 ? -dNp : dNp) > Math.abs(cur.np || 0) * 1.5 + 1e8;
      const badRev = dRev != null && dRev < 0;
      out[q] = {
        rev: badRev ? null : dRev,
        np: badNp ? null : dNp,
        unreliable: !!(badNp || badRev)
      };
    } else {
      out[q] = { rev: cur.rev, np: cur.np };   // 缺上期累计时退化用累计值（标注 approximate）
      out[q].approx = true;
    }
  }
  return out;
}

// 一致预期年度净利（亿元）与增速
// A股：consensus 返回年度表（| 年份 | eps | 净利 | ...）→ 取最早~最晚年度算 CAGR
// 港股：consensus 返回季度表（| epsForecast | netProfitForecast | ... | 2026Q2 |）→ 近四季净利年化后
//       与最新季报年化净利比（同为年化口径，可比），vsCons 同样是「实际年化 − 预期年化」的增速差
function consensusOf(code, name) {
  try {
    const out = execFileSync(WS_BIN, ["consensus", code], { encoding: "utf8", timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    // A股年度表：| 年份 | eps | 净利 | 营收 | ...
    const yearRows = [];
    for (const ln of String(out).split("\n")) {
      const m = /^\|\s*(\d{4})\s*\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|/.exec(ln.trim());
      if (m) yearRows.push({ y: +m[1], eps: Number(m[2]), rev: Number(m[3]), np: Number(m[4]) });
    }
    if (yearRows.length) {
      const byY = {};
      yearRows.forEach((r) => { if (isFinite(r.np) && r.np > 0) byY[r.y] = r; });
      const ys = Object.keys(byY).map(Number).sort();
      if (ys.length >= 2) {
        const y0 = ys[0], yN = ys[ys.length - 1];
        const cagr = Math.pow(byY[yN].np / byY[y0].np, 1 / (yN - y0)) - 1;
        return { years: ys, npBase: +byY[y0].np.toFixed(0), npEnd: +byY[yN].np.toFixed(0), cagr: +(cagr * 100).toFixed(1), kind: "year" };
      }
    }
    // 港股季度表：| epsFc | npFc | peFc | 2026Q2 | psFc | revFc | roeFc |
    const qRows = [];
    for (const ln of String(out).split("\n")) {
      const m = /^\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*(\d{4})Q(\d)\s*\|/.exec(ln.trim());
      if (m) qRows.push({ eps: +m[1], np: +m[2], q: m[4] + "Q" + m[5] });
    }
    if (qRows.length >= 2) {
      // 近四季净利求和 = 年化预期净利（单位已是亿）
      const last4 = qRows.slice(-4);
      const npAnnual = last4.reduce((a, r) => a + r.np, 0);
      return { qRange: [qRows[0].q, qRows[qRows.length - 1].q], npAnnual: +npAnnual.toFixed(0), kind: "quarter" };
    }
    return null;
  } catch (e) { return null; }
}

// 财务利润表：A股与港股列不同，取 NPParentCompanyOwners（A股归母累计）/
// ProfitToShareholders（港股归母累计）/ OperatingRevenue|OperatingIncome（营收累计）
// 注意 --limit 6：单季还原需要「上一年 Q1」在内的 6 期累计（Q3 报 1~9 月累计，差值才是单季）
function financeOf(code) {
  const out = execFileSync(WS_BIN, ["finance", code, "--type", "income", "--limit", "6"], { encoding: "utf8", timeout: 90000, maxBuffer: 32 * 1024 * 1024 });
  const hdr = String(out).split("\n")[0].split("|").map((s) => s.trim());
  const iEnd = hdr.indexOf("EndDate");
  const iRev = hdr.indexOf("OperatingRevenue") >= 0 ? hdr.indexOf("OperatingRevenue") : hdr.indexOf("OperatingIncome");
  const iNP = hdr.indexOf("NPParentCompanyOwners") >= 0 ? hdr.indexOf("NPParentCompanyOwners") : hdr.indexOf("ProfitToShareholders");
  const rows = [];
  for (const ln of String(out).split("\n")) {
    if (!/^\|\s*\d{4}-\d{2}-\d{2}/.test(ln)) continue;
    const f = ln.split("|").map((s) => s.trim());
    rows.push({ end: f[iEnd], rev: parseFloat(f[iRev]), np: parseFloat(f[iNP]) });
  }
  rows.sort((a, b) => (a.end < b.end ? -1 : 1));
  return rows;
}

const only = process.argv[2] ? process.argv[2].split(",") : null;
const list = only ? STOCKS.filter((s) => only.indexOf(s.code) >= 0) : STOCKS;
const out = { asOf: new Date().toISOString().slice(0, 10), items: [] };

for (let i = 0; i < list.length; i++) {
  const s = list[i];
  const line = { code: s.code, name: s.name, mkt: s.mkt };
  try {
    const rows = financeOf(s.code);
    if (rows.length < 2) { line.err = "财务数据不足"; out.items.push(line); console.log("✗ " + s.name + " 财务数据不足"); continue; }
    const last = rows[rows.length - 1];
    const prev = rows[rows.length - 2];
    const q = endQ(last.end), pq = endQ(prev.end);
    line.q = q;
    line.revYi = yi(last.rev);                    // 本期累计营收（亿）
    line.npYi = yi(last.np);                      // 本期累计归母净利（亿）
    // 累计同比（数据源直接给的口径，财报原文口径）
    // 单季环比/同比：还原单季
    const qmap = toQuarterly(rows);
    const cq = qmap[q], pqq = qmap[pq], yqq = qmap[yoyQ(q)];
    if (cq && cq.unreliable) line.qUnreliable = true;   // 数据源非累计口径（如阿里财年错位），单季字段不可用
    if (cq && pqq && cq.np != null && pqq.np != null && pqq.np !== 0) line.npQoQ = +(((cq.np / pqq.np) - 1) * 100).toFixed(1);
    if (cq && yqq && cq.np != null && yqq.np != null && yqq.np !== 0) line.npYoY = +(((cq.np / yqq.np) - 1) * 100).toFixed(1);
    if (cq && pqq && cq.rev != null && pqq.rev != null && pqq.rev !== 0) line.revQoQ = +(((cq.rev / pqq.rev) - 1) * 100).toFixed(1);
    line.npQYi = (cq && cq.np != null) ? yi(cq.np) : null;   // 本季单季净利（亿）
    // 一致预期对照：A股年度口径（累计同比 vs 预期 CAGR）；港股季度口径（单季年化 vs 近四季预期年化）
    const cons = consensusOf(s.code, s.name);
    if (cons && cons.kind === "quarter") {
      // 港股：本季单季 ×4 年化 vs 预期年化净利（近四季之和）→ vsCons = 增速差（正 = 跑赢）
      line.consQRange = cons.qRange;
      line.consNpAnnual = cons.npAnnual;          // 预期年化净利（亿）
      if (cq && cq.np != null && cons.npAnnual > 0) {
        const annualized = cq.np * 4;             // 元 → 年化，再转亿
        line.npAnnual = yi(annualized);           // 实际单季年化净利（亿）
        line.vsCons = +((yi(annualized) / cons.npAnnual - 1) * 100).toFixed(1);
      }
      // 累计同比仍按报告期差算（同口径展示）
      const mmdd = last.end.slice(4);
      const samePeriodPrev = rows.find((r) => r.end === (Number(last.end.slice(0, 4)) - 1) + mmdd);
      if (samePeriodPrev && samePeriodPrev.np != null && last.np != null && samePeriodPrev.np !== 0) {
        line.npYoYAcc = +(((last.np / samePeriodPrev.np) - 1) * 100).toFixed(1);
      }
    } else if (cons) {
      line.consYears = cons.years;
      line.consCagr = cons.cagr;
      // 累计同比：本期累计 vs 一年前同期累计（报告期同尾日，如 2026-06-30 vs 2025-06-30）
      let npYoYAcc = null;
      const mmdd = last.end.slice(4);
      const samePeriodPrev = rows.find((r) => r.end === (Number(last.end.slice(0, 4)) - 1) + mmdd);
      if (samePeriodPrev && samePeriodPrev.np != null && last.np != null && samePeriodPrev.np !== 0) {
        npYoYAcc = +(((last.np / samePeriodPrev.np) - 1) * 100).toFixed(1);
      }
      line.npYoYAcc = npYoYAcc;                   // 累计同比（与预期同口径比较）
      if (npYoYAcc != null && cons.cagr != null) {
        line.vsCons = +(npYoYAcc - cons.cagr).toFixed(1);   // 正 = 跑赢年度预期
      }
    }
    out.items.push(line);
    console.log("✓ " + s.name + " " + q + " 累计净利 " + line.npYi + "亿" +
      (line.npQoQ != null ? " 单季环比 " + line.npQoQ + "%" : "") +
      (line.npYoY != null ? " 单季同比 " + line.npYoY + "%" : "") +
      (line.vsCons != null ? " vs预期 " + (line.vsCons > 0 ? "+" : "") + line.vsCons + "pp" : ""));
  } catch (e) {
    line.err = String(e.message || e).slice(0, 80);
    out.items.push(line);
    console.log("✗ " + s.name + " " + line.err);
  }
  // 限频防护：每只间隔 1.5s
  if (i < list.length - 1) { try { execFileSync("/bin/sleep", ["1.5"]); } catch (e) { } }
}

const body = "// 财报速览（fetch-earnings.js 自动生成，勿手改）\n" +
  "// 口径：q=报告期；revYi/npYi=累计营收/归母净利(亿)；npQYi=单季净利(亿)；npQoQ/npYoY=单季环比/同比(%)；\n" +
  "// npYoYAcc=累计同比(%)；A股 consCagr=年度预期增速(%)、vsCons=累计同比−预期(pp)；\n" +
  "// 港股 consNpAnnual=近四季预期净利年化(亿)、npAnnual=单季年化、vsCons=年化偏离(%)\n" +
  "window.EARNINGS = " + JSON.stringify(out, null, 1) + ";\n";
fs.writeFileSync(OUT, body, "utf8");
console.log("\nWROTE " + path.relative(process.cwd(), OUT) + "（" + out.items.length + " 只，成功 " + out.items.filter((x) => !x.err).length + "）");
