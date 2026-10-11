// 历史留档自检：记录/幂等/净值计算/报告保存/导入导出/异常降级
const fs = require("fs");
const path = require("path");
const dir = __dirname;
const store = {};

// --- localStorage 桩 ---
let LS = {};
let lsBroken = false;
global.localStorage = {
  getItem(k) { if (lsBroken) throw new Error("denied"); return Object.prototype.hasOwnProperty.call(LS, k) ? LS[k] : null; },
  setItem(k, v) { if (lsBroken) throw new Error("denied"); LS[k] = String(v); }
};

function mkEl(id) {
  return { id, style: {}, innerHTML: "", textContent: "", className: "", value: "", files: [], appendChild() {}, setAttribute() {}, addEventListener() {}, click() {} };
}
const FIXTURE = {
  v_sh600519: "1~贵州茅台~600519~1300.00~1258.62~1260~1~1~1~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20261004153000~41.38~3.29~1310~1250~",
  v_hk00700: "100~腾讯控股~00700~450.000~421.200~430.000~1~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~2026/10/04 16:00:00~28.80~6.84~455~425~",
  v_sh000001: "1~上证指数~000001~3900.00~3842.19~3850~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20261004153000~57.81~1.50~3910~3840~",
  v_sz399001: "1~深证成指~399001~13000.00~12887.62~12900~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20261004153000~112~0.87~13050~12800~",
  v_sz399006: "1~创业板指~399006~3200.00~3135.28~3150~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20261004153000~64~2.06~3210~3130~"
};
let scriptMode = "ok";

global.document = {
  getElementById(id) { if (!store[id]) store[id] = mkEl(id); return store[id]; },
  querySelectorAll() { return []; },
  getElementsByTagName() {
    const head = mkEl("head");
    head.appendChild = function (el) {
      setTimeout(function () {
        if (scriptMode === "fail") { if (el.onerror) el.onerror(); return; }
        if (scriptMode === "ok") Object.keys(FIXTURE).forEach(k => { global.window[k] = FIXTURE[k]; });
        if (el.onload) el.onload();
      }, 0);
    };
    return [head];
  },
  createElement() { return mkEl("x"); },
  addEventListener() {}
};
global.window = global;
global.window.localStorage = global.localStorage;
global.navigator = {};
global.Blob = class { constructor(p) { this.parts = p; } };
// 注意：不要覆盖 global.URL（node 内部 fs shim 依赖它）；node 22 自带 createObjectURL 会对假 Blob 报错，这里强制替换
global.URL.createObjectURL = function () { return "blob:x"; };
global.FileReader = class { readAsText() {} };

eval(fs.readFileSync(path.join(dir, "data.js"), "utf8"));
eval(fs.readFileSync(path.join(dir, "data/lt.js"), "utf8"));
eval(fs.readFileSync(path.join(dir, "app.js"), "utf8"));

const wait = ms => new Promise(r => setTimeout(r, ms));
const KEY = "ia_history_v1";
const read = () => JSON.parse(LS[KEY] || "{}");

function assert(name, cond, extra) {
  if (!cond) throw new Error("FAIL: " + name + (extra ? " → " + extra : ""));
  console.log("  ✓ " + name + (extra ? "（" + extra + "）" : ""));
}

(async function () {
  await wait(200);                       // 等实时行情加载 + 自动留档

  // 1) 自动留档
  let d = read();
  assert("打开页面自动记录当日快照", d.snaps && d.snaps.length === 1, "条数=" + (d.snaps || []).length);
  const s0 = d.snaps[0];
  assert("快照含推荐标的", s0.count > 0, s0.count + " 只");
  assert("快照记录配比", s0.alloc && s0.alloc.steady === 40);
  assert("快照标记数据来源", s0.mode === "实时", s0.mode);
  assert("快照记录上证点位", Math.abs(s0.indices[0].close - 3900) < 0.01, String(s0.indices[0].close));

  // 2) 同一天重复记录不重复追加（幂等）
  window.hRecordNow();
  d = read();
  assert("同日重复记录不产生重复条目", d.snaps.length === 1, "条数=" + d.snaps.length);

  // 3) 报告保存与读取
  window.hSaveReport();
  d = read();
  const dates = Object.keys(d.reports);
  assert("报告已保存", dates.length === 1 && d.reports[dates[0]].includes("每日投资总结"), dates[0]);

  // 4) 渲染历史页 + 净值
  window.showTab("history");
  const html = store["history-body"].innerHTML || "";
  assert("历史页渲染出留档表格", html.includes("留档明细") && html.includes("组合净值走势"));
  assert("历史页提示存储位置", html.includes("本机浏览器"));
  assert("单条快照时提示需≥2条", (store["h-chart"].innerHTML || "").includes("至少 2 条留档"));

  // 5) 模拟第二条快照（改价后再记）→ 校验净值计算
  // 注：组合成员不含茅台，改组合内标的（腾讯）与上证即可
  FIXTURE.v_hk00700 = FIXTURE.v_hk00700.replace("~450.000~421.200~", "~500.000~421.200~");
  FIXTURE.v_sh000001 = FIXTURE.v_sh000001.replace("~3900.00~3842.19~", "~4000.00~3842.19~");
  const old = d.snaps[0].date;
  d.snaps[0].date = "2026-09-01";       // 把首条改到过去，腾出今天
  LS[KEY] = JSON.stringify(d);
  window.refreshLive();
  await wait(200);
  d = read();
  assert("跨日新增第二条快照", d.snaps.length === 2, "条数=" + d.snaps.length);
  window.showTab("history");
  const chart = store["h-chart"].innerHTML || "";
  assert("两条快照后画出走势图", chart.includes("<svg") && chart.includes("polyline"));
  // 净值口径校验：茅台 1258.62→1300→1400，组合净值应随之上行
  const navVals = (chart.match(/font-weight="bold"[^>]*>([\d.]+)</g) || []).map(t => Number((t.match(/>([\d.]+)</) || [0, NaN])[1]));
  if (process.env.DEBUG_CHART) {
    console.log("SNAPS:", JSON.stringify(read().snaps.map(s => ({ d: s.date, m: s.mode, px: [].concat(s.picks.steady, s.picks.growth, s.picks.rotate, s.picks.tenx).map(x => x.code + ":" + x.px) }))));
    console.log("CHART:", chart.slice(-400));
  }
  assert("末点组合净值 > 1（整体上行）", navVals.length >= 2 && navVals[0] > 1, "末值=" + navVals[0]);

  // 6) 导出（不抛错）与删除
  window.hExport();
  window.hDelSnap("2026-09-01");
  d = read();
  assert("删除指定日期留档", d.snaps.length === 1 && d.snaps[0].date !== "2026-09-01");

  // 7) 本地存储不可用时的降级（不崩溃）
  lsBroken = true;
  let crashed = false;
  try { window.hRecordNow(); window.showTab("history"); } catch (e) { crashed = true; }
  assert("本地存储不可用时降级不崩溃", !crashed);
  assert("页面显示存储不可用", (store["history-body"].innerHTML || "").includes("不可用"));

  console.log("HISTORY-STORE-OK");
  process.exit(0);
})();
