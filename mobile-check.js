// 移动端与 PWA 自检
const fs = require("fs");
const assert = (name, cond, extra) => {
  if (!cond) { console.error("  ✗ " + name + (extra ? " → " + extra : "")); process.exitCode = 1; }
  else console.log("  ✓ " + name);
};

console.log("[1] manifest.json");
const mf = JSON.parse(fs.readFileSync(__dirname + "/manifest.json", "utf8"));
assert("JSON 合法", !!mf);
assert("display=standalone（全屏类App）", mf.display === "standalone");
assert("含 192/512/maskable 图标", mf.icons.length === 3 && mf.icons.every(i => fs.existsSync(__dirname + "/" + i.src)));
assert("theme_color 与页面一致", mf.theme_color === "#1d4ed8");
assert("start_url 相对路径", mf.start_url === "./");

console.log("[2] sw.js");
const sw = fs.readFileSync(__dirname + "/sw.js", "utf8");
assert("缓存所有核心资源", ["./index.html", "./app.js", "./data.js", "./data/valuation.js", "./manifest.json"].every(a => sw.includes('"' + a + '"')));
assert("行情接口不缓存（gtimg）", sw.includes("gtimg.cn"));
assert("network-first 策略（在线取最新、离线回退缓存）", sw.includes('fetch(e.request, { cache: "no-store" })') && sw.includes("caches.match"));
assert("外壳不再缓存优先（避免手机端停在旧版）", !/caches\.match\(e\.request\)\.then/.test(sw));
assert("旧版本缓存清理", sw.includes("caches.delete"));

console.log("[3] index.html");
const html = fs.readFileSync(__dirname + "/index.html", "utf8");
assert("viewport 含 viewport-fit=cover（safe-area）", html.includes("viewport-fit=cover"));
assert("apple-mobile-web-app-capable", html.includes("apple-mobile-web-app-capable"));
assert("apple-touch-icon", html.includes("apple-touch-icon"));
assert("manifest 已挂载", html.includes('rel="manifest"'));
assert("theme-color", html.includes("theme-color"));
const navBtns = (html.match(/class="nav-btn/g) || []).length;
const ics = (html.match(/<span class="ic">/g) || []).length;
const lbs = (html.match(/<span class="lb">/g) || []).length;
assert("导航按钮结构化（每个 nav-btn 含 .ic/.lb）", navBtns > 0 && navBtns === ics && ics === lbs, navBtns + " 个按钮");
assert("无置顶安装引导条（页面保持干净）", !html.includes("pwa-hint") && !html.includes("pwa-install"));

console.log("[4] style.css 移动端");
const css = fs.readFileSync(__dirname + "/style.css", "utf8");
assert("640px 断点存在", css.includes("@media (max-width: 640px)"));
assert("底部固定 tab（position:fixed）", /max-width:\s*640px[\s\S]*\.nav\s*{[^}]*position:\s*fixed/.test(css));
assert("safe-area 适配（env()）", css.includes("env(safe-area-inset-bottom)"));
assert("表格移动端滚动", /\.tbl\s*{[^}]*overflow-x:\s*auto/.test(css));
assert("长文本列换行（wrapcol）", css.includes(".wrapcol"));
assert("720px 断点（两列卡片→单列）", css.includes("@media (max-width: 720px)") && /max-width:\s*720px[\s\S]*\.grid2\s*{[^}]*1fr/.test(css));
assert("键值网格成对排列（.kvg.k2 / .kvg.k4）", css.includes(".kvg.k2") && css.includes(".kvg.k4"));
assert("窄屏 k4 → 一行一对", /max-width:\s*720px[\s\S]*\.kvg\.k4\s*{[^}]*grid-template-columns:\s*minmax\(88px, max-content\) 1fr/.test(css));
assert("宽表窄屏堆叠（.tbl-stack + data-l）", css.includes(".tbl-stack") && css.includes("attr(data-l)"));
assert("堆叠时隐藏表头", /\.tbl-stack thead\s*{[^}]*display:\s*none/.test(css));
assert("宽表容器可横向滚动（.tbl-scroll）", /\.tbl-scroll\s*{[^}]*overflow-x:\s*auto/.test(css));
assert("窄屏精简顶栏副标题（.hide-sm）", css.includes(".hide-sm"));
assert("底部 tab 可横向滚动（tab 多于屏宽不挤压）", /max-width:\s*640px[\s\S]*\.nav\s*{[^}]*overflow-x:\s*auto/.test(css));
assert("底部 tab 固定宽度（不再 flex:1 压缩）", /max-width:\s*640px[\s\S]*\.nav-btn\s*{[^}]*flex:\s*0 0 auto/.test(css));
assert("中屏导航压缩（不挤成两行）", css.includes("@media (min-width: 641px) and (max-width: 1100px)"));
assert("iOS 独立状态栏样式", css.includes("black-translucent") || html.includes("black-translucent"));

console.log("[5] app.js PWA 逻辑");
const app = fs.readFileSync(__dirname + "/app.js", "utf8");
assert("SW 注册（仅 https）", app.includes('serviceWorker.register("sw.js"') && app.includes('location.protocol === "https:"'));
assert("SW 主动查更新 + 新版本自动刷新（防旧外壳）", app.includes("updateViaCache: \"none\"") && app.includes("controllerchange") && app.includes("ia-sw-reload"));
assert("未残留安装引导逻辑", !app.includes("pwa-hint") && !app.includes("beforeinstallprompt"));
assert("推荐页理由列 wrapcol", app.includes('small wrapcol'));
assert("页面已使用成对键值网格 kvg", (app.match(/kvg k[24]/g) || []).length >= 5, (app.match(/kvg k[24]/g) || []).length + " 处");
assert("宽表已标记 tbl-stack（窄屏堆叠）", (app.match(/tbl tbl-stack/g) || []).length >= 3, (app.match(/tbl tbl-stack/g) || []).length + " 张");
assert("堆叠单元格带 data-l 列名", (app.match(/data-l="/g) || []).length >= 12, (app.match(/data-l="/g) || []).length + " 处");
assert("切换页签时把当前 tab 滚入视野（11 个 tab 时可横滑）", app.includes('scrollIntoView({ block: "nearest", inline: "center" })'));
assert("导航含「红利对比」独立页", html.includes('showTab(\'divcmp\')') && app.includes('function renderDivCmp()'));
const tabsM = app.match(/var tabs = \[([^\]]+)\]/);
const tabCount = tabsM ? tabsM[1].split(",").length : 0;
assert("导航按钮数 = tabs 数（无遗漏/多余）", tabCount > 0 && navBtns === tabCount, navBtns + " 按钮 / " + tabCount + " tabs");

console.log("[6] 图标");
for (const f of ["icon-192.png", "icon-512.png", "icon-maskable-512.png", "icon.svg"]) {
  const p = __dirname + "/icons/" + f;
  assert(f + " 存在", fs.existsSync(p));
}
const png = fs.readFileSync(__dirname + "/icons/icon-512.png");
assert("PNG 头合法", png[0] === 0x89 && png.toString("ascii", 1, 4) === "PNG");

console.log(process.exitCode ? "MOBILE-CHECK-FAIL" : "MOBILE-CHECK-OK");
