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
const TECH = {
  csi: { ma250: 0, rsi: 0 },        // 中证红利：技术位回测无增益，只提示不加仓
  lowvol: { ma250: 3, rsi: 2 }      // 红利低波：年线+3pp / RSI+2pp（6年回测有效）
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
  function addLadder(name, d, px) {
    if (px == null || d.px == null || d.dy == null) return;
    const spread = d.dy - bondY;                       // 收盘锚利差（口径与页面一致）
    const next = LADDER.find((x) => x.th > spread);
    if (!next) return;                                 // 已在最高档
    const dyT = next.th + bondY;
    const pxT = d.px * d.dy / dyT;                     // 分红不变假设下的触发价
    if (px <= pxT) {
      alerts.push({ key: "ladder_" + name + "_" + next.th, level: "档位升档",
        title: name + " 触及加仓档位（利差→" + next.th.toFixed(1) + "pp）",
        detail: "现价 " + (px < 10 ? px.toFixed(3) : px.toFixed(2)) + " ≤ 触发价 " + (pxT < 10 ? pxT.toFixed(3) : pxT.toFixed(2)) +
          "（对应档位仓 " + next.w + "%，" + next.label + "）。当前利差 " + spread.toFixed(2) + "pp。" });
    }
  }
  function addTech(name, key, d, px, gainPP) {
    const cfgT = TECH[name === "中证红利" ? "csi" : "lowvol"];
    const add = cfgT[key] || 0;
    if (px == null) return;
    let hit = false, txt = "";
    if (key === "ma250" && d.ma250 != null) {
      hit = px <= d.ma250;
      txt = "现价 " + (px < 10 ? px.toFixed(3) : px.toFixed(2)) + " vs 年线 " + (d.ma250 < 10 ? d.ma250.toFixed(3) : d.ma250.toFixed(2)) +
        (add ? "（回测加仓增益 +" + add + "pp）" : "（该标的此项无回测增益，仅提示）");
    }
    if (key === "rsi" && d.rsi30 && d.rsi30.price != null) {
      hit = px <= d.rsi30.price;
      txt = "现价接近 RSI30 触发价 " + (d.rsi30.price < 10 ? d.rsi30.price.toFixed(3) : d.rsi30.price.toFixed(2)) +
        (add ? "（回测加仓增益 +" + add + "pp）" : "（该标的此项无回测增益，仅提示）");
    }
    if (hit) alerts.push({ key: "tech_" + name + "_" + key, level: "技术信号", title: name + " " + (key === "ma250" ? "跌破年线" : "RSI 超卖区"), detail: txt });
  }

  addLadder("中证红利", c, csiPx);
  addLadder("红利低波", l, lvPx);
  addTech("红利低波", "ma250", l, lvPx);
  addTech("红利低波", "rsi", l, lvPx);
  addTech("中证红利", "ma250", c, csiPx);   // 无增益但提示（页面观察项口径）

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
