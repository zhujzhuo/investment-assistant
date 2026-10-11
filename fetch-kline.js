// 批量拉取不复权月K（腾讯公开接口），用于计算历史估值分位
// 用法: node fetch-kline.js
const fs = require("fs");
const https = require("https");
const path = require("path");

// 代码列表取自 data.js 的股票池（而不是历史财报文件），保证新增标的也能抓到月K
const sb = { window: {} };
new Function("window", fs.readFileSync(path.join(__dirname, "data.js"), "utf8"))(sb.window);
const CODES = (sb.window.STOCKS || []).map(s => s.code);
const MONTHS = 48; // 4 年月K（上市不足 4 年的按实际长度返回）

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 20000 }, res => {
      let buf = "";
      res.on("data", d => (buf += d));
      res.on("end", () => resolve(buf));
    }).on("error", reject).on("timeout", function () { this.destroy(new Error("timeout")); });
  });
}

(async function () {
  const out = { months: MONTHS, fetchedAt: new Date().toISOString().slice(0, 10), data: {} };
  const errors = {};
  for (const code of CODES) {
    const url = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=" + code + ",month,,," + MONTHS + ",";
    try {
      const txt = await get(url);
      const j = JSON.parse(txt);
      const arr = (j.data && j.data[code] && j.data[code].month) || [];
      // 元素: [date, open, close, high, low, volume, ...]
      const rows = arr
        .filter(r => r && r[0] && r[2] != null)
        .map(r => ({ d: r[0], c: Number(r[2]) }))
        .filter(r => isFinite(r.c) && r.c > 0);
      if (!rows.length) { errors[code] = "empty"; continue; }
      out.data[code] = rows;
      console.log(code, "n=" + rows.length, rows[rows.length - 1].d + " close=" + rows[rows.length - 1].c);
    } catch (e) {
      errors[code] = String(e.message || e);
      console.log(code, "ERROR", errors[code]);
    }
    await new Promise(r => setTimeout(r, 220)); // 轻微限速，避免被拒
  }
  out.errors = errors;
  fs.writeFileSync(path.join(__dirname, "data/month-kline.json"), JSON.stringify(out));
  console.log("\nWROTE data/month-kline.json  codes=" + Object.keys(out.data).length + "  errors=" + Object.keys(errors).length);
})();
