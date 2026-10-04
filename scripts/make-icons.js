'use strict';

/**
 * Генерує PNG-іконки PWA без зовнішніх залежностей (лише zlib).
 * Запуск: npm run icons  →  public/icons/*.png
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(OUT, { recursive: true });

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const C1 = hex('#7c5cff');
const C2 = hex('#00e5ff');
const C3 = hex('#ff3d9a');
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const clamp01 = (v) => Math.max(0, Math.min(1, v));

function gradient(t) {
  return t < 0.5 ? mix(C1, C2, t * 2) : mix(C2, C3, (t - 0.5) * 2);
}

/** Знакова відстань до скругленого прямокутника (центр, піврозміри, радіус). */
function sdRoundRect(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - (hx - r);
  const qy = Math.abs(py - cy) - (hy - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * @param {number} size розмір у пікселях
 * @param {object} opts { rounded: скругляти кути (прозорий фон), pad: відступ вмісту (0..1) }
 */
function render(size, { rounded, pad }) {
  const buf = Buffer.alloc(size * size * 4);
  const bars = [0.34, 0.62, 0.46, 0.8];
  const area = size * (1 - pad * 2);
  const barW = area * 0.16;
  const gap = area * 0.1;
  const total = bars.length * barW + (bars.length - 1) * gap;
  const startX = (size - total) / 2;
  const cy = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      // Фон: темний градієнт із легким кольоровим сяйвом.
      const vy = py / size;
      const glow = clamp01(1 - Math.hypot(px / size - 0.5, py / size - 0.55) * 1.6);
      let col = [11 + glow * 22, 10 + glow * 12, 20 + glow * 46 + vy * 6];
      let alpha = 1;
      if (rounded) {
        const d = sdRoundRect(px, py, size / 2, size / 2, size / 2, size / 2, size * 0.225);
        alpha = clamp01(0.5 - d);
      }
      // Стовпчики хвилі.
      for (let i = 0; i < bars.length; i++) {
        const bx = startX + i * (barW + gap) + barW / 2;
        const h = area * bars[i];
        const d = sdRoundRect(px, py, bx, cy, barW / 2, h / 2, barW / 2);
        const cover = clamp01(0.5 - d);
        if (cover > 0) {
          const g = gradient(clamp01((py - (cy - h / 2)) / h));
          col = mix(col, g, cover);
        }
      }
      const o = (y * size + x) * 4;
      buf[o] = Math.round(col[0]);
      buf[o + 1] = Math.round(col[1]);
      buf[o + 2] = Math.round(col[2]);
      buf[o + 3] = Math.round(alpha * 255);
    }
  }
  return buf;
}

const targets = [
  ['icon-192.png', 192, { rounded: true, pad: 0.2 }],
  ['icon-512.png', 512, { rounded: true, pad: 0.2 }],
  ['icon-maskable-512.png', 512, { rounded: false, pad: 0.3 }],
  ['apple-touch-icon.png', 180, { rounded: false, pad: 0.24 }],
  ['favicon-32.png', 32, { rounded: true, pad: 0.12 }],
];

for (const [name, size, opts] of targets) {
  fs.writeFileSync(path.join(OUT, name), encodePng(size, render(size, opts)));
  console.log('✓', name);
}

fs.writeFileSync(
  path.join(OUT, 'icon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#7c5cff"/><stop offset="0.5" stop-color="#00e5ff"/><stop offset="1" stop-color="#ff3d9a"/>
    </linearGradient>
    <radialGradient id="bg" cx="0.5" cy="0.55" r="0.7">
      <stop offset="0" stop-color="#1d1a3a"/><stop offset="1" stop-color="#0b0a14"/>
    </radialGradient>
  </defs>
  <rect width="512" height="512" rx="115" fill="url(#bg)"/>
  <rect x="116" y="173" width="66" height="166" rx="33" fill="url(#g)"/>
  <rect x="196" y="97" width="66" height="318" rx="33" fill="url(#g)"/>
  <rect x="276" y="147" width="66" height="218" rx="33" fill="url(#g)"/>
  <rect x="356" y="106" width="66" height="300" rx="33" fill="url(#g)"/>
</svg>
`
);
console.log('✓ icon.svg');
