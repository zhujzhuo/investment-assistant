// 红利加仓到价提醒（2026-10-26）：盘中价触及加仓触发 → 微信推送
// 判定口径（与 app.js 完全一致）：
//   ① 档位升档触发价：pxT = px0·dy0 / (下一档利差 + 国债)，收盘锚来自 data/asset.js 快照
//   ③ 周 BOLL 下轨（两标的均 +5pp）；④ 周 K 收阳（组合确认项，不单独加仓）
// 距离口径：全部用「真实跌幅」1 − 触发价/现价（与日报、页面 ETF 折算价一致）。
//   注意：档位触发价 pxT = px0·dy0/(th+bondY) = 分红额 D ÷ (目标利差+国债)，
//   在「分红额不变」假设下是一个**与价格无关的绝对价位**——红利上涨不会把触发价抬高，
//   只会让「还需再跌」变大；反过来，只有当 ① 盘中价相对昨收锚回落、② 技术位自身滚动移动
//   （年线/RSI/周BOLL 都是滚动窗口，会自己走）、③ 利差跨过档位边界 时，这个百分比才会变小。
// 通道：Server酱 Turbo（https://sct.ftqq.com/，微信扫码免费申请 SendKey）与 企业微信群机器人 webhook 二选一。
//   本地：data/alert-config.json { "channel": "serverchan"|"wecom"|"none", "serverChanKey": "...", "wecomWebhook": "..." }
//   云端：用环境变量（GitHub Actions Secrets）注入，优先级高于文件 —— SERVERCHAN_KEY / WECOM_WEBHOOK，
//         这样密钥不必进仓库（alert-config.json 已在 .gitignore）。
//   已执行仓位可用 ALERT_EXEC_BASE 覆盖（云端无法读本地 localStorage）。
// 去重：data/alert-state.json 记录「信号键+日期」，同一信号当日只推一次、触发状态持续期间不重推。
//   云端无持久盘 → 由 workflow 把该文件 commit 回仓库（[skip ci]）实现跨次运行去重。
// 用法：node alert-check.js [--dry] [--cloud] [--px=sh000922:6300,sh512890:1.45]
const fs = require("fs");
const path = require("path");
const https = require("https");

const DIR = __dirname;
const CFG_F = path.join(DIR, "data", "alert-config.json");
const STATE_F = path.join(DIR, "data", "alert-state.json");

// ---- 触发规则（与 app.js DIV_LADDER / DIV_ADD 同口径，改规则需两处同步）----
// 升档触发按「最近的更高一档」取（必须升序：find 取第一个 th > spread）
// 历史 bug（2026-10-29 修）：曾按降序写，find 直接跳到最高的 3.5pp 档，
//   导致微信消息里的档位触发价算成 4483（需再跌 19.2%），比页面/日报的 4955（10.7%）远得多。
// 完整档位表（升序，与 app.js DIV_LADDER 一致）：find 取第一个 th > spread = 最近的更高一档；
// 减仓时用「低于当前档的最大 th」取下一档（2.5 → 2.0）。
// 历史 bug（2026-10-29 修）：曾按降序写，find 直接跳到最高的 3.5pp 档，
//   导致微信消息里的档位触发价算成 4483（需再跌 19.2%），比页面/日报的 4955（10.7%）远得多。
const LADDER = [
  { th: -99, w: 30, label: "利差极窄·只留底仓" },
  { th: 1.0, w: 32, label: "利差偏窄·分批减仓" },
  { th: 1.5, w: 35, label: "利差收窄·底仓上方" },
  { th: 2.0, w: 40, label: "利差中性·标准仓" },
  { th: 2.5, w: 44, label: "利差偏宽·小幅加仓" },
  { th: 3.0, w: 47, label: "利差显著·加仓" },
  { th: 3.5, w: 50, label: "利差极宽·重仓" }
];
function curTh(spread) {                     // 当前所处档（最大的 th ≤ spread）
  let t = null;
  for (const x of LADDER) if (x.th <= spread && (!t || x.th > t.th)) t = x;
  return t || LADDER[0];
}
function downTh(spread) {                    // 降档目标（低于当前档的最大 th）
  const ct = curTh(spread);
  let d = null;
  for (const x of LADDER) if (x.th < ct.th && (!d || x.th > d.th)) d = x;
  return d;
}
// 有效技术位全景（6 年回测 DIV_ADD；0 = 无回测增益，仅观察）
//   wklow = 周 BOLL 下轨（两标的均 +5pp）；wkup = 周 K 收阳/走平（组合确认项，无独立增益）
const TECH = {
  csi: { ma250: 0, rsi: 0, wklow: 5, wkup: 0 },
  lowvol: { ma250: 3, rsi: 2, wklow: 5, wkup: 0 }
};

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      const bufs = [];
      res.on("data", (d) => bufs.push(d));
      res.on("end", () => resolve(Buffer.concat(bufs)));
    }).on("error", reject);
  });
}
function post(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.from(JSON.stringify(body));
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": data.length } }, (res) => {
      const bufs = [];
      res.on("data", (d) => bufs.push(d));
      res.on("end", () => resolve(Buffer.concat(bufs).toString()));
    });
    req.on("error", reject);
    req.end(data);
  });
}
function parseQuote(text) {
  const out = {};
  for (const ln of String(text).split("\n")) {
    const m = ln.match(/^v_([a-zA-Z0-9]+)="(.*)";?\s*$/);
    if (!m) continue;
    const f = m[2].split("~");
    const px = parseFloat(f[3]);
    if (!isFinite(px) || px <= 0) continue;
    out[m[1]] = { px, time: f[30] || "" };
  }
  return out;
}

function loadJSON(f, dft) {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return dft; }
}
function saveJSON(f, o) { fs.writeFileSync(f, JSON.stringify(o, null, 1), "utf8"); }

(async function () {
  const dry = process.argv.indexOf("--dry") >= 0;
  const cloud = process.argv.indexOf("--cloud") >= 0;     // 云端（GitHub Actions）运行：标注来源 + 校验快照新鲜度
  const cfg = loadJSON(CFG_F, { channel: "none" });
  // 云端优先用环境变量（Secrets），本地仍走 alert-config.json
  // ALERT_CHANNEL=none = 显式「只维护去重状态、不推送」（云端刷新链用，推送交给 WorkBuddy 云端任务，避免双发）
  const FORCE_NONE = String(process.env.ALERT_CHANNEL || "").toLowerCase() === "none";
  if (process.env.SERVERCHAN_KEY && !FORCE_NONE) { cfg.channel = "serverchan"; cfg.serverChanKey = process.env.SERVERCHAN_KEY; }
  else if (process.env.WECOM_WEBHOOK && !FORCE_NONE) { cfg.channel = "wecom"; cfg.wecomWebhook = process.env.WECOM_WEBHOOK; }
  else if (FORCE_NONE) cfg.channel = "none";
  if (cloud && cfg.channel === "none" && !FORCE_NONE) {
    console.error("⚠ 云端未检测到 SERVERCHAN_KEY / WECOM_WEBHOOK：本轮不会推送。" +
      "GitHub Actions 请在 Settings → Secrets 里加 SERVERCHAN_KEY；WorkBuddy 云端任务请在命令行里带 SERVERCHAN_KEY=... 。" +
      "（无信号时不影响）");
  }
  const ENV_EXEC = Number(process.env.ALERT_EXEC_BASE);   // 云端覆盖「已执行仓位」
  const state = loadJSON(STATE_F, { sent: {} });
  const today = new Date().toISOString().slice(0, 10);

  // 1) 实时价（与页面同源：qt.gtimg.cn）
  const q = parseQuote((await get("https://qt.gtimg.cn/q=sh000922,sh512890")).toString());
  let csiPx = q["sh000922"] && q["sh000922"].px, lvPx = q["sh512890"] && q["sh512890"].px;
  // 测试/演练用价格覆盖：--px=sh000922:6300,sh512890:1.45（只影响本次判定，不写任何文件）
  const pxArg = (process.argv.find((a) => a.indexOf("--px=") === 0) || "").slice(5);
  if (pxArg) {
    for (const kv of pxArg.split(",")) {
      const p = kv.split(":"), v = parseFloat(p[1]);
      if (!isFinite(v)) continue;
      if (p[0] === "sh000922") csiPx = v; else if (p[0] === "sh512890") lvPx = v;
    }
    console.log("价格覆盖（演练）：" + pxArg);
  }

  // 2) 快照锚（收盘 dy/ma250 等，fetch-asset.js 每日 18:00 刷新）
  const g = { window: {} };
  new Function("window", fs.readFileSync(path.join(DIR, "data", "asset.js"), "utf8"))(g.window);
  const A = g.window.ASSET, bondY = A.bond10y.v;
  const c = A.dividend.csi, l = A.dividend.lowvol;

  const alerts = [];
  // 档位仓贡献口径（与 app.js addPlanRows 一致）：红利总仓 = 两标的档位仓均值 → 单标的升 Npp 只贡献 N/2 到总仓
  function wOf(spread) {
    if (spread >= 3.5) return 50;
    if (spread >= 3.0) return 47;
    if (spread >= 2.5) return 44;
    if (spread >= 2.0) return 40;
    if (spread >= 1.5) return 35;
    if (spread >= 1.0) return 32;
    return 30;
  }
  function fmtPx(v) { return v < 10 ? v.toFixed(3) : v.toFixed(2); }
  // 执行层：已执行档位仓（data/pos.json，手动维护；页面「已执行仓位」输入框同源）
  const POS_F = path.join(DIR, "data", "pos.json");
  const pos = loadJSON(POS_F, null);
  const BAND = 3;                                   // 执行带宽：|目标 − 已执行| ≥ 3pp 才动手
  function histBase() {                             // 用月度股息率序列还原历史档位仓（滤分红月脉冲）
    const hc = c.dyHist || [], hl = l.dyHist || [], out = [], n = Math.min(hc.length, hl.length);
    for (let i = 0; i < n; i++) out.push(Math.round((wOf(hc[i] - bondY) + wOf(hl[i] - bondY)) / 2));
    return out;
  }
  const HB = histBase();
  const curBase = HB.length ? HB[HB.length - 1] : Math.round((wOf(c.dy - bondY) + wOf(l.dy - bondY)) / 2);
  const prevBase = HB.length >= 2 ? HB[HB.length - 2] : curBase;
  const pending = HB.length >= 2 && curBase !== prevBase;   // 本期刚变 → 待下期确认
  const confBase = pending ? prevBase : curBase;
  // 云端无法读 localStorage → ALERT_EXEC_BASE 覆盖（合法区间 20~60）
  const execBase = (ENV_EXEC >= 20 && ENV_EXEC <= 60) ? Math.round(ENV_EXEC)
    : ((pos && pos.div >= 20 && pos.div <= 60) ? Math.round(pos.div) : confBase);
  const execSrc = (ENV_EXEC >= 20 && ENV_EXEC <= 60) ? "环境变量" : ((pos && pos.div >= 20 && pos.div <= 60) ? "data/pos.json" : "默认（=目标档位仓）");
  // 真实跌幅（与日报/页面 ETF 折算价同口径）：还需再跌 = 1 − 触发价/现价
  function dropPct(px, tPx) { return (1 - tPx / px) * 100; }
  function chgStr(px, base) {
    if (px == null || base == null || !base) return "";
    const c = (px / base - 1) * 100;
    return (c >= 0 ? "+" : "") + c.toFixed(2) + "%";
  }
  // 档位类信号先收集，最后按「两标的合计后的目标总仓」统一做带宽判定
  // （单标的降档只影响总仓的一半，必须合并看才不会误判「未达带宽」）
  const ladSig = [];
  function addLadder(name, d, px) {
    if (px == null || d.px == null || d.dy == null) return;
    const spread = d.dy - bondY;                       // 收盘锚利差（口径与页面一致）
    const next = LADDER.find((x) => x.th > spread);
    if (!next) return;                                 // 已在最高档
    const dyT = next.th + bondY;
    const pxT = d.px * d.dy / dyT;                     // 分红不变假设下的触发价
    if (px <= pxT) {
      const dW = next.w - wOf(spread);                 // 该标的档位仓增量
      ladSig.push({ kind: "加仓", name: name, th: next.th, from: wOf(spread), to: next.w, dW: dW, dTot: dW / 2, pxT: pxT, spread: spread, px: px });
    }
  }
  function addTech(name, key, d, px) {
    const cfgT = TECH[name === "中证红利" ? "csi" : "lowvol"];
    const add = cfgT[key] || 0;                        // 回测增益 pp；0 = 无增益（仅观察）
    if (px == null) return;
    let hit = false, txt = "";
    if (key === "ma250" && d.ma250 != null) {
      hit = px <= d.ma250;
      txt = "现价 " + fmtPx(px) + " vs 年线 " + fmtPx(d.ma250);
    }
    if (key === "rsi" && d.rsi30 && d.rsi30.price != null) {
      hit = px <= d.rsi30.price;
      txt = "现价 " + fmtPx(px) + " ≤ RSI30 经验触发价 " + fmtPx(d.rsi30.price) + "（现 RSI " + (d.rsi14 != null ? d.rsi14.toFixed(1) : "—") + "）";
    }
    if (key === "wklow" && d.wk && d.wk.lower != null) {
      hit = px <= d.wk.lower;
      txt = "现价 " + fmtPx(px) + " vs 周BOLL下轨 " + fmtPx(d.wk.lower);
    }
    if (key === "wkup") {
      hit = d.wkUp === true;                           // 快照口径：本周周K收阳/走平
      txt = d.wkUp === true ? "本周周K收阳（或走平）" : "本周周K收阴（未确认）";
    }
    if (!hit) return;
    // 观察级（无增益）：不构成加仓动作——给出「距真实加仓触发价还差多少」
    if (!add) {
      const lines = [];
      const spread = d.dy - bondY;
      const next = LADDER.find((x) => x.th > spread);
      if (next) {
        const pxT = d.px * d.dy / (next.th + bondY);
        lines.push("档位价 " + fmtPx(pxT) + "（再跌 " + dropPct(px, pxT).toFixed(1) + "%，利差需再走宽 " + (next.th - spread).toFixed(2) + "pp）");
      }
      // 该标的所有有效技术位（增益>0）的距离
      for (const tk of ["ma250", "rsi", "wklow"]) {
        const g2 = cfgT[tk] || 0;
        if (!g2 || tk === key) continue;
        const tPx = tk === "ma250" ? d.ma250 : (tk === "rsi" ? (d.rsi30 && d.rsi30.price) : (d.wk && d.wk.lower));
        if (tPx == null) continue;
        const nm = tk === "ma250" ? "年线" : (tk === "rsi" ? "RSI30 价" : "周BOLL下轨");
        lines.push(nm + " " + fmtPx(tPx) + "（" + (tPx < px ? "再跌 " + dropPct(px, tPx).toFixed(1) + "%" : "已触发可叠加") + " +" + g2 + "pp）");
      }
      // 组合确认项（wkup 对两标的都是组合条件）：单独报是否已满足
      alerts.push({ key: "tech_" + name + "_" + key, level: "观察提示",
        title: name + " " + (key === "ma250" ? "跌破年线（观察项）" : key === "rsi" ? "RSI 超卖（观察项）" : "周K状态（组合确认项）"),
        detail: txt + (key === "wkup" ? "，组合确认项（不单独加仓）" : "，仅观察不加仓") +
          (lines.length ? "\n距加仓：" + lines.join("；") : "；已无在途加仓触发") });
    } else {
      // 实际加仓级（有增益）：给出加仓 pp
      alerts.push({ key: "tech_" + name + "_" + key, level: "实际加仓",
        title: name + " " + (key === "ma250" ? "跌破年线（有效信号）" : key === "rsi" ? "RSI 超卖（有效信号）" : "周BOLL下轨以下（有效信号）"),
        detail: txt + " → 技术加仓 +" + add + "pp（时机仓，回补可撤回）" +
          (key === "ma250" && cfgT.wkup === 0 && d.wkUp ? "；本周周K收阳，构成三重买点" : "") });
    }
  }

  // 降档减仓（与加仓对称）：价涨 → 股息率降 → 利差收窄跨档向下 → 档位仓降。
  // 触发价 pxT = 分红额 D ÷(下一档利差+国债)，与页面「减仓参考价」同式；同样走 3pp 执行带宽。
  function addTrim(name, d, px) {
    if (px == null || d.px == null || d.dy == null) return;
    const spread = d.dy - bondY, wNow = wOf(spread);
    const down = downTh(spread);
    if (!down || down.w >= wNow) return;                 // 已在底仓档，不再减
    const pxT = d.px * d.dy / (down.th + bondY);
    if (px < pxT) return;                                // 未到减仓价
    const dW = wNow - down.w, dTot = dW / 2;             // 单标的降 Npp → 总仓只降 N/2
    ladSig.push({ kind: "减仓", name: name, th: down.th, from: wNow, to: down.w, dW: dW, dTot: dTot, pxT: pxT, spread: spread, px: px });
  }

  addLadder("中证红利", c, csiPx);
  addLadder("红利低波", l, lvPx);
  addTrim("中证红利", c, csiPx);
  addTrim("红利低波", l, lvPx);
  // 两标的合计后的目标总仓 → 统一带宽判定
  let wNewC = wOf(c.dy - bondY), wNewL = wOf(l.dy - bondY);
  for (const s of ladSig) { if (s.name === "中证红利") wNewC = s.to; else wNewL = s.to; }
  const baseFinal = Math.round((wNewC + wNewL) / 2);
  const gapFinal = baseFinal - execBase;
  const actFinal = Math.abs(gapFinal) >= BAND;
  for (const s of ladSig) {
    const up = s.kind === "加仓";
    alerts.push({
      key: (up ? "ladder_" : "trim_") + s.name + "_" + s.th,
      level: actFinal ? (up ? "实际加仓" : "实际减仓") : "观察提示",
      title: s.name + (up ? " 触及加仓档位（利差→" : " 触及降档（利差→") + s.th.toFixed(1) + "pp）",
      detail: "现价 " + fmtPx(s.px) + (up ? " ≤ " : " ≥ ") + "触发价 " + fmtPx(s.pxT) + "（利差 " + s.spread.toFixed(2) + "pp）\n" +
        "档位仓 " + s.from + "%→" + s.to + "%（红利总仓 " + (up ? "+" : "−") + s.dTot.toFixed(1) + "pp）；" +
        "合计目标 " + baseFinal + "% vs 已执行 " + execBase + "% → " +
        (actFinal ? "达 " + BAND + "pp 带宽→执行（分2批，执行后更新「已执行仓位」）" : "未达 " + BAND + "pp 带宽→不动")
    });
  }
  // 红利低波（全部有效位 + 组合确认）
  addTech("红利低波", "ma250", l, lvPx);      // +3pp
  addTech("红利低波", "rsi", l, lvPx);        // +2pp
  addTech("红利低波", "wklow", l, lvPx);      // +5pp
  addTech("红利低波", "wkup", l, lvPx);       // 组合确认项
  // 中证红利（年线/RSI 无增益仅观察；周BOLL下轨 +5pp 是唯一有效技术位；wkup 组合确认）
  addTech("中证红利", "ma250", c, csiPx);
  addTech("中证红利", "wklow", c, csiPx);    // +5pp
  addTech("中证红利", "wkup", c, csiPx);     // 组合确认项

  // 3) 去重：当日已推过同 key 的不再推；状态清除（回升到触发价上方）后记 done 允许下次再触发时重推
  const fresh = alerts.filter((a) => {
    const s = state.sent[a.key];
    if (!s) return true;
    if (s.done) return true;          // 上轮已解除 → 允许重推
    return s.date !== today;          // 同日不重推，隔日若仍触发则再推一次
  });

  console.log("行情: 中证红利 " + csiPx + " / 红利低波 " + lvPx + "（快照锚 " + A.asOfA + "，利差 " + (c.dy - bondY).toFixed(2) + " / " + (l.dy - bondY).toFixed(2) + "pp）");
  console.log("已执行仓位 " + execBase + "%（来源 " + execSrc + "）｜档位目标 " + confBase + "%" + (pending ? "（新值 " + curBase + "% 待确认）" : ""));
  console.log("触发 " + alerts.length + " 条，去重后待推 " + fresh.length + " 条" + (dry ? "（dry 模式）" : "") + (cloud ? "（cloud 模式）" : ""));
  console.log("触发键: " + alerts.map(function (a) { return a.key; }).join(","));

  if (!fresh.length) { console.log("无待推送提醒。"); saveJSON(STATE_F, state); return; }

  // 4) 推送（精简版：标题定级 + 两行行情 + 每条信号两行 + 一行页脚，一眼看明白）
  const hasAct = fresh.some((a) => a.level !== "观察提示");
  const title = "红利提醒【" + (hasAct ? "执行" : "观察") + "】" + fresh.length + " 条 " + today.slice(5);
  const gapNow = confBase - execBase;
  // 快照新鲜度：云端 asset.js 由 18:00 的 refresh workflow 提交，若它失败这里会明显滞后
  const staleDays = A.asOfA ? Math.round((Date.parse(today) - Date.parse(A.asOfA)) / 86400000) : null;
  const staleNote = (staleDays != null && staleDays > 3)
    ? "\n⚠ 快照锚 " + A.asOfA + " 已 " + staleDays + " 天未更新，数据偏旧仅供参考"
    : "";
  const runner = process.env.ALERT_RUNNER || "GitHub Actions";   // 云端执行者（WorkBuddy 云端任务 / GitHub Actions）
  const base = "中证红利 " + fmtPx(csiPx) + "（" + (chgStr(csiPx, c.px) || "—") + "）/ 低波 " + fmtPx(lvPx) + "（" + (chgStr(lvPx, l.px) || "—") +
    "）· 利差 " + (c.dy - bondY).toFixed(2) + "/" + (l.dy - bondY).toFixed(2) + "pp · 锚 " + A.asOfA +
    "\n目标仓 " + confBase + "% / 已执行 " + execBase + "% → " +
    (Math.abs(gapNow) >= BAND ? "达带宽，可执行" : "偏离 " + (gapNow > 0 ? "+" : "") + gapNow + "pp，不动");
  const lines = fresh.map((a) => "【" + a.level + "】" + a.title + "\n" + a.detail);
  const md = title + "\n\n" + base + staleNote + "\n\n" + lines.join("\n\n") +
    "\n\n—— 云端执行 · " + runner + " · 非投资建议";
  console.log("\n" + md + "\n");

  if (!dry && cfg.channel !== "none") {
    let ok = false;
    try {
      if (cfg.channel === "serverchan" && cfg.serverChanKey) {
        const r = JSON.parse(await post("https://sctapi.ftqq.com/" + cfg.serverChanKey + ".send", { title: title, desp: md }));
        ok = r && (r.code === 0 || r.errno === 0);
      } else if (cfg.channel === "wecom" && cfg.wecomWebhook) {
        const r = JSON.parse(await post(cfg.wecomWebhook, { msgtype: "text", text: { content: md.slice(0, 2000) } }));
        ok = r && r.errcode === 0;
      }
    } catch (e) { console.error("推送失败:", e.message); }
    console.log(ok ? "✓ 微信推送成功（" + cfg.channel + "）" : "✗ 推送失败（检查 data/alert-config.json）");
    if (ok) fresh.forEach((a) => { state.sent[a.key] = { date: today, done: false }; });
  } else if (!dry) {
    console.log("未配置推送通道（channel=none，云端请设置 Secret SERVERCHAN_KEY）——仅打印。申请 Server酱 Key 后填入即可。");
    // 未配通道也记状态：避免配置好后一次性补发堆积
    fresh.forEach((a) => { state.sent[a.key] = { date: today, done: false }; });
    if (cloud && !FORCE_NONE) {                   // 云端缺密钥 = 配置事故，让 workflow 变红提醒
      console.error("✗ 云端未检测到 SERVERCHAN_KEY / WECOM_WEBHOOK，无法推送");
      saveJSON(STATE_F, state);
      process.exit(1);
    }
  }
  // 未触发/已解除的旧信号标记 done
  alerts.forEach((a) => { if (!fresh.find((f) => f.key === a.key)) { const s = state.sent[a.key]; if (s && !s.done) s.done = true; } });
  if (!dry) saveJSON(STATE_F, state);
})();
