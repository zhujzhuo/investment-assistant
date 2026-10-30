// 云端红利到价提醒（WorkBuddy 云端 automation 用）
// 与本地 alert-check.js 完全同一套判定代码：本脚本只负责「把仓库里的脚本 + 最新快照拉到沙箱里跑起来」，
// 不依赖本机任何文件（本机不开机也能跑），判定口径、档位表、执行带宽全部来自仓库里的 alert-check.js。
//
// 用法（云端沙箱 / 任意有 node + 网络的机器）：
//   node cloud-alert.js                      # 正常跑（有信号则推送）
//   node cloud-alert.js --dry                # 只打印，绝不推送（演练必须带）
//   SERVERCHAN_KEY=SCTxxx node cloud-alert.js
//   node cloud-alert.js --px=sh000922:5000 --dry   # 演练价（强制 dry）
//
// 说明：
//   · 代码与快照都从 GitHub 仓库 main 分支拉取（zhujzhuo/investment-assistant），
//     仓库由 GitHub Actions 每天 18:00（收盘后）刷新 data/asset.js，因此云端拿到的永远是最新收盘锚。
//   · 去重状态：先尝试复用沙箱里残留的 data/alert-state.json；没有则从仓库拉一份作为基线，
//     这样「信号持续期间」不会天天重复推（推送由本脚本负责，仓库侧只维护状态不推送）。
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const { execFileSync } = require("child_process");

const REPO = process.env.IA_REPO || "zhujzhuo/investment-assistant";
const REF = process.env.IA_REF || "main";
const RAW = "https://raw.githubusercontent.com/" + REPO + "/" + REF + "/";
const DIR = process.env.IA_DIR || path.join(os.tmpdir(), "ia-cloud");

const argv = process.argv.slice(2);
const dry = argv.indexOf("--dry") >= 0;
const pxArg = (argv.find((a) => a.indexOf("--px=") === 0) || "").slice(5);
const fresh = argv.indexOf("--fresh-state") >= 0;      // 丢弃本地残留状态，强制用仓库基线

// 演练价一律强制 dry —— 2026-10-30 教训：曾因非 dry 跑演练价误发一条真实微信推送
const forceDry = dry || !!pxArg;

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0 (WorkBuddy-Cloud)" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error("HTTP " + res.statusCode + " " + url)); }
      const bufs = [];
      res.on("data", (d) => bufs.push(d));
      res.on("end", () => resolve(Buffer.concat(bufs)));
    }).on("error", reject);
  });
}
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }

async function fetchTo(rel, dest) {
  // 网络抖动很常见（云端沙箱偶发 ETIMEDOUT）→ 最多重试 2 次
  for (let i = 0; i < 3; i++) {
    try {
      const buf = await get(RAW + rel);
      mkdirp(path.dirname(dest));
      fs.writeFileSync(dest, buf);
      return buf.length;
    } catch (e) {
      if (i === 2) { console.error("✗ 拉取失败 " + rel + "：" + e.message); return 0; }
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  return 0;
}

(async function () {
  console.log("== 云端红利提醒 ==");
  console.log("仓库 " + REPO + "@" + REF + " ｜ 工作目录 " + DIR + (forceDry ? " ｜ dry（不推送）" : ""));

  mkdirp(path.join(DIR, "data"));
  // 1) 判定脚本（唯一真源，口径与本地一致）
  let n = await fetchTo("alert-check.js", path.join(DIR, "alert-check.js"));
  if (!n) { console.error("✗ 拿不到 alert-check.js，终止（检查网络或仓库路径）"); process.exit(2); }
  // 2) 快照锚（收盘价/股息率/年线/RSI/周BOLL）—— GitHub Actions 每天 18:00 刷新
  n = await fetchTo("data/asset.js", path.join(DIR, "data", "asset.js"));
  if (!n) { console.error("✗ 拿不到 data/asset.js，终止"); process.exit(2); }
  // 3) 已执行仓位（可选，缺则用默认锚）
  await fetchTo("data/pos.json", path.join(DIR, "data", "pos.json"));
  // 4) 去重状态基线（可选）
  const stF = path.join(DIR, "data", "alert-state.json");
  if (fresh || !fs.existsSync(stF)) await fetchTo("data/alert-state.json", stF);

  // 版本自检：确认拉到的不是缓存的旧脚本
  const src = fs.readFileSync(path.join(DIR, "alert-check.js"), "utf8");
  if (src.indexOf("addTrim") < 0) { console.error("✗ 拉到的 alert-check.js 不含 addTrim（旧版），终止"); process.exit(2); }
  const asOf = (fs.readFileSync(path.join(DIR, "data", "asset.js"), "utf8").match(/asOfA"?\s*:\s*"([^"]*)"/) || [])[1] || "?";
  console.log("快照锚 " + asOf + " ｜ 脚本 " + (src.length / 1024).toFixed(0) + "KB");

  const args = [path.join(DIR, "alert-check.js"), "--cloud"];
  if (forceDry) args.push("--dry");
  if (pxArg) args.push("--px=" + pxArg);
  const env = Object.assign({}, process.env);
  if (!env.ALERT_RUNNER) env.ALERT_RUNNER = "WorkBuddy 云端";   // 消息头标注执行来源
  if (!env.SERVERCHAN_KEY && !env.WECOM_WEBHOOK) env.ALERT_CHANNEL = "none";   // 云端没密钥 → 明确不推，避免误发
  try {
    execFileSync(process.execPath, args, { cwd: DIR, stdio: "inherit", env: env, timeout: 120000 });
  } catch (e) {
    if (e.status === 1) { console.error("（alert-check 以 1 退出：云端未配置推送通道或推送失败）"); process.exit(1); }
    console.error("✗ 运行失败: " + e.message);
    process.exit(3);
  }
})();
