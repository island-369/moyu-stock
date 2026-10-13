'use strict';
/**
 * 托盘图标生成器：纯 Node（zlib）生成 16px / 32px 模板 PNG（双蜡烛图形）。
 * 运行：node tools/gen-icon.js（产物已提交仓库，一般无需重跑）
 */
const fs = require('fs');
const path = require('path');

/* ---- PNG 编码（无外部依赖） ---- */
function crc32(buf) {
  if (!crc32.table) {
    crc32.table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32.table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crc32.table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function makePng(size, pixelAt) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const o = 1 + x * 4;
      const c = pixelAt(x, y); // [r,g,b,a] 或 null（透明）
      if (c) {
        row[o] = c[0]; row[o + 1] = c[1]; row[o + 2] = c[2]; row[o + 3] = c[3] == null ? 255 : c[3];
      } else {
        row[o + 3] = 0;
      }
    }
    rows.push(row);
  }
  const idat = require('zlib').deflateSync(Buffer.concat(rows));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---- 托盘：模板图双蜡烛（16px 逻辑，黑色模板） ---- */
function glyph(x, y) {
  const candleA = (x >= 2 && x <= 5 && y >= 6 && y <= 11) || (x >= 3 && x <= 4 && y >= 3 && y <= 13);
  const candleB = (x >= 9 && x <= 12 && y >= 2 && y <= 8) || (x >= 10 && x <= 11 && y >= 0 && y <= 10);
  return candleA || candleB;
}

/* ---- 应用图标：128px 圆角深底 + 红涨绿跌双蜡烛 ---- */
function appIconPixel(x, y) {
  const S = 128, M = 6, R = 28;
  // 圆角矩形背景
  const inRounded = (px, py) => {
    if (px < M || py < M || px >= S - M || py >= S - M) return false;
    const cx = Math.max(M + R, Math.min(px, S - M - R));
    const cy = Math.max(M + R, Math.min(py, S - M - R));
    const dx = px - cx, dy = py - cy;
    return dx * dx + dy * dy <= R * R;
  };
  if (!inRounded(x, y)) return null;
  // 红蜡烛（右上，涨）：烛身 + 烛芯
  if (x >= 80 && x <= 108 && y >= 34 && y <= 76) return [229, 72, 77];
  if (x >= 90 && x <= 98 && y >= 20 && y <= 96) return [229, 72, 77];
  // 绿蜡烛（左下，跌）：烛身 + 烛芯
  if (x >= 22 && x <= 50 && y >= 64 && y <= 100) return [48, 164, 108];
  if (x >= 32 && x <= 40 && y >= 50 && y <= 114) return [48, 164, 108];
  return [26, 32, 44];
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'tray-icon.png'), makePng(16, (x, y) => (glyph(x, y) ? [0, 0, 0] : null)));
fs.writeFileSync(path.join(outDir, 'tray-icon@2x.png'), makePng(32, (x, y) => (glyph(Math.floor(x / 2), Math.floor(y / 2)) ? [0, 0, 0] : null)));
fs.writeFileSync(path.join(outDir, 'app-icon.png'), makePng(128, appIconPixel));
fs.writeFileSync(path.join(outDir, 'app-icon@2x.png'), makePng(256, (x, y) => appIconPixel(Math.floor(x / 2), Math.floor(y / 2))));
console.log('icons written to', outDir);
