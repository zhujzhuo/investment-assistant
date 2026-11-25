// 提取「每日推荐四象限」(pick-body) 与美股四象限 (us-body) 渲染文本
const fs = require("fs");
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
global.setTimeout = setTimeout;
["data.js", "data/lt.js", "data/valuation.js", "data/us.js", "data/asset.js", "data/etf.js", "data/divbt.js", "data/index.js", "app.js"].forEach(f => eval(fs.readFileSync(f, "utf8")));

function txt(html) {
  return html.replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, "|")
    .replace(/\|+/g, "|")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .trim();
}

window.showTab("ah");
console.log("=== PICK ===");
console.log(txt(store["pick-body"] ? store["pick-body"].innerHTML : "(none)"));
console.log("=== WATCH ===");
console.log(txt(store["watch-body"] ? store["watch-body"].innerHTML : "(none)"));
console.log("=== SCREEN ===");
console.log(txt(store["screen-body"] ? store["screen-body"].innerHTML : "(none)"));
window.showTab("us");
console.log("=== US ===");
console.log(txt(store["us-detail"] ? store["us-detail"].innerHTML : "(none)"));
console.log("=== USDONUT ===");
console.log(txt(store["us-donut"] ? store["us-donut"].innerHTML : "(none)"));

window.showTab("us");
console.log("=== USTABLE ===");
console.log(txt(store["us-table"] ? store["us-table"].innerHTML : "(none)"));
window.showTab("plan");
console.log("=== PLAN ===");
console.log(txt(store["plan-body"] ? store["plan-body"].innerHTML : "(none)"));
