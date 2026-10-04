/* Витяг кольорів із обкладинки для Ambient Background і візуалізатора. */

import { clamp, hashPalette, hexToRgb, hslToHex, rgbToHsl } from './util.js';

const DEFAULT_PALETTE = ['#7c5cff', '#00e5ff', '#ff3d9a'];
const cache = new Map();
let current = DEFAULT_PALETTE.slice();

export const getPalette = () => current.slice();

function neon([r, g, b]) {
  const [h, s, l] = rgbToHsl(r, g, b);
  return hslToHex(h, clamp(s, 58, 95), clamp(l, 44, 62));
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function quantize(data) {
  const buckets = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 200) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (luma < 22 || luma > 244) continue;
    const sat = max === 0 ? 0 : (max - min) / max;
    const weight = 1 + sat * 4;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key) || { w: 0, r: 0, g: 0, b: 0 };
    bucket.w += weight;
    bucket.r += r * weight;
    bucket.g += g * weight;
    bucket.b += b * weight;
    buckets.set(key, bucket);
  }
  return Array.from(buckets.values())
    .sort((x, y) => y.w - x.w)
    .map((b) => [b.r / b.w, b.g / b.w, b.b / b.w]);
}

function pickDistinct(colors, count) {
  const picked = [];
  for (const c of colors) {
    if (picked.every((p) => distance(p, c) > 70)) picked.push(c);
    if (picked.length === count) break;
  }
  return picked;
}

function fillPalette(picked) {
  const out = picked.map(neon);
  if (!out.length) return DEFAULT_PALETTE.slice();
  const [h, s, l] = rgbToHsl(...hexToRgb(out[0]));
  while (out.length < 3) {
    const shift = out.length === 1 ? 52 : -64;
    out.push(hslToHex(h + shift, clamp(s, 60, 90), clamp(l, 46, 58)));
  }
  return out.slice(0, 3);
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

export async function paletteFor(track) {
  if (!track) return DEFAULT_PALETTE.slice();
  const key = track.cover_url || `ph:${track.id}`;
  if (cache.has(key)) return cache.get(key).slice();
  let palette;
  if (!track.cover_url) {
    palette = hashPalette(`${track.id}:${track.title}`);
  } else {
    try {
      const img = await loadImage(track.cover_url);
      const size = 40;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, size, size);
      const data = ctx.getImageData(0, 0, size, size).data;
      palette = fillPalette(pickDistinct(quantize(data), 3));
    } catch (_) {
      palette = hashPalette(`${track.id}:${track.title}`);
    }
  }
  cache.set(key, palette);
  return palette.slice();
}

/** Застосовує палітру до CSS-змінних (@property робить перехід плавним). */
export function applyAmbient(palette) {
  const p = palette && palette.length >= 3 ? palette : DEFAULT_PALETTE;
  current = p.slice();
  const root = document.documentElement.style;
  root.setProperty('--c1', p[0]);
  root.setProperty('--c2', p[1]);
  root.setProperty('--c3', p[2]);
  const [h, s, l] = rgbToHsl(...hexToRgb(p[0]));
  root.setProperty('--accent', hslToHex(h, clamp(s, 70, 100), clamp(l + 16, 68, 80)));
}

export function resetAmbient() {
  applyAmbient(DEFAULT_PALETTE);
}
