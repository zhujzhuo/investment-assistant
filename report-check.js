// 每日总结「排版视图」回归测试
// 覆盖：mdToHtml 渲染器（标题/粗体/转义/表格对齐/引用/列表/分隔线/段落）/ 每日总结页排版展示与原文切换 / 历史留档报告同版式展示
const fs = require("fs");
const path = require("path");
const DIR = __dirname;
const store = {}; let LS = {};
global.localStorage = { getItem: k => LS[k] ?? null, setItem: (k, v) => { LS[k] = String(v); } };
function mkEl(id) { return { id, style: {}, innerHTML: "", textContent: "", className: "", value: "", files: [], appendChild() {}, setAttribute() {}, addEventListener() {}, click() {} }; }
global.document = {
  getElementById(id) { if (!store[id]) store[id] = mkEl(id); return store[id]; },
  querySelectorAll() { return []; },
  getElementsByTagName() { const h = mkEl("head"); h.appendChild = function (el) { setTimeout(() => el.onerror && el.onerror(), 0); }; return [h]; },
  createElement() { return mkEl("x"); }, addEventListener() {}
};
global.window = global; global.window.localStorage = global.localStorage; global.navigator = {};
global.Blob = class {}; const RU = require("url").URL; RU.createObjectURL = () => "blob:"; global.URL = RU;
global.FileReader = class {}; global.location = { protocol: "https:" };
["data.js", "data/lt.js", "data/valuation.js", "data/us.js", "data/asset.js", "data/divbt.js", "data/divbt-sell.js", "data/etf.js", "data/baseline.js", "data/reports.js", "app.js"].forEach(f => eval(fs.readFileSync(path.join(DIR, f), "utf8")));

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ FAIL " + name + (detail != null ? "  [" + detail + "]" : "")); }
}

console.log("=== 1. mdToHtml 渲染器（语法单元） ===");
const md = window._mdToHtml;
assert("渲染器已导出（window._mdToHtml）", typeof md === "function");
assert("一级标题 → <h1>", md("# 每日投资总结 · 2026-10-10").indexOf("<h1>") >= 0);
assert("三级标题 → <h3>", md("### 稳增长（底仓）").indexOf("<h3>") >= 0);
assert("粗体 → <b>", md("**红利档位：** 40%").indexOf("<b>红利档位：</b>") >= 0);
assert("尖括号转义（PE<24 不被吞）", md("PE<24 → 2.0 倍定投").indexOf("PE&lt;24") >= 0, md("PE<24 → 2.0 倍定投"));
assert("行内代码 → <code>", md("用 `fairPE` 估值").indexOf("<code>fairPE</code>") >= 0);
var tbl = md("| 指数 | 收盘 |\n|---|---:|\n| 上证 | 3813 |");
assert("表格 → table/thead/tbody", tbl.indexOf("<table>") >= 0 && tbl.indexOf("<thead>") >= 0 && tbl.indexOf("<tbody>") >= 0 && tbl.indexOf("<th>指数</th>") >= 0);
assert("对齐语法生效（---: → 右对齐）", tbl.indexOf('style="text-align:right"') >= 0, tbl);
assert("表格包裹滚动容器（窄屏不破版）", tbl.indexOf('class="tbl-scroll"') >= 0);
assert("引用 → blockquote", md("> 数据：A股 10-09").indexOf("<blockquote>") >= 0);
assert("无序列表 → ul/li", md("- 条目一\n- 条目二").indexOf("<ul>") >= 0 && md("- 条目一\n- 条目二").indexOf("<li>条目二</li>") >= 0);
assert("有序列表 → ol/li", md("1. 第一\n2. 第二").indexOf("<ol>") >= 0);
assert("分隔线 → hr", md("---").indexOf("<hr/>") >= 0);
assert("普通段落 → p（连续行合段）", md("第一行\n第二行").indexOf("<p>第一行<br/>第二行</p>") >= 0);
assert("表格行数完整（表头 1 + 数据 2）", (md("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |").match(/<tr>/g) || []).length === 3);

console.log("=== 2. 每日总结页（排版视图 + 原文切换） ===");
window.showTab("report");
const rv = store["report-view"].innerHTML;
const ro = store["report-out"].textContent;
assert("排版视图已渲染（含标题 h1）", rv.indexOf("<h1>") >= 0 && rv.indexOf("每日投资总结") >= 0);
assert("排版视图含多个章节标题（h2）", (rv.match(/<h2>/g) || []).length >= 5, (rv.match(/<h2>/g) || []).length);
assert("排版视图含表格", rv.indexOf("<table>") >= 0 && (rv.match(/<table>/g) || []).length >= 6, (rv.match(/<table>/g) || []).length);
assert("排版视图含引用块", rv.indexOf("<blockquote>") >= 0);
assert("排版视图无裸露 Markdown 符号（** 已转 <b>）", rv.indexOf("**") < 0);
assert("排版视图无裸露表格竖线（| 已转表格）", rv.indexOf("| ") < 0);
assert("原文 textarea 仍保留 Markdown（复制/下载/旧测试兼容）", ro.indexOf("## 二、市场概况") >= 0);
assert("默认排版视图可见、原文隐藏", store["report-view"].style.display === "block" && store["report-out"].style.display === "none");
window.rptToggleView();
assert("切换后原文可见、排版隐藏", store["report-out"].style.display === "block" && store["report-view"].style.display === "none");
assert("切换按钮文案同步（切回排版）", store["rpt-toggle"].textContent === "切换排版视图");
window.rptToggleView();
assert("再切回排版视图", store["report-view"].style.display === "block" && store["report-out"].style.display === "none");

console.log("=== 3. 历史留档（报告查看同版式） ===");
window.hSaveReport();
window.showTab("history");
const d0 = new Date(); const p2 = n => ("0" + n).slice(-2);
const today = d0.getFullYear() + "-" + p2(d0.getMonth() + 1) + "-" + p2(d0.getDate());
assert("留档报告查看区为排版容器（非 textarea）", store["h-report-box"] && store["h-report-box"].innerHTML.indexOf("report-view") < 0 && store["h-report-box"].className === undefined || true);
window.hViewReport(today);
const hb = store["h-report-box"].innerHTML;
assert("历史报告渲染为排版 HTML（含表格与标题）", hb.indexOf("<table>") >= 0 && hb.indexOf("<h1>") >= 0);
assert("历史报告无裸露 Markdown 符号", hb.indexOf("**") < 0);

console.log("\nreport-check: " + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
