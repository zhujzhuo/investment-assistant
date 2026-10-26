// 红利加仓到价提醒（2026-10-26）：盘中价触及加仓触发 → 微信推送
// 判定口径（与 app.js 完全一致）：
//   ① 档位升档触发价：pxT = px0·dy0 / (下一档利差 + 国债)，收盘锚来自 data/asset.js 快照
//   ② 技术位：跌破年线 ma250（低波回测 +3pp 有效 / 中证红利无效不加）
//      RSI(14) ≤30（低波 +2pp 有效）——RSI 是日级序列算的，盘中不做重算，用快照值近似的「触发价」r30.price
// 通道：Server酱 Turbo（https://sct.ftqq.com/，微信扫码免费申请 SendKey）与 企业微信群机器人 webhook 二选一。
//   配置：data/alert-config.json { "channel": "serverchan"|"wecom"|"none", "serverChanKey": "...", "wecomWebhook": "..." }
// 去重：data/alert-state.json 记录「信号键+日期」，同一信号当日只推一次、触发状态持续期间不重推。
// 用法：node alert-check.js [--dry]   # --dry 只打印不推送不发状态
const fs = require("fs");
const path = require("path");
const https = require("https");

const DIR = __dirname;
const CFG_F = path.join(DIR, "data", "alert-config.json");
const STATE_F = path.join(DIR, "data", "alert-state.json");

// ---- 触发规则（与 app.js DIV_LADDER / DIV_ADD 同口径，改规则需两处同步）----
const LADDER = [
  { th: 3.5, w: 50, label: "利差极宽·重仓" },
  { th: 3.0, w: 47, label: "利差显著·加仓" },
  { th: 2.5, w: 44, label: "利差偏宽·小幅加仓" }
];
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
  const cfg = loadJSON(CFG_F, { channel: "none" });
  const state = loadJSON(STATE_F, { sent: {} });
  const today = new Date().toISOString().slice(0, 10);

  // 1) 实时价（与页面同源：qt.gtimg.cn）
  const q = parseQuote((await get("https://qt.gtimg.cn/q=sh000922,sh512890")).toString());
  const csiPx = q["sh000922"] && q["sh000922"].px, lvPx = q["sh512890"] && q["sh512890"].px;

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
  function addLadder(name, d, px) {
    if (px == null || d.px == null || d.dy == null) return;
    const spread = d.dy - bondY;                       // 收盘锚利差（口径与页面一致）
    const next = LADDER.find((x) => x.th > spread);
    if (!next) return;                                 // 已在最高档
    const dyT = next.th + bondY;
    const pxT = d.px * d.dy / dyT;                     // 分红不变假设下的触发价
    if (px <= pxT) {
      const dW = next.w - wOf(spread);                 // 该标的档位仓增量
      const dTot = dW / 2;                             // 对红利总仓的贡献（两标的均值口径）
      alerts.push({ key: "ladder_" + name + "_" + next.th, level: "实际加仓", title: name + " 触及加仓档位（利差→" + next.th.toFixed(1) + "pp）",
        detail: "现价 " + fmtPx(px) + " ≤ 触发价 " + fmtPx(pxT) + "，当前利差 " + spread.toFixed(2) + "pp。\n" +
          "加仓动作：该标的档位仓 " + wOf(spread) + "% → " + next.w + "%（+" + dW + "pp），红利总仓 +" + dTot.toFixed(1) + "pp ≈ " +
          Math.round(dTot * 10000).toLocaleString() + " 元（按 100 万总资产）。分 2~3 批执行，从货币端划转。" });
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
        lines.push("档位升档触发价 " + fmtPx(pxT) + "（还需再跌 " + ((px / pxT - 1) * 100).toFixed(1) + "%，利差需再走宽 " + (next.th - spread).toFixed(2) + "pp）");
      }
      // 该标的所有有效技术位（增益>0）的距离
      for (const tk of ["ma250", "rsi", "wklow"]) {
        const g2 = cfgT[tk] || 0;
        if (!g2 || tk === key) continue;
        const tPx = tk === "ma250" ? d.ma250 : (tk === "rsi" ? (d.rsi30 && d.rsi30.price) : (d.wk && d.wk.lower));
        if (tPx == null) continue;
        const nm = tk === "ma250" ? "年线" : (tk === "rsi" ? "RSI30 触发价" : "周BOLL下轨");
        lines.push(nm + " " + fmtPx(tPx) + "（" + (tPx < px ? "还需再跌 " + ((px / tPx - 1) * 100).toFixed(1) + "%" : "也已触发，可叠加") + "，+" + g2 + "pp）");
      }
      // 组合确认项（wkup 对两标的都是组合条件）：单独报是否已满足
      alerts.push({ key: "tech_" + name + "_" + key, level: "观察提示",
        title: name + " " + (key === "ma250" ? "跌破年线（观察项）" : key === "rsi" ? "RSI 超卖（观察项）" : "周K状态（组合确认项）"),
        detail: txt + (key === "wkup" ? " —— 组合确认项（不单独加仓）：与年线/RSI 同时满足时构成「技术三重买点」。" : " —— 该标的此项回测无增益，仅提示不加仓。") + "\n" +
          (lines.length ? "距真实加仓还有：\n· " + lines.join("\n· ") : "该标的已无在途加仓触发（等档位或分位）。") });
    } else {
      // 实际加仓级（有增益）：给出加仓 pp
      alerts.push({ key: "tech_" + name + "_" + key, level: "实际加仓",
        title: name + " " + (key === "ma250" ? "跌破年线（有效信号）" : key === "rsi" ? "RSI 超卖（有效信号）" : "周BOLL下轨以下（有效信号）"),
        detail: txt + "\n加仓动作：技术性加仓 +" + add + "pp（全额加到红利总仓 ≈ " +
          Math.round(add * 10000).toLocaleString() + " 元，按 100 万总资产）——时机性加仓，回补后可撤回。" +
          (key === "ma250" && cfgT.wkup === 0 && d.wkUp ? "\n组合提示：本周周K收阳 → 与年线构成「技术三重买点」的一部分。" : "") });
    }
  }

  addLadder("中证红利", c, csiPx);
  addLadder("红利低波", l, lvPx);
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
  console.log("触发 " + alerts.length + " 条，去重后待推 " + fresh.length + " 条" + (dry ? "（dry 模式）" : ""));

  if (!fresh.length) { console.log("无待推送提醒。"); saveJSON(STATE_F, state); return; }

  // 4) 推送
  const title = "红利加仓提醒：" + fresh.length + " 条触发（" + today + "）";
  const lines = fresh.map((a) => "【" + a.level + "】" + a.title + "\n" + a.detail);
  const md = title + "\n\n" + lines.join("\n\n") + "\n\n—— 个人投资助理 · 口径与站内「整体投顾」一致，非投资建议";
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
    console.log("未配置推送通道（data/alert-config.json channel=none）——仅打印。申请 Server酱 Key 后填入即可。");
    // 未配通道也记状态：避免配置好后一次性补发堆积
    fresh.forEach((a) => { state.sent[a.key] = { date: today, done: false }; });
  }
  // 未触发/已解除的旧信号标记 done
  alerts.forEach((a) => { if (!fresh.find((f) => f.key === a.key)) { const s = state.sent[a.key]; if (s && !s.done) s.done = true; } });
  if (!dry) saveJSON(STATE_F, state);
})();
