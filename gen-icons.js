// 零依赖 PNG 图标生成器：蓝底圆角 + 递增白柱（投资/增长语义）
// 用法: node gen-icons.js  → 生成 icons/icon-192.png / icon-512.png / icon-maskable-512.png
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// ---------- PNG 编码 ----------
let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c;
  }
  return CRC_TABLE;
}
function crc32(buf) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- 画布（超采样抗锯齿） ----------
function makeCanvas(size, ss) {
  const W = size * ss;
  const buf = Buffer.alloc(W * W * 4, 0);
  return { size, ss, W, buf };
}
function blend(cv, x, y, col, a) {
  if (x < 0 || y < 0 || x >= cv.W || y >= cv.W) return;
  const i = (y * cv.W + x) * 4;
  const alpha = a === undefined ? col[3] / 255 : a;
  const inv = 1 - alpha;
  cv.buf[i] = col[0] * alpha + cv.buf[i] * inv;
  cv.buf[i + 1] = col[1] * alpha + cv.buf[i + 1] * inv;
  cv.buf[i + 2] = col[2] * alpha + cv.buf[i + 2] * inv;
  cv.buf[i + 3] = 255 * alpha + cv.buf[i + 3] * inv;
}
function inRR(px, py, x0, y0, x1, y1, r) {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const cx = Math.min(Math.max(px, x0 + r), x1 - r);
  const cy = Math.min(Math.max(py, y0 + r), y1 - r);
  const dx = px - cx, dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}
function fillRR(cv, x0, y0, x1, y1, r, colorFn) {
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
      if (inRR(x + 0.5, y + 0.5, x0, y0, x1, y1, r)) {
        blend(cv, x, y, colorFn(x + 0.5, y + 0.5));
      }
    }
  }
}
function lerp(a, b, t) { return a + (b - a) * t; }
function mixCol(c1, c2, t) {
  return [Math.round(lerp(c1[0], c2[0], t)), Math.round(lerp(c1[1], c2[1], t)), Math.round(lerp(c1[2], c2[2], t)), 255];
}
function downsample(cv) {
  const s = cv.size, ss = cv.ss, out = Buffer.alloc(s * s * 4);
  const n = ss * ss;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < ss; dy++) {
        for (let dx = 0; dx < ss; dx++) {
          const i = ((y * ss + dy) * cv.W + (x * ss + dx)) * 4;
          r += cv.buf[i]; g += cv.buf[i + 1]; b += cv.buf[i + 2]; a += cv.buf[i + 3];
        }
      }
      const o = (y * s + x) * 4;
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

// ---------- 图标绘制 ----------
const BLUE_TOP = [37, 99, 235];     // #2563eb
const BLUE_BOT = [23, 55, 148];     // #173794
const WHITE = [255, 255, 255, 255];

function drawIcon(size, maskable) {
  const ss = 2;
  const cv = makeCanvas(size, ss);
  const S = cv.W;
  const u = S / 512; // 以 512 为设计基准

  // maskable 图标：内容收缩到安全区（80%），四周留白
  const pad = maskable ? 0.14 * S : 0;
  const bx0 = pad, by0 = pad, bx1 = S - pad, by1 = S - pad;
  const radius = maskable ? 0.30 * (bx1 - bx0) : 0.22 * S;

  // 背景：垂直渐变圆角矩形
  fillRR(cv, bx0, by0, bx1, by1, radius, function (x, y) {
    const t = (y - by0) / Math.max(1, by1 - by0);
    return mixCol(BLUE_TOP, BLUE_BOT, t);
  });

  // 三根递增白柱
  const bw = 62 * u;
  const gap = 36 * u;
  const total = bw * 3 + gap * 2;
  const left = (S - total) / 2;
  const baseY = by0 + 0.72 * (by1 - by0);
  const heights = [0.20, 0.34, 0.50].map(function (h) { return h * (by1 - by0); });
  for (let i = 0; i < 3; i++) {
    const x0 = left + i * (bw + gap);
    const y1 = baseY;
    const y0 = baseY - heights[i];
    fillRR(cv, x0, y0, x0 + bw, y1, Math.min(14 * u, bw / 2), function () { return WHITE; });
  }

  // 柱顶上方的上升趋势折线
  const pts = [
    [left + bw * 0.5, baseY - heights[0] - 30 * u],
    [left + bw + gap + bw * 0.5, baseY - heights[1] - 26 * u],
    [left + 2 * (bw + gap) + bw * 0.5, baseY - heights[2] - 34 * u],
  ];
  const lw = 13 * u;
  for (let p = 0; p < pts.length - 1; p++) {
    strokeSeg(cv, pts[p], pts[p + 1], lw, WHITE);
  }
  for (let p = 0; p < pts.length; p++) {
    fillCircle(cv, pts[p][0], pts[p][1], lw * 0.62, WHITE);
  }

  return encodePNG(size, size, downsample(cv));
}
function strokeSeg(cv, a, b, w, col) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  const steps = Math.max(2, Math.ceil(len * 2));
  const r = w / 2;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    fillCircle(cv, a[0] + dx * t, a[1] + dy * t, r, col);
  }
}
function fillCircle(cv, cx, cy, r, col) {
  const x0 = Math.floor(cx - r - 1), x1 = Math.ceil(cx + r + 1);
  const y0 = Math.floor(cy - r - 1), y1 = Math.ceil(cy + r + 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const d = Math.hypot(dx, dy);
      if (d <= r - 0.5) blend(cv, x, y, col);
      else if (d < r + 0.5) blend(cv, x, y, col, (r + 0.5 - d));
    }
  }
}

// ---------- 输出 ----------
const outDir = path.join(__dirname, "icons");
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const targets = [
  ["icon-192.png", 192, false],
  ["icon-512.png", 512, false],
  ["icon-maskable-512.png", 512, true],
];
for (const t of targets) {
  const png = drawIcon(t[1], t[2]);
  fs.writeFileSync(path.join(outDir, t[0]), png);
  console.log(t[0], (png.length / 1024).toFixed(1) + " KB");
}

// SVG favicon（含中文「投」字，浏览器端渲染）
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
  '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">' +
  '<stop offset="0" stop-color="#2563eb"/><stop offset="1" stop-color="#173794"/></linearGradient></defs>' +
  '<rect width="512" height="512" rx="112" fill="url(#g)"/>' +
  '<text x="256" y="256" font-family="PingFang SC,Microsoft YaHei,sans-serif" font-size="300" ' +
  'font-weight="700" fill="#fff" text-anchor="middle" dominant-baseline="central">投</text></svg>';
fs.writeFileSync(path.join(outDir, "icon.svg"), svg);
console.log("icon.svg written");
console.log("ICONS-OK");
