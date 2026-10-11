// 将 index.html + style.css + data.js + app.js 打包为自包含单文件 HTML
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const outDir = path.join(dir, "dist");
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

let html = fs.readFileSync(path.join(dir, "index.html"), "utf8");

// 单文件版用于本地 file:// 打开：剥离 PWA 专属引用（manifest/sw/图标在本地无意义）
html = html.replace(/<link rel="manifest"[^>]*>\n?/g, "");
html = html.replace(/<link rel="apple-touch-icon"[^>]*>\n?/g, "");

const guard = (s) => s.replace(/<\/script>/gi, "<\\/script>");

// 通用内联：逐个替换 <link rel="stylesheet" href="..."> 与 <script src="...">
html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, function (m, f) {
  return "<style>\n" + fs.readFileSync(path.join(dir, f), "utf8") + "\n</style>";
});
html = html.replace(/<script src="([^"]+)"><\/script>/g, function (m, f) {
  return "<script>\n" + guard(fs.readFileSync(path.join(dir, f), "utf8")) + "\n</script>";
});

if (/<link rel="stylesheet"/.test(html) || /<script src=/.test(html)) {
  throw new Error("inline failed: external reference still present");
}

const out = path.join(outDir, "个人投资智能助理_单文件版.html");
fs.writeFileSync(out, html, "utf8");
console.log("built:", out, (fs.statSync(out).size / 1024).toFixed(1) + " KB");
