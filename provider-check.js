// 数据源适配层（provider.js）回归测试
// 覆盖：数据源选择逻辑（IA_PROVIDER / 自动探测）/ qt 字段映射（A股·港股·指数，westock 实测同值对照）/
//       在线 qt 拉取冒烟 / qtParse 边界（乱行、空行）
const fs = require("fs");
const path = require("path");
const DIR = __dirname;
const P = require("./provider.js");

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ FAIL " + name + (detail != null ? "  [" + detail + "]" : "")); }
}

console.log("=== 1. 数据源选择逻辑 ===");
const envBefore = process.env.IA_PROVIDER;
delete process.env.IA_PROVIDER;
assert("无环境变量时自动探测（本机有 westock → westock）", P.pick() === "westock", P.pick());
process.env.IA_PROVIDER = "qt";
assert("IA_PROVIDER=qt → 强制 qt", P.pick() === "qt");
process.env.IA_PROVIDER = "westock";
assert("IA_PROVIDER=westock → 强制 westock", P.pick() === "westock");
process.env.IA_PROVIDER = envBefore || "";
delete process.env.IA_PROVIDER;
assert("westockOK 探测", P.westockOK() === true);

console.log("=== 2. qt 字段映射（A股 / 港股 / 指数，2026-10-11 实测校准） ===");
// 构造样例行：只在关键位置填值（字段布局见 provider.js 注释）
function mkRow(fields, len) {
  const a = []; for (let i = 0; i < (len || 80); i++) a.push("");
  for (const k of Object.keys(fields)) a[Number(k)] = String(fields[k]);
  return a.join("~");
}
// A股样例（茅台 10-09 收盘，与 westock 实测同值）
const rowA = mkRow({ 1: "贵州茅台", 3: "1263.00", 4: "1255.79", 30: "20261009161459", 32: "0.57", 39: "19.39", 45: "15788.53", 46: "6.28", 64: "4.12", 67: "1539.98", 68: "1151.01", 62: "-6.39" });
const qa = P.qtParse("sh600519", rowA);
assert("A股解析成功", !!qa);
assert("A股 price=1263", qa && qa.price === 1263, qa && qa.price);
assert("A股 chg%=0.57", qa && qa.change_percent === 0.57);
assert("A股 PE=19.39（[39]）", qa && qa.pe_ratio === 19.39);
assert("A股 PB=6.28（[46]）", qa && qa.pb_ratio === 6.28);
assert("A股 股息TTM=4.12（[64]）", qa && qa.dividend_ratio_ttm === 4.12);
assert("A股 市值=15788.53亿→元", qa && qa.total_market_cap === 15788.53e8, qa && qa.total_market_cap);
assert("A股 52周高/低=1539.98/1151.01（[67]/[68]）", qa && qa.high_52week === 1539.98 && qa.low_52week === 1151.01);
assert("A股 年内=-6.39（[62]）", qa && qa.chg_ytd === -6.39);
assert("A股 时间归一 2026-10-09 16:14", qa && qa.time === "2026-10-09 16:14", qa && qa.time);
assert("qt 无前瞻PE → pe_fwd=null（保留旧值信号）", qa && qa.pe_fwd == null);
// 港股样例（腾讯 10-09 收盘；PE-TTM 在 [57]、52周在 [48]/[49]、年内 [61]）
const rowH = mkRow({ 1: "腾讯控股", 3: "424.800", 30: "2026/10/09 16:08:14", 32: "3.26", 57: "14.24", 45: "38625.3886", 48: "663.700", 49: "411.000", 61: "-28.45" }, 78);
const qh = P.qtParse("hk00700", rowH);
assert("港股解析成功", !!qh);
assert("港股 PE-TTM=14.24（[57]，与 westock 同值）", qh && qh.pe_ratio === 14.24);
assert("港股 52周高/低=663.7/411（[48]/[49]）", qh && qh.high_52week === 663.7 && qh.low_52week === 411);
assert("港股 年内=-28.45（[61]）", qh && qh.chg_ytd === -28.45);
assert("港股 市值=38625.39亿→元", qh && qh.total_market_cap === 38625.3886e8);
assert("港股 PB/股息 qt 无 → null（保留旧值信号）", qh && qh.pb_ratio == null && qh.dividend_ratio_ttm == null);
assert("港股 时间归一 2026-10-09 16:08", qh && qh.time === "2026-10-09 16:08", qh && qh.time);
// 指数样例（上证：成交额万元在 [37]，[47]/[48] 是涨跌停价不是52周）
const rowI = mkRow({ 1: "上证指数", 3: "3813.79", 30: "20261009161400", 32: "0.05", 37: "88856120", 45: "674203.09", 47: "-1", 48: "-1" });
const qi = P.qtParse("sh000001", rowI);
assert("指数解析成功", !!qi);
assert("指数 成交额万元→元 = 888561200000", qi && qi.amount === 88856120e4, qi && qi.amount);
assert("指数 不取 52 周字段（[47]/[48] 涨跌停价）", qi && qi.high_52week == null && qi.low_52week == null);
// 边界
assert("乱行返回 null", P.qtParse("sh600519", "not-a-quote") == null);
assert("空串返回 null", P.qtParse("sh600519", "") == null);
assert("价格为 0 停牌行返回 null", P.qtParse("sh600519", mkRow({ 3: "0.00" })) == null);

console.log("=== 3. 在线 qt 拉取冒烟（qtFetch） ===");
(async () => {
  try {
    const { quotes, source } = await P.quotes(["sh600519", "hk00700", "sh000001"]);
    assert("westock 模式 source=westock", source === "westock", source);
    assert("westock 茅茅行情字段齐全", quotes["sh600519"] && quotes["sh600519"].pe_fwd != null);
    process.env.IA_PROVIDER = "qt";
    const r2 = await P.quotes(["sh600519", "hk00700", "sh000001"]);
    assert("qt 模式 source=qt", r2.source === "qt", r2.source);
    const a = r2.quotes["sh600519"], h = r2.quotes["hk00700"], i = r2.quotes["sh000001"];
    assert("qt 茅茅 px>0 且 PE 与 westock 同值口径", a && a.price > 0 && a.pe_ratio > 0, JSON.stringify(a && { px: a.price, pe: a.pe_ratio }));
    assert("qt 腾讯 px>0 且 PE-TTM>0", h && h.price > 0 && h.pe_ratio > 0, JSON.stringify(h && { px: h.price, pe: h.pe_ratio }));
    assert("qt 上证 px>0 且成交额>1e11", i && i.price > 0 && i.amount > 1e11, JSON.stringify(i && { px: i.price, amt: i.amount }));
    assert("qt 茅茅 52周高≈1539.98", a && Math.abs(a.high_52week - 1539.98) < 1, a && a.high_52week);
    assert("qt 与 westock 茅茅价格一致（同源）", a && Math.abs(a.price - quotes["sh600519"].price) < 0.01, a && a.price + " vs " + quotes["sh600519"].price);
  } catch (e) {
    assert("在线拉取异常: " + e.message, false);
  } finally {
    delete process.env.IA_PROVIDER;
  }

  console.log("\n结果: " + pass + " 通过, " + fail + " 失败");
  process.exit(fail ? 1 : 0);
})();
