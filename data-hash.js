// 计算「当前对外数据」的哈希（用于判断是否需要重新部署：内容不变则不发版）
// 只取真正对外服务的文件，排除抓取原始缓存（*-raw.json / eps-history.json）以免误触发
const fs = require("fs");
const crypto = require("crypto");

const FILES = [
  "data.js",
  "data/lt.js",
  "data/valuation.js",
  "data/us.js",
  "data/asset.js",
  "data/divbt.js",
  "data/divbt-sell.js",
  "data/etf.js",
  "data/baseline.js",
  "data/reports.js",
  "data/snap-all.js"
];

const h = crypto.createHash("sha256");
for (const f of FILES) {
  try { h.update(fs.readFileSync(f, "utf8")); }
  catch (e) { h.update(f + ":missing"); }
}
process.stdout.write(h.digest("hex"));
