// 组合权重自检：渲染投资组合页并校验明细权重合计 = 100%
const fs = require("fs");
const path = require("path");
const dir = __dirname;
const store = {};

function mkEl(id) {
  return { id, style: {}, innerHTML: "", textContent: "", className: "", value: "", children: [], appendChild() {}, setAttribute() {}, addEventListener() {} };
}
global.document = {
  getElementById(id) { if (!store[id]) store[id] = mkEl(id); return store[id]; },
  querySelectorAll() { return []; },
  createElement() { return mkEl("tmp"); },
  addEventListener() {}
};
global.window = {};
global.navigator = {};

eval(fs.readFileSync(path.join(dir, "data.js"), "utf8"));
eval(fs.readFileSync(path.join(dir, "app.js"), "utf8"));

function check(label) {
  const html = store["pdetail"].innerHTML || "";
  const re = /组合权重 ([\d.]+)%/g;
  let m, sum = 0, n = 0;
  while ((m = re.exec(html)) !== null) { sum += Number(m[1]); n++; }
  const meta = (store["donut"].innerHTML || "").match(/权重合计<\/div><div><b>([\d.]+)%/);
  console.log(label + " → 明细条数 " + n + "，权重合计 " + sum.toFixed(1) + "%" + (meta ? "，面板显示 " + meta[1] + "%" : ""));
  if (n === 0) throw new Error("no holdings rendered");
  if (Math.abs(sum - 100) > 0.6) throw new Error("weight sum out of range: " + sum.toFixed(2) + "%");
}

// 默认配比
window.showTab("portfolio");
check("默认配比 40/30/20/10");

// 极端配比：单象限拉满
const cases = [
  ["steady", 60], ["growth", 60], ["rotate", 60], ["tenx", 60]
];
for (const [k, v] of cases) {
  window._setA(k, v);
  store["pdetail"].innerHTML = "";
  window.showTab("portfolio");
  check("调整 " + k + "=60");
}

// 全部归零边界
["steady", "growth", "rotate", "tenx"].forEach(k => window._setA(k, 0));
store["pdetail"].innerHTML = "";
window.showTab("portfolio");
console.log("全零边界 →", (store["pdetail"].innerHTML || "").includes("请调高") ? "提示正常" : "异常");

console.log("PORTFOLIO-WEIGHT-OK");
