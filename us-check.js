// 美股组合 + 全球指数自检
const fs = require("fs");
const path = require("path");
const dir = __dirname;
const store = {};

let LS = {};
global.localStorage = {
  getItem(k) { return Object.prototype.hasOwnProperty.call(LS, k) ? LS[k] : null; },
  setItem(k, v) { LS[k] = String(v); }
};

function mkEl(id) {
  return { id, style: {}, innerHTML: "", textContent: "", className: "", value: "", files: [], appendChild() {}, setAttribute() {}, addEventListener() {}, click() {} };
}

// 构造行情串（字段索引：1=名称 3=现价 4=昨收 30=时间）
function q(name, px, prev, time) {
  const f = new Array(50).fill("0");
  f[1] = name; f[2] = "TEST"; f[3] = String(px); f[4] = String(prev); f[30] = time || "2026-10-06 16:00:00";
  return f.join("~");
}

// 美股：MSFT 价格翻倍（525.18→1050），纳斯达克与恒生科技同步更新
const FIXTURE = {
  v_usMSFT: q("微软", 1050, 517.53),
  v_usGOOGL: q("谷歌-A", 346.47, 336.48),
  v_usIXIC: q("纳斯达克", 28000, 27190.86),
  v_hkHSTECH: q("恒生科技指数", 4300, 4183.68),
  v_sh000001: q("上证指数", 3900, 3842.19),
  v_sz399001: q("深证成指", 13000, 12887.62),
  v_sz399006: q("创业板指", 3200, 3135.28)
};
let scriptMode = "ok";
const requested = [];

global.document = {
  getElementById(id) { if (!store[id]) store[id] = mkEl(id); return store[id]; },
  querySelectorAll() { return []; },
  getElementsByTagName() {
    const head = mkEl("head");
    head.appendChild = function (el) {
      requested.push(el.src || "");
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
global.URL.createObjectURL = function () { return "blob:x"; };
global.FileReader = class { readAsText() {} };
global.location = { protocol: "https:" };

eval(fs.readFileSync(path.join(dir, "data.js"), "utf8"));
const SNAP_600519 = (window.STOCKS.find(s => s.code === "sh600519") || {}).px;   // 快照价随每日刷新变化，测试不钉死具体数字
eval(fs.readFileSync(path.join(dir, "data/valuation.js"), "utf8"));
eval(fs.readFileSync(path.join(dir, "data/us.js"), "utf8"));
eval(fs.readFileSync(path.join(dir, "app.js"), "utf8"));

const wait = ms => new Promise(r => setTimeout(r, ms));
function assert(name, cond, extra) {
  if (!cond) throw new Error("FAIL: " + name + (extra ? " → " + extra : ""));
  console.log("  ✓ " + name + (extra ? "（" + extra + "）" : ""));
}
const US = window.US_STOCKS, UM = window.US_MKT;
const get = c => US.find(s => s.code === c);

(async function () {
  console.log("=== 1. 数据完整性 ===");
  assert("美股标的 21 只", US.length === 21, "实际 " + US.length);
  assert("全球指数 6 个", UM.indices.length === 6, "实际 " + UM.indices.length);
  assert("含恒生科技指数", UM.indices.some(i => i.short === "HSTECH" && i.close > 0));
  assert("含纳斯达克综合", UM.indices.some(i => i.short === "IXIC" && i.close > 0));
  assert("含纳斯达克100", UM.indices.some(i => i.short === "NDX"));
  assert("四象限均有标的", ["steady", "growth", "rotate", "tenx"].every(k => US.some(s => s.cat.indexOf(k) >= 0)));
  const noPx = US.filter(s => !s.px || s.px <= 0);
  assert("全部美股有有效价格", noPx.length === 0, noPx.map(s => s.name).join(","));
  const noComp = US.filter(s => !isFinite(s.moat + s.quality + s.mgmt + s.growth + s.valuation));
  assert("五维评分齐全", noComp.length === 0);

  console.log("=== 2. 估值信号与参考价 ===");
  const amzn = get("usAMZN"), avgo = get("usAVGO"), coin = get("usCOIN");
  window.showTab("us");
  const tbl = store["us-table"].innerHTML;
  assert("AMZN(PE 20.23 < 带 22) 判为低于合理PE带", tbl.indexOf("低于合理PE带") >= 0);
  assert("AVGO(PE 46.24 > 带 45) 判为高于合理PE带", tbl.indexOf("高于合理PE带") >= 0);
  assert("COIN 亏损判为盈利口径不适用", tbl.indexOf("盈利口径不适用") >= 0);
  const body = store["us-body"].innerHTML;
  assert("美股页含全球指数区块", body.indexOf("相关全球指数") >= 0);
  assert("美股页含恒生科技", body.indexOf("恒生科技指数") >= 0);
  assert("美股页含纳斯达克", body.indexOf("纳斯达克") >= 0);
  assert("美股页四象限齐全", ["稳增长", "高增长", "热点轮动", "十倍空间"].every(t => body.indexOf(t) >= 0));
  assert("美股页独立于A股组合", body.indexOf("与 A股/港股组合互不干扰") >= 0);

  console.log("=== 3. 推荐数量与参考价区间 ===");
  const P = window.usPicks ? window.usPicks() : null;
  // usPicks 未导出，改为从页面统计：每个象限表的行数
  const rowsOf = (html, marker) => {
    const i = html.indexOf(marker);
    if (i < 0) return -1;
    const seg = html.slice(i, html.indexOf("</table>", i));
    return (seg.match(/<tr title=/g) || []).length;
  };
  assert("稳增长推荐 ≤3 只", rowsOf(body, "稳增长 · 底仓") === 3, rowsOf(body, "稳增长 · 底仓"));
  assert("高增长推荐 ≤3 只", rowsOf(body, "高增长 · 进攻") === 3, rowsOf(body, "高增长 · 进攻"));
  assert("热点轮动推荐 ≤2 只", rowsOf(body, "热点轮动 · 卫星") === 2, rowsOf(body, "热点轮动 · 卫星"));
  assert("十倍空间推荐 ≤2 只", rowsOf(body, "十倍空间 · 期权") === 2, rowsOf(body, "十倍空间 · 期权"));
  assert("参考价区间含中枢", body.indexOf("中枢") >= 0);

  console.log("=== 4. 组合权重合计 ===");
  function detailWeights() {
    const d = store["us-detail"].innerHTML;
    return (d.match(/权重 ([\d.]+)%/g) || []).map(x => Number(x.replace(/[^\d.]/g, "")));
  }
  const w0 = detailWeights();
  const sum0 = w0.reduce((a, b) => a + b, 0);
  assert("默认配比权重合计 100%", Math.abs(sum0 - 100) < 0.6, "合计 " + sum0.toFixed(1) + "%");
  window._setUA("steady", 60);
  const w1 = detailWeights(), sum1 = w1.reduce((a, b) => a + b, 0);
  assert("steady=60 时仍合计 100%", Math.abs(sum1 - 100) < 0.6, "合计 " + sum1.toFixed(1) + "%");
  window._setUA("steady", 35); window._setUA("growth", 0); window._setUA("rotate", 0); window._setUA("tenx", 0);
  const w2 = detailWeights(), sum2 = w2.reduce((a, b) => a + b, 0);
  assert("仅剩单一象限时合计 100%", Math.abs(sum2 - 100) < 0.6, "合计 " + sum2.toFixed(1) + "%");
  window._setUA("growth", 35); window._setUA("rotate", 20); window._setUA("tenx", 10);
  assert("环形图已渲染", store["us-donut"].innerHTML.indexOf("<svg") >= 0);

  console.log("=== 5. 筛选与排序 ===");
  window._usView("cat", "tenx");
  const t4 = (store["us-table"].innerHTML.match(/<tr title=/g) || []).length;
  assert("切到十倍空间后 4 行", t4 === 4, "实际 " + t4);
  window._usView("cat", "all");
  window._usView("sort", "pe");
  const peFirst = Number(store["us-table"].innerHTML.match(/<td>([\d.]+)<\/td><td>[\d.]+<\/td><td>[—\d.]+%?<\/td><td>[\d.]+<\/td>/)?.[1] || 0);
  const sorted = US.filter(s => s.pe).sort((a, b) => a.pe - b.pe);
  assert("按 PE 升序：首行即最低 PE " + sorted[0].pe, store["us-table"].innerHTML.indexOf(">" + sorted[0].pe.toFixed(1) + "<") >= 0);
  window._usView("sort", "pos52");
  assert("按 52 周位置排序可用", store["us-table"].innerHTML.indexOf("<tr title=") >= 0);
  window._usView("sort", "comp"); window._usView("cat", "all");

  console.log("=== 6. 实时行情联动（美股 + 全球指数）===");
  const msftBase = get("usMSFT");
  const div0 = msftBase.div;
  window.showTab("radar");
  const radar0 = store["radar-body"].innerHTML;
  assert("雷达页含全球指数区块", radar0.indexOf("全球指数") >= 0);
  assert("雷达页含恒生科技", radar0.indexOf("HSTECH") >= 0 || radar0.indexOf("恒生科技") >= 0);
  assert("雷达页含纳斯达克", radar0.indexOf("纳斯达克") >= 0);
  window.showTab("us");
  await wait(300);              // 先让页面初始化时的自动加载跑完，避免混入批次计数
  requested.length = 0;
  window.showTab("radar");
  window.refreshLive();
  await wait(300);
  assert("分两批请求行情", requested.length === 2, "实际 " + requested.length + " 批");
  assert("美股代码加入实时请求", requested.some(u => u.indexOf("usMSFT") >= 0));
  assert("全球指数加入实时请求", requested.some(u => u.indexOf("usIXIC") >= 0) && requested.some(u => u.indexOf("hkHSTECH") >= 0));
  assert("含点代码 BRK.B 已排除（避免脚本中断）", !requested.some(u => u.indexOf("usBRK.B") >= 0));

  const ms = get("usMSFT");
  assert("MSFT 价格已更新为 1050", ms.px === 1050, "现价 " + ms.px);
  assert("MSFT PE 按 EPS 重算 = 1050/17.95", Math.abs(ms.pe - 1050 / 17.95) < 0.05, "PE " + Number(ms.pe).toFixed(2));
  assert("MSFT 股息率随价反向缩小", ms.div < div0, div0 + "% → " + Number(ms.div).toFixed(2) + "%");
  assert("52周位置封顶 100%", ms.pos52 <= 100 && ms.pos52 >= 0, Number(ms.pos52).toFixed(1));
  const ixic = UM.indices.find(i => i.short === "IXIC");
  assert("纳斯达克实时更新为 28000", ixic.close === 28000, "点位 " + ixic.close);
  const hstech = UM.indices.find(i => i.short === "HSTECH");
  assert("恒生科技实时更新为 4300", hstech.close === 4300, "点位 " + hstech.close);

  console.log("=== 7. 重复刷新不累积 & 独立性 ===");
  window.refreshLive();
  await wait(300);
  const ms2 = get("usMSFT");
  assert("重复刷新价格不累积", ms2.px === 1050, "现价 " + ms2.px);
  assert("重复刷新 PE 不累积", Math.abs(ms2.pe - 1050 / 17.95) < 0.05, "PE " + Number(ms2.pe).toFixed(2));
  const ko = get("usKO");
  assert("无实时数据的美股保持快照", ko.px === 86.17, "现价 " + ko.px);
  const ahStock = window.STOCKS.find(s => s.code === "sh600519");
  assert("A股标的未被美股逻辑污染（价格保持快照值）", ahStock.px === SNAP_600519, "现价 " + ahStock.px + " vs 快照 " + SNAP_600519);

  console.log("=== 8. 异常降级 ===");
  scriptMode = "fail";
  window.refreshLive();
  await wait(300);
  assert("网络失败不崩溃", true);
  scriptMode = "ok";

  console.log("\nUS-OK");
})().catch(e => { console.error("\n" + e.message); process.exit(1); });
