// 抓取「业绩预约披露日」（下次财报披露时间点）→ data/reports.js
// 用法: node fetch-reports.js   （或由 refresh-data.js 每日顺带调用，无需单独排程）
// 数据源：westock disclosure 财报披露日历（A股/港股/美股统一入口，支持逗号批量）
// 说明：披露日为交易所/公司「预约」时间，偶尔会改期——所以放进每日刷新，
//       每天用最新预约日覆盖；个别代码抓取失败时保留旧值（合并式更新）。
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const DIR = __dirname;
const WESTOCK = process.env.WESTOCK_BIN || "/Users/didi/.local/bin/westock";
const OUT_F = path.join(DIR, "data", "reports.js");

// ---------- 工具 ----------
function parsePipe(raw) {
  // disclosure 输出首行是「[Batch] 状态: success | 总数: N」——这行本身含竖线，必须先剔除再按表格解析
  const lines = String(raw).trim().split("\n")
    .filter(l => l.indexOf("|") >= 0 && l.indexOf("[Batch]") < 0 && l.indexOf("状态:") < 0);
  if (lines.length < 3) return [];
  const head = lines[0].split("|").map(s => s.trim());
  return lines.slice(2).map(l => {
    const cells = l.split("|").map(s => s.trim());
    const o = {};
    head.forEach((k, i) => { o[k] = cells[i]; });
    return o;
  });
}
function normDate(v) {
  if (!v) return null;
  v = String(v).trim();
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[0];
  m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return m[1] + "-" + m[2] + "-" + m[3];
  return null;
}
function dateFromDesc(desc) {
  if (!desc) return null;
  const m = String(desc).match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// ---------- 主流程 ----------
function refresh() {
  const sb = { window: {} };
  new Function("window", fs.readFileSync(path.join(DIR, "data.js"), "utf8"))(sb.window);
  const STOCKS = sb.window.STOCKS || [];
  const ub = { window: {} };
  new Function("window", fs.readFileSync(path.join(DIR, "data", "us.js"), "utf8"))(ub.window);
  const USTOCKS = ub.window.US_STOCKS || [];
  const codes = STOCKS.map(s => s.code).concat(USTOCKS.map(s => s.code));
  if (!codes.length) { console.error("股票池为空，退出"); return false; }

  // 旧数据（合并式更新：失败的代码保留旧值）
  let old = {};
  if (fs.existsSync(OUT_F)) {
    try {
      const rb = { window: {} };
      new Function("window", fs.readFileSync(OUT_F, "utf8"))(rb.window);
      old = (rb.window.REPORTS && rb.window.REPORTS.dates) || {};
    } catch (e) { old = {}; }
  }

  // 批量抓取（6 只/批，批间隔 15s——disclosure 限频比 quote 严，间隔短了会 LOCAL_RATE_LIMITED；
  //          实测 15s 间隔稳定可用，触发限频时再退避重试；失败的代码保留旧值，次日刷新时补齐）
  const dates = {};
  const BATCH = 6;
  for (let i = 0; i < codes.length; i += BATCH) {
    const batch = codes.slice(i, i + BATCH);
    let rows = [], ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      if (attempt) { console.error("  限频，等待 " + (attempt * 15) + "s 后重试: " + batch.join(",")); sleep(attempt * 15000); }
      try {
        const raw = execFileSync(WESTOCK, ["disclosure", batch.join(",")], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
        rows = parsePipe(raw);
        if (rows.length) ok = true;
        else if (String(raw).indexOf("RATE_LIMITED") < 0) ok = true;   // 真没数据也算成功，不重试
      } catch (e) {
        if (String(e.message).indexOf("RATE_LIMITED") < 0 && attempt === 0) console.error("  批次失败，重试逐只: " + batch.join(","));
        if (String(e.message).indexOf("RATE_LIMITED") < 0) break;      // 非限频错误不再重试
      }
    }
    if (!ok && rows.length === 0) {
      // 逐只兜底（放慢节奏，15s 一只）
      for (const one of batch) {
        try { rows = rows.concat(parsePipe(execFileSync(WESTOCK, ["disclosure", one], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }))); }
        catch (e2) { console.error("  ✗ " + one + " 获取失败: " + e2.message.slice(0, 80)); }
        sleep(15000);
      }
    }
    for (const r of rows) {
      // disclosureDate：A股为 YYYY-MM-DD；美股为 YYYYMMDD；港股常为空（日期藏在 disclosureDesc 里）
      const d = normDate(r.disclosureDate) || dateFromDesc(r.disclosureDesc);
      if (r.code && d) dates[r.code] = d;
    }
    if (i + BATCH < codes.length) sleep(15000);
  }

  // 合并：本次取到的覆盖旧值，没取到的保留旧值
  const merged = Object.assign({}, old, dates);
  const got = Object.keys(dates).length;
  const keep = Object.keys(merged).length;

  const today = new Date(); const pad = n => ("0" + n).slice(-2);
  const asOf = today.getFullYear() + "-" + pad(today.getMonth() + 1) + "-" + pad(today.getDate());
  const head =
    "// 财报披露日历（fetch-reports.js 自动生成，勿手改；refresh-data.js 每日顺带刷新）\n" +
    "// 来源：westock disclosure「业绩预约披露日」（A股/港股/美股）；预约日可能改期，以交易所公告为准\n" +
    "// dates[code] = 下次财报预约披露日（YYYY-MM-DD）；页面据此展示财报日历与标的行的「财报」标记\n";
  const body = "window.REPORTS = {\n  asOf: \"" + asOf + "\",\n  dates: " + JSON.stringify(merged, null, 2) + "\n};\n";
  fs.writeFileSync(OUT_F, head + body, "utf8");
  console.log("reports.js 已刷新: 本次新取 " + got + " 只 · 合并后 " + keep + "/" + codes.length + " 只 · 生成于 " + asOf);
  return keep >= Math.floor(codes.length * 0.6);   // 覆盖率过低视为异常（调用方可决定是否保留）
}

if (require.main === module) {
  const ok = refresh();
  if (!ok) { console.error("披露日覆盖率过低，请检查 westock disclosure 接口"); process.exit(1); }
}
module.exports = { refresh: refresh };
