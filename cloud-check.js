// 云端提醒链路自检（2026-10-30）：
//   ① alert-check.js 支持环境变量注入（Server酱 Key / 已执行仓位），密钥不进仓库
//   ② fetch-asset.js 有云端 K 线兜底（东财）+「关键K线缺失不写盘」保护
//   ③ dividend-alert.yml 的 cron、命令、状态回写正确
//   ④ refresh.yml 收盘后（北京18:00）刷新资产快照，保证云端读到的锚是「最近收盘」而非盘中价
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const DIR = __dirname;
const NODE = process.execPath;

let pass = 0, fail = 0;
function assert(name, ok, extra) {
  if (ok) { pass++; console.log("  ✓ " + name + (extra ? "  [" + extra + "]" : "")); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  [" + extra + "]" : "")); }
}
function read(f) { return fs.readFileSync(path.join(DIR, f), "utf8"); }

console.log("\n=== 云端提醒自检 ===\n");

// ---------- 1. alert-check.js 环境变量 ----------
const AC = read("alert-check.js");
assert("支持 SERVERCHAN_KEY 环境变量（密钥走 Secrets，不入库）", /process\.env\.SERVERCHAN_KEY/.test(AC));
assert("支持 WECOM_WEBHOOK 环境变量", /process\.env\.WECOM_WEBHOOK/.test(AC));
assert("支持 ALERT_EXEC_BASE 覆盖已执行仓位", /process\.env\.ALERT_EXEC_BASE/.test(AC));
assert("支持 --cloud 标记并在消息里标注来源", /--cloud/.test(AC) && /云端执行/.test(AC));
assert("云端有信号但无密钥 → 以退出码 1 暴露配置事故", /SERVERCHAN_KEY \/ WECOM_WEBHOOK，无法推送/.test(AC) && /process\.exit\(1\)/.test(AC));

// 环境变量真实生效（用 dry 跑，不推送）
const STATE_F = path.join(DIR, "data", "alert-state.json");
const bak = fs.existsSync(STATE_F) ? fs.readFileSync(STATE_F, "utf8") : "{\"sent\":{}}";
fs.writeFileSync(STATE_F, "{\"sent\":{}}");
let out = "";
try {
  out = execFileSync(NODE, [path.join(DIR, "alert-check.js"), "--dry", "--cloud"], {
    encoding: "utf8", env: Object.assign({}, process.env, { SERVERCHAN_KEY: "SCT_x", ALERT_EXEC_BASE: "42" }), timeout: 90000
  });
} catch (e) { out = String(e.stdout || "") + String(e.stderr || ""); }
assert("ALERT_EXEC_BASE=42 生效（已执行仓位 42%、来源=环境变量）", /已执行仓位 42%（来源 环境变量）/.test(out), (out.match(/已执行仓位[^\n]*/) || [""])[0]);
assert("--cloud 消息头标注「云端执行 · GitHub Actions」", /云端执行 · GitHub Actions/.test(out));
fs.writeFileSync(STATE_F, bak);

// 不传环境变量时不覆盖 pos.json
fs.writeFileSync(STATE_F, "{\"sent\":{}}");
let out2 = "";
try {
  out2 = execFileSync(NODE, [path.join(DIR, "alert-check.js"), "--dry"], { encoding: "utf8", timeout: 90000 });
} catch (e) { out2 = String(e.stdout || ""); }
assert("未传环境变量时回退 data/pos.json（不被 ALERT_EXEC_BASE 污染）", /来源 (data\/pos\.json|默认)/.test(out2), (out2.match(/已执行仓位[^\n]*/) || [""])[0]);
fs.writeFileSync(STATE_F, bak);

// ---------- 2. fetch-asset.js 云端兜底与保护 ----------
const FA = read("fetch-asset.js");
assert("新增东财公开 K 线兜底（push2his）", /push2his\.eastmoney\.com/.test(FA));
assert("sh→1. / sz→0. 的 secid 映射", /"1\." \+ m\[2\]/.test(FA) && /"0\." \+ m\[2\]/.test(FA));
assert("CLI 缺失时不再空等重试（HAS_CLI 只探测一次）", /const HAS_CLI = fs\.existsSync\(WS_BIN\)/.test(FA));
assert("可用 IA_WESTOCK_BIN 模拟「无 CLI」环境（便于云测）", /process\.env\.IA_WESTOCK_BIN/.test(FA));
assert("关键K线缺失时不写盘，保留上次好快照", /关键K线缺失/.test(FA) && /本次不写盘/.test(FA));
const REQ = (FA.match(/const REQUIRED_K = \[([^\]]*)\]/) || ["", ""])[1];
assert("保护清单含红利日/周/月K（美股不在内，云端本就拿不到）", /csiD/.test(REQ) && /lowvolD/.test(REQ) && /csiW/.test(REQ) && !/nas/.test(REQ), REQ.replace(/\s/g, ""));

// ---------- 3. 工作流（GitHub 侧只维护状态，推送交给 WorkBuddy 云端任务 → 不双推）----------
const WA = read(path.join(".github", "workflows", "dividend-alert.yml"));
assert("提醒工作流存在", fs.existsSync(path.join(DIR, ".github", "workflows", "dividend-alert.yml")));
assert("cron 改到北京 18:30（UTC 10:30，收盘后维护状态）", /cron: "30 10 \* \* 1-5"/.test(WA));
assert("不再有盘中 10:15/14:30 的推送 cron", !/cron: "15 2 \* \* 1-5"/.test(WA) && !/cron: "30 6 \* \* 1-5"/.test(WA));
assert("GitHub 侧显式不推送（ALERT_CHANNEL=none）", /ALERT_CHANNEL: "none"/.test(WA));
assert("GitHub 侧不再引用 secrets（避免与云端任务双发）", !/secrets\.SERVERCHAN_KEY/.test(WA));
assert("支持 workflow_dispatch 手动验证", /workflow_dispatch/.test(WA));
assert("运行 alert-check.js --cloud", /node alert-check\.js --cloud/.test(WA));
assert("状态回写仓库（云端无持久盘）", /git add data\/alert-state\.json/.test(WA));
assert("状态提交带 [skip ci]（不触发其它 workflow）", /\[skip ci\]/.test(WA));
assert("回写前先 rebase，避免与 18:00 刷新冲突", /git pull --rebase origin main/.test(WA));

const WR = read(path.join(".github", "workflows", "refresh.yml"));
assert("18:00 刷新链已加入 fetch-asset（收盘后跑，锚不被盘中价污染）", /run: node fetch-asset\.js/.test(WR));
assert("refresh.yml 仍是北京 18:00（UTC 10:00）", /cron: "0 10 \* \* 1-5"/.test(WR));
assert("fetch-asset 排在 refresh-data 之前", WR.indexOf("node fetch-asset.js") < WR.indexOf("node refresh-data.js"));

// ---------- 4. 密钥安全 ----------
const GI = read(".gitignore");
assert("alert-config.json 仍在 .gitignore（密钥不入库）", /alert-config\.json/.test(GI));
assert("alert-state.json 未被忽略（云端靠仓库持久化去重）", !/data\/alert-state\.json/.test(GI));
assert("alert-config.json 未被 git 跟踪", (function () {
  try { execFileSync("git", ["ls-files", "--error-unmatch", "data/alert-config.json"], { cwd: DIR, encoding: "utf8" }); return false; }
  catch (e) { return true; }
})());

// ---------- 5. 云端一键脚本 cloud-alert.js（WorkBuddy 云端任务用）----------
const CA = read("cloud-alert.js");
assert("cloud-alert.js 存在", fs.existsSync(path.join(DIR, "cloud-alert.js")));
assert("从仓库拉判定脚本（口径唯一真源，不复制逻辑）", /raw\.githubusercontent\.com/.test(CA) && /fetchTo\("alert-check\.js"/.test(CA));
assert("从仓库拉快照 data/asset.js", /fetchTo\("data\/asset\.js"/.test(CA));
assert("复用仓库去重状态做基线（信号持续期不重复推）", /fetchTo\("data\/alert-state\.json"/.test(CA));
assert("演练价强制 dry（防止误发真实推送）", /const forceDry = dry \|\| !!pxArg/.test(CA));
assert("无密钥时显式 ALERT_CHANNEL=none（不误发）", /env\.ALERT_CHANNEL = "none"/.test(CA));
assert("不读本地 data/ 目录（纯网络取数）", !/require\(.*data\/asset/.test(CA));
assert("标注执行来源 ALERT_RUNNER", /ALERT_RUNNER/.test(CA));

// 端到端：在干净临时目录模拟云端沙箱跑一次（dry，绝不推送）
const TMP = path.join(require("os").tmpdir(), "ia-cloud-check-" + Date.now());
try {
  const out = execFileSync(NODE, ["cloud-alert.js", "--dry"], {
    cwd: DIR, encoding: "utf8", timeout: 120000,
    env: Object.assign({}, process.env, { IA_DIR: TMP })
  });
  assert("云端沙箱端到端跑通（拉脚本+快照+判定）", /快照锚 \d{4}-\d{2}-\d{2}/.test(out) && /触发 \d+ 条/.test(out),
    (out.match(/快照锚 [^\s｜]+/) || [""])[0] + " " + (out.match(/触发 \d+ 条[^（]*/) || [""])[0]);
  assert("端到端未报拉取失败", out.indexOf("✗") < 0);
} catch (e) {
  assert("云端沙箱端到端跑通（拉脚本+快照+判定）", false, String(e.message).slice(0, 80));
}

console.log("\n" + (fail ? "✗ " : "✓ ") + "云端自检 " + pass + " 通过 / " + fail + " 失败\n");
process.exit(fail ? 1 : 0);
