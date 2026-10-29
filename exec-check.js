// 仓位执行层自检（2026-10-29）：
//   ① 档位仓执行带宽（|目标 − 已执行| ≥ 3pp 才动手）② 分红月脉冲过滤（新档位需连续 2 期确认）
//   ③ 内部倾斜不为换仓（页面文案 + 回测依据）④ 页面与日报拆「目标 / 已执行 / 偏离」三栏
// 用法: node exec-check.js
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
global.document = {
  getElementById(id) { if (!store[id]) store[id] = mkEl(id); return store[id]; },
  querySelectorAll() { return []; },
  getElementsByTagName() { const h = mkEl("head"); h.appendChild = function (el) { setTimeout(function () { if (el.onerror) el.onerror(); }, 0); }; return [h]; },
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
global.setTimeout = setTimeout;

eval(fs.readFileSync(path.join(dir, "data.js"), "utf8"));
eval(fs.readFileSync(path.join(dir, "data/valuation.js"), "utf8"));
eval(fs.readFileSync(path.join(dir, "data/us.js"), "utf8"));
eval(fs.readFileSync(path.join(dir, "data/asset.js"), "utf8"));
eval(fs.readFileSync(path.join(dir, "data/etf.js"), "utf8"));
eval(fs.readFileSync(path.join(dir, "app.js"), "utf8"));

let pass = 0, fail = 0;
function assert(name, ok, extra) {
  if (ok) { pass++; console.log("  ✓ " + name + (extra ? "（" + extra + "）" : "")); }
  else { fail++; console.log("  ✗ " + name + (extra ? " → " + extra : "")); }
}

console.log("== 1. 档位仓执行层（带宽 + 脉冲过滤）==");
const P = window._planState(), E = P.exec;
assert("planState 暴露 exec 层", !!E && typeof E.confirmed === "number" && typeof E.exec === "number");
assert("历史档位序列 ≥24 期", E.hist.length >= 24, E.hist.length + " 期");
assert("脉冲序列可辨（2026-05=46 / 2026-06=42）", E.hist[31] === 46 && E.hist[32] === 42, E.hist[31] + "/" + E.hist[32]);
assert("本期与上期一致 → 非待确认", E.pending === false && E.confirmed === E.cur, E.cur + "%");
assert("默认已执行=确认值 → 偏离 0、不动", E.gap === 0 && E.act === false);
assert("带宽阈值 3pp", E.band === 3);

console.log("== 2. 带宽判定（偏离 <3pp 不动 / ≥3pp 执行）==");
window._setExecBase(E.confirmed - 2);
const P2 = window._planState();
assert("偏离 2pp → 不动（<3pp 带宽）", P2.exec.gap === 2 && P2.exec.act === false, "gap " + P2.exec.gap);
window._setExecBase(E.confirmed - 4);
const P3 = window._planState();
assert("偏离 4pp → 执行（≥3pp 带宽）", P3.exec.gap === 4 && P3.exec.act === true, "gap " + P3.exec.gap);
assert("执行金额按 100 万折算", P3.exec.amt === (4 * 10000).toLocaleString(), P3.exec.amt + " 元");
window._setExecBase(E.confirmed);
const P4 = window._planState();
assert("记录已执行后偏离归零", P4.exec.gap === 0 && P4.exec.exec === E.confirmed);

console.log("== 3. 页面三栏（目标 / 已执行 / 是否动手）==");
window.showTab("plan");
const hp = store["plan-body"].innerHTML;
assert("plan 页含「档位目标 ／ 已执行」", hp.indexOf("档位目标 ／ 已执行") >= 0);
assert("plan 页含「是否动手」", hp.indexOf("是否动手") >= 0);
assert("plan 页注明连续 2 期确认 + 带宽", hp.indexOf("连续 2 期") >= 0 && hp.indexOf("pp 才动手") >= 0);
assert("plan 页含已执行仓位输入框", hp.indexOf("execBaseIn") >= 0 && hp.indexOf("_setExecBase") >= 0);

console.log("== 4. 倾斜不为换仓 ==");
window.showTab("divcmp");
const hd = store["divcmp-body"].innerHTML;
assert("红利对比页「不单独换仓」", hd.indexOf("不单独换仓") >= 0);
assert("倾斜回测依据（−0.05pp）", hd.indexOf("0.05pp") >= 0);
assert("倾斜只在三种时候顺带执行", hd.indexOf("新钱投入、分红到账、本来就发生的加减仓") >= 0);
assert("横向对比页不再要求互换", hd.indexOf("新增的钱") >= 0);

console.log("== 5. 日报三栏 ==");
let md = "";
try { md = window._reportMarkdown(); } catch (e) { md = ""; }
assert("日报可生成", md.length > 200);
assert("日报含档位目标／已执行／偏离", /档位目标 \d+% ／已执行 \d+%/.test(md) && /偏离 [+-]?\d+pp/.test(md), (md.match(/档位目标[^|]*/) || [""])[0].slice(0, 80));
assert("日报含执行与否判定", md.indexOf("不动") >= 0 || md.indexOf("执行") >= 0);
assert("日报含仓位执行口径行", md.indexOf("仓位执行口径") >= 0);
assert("日报注明倾斜不单独换仓", md.indexOf("不单独换仓") >= 0);

console.log("\n结果：" + (pass + fail) + " 项 · " + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
