/**
 * Run once:  node gen-pi-logo.mjs
 * Produces:  pi-logo.png  (alongside this file)
 * No dependencies — pure Node.js zlib + manual PNG encoding.
 */

import { deflateSync } from "zlib";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── canvas config ────────────────────────────────────────────────────────────
const W = 320, H = 160;
const pixels = Buffer.alloc(W * H * 4); // RGBA

// ─── gradient palette: trans-pride (blue → pink → white → pink → blue) ────────
const STOPS = [
  [91, 206, 250],
  [245, 169, 184],
  [255, 255, 255],
  [245, 169, 184],
  [91, 206, 250],
];

function gradientAt(t) {
  const s = Math.max(0, Math.min(1, t)) * (STOPS.length - 1);
  const i = Math.min(Math.floor(s), STOPS.length - 2);
  const u = s - i;
  const a = STOPS[i], b = STOPS[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * u),
    Math.round(a[1] + (b[1] - a[1]) * u),
    Math.round(a[2] + (b[2] - a[2]) * u),
  ];
}

// ─── pixel helpers ────────────────────────────────────────────────────────────
function setPixel(x, y, r, g, b, a = 255) {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = (y * W + x) * 4;
  // alpha-blend onto existing
  const oldA = pixels[i + 3] / 255;
  const newA = a / 255;
  const outA = newA + oldA * (1 - newA);
  if (outA === 0) return;
  pixels[i]     = Math.round((r * newA + pixels[i]     * oldA * (1 - newA)) / outA);
  pixels[i + 1] = Math.round((g * newA + pixels[i + 1] * oldA * (1 - newA)) / outA);
  pixels[i + 2] = Math.round((b * newA + pixels[i + 2] * oldA * (1 - newA)) / outA);
  pixels[i + 3] = Math.round(outA * 255);
}

/** Filled anti-aliased rectangle */
function fillRect(x0, y0, x1, y1, colorFn) {
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
      const cx = Math.max(0, Math.min(1, x1 - x, x - x0 + 1, y1 - y, y - y0 + 1));
      if (cx <= 0) continue;
      const [r, g, b] = colorFn(x, y);
      setPixel(x, y, r, g, b, Math.round(cx * 255));
    }
  }
}

/** Filled anti-aliased ellipse (axis-aligned) */
function fillEllipse(cx, cy, rx, ry, colorFn) {
  for (let y = Math.floor(cy - ry - 1); y <= Math.ceil(cy + ry + 1); y++) {
    for (let x = Math.floor(cx - rx - 1); x <= Math.ceil(cx + rx + 1); x++) {
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      const d = Math.sqrt(dx * dx + dy * dy);
      const alpha = Math.max(0, Math.min(1, 1 - (d - 1) * (rx + ry) / 2));
      if (alpha <= 0) continue;
      const [r, g, b] = colorFn(x, y);
      setPixel(x, y, r, g, b, Math.round(alpha * 255));
    }
  }
}

// Color function: gradient based on x position
const gradColor = (x, _y) => gradientAt(x / (W - 1));

// ─── draw the π shape ────────────────────────────────────────────────────────
const pad    = 18;   // left/right padding
const barH   = 18;   // horizontal bar height
const barY   = 28;   // bar top y
const legW   = 24;   // leg width
const legR   = 10;   // leg bottom corner radius
const legBot = H - 32; // leg bottom y
const legGap = 68;   // gap between legs (center-to-center offset)
const midX   = W / 2;

// Horizontal top bar (full width, with rounded caps)
fillRect(pad, barY, W - pad, barY + barH, gradColor);
// Round left end
fillEllipse(pad + barH / 2, barY + barH / 2, barH / 2, barH / 2, gradColor);
// Round right end
fillEllipse(W - pad - barH / 2, barY + barH / 2, barH / 2, barH / 2, gradColor);

// Left leg
const lx = midX - legGap / 2;
fillRect(lx - legW / 2, barY, lx + legW / 2, legBot, gradColor);
// Left leg rounded bottom-left
fillEllipse(lx - legW / 2 + legR, legBot - legR, legR, legR, gradColor);
// Left leg rounded bottom-right
fillEllipse(lx + legW / 2 - legR, legBot - legR, legR, legR, gradColor);
// Left leg bottom cap (fill between rounded corners)
fillRect(lx - legW / 2 + legR, legBot - legR, lx + legW / 2 - legR, legBot, gradColor);

// Right leg
const rx2 = midX + legGap / 2;
fillRect(rx2 - legW / 2, barY, rx2 + legW / 2, legBot, gradColor);
fillEllipse(rx2 - legW / 2 + legR, legBot - legR, legR, legR, gradColor);
fillEllipse(rx2 + legW / 2 - legR, legBot - legR, legR, legR, gradColor);
fillRect(rx2 - legW / 2 + legR, legBot - legR, rx2 + legW / 2 - legR, legBot, gradColor);

// ─── encode as PNG ────────────────────────────────────────────────────────────
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (const b of buf) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const len = Buffer.allocUnsafe(4); len.writeUInt32BE(data.length);
  const crcData = Buffer.concat([typeBytes, data]);
  const crcBuf = Buffer.allocUnsafe(4); crcBuf.writeUInt32BE(crc32(crcData));
  return Buffer.concat([len, typeBytes, data, crcBuf]);
}

// IHDR
const ihdr = Buffer.allocUnsafe(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA

// Raw scanlines (filter byte 0 = None per row)
const stride = W * 4;
const raw = Buffer.allocUnsafe(H * (stride + 1));
for (let y = 0; y < H; y++) {
  raw[y * (stride + 1)] = 0;
  Buffer.from(pixels.buffer).copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
}

const idat = deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), // PNG sig
  chunk("IHDR", ihdr),
  chunk("IDAT", idat),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = join(__dirname, "pi-logo.png");
writeFileSync(out, png);
console.log(`Written: ${out}  (${W}×${H})`);
