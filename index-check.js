// 宽基指数页自检：数据快照口径 + 页面渲染 + 定投金额 + 微信提醒跨档去重
// 用法: node index-check.js
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const DIR = __dirname;
const NODE = process.execPath;

let pass = 0, fail = 0;
function assert(name, ok, detail) {
  if (ok) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (detail ? " → " + detail : "")); }
}

console.log("== 1. 数据快照 data/index.js ==");
const SRC_IDX = fs.readFileSync(path.join(DIR, "data", "index.js"), "utf8");
assert("data/index.js 存在且声明 window.BROAD", /window\.BROAD\s*=/.test(SRC_IDX));
assert("生成脚本 fetch-index.js 存在", fs.existsSync(path.join(DIR, "fetch-index.js")));
assert("数据源为中证指数官网 index-perf", /csindex\.com\.cn\/csindex-home\/perf\/index-perf/.test(fs.readFileSync(path.join(DIR, "fetch-index.js"), "utf8")));

// DOM/global 桩（与 base-check.js 同套路；loadLive 会被 head.appendChild 桩立刻 onerror 回退到快照）
const store = {}; let LS = {};
global.localStorage = { getItem: (k) => LS[k] ?? null, setItem: (k, v) => { LS[k] = String(v); } };
function mkEl(id) {
  return { id, style: {}, innerHTML: "", textContent: "", className: "", value: "", files: [],
    appendChild() {}, setAttribute() {}, addEventListener() {}, click() {} };
}
global.document = {
  getElementById(id) { if (!store[id]) store[id] = mkEl(id); return store[id]; },
  querySelectorAll() { return []; },
  getElementsByTagName() { const h = mkEl("head"); h.appendChild = function (el) { setTimeout(() => el.onerror && el.onerror(), 0); }; return [h]; },
  createElement() { return mkEl("x"); }, addEventListener() {}
};
global.window = global; global.window.localStorage = global.localStorage; global.navigator = {};
global.Blob = class {}; const RU = require("url").URL; RU.createObjectURL = () => "blob:"; global.URL = RU;
global.FileReader = class {}; global.location = { protocol: "https:" };
["data.js", "data/lt.js", "data/valuation.js", "data/us.js", "data/asset.js", "data/divbt.js",
 "data/divbt-sell.js", "data/etf.js", "data/baseline.js", "data/reports.js", "data/earnings.js",
 "data/comps.js", "data/snap-all.js", "data/index.js", "app.js"]
  .forEach(f => eval(fs.readFileSync(path.join(DIR, f), "utf8")));

const B = window.BROAD;
assert("BROAD 含 6 个宽基指数", B && B.list && B.list.length === 6, B && B.list && B.list.length);
assert("档位表 5 档且升序", B.ladder.length === 5 && B.ladder.every((t, i) => i === 0 || t.max > B.ladder[i - 1].max));
assert("档位倍数随分位单调下降", B.ladder.every((t, i) => i === 0 || t.mult <= B.ladder[i - 1].mult));
assert("锚日期与国债收益率有效", /^\d{4}-\d{2}-\d{2}$/.test(B.asOf) && B.bond10y > 0);
const core = ["000300", "000905", "000906", "000852"];
assert("覆盖用户点名的四个宽基", core.every(c => B.list.some(o => o.code === c)));
assert("每个指数有 PE / 10y分位 / ERP / 月末序列", B.list.every(o =>
  o.pe > 0 && o.pePct10y >= 0 && o.pePct10y <= 100 && o.erp != null && o.peHist.length > 12));
assert("分位 ≤ 当前 PE 在历史区间内", B.list.every(o => o.pe >= o.peStats.min && o.pe <= o.peStats.max));
assert("每个指数都有可投场内 ETF", B.list.every(o => /^(sh|sz)\d{6}$/.test(o.etf) && o.etfName));
assert("分位口径与生成端一致（≤ 占比）", /function pctOf\(series, v\)/.test(fs.readFileSync(path.join(DIR, "fetch-index.js"), "utf8")));

console.log("== 2. 接入点登记 ==");
const IDX_HTML = fs.readFileSync(path.join(DIR, "index.html"), "utf8");
const APP = fs.readFileSync(path.join(DIR, "app.js"), "utf8");
assert("index.html 有 nav-broad 按钮（含 ic/lb）", /id="nav-broad"[\s\S]{0,120}class="ic"[\s\S]{0,120}class="lb"/.test(IDX_HTML));
assert("index.html 有 tab-broad / broad-body", /id="tab-broad"/.test(IDX_HTML) && /id="broad-body"/.test(IDX_HTML));
assert("index.html 引入 data/index.js", /<script src="data\/index\.js"><\/script>/.test(IDX_HTML));
assert("app.js tabs 数组含 broad", /var tabs = \[[^\]]*"broad"[^\]]*\]/.test(APP));
assert("showTab / rerender 都有 broad 分支", /t === "broad"\) safe\(renderBroad\)/.test(APP) && /curTab === "broad"\) renderBroad\(\)/.test(APP));
const SW_SRC = fs.readFileSync(path.join(DIR, "sw.js"), "utf8");
const SW_VER = Number((SW_SRC.match(/ia-cache-v(\d+)/) || [])[1] || 0);
assert("SW 版本 >=45（外壳改动须 bump）且预缓存 data/index.js", SW_VER >= 45 && /data\/index\.js/.test(SW_SRC));
assert("导航顺序：宽基指数紧跟 A股港股（在红利对比之前）",
  /id="nav-ah"[\s\S]{0,300}id="nav-broad"[\s\S]{0,300}id="nav-divcmp"/.test(IDX_HTML));
assert("app.js tabs 顺序与导航一致：plan / ah / broad 连续", /var tabs = \["plan", "ah", "broad"/.test(APP));
assert("data-hash.js 登记 index.js", /data\/index\.js/.test(fs.readFileSync(path.join(DIR, "data-hash.js"), "utf8")));
assert("refresh.yml 纳入 fetch-index.js", /node fetch-index\.js/.test(fs.readFileSync(path.join(DIR, ".github", "workflows", "refresh.yml"), "utf8")));
assert("cloud-alert.js 拉取 data/index.js", /fetchTo\("data\/index\.js"/.test(fs.readFileSync(path.join(DIR, "cloud-alert.js"), "utf8")));
assert("loadLive 纳入宽基实时行情", /BR\.list\[bq\]\.qt\) codes\.push/.test(APP));

console.log("== 3. 页面渲染 ==");
window.showTab("broad");
const html = store["broad-body"].innerHTML;
assert("broad-body 有内容（未静默报错）", html.length > 1000, "len=" + html.length);
assert("结论卡直接回答四大宽基是否低估", html.indexOf("当前结论") >= 0 && html.indexOf("沪深300") >= 0 && html.indexOf("中证1000") >= 0);
assert("结论卡提示 5y/10y 与 ERP 背离", html.indexOf("背离") >= 0 && html.indexOf("ERP") >= 0);
assert("估值总览含 10年分位 / ERP / 52周位置", html.indexOf("10年分位") >= 0 && html.indexOf("52周位置") >= 0);
assert("10 年 PE 走势含 SVG", html.indexOf("<svg") >= 0 && html.indexOf("10 年 PE 走势") >= 0);
assert("定投档位表含 5 档", html.indexOf("低估定投档位") >= 0 && B.ladder.every(t => html.indexOf(t.label) >= 0));
assert("本期执行清单含基准金额与合计", html.indexOf("每期基准金额") >= 0 && html.indexOf("本期合计") >= 0);
assert("组合接入说明不动存量仓位", html.indexOf("不动") >= 0 && html.indexOf("新增资金") >= 0);
assert("成分重叠提示（中证800=300+500）", html.indexOf("中证800 = 沪深300 + 中证500") >= 0);
assert("提醒策略含云端 10:15 与同档不重推", html.indexOf("10:15") >= 0 && html.indexOf("同档不重推") >= 0);
assert("页脚免责声明", html.indexOf("非投资建议") >= 0 || html.indexOf("免责") >= 0 || html.indexOf(window.DISCLAIMER.slice(0, 8)) >= 0);

console.log("== 4. 定投金额口径（数据驱动，不写死行情）==");
let E = window._broadExpose();
assert("默认组合 core（800 + 1000）", E.uni === "core" && E.rows.length === 2);
const expTotal = E.rows.reduce((s, r) => {
  const o = B.list.filter(x => x.code === r.code)[0];
  const t = B.ladder[o.tierIdx];
  return s + Math.round(E.base / E.rows.length * t.mult);
}, 0);
assert("本期合计 = 基准/只数 × 各档倍数", E.total === expTotal, E.total + " vs " + expTotal);
assert("每行金额与档位倍数一致", E.rows.every(r => {
  const o = B.list.filter(x => x.code === r.code)[0];
  return r.amount === Math.round(E.base / E.rows.length * B.ladder[o.tierIdx].mult);
}));
window._dcaSetBase(10000);
E = window._broadExpose();
assert("改基准金额后合计等比放大", E.base === 10000 && E.total === Math.round(expTotal * 2));
window._dcaSetUni("all");
E = window._broadExpose();
assert("切到全部 6 只等权", E.uni === "all" && E.rows.length === 6);
window._dcaSetBase(5000); window._dcaSetUni("core");

console.log("== 5. 微信提醒：跨档才推、同档不推、首次建基线 ==");
const STATE_F = path.join(DIR, "data", "alert-state.json");
const backup = fs.readFileSync(STATE_F, "utf8");
function runAlert() {
  return execFileSync(NODE, [path.join(DIR, "alert-check.js"), "--dry"], { encoding: "utf8", timeout: 60000, cwd: DIR });
}
try {
  // 5a 首次（无 state.broad）→ 只建基线
  fs.writeFileSync(STATE_F, JSON.stringify({ sent: {} }));
  const o1 = runAlert();
  assert("首次运行建立档位基线且不推送", /宽基档位基线已建立/.test(o1) && !/【定投提醒】/.test(o1));
  // 5b 构造「上次更贵」→ 跨档变便宜，应触发
  const prev = {};
  B.list.forEach(o => { prev[o.code] = (o.tierIdx == null) ? null : Math.min(B.ladder.length - 1, o.tierIdx + 1); });
  fs.writeFileSync(STATE_F, JSON.stringify({ sent: {}, broad: prev }));
  const o2 = runAlert();
  assert("分位跨档触发【定投提醒】", /【定投提醒】/.test(o2) && /宽基档位变化/.test(o2));
  assert("消息给出 PE 分位与档位倍数", /PE分位 [\d.]+% → .+ [\d.]+×/.test(o2));
  assert("跨档消息标题定级为执行", /到价提醒【执行】|宽基定投【执行】/.test(o2));
  // 5c 同档 → 不推
  const cur = {}; B.list.forEach(o => { cur[o.code] = o.tierIdx; });
  fs.writeFileSync(STATE_F, JSON.stringify({ sent: {}, broad: cur }));
  const o3 = runAlert();
  assert("同档不重推（不骚扰）", !/【定投提醒】/.test(o3));
} finally {
  fs.writeFileSync(STATE_F, backup);   // 还原去重状态，避免污染其它测试与真实推送
}

console.log("\n结果：" + (pass + fail) + " 项 · " + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
