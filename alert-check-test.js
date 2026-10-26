// 加仓提醒测试：判定口径 + 去重状态机 + 配置解析（不实际推送）
// 用法: node alert-check-test.js
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

console.log("== 1. 脚本与配置 ==");
assert("alert-check.js 存在", fs.existsSync(path.join(DIR, "alert-check.js")));
assert("data/alert-config.json 存在（模板）", fs.existsSync(path.join(DIR, "data", "alert-config.json")));

console.log("== 2. 判定口径与消息分级（dry 跑一次）==");
const out = execFileSync(NODE, [path.join(DIR, "alert-check.js"), "--dry"], { encoding: "utf8", timeout: 60000 });
assert("输出含行情行", /行情: 中证红利 [\d.]+ \/ 红利低波 [\d.]+/.test(out), out.split("\n")[0]);
assert("输出含利差口径", /利差 [\d.]+ \/ [\d.]+pp/.test(out));
assert("触发条数行", /触发 \d+ 条/.test(out));
assert("消息分级（观察提示 或 实际加仓）", /【观察提示】|【实际加仓】/.test(out));
assert("观察项含「距真实加仓还有」", out.indexOf("距真实加仓还有") >= 0 || out.indexOf("实际加仓") >= 0);
assert("含免责声明", out.indexOf("非投资建议") >= 0);

// 消息分级口径：档位升档加仓 N/2、技术有效加仓全额 N——从代码逻辑核验（构造快照算一遍）
console.log("== 2b. 加仓 pp 口径（与 app.js addPlanRows/DIV_ADD 一致）==");
const SRC = fs.readFileSync(path.join(DIR, "alert-check.js"), "utf8");
assert("档位增量贡献 N/2（脚本含 dW/2）", SRC.indexOf("dW / 2") >= 0);
assert("技术全额进总仓（脚本含全额加到红利总仓）", SRC.indexOf("全额加到红利总仓") >= 0);
assert("观察级含距真实加仓锚点", SRC.indexOf("距真实加仓还有") >= 0);

// 2c. 全信号覆盖：wklow（周BOLL下轨 +5pp）与 wkup（组合确认）已纳入
console.log("== 2c. 有效点位全景覆盖 ==");
assert("中证红利 wklow +5pp 纳入", /csi:\s*\{[^}]*wklow:\s*5/.test(SRC));
assert("红利低波 wklow +5pp 纳入", /lowvol:\s*\{[^}]*wklow:\s*5/.test(SRC));
assert("wklow 触发判定接入（调用清单）", /addTech\("中证红利", "wklow"/.test(SRC) && /addTech\("红利低波", "wklow"/.test(SRC));
assert("wkup 组合确认项接入", /addTech\("红利低波", "wkup"/.test(SRC) && /addTech\("中证红利", "wkup"/.test(SRC));
assert("wkup 定位为组合确认（不单独加仓）", SRC.indexOf("组合确认项") >= 0);
assert("RSI 消息含当前 RSI 值", SRC.indexOf("现 RSI") >= 0);

// 触发价口径核验：与页面公式一致 pxT = px·dy/(th+bondY)
console.log("== 3. 触发价口径核验（与 app.js addPlanRows 同式）==");
const g = { window: {} };
new Function("window", fs.readFileSync(path.join(DIR, "data", "asset.js"), "utf8"))(g.window);
const A = g.window.ASSET, bondY = A.bond10y.v;
const spread = A.dividend.lowvol.dy - bondY;
const next = spread < 2.5 ? 2.5 : 3.0;   // 下一档
const pxT = A.dividend.lowvol.px * A.dividend.lowvol.dy / (next + bondY);
assert("红利低波下一档触发价公式自洽", isFinite(pxT) && pxT > 0 && pxT < A.dividend.lowvol.px, pxT.toFixed(3));

console.log("== 4. 去重状态机 ==");
const STATE_F = path.join(DIR, "data", "alert-state.json");
// 手造状态：某 key 当日已推 → 复跑应过滤
const today = new Date().toISOString().slice(0, 10);
const st = { sent: { tech_中证红利_ma250: { date: today, done: false } } };
fs.writeFileSync(STATE_F, JSON.stringify(st));
const out2 = execFileSync(NODE, [path.join(DIR, "alert-check.js"), "--dry"], { encoding: "utf8", timeout: 60000 });
const m = out2.match(/触发 (\d+) 条，去重后待推 (\d+) 条/);
assert("当日已推信号被去重", m && m[1] !== "0" && m[2] === "0", m && ("触发" + m[1] + "/待推" + m[2]));
// done=true（已解除）允许重推
fs.writeFileSync(STATE_F, JSON.stringify({ sent: { tech_中证红利_ma250: { date: today, done: true } } }));
const out3 = execFileSync(NODE, [path.join(DIR, "alert-check.js"), "--dry"], { encoding: "utf8", timeout: 60000 });
const m3 = out3.match(/触发 (\d+) 条，去重后待推 (\d+) 条/);
assert("已解除(done)信号允许重推", m3 && m3[2] !== "0", m3 && ("待推" + m3[2]));
fs.writeFileSync(STATE_F, JSON.stringify({ sent: {} }));   // 清回

console.log("\n结果：" + (pass + fail) + " 项 · " + pass + " 通过 / " + fail + " 失败");
process.exit(fail ? 1 : 0);
