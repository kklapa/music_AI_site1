/* Canvas-візуалізатор частот і хвилі (Web Audio AnalyserNode). Без аналізатора — м'яка імітація. */

import { isTouch, reducedMotion } from './util.js';

export class Visualizer {
  constructor(canvas, { getPalette }) {
    this.canvas = canvas;
    this.cx = canvas.getContext('2d');
    this.getPalette = getPalette;
    this.analyser = null;
    this.playing = false;
    this.running = false;
    this.bars = 56;
    this.levels = new Float32Array(this.bars);
    this.freq = null;
    this.wave = null;
    this.raf = 0;
    this.last = 0;
    this.dpr = 1;
    this.lowPower = isTouch() || (navigator.hardwareConcurrency || 8) <= 4;
    this.frame = this.frame.bind(this);
    this.onResize = () => this.resize();
    if (typeof ResizeObserver === 'function') {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(canvas);
    }
  }

  setAnalyser(analyser) {
    this.analyser = analyser || null;
    if (this.analyser) {
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
      this.wave = new Uint8Array(this.analyser.fftSize);
    }
  }

  setPlaying(v) {
    this.playing = !!v;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, this.lowPower ? 1.5 : 2);
    const w = Math.round(rect.width * this.dpr);
    const h = Math.round(rect.height * this.dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.resize();
    this.raf = requestAnimationFrame(this.frame);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  targetLevels(now) {
    const n = this.bars;
    const out = new Float32Array(n);
    if (this.playing && this.analyser) {
      this.analyser.getByteFrequencyData(this.freq);
      const usable = Math.floor(this.freq.length * 0.72);
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const bin = Math.floor(2 + Math.pow(t, 1.55) * usable);
        const next = Math.min(this.freq.length - 1, bin + 1);
        let v = (this.freq[bin] + this.freq[next]) / 510;
        v = Math.pow(v, 1.2) * (0.78 + 0.55 * t);
        out[i] = Math.min(1, v);
      }
    } else if (this.playing) {
      for (let i = 0; i < n; i++) {
        const a = 0.5 + 0.5 * Math.sin(now / 230 + i * 0.62);
        const b = 0.6 + 0.4 * Math.sin(now / 971 + i * 1.7);
        out[i] = 0.12 + 0.55 * a * b;
      }
    } else {
      for (let i = 0; i < n; i++) out[i] = 0.035 + 0.03 * Math.sin(now / 900 + i * 0.5);
    }
    return out;
  }

  frame(now) {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    if (document.hidden) return;
    if (this.lowPower && now - this.last < 33) return;
    this.last = now;

    const { canvas, cx } = this;
    const W = canvas.width;
    const H = canvas.height;
    if (!W || !H) {
      this.resize();
      return;
    }
    const target = this.targetLevels(now);
    for (let i = 0; i < this.bars; i++) {
      const v = target[i];
      this.levels[i] += (v - this.levels[i]) * (v > this.levels[i] ? 0.55 : 0.14);
    }

    cx.clearRect(0, 0, W, H);
    const palette = this.getPalette();
    const grad = cx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, palette[0]);
    grad.addColorStop(0.5, palette[1]);
    grad.addColorStop(1, palette[2]);

    const n = this.bars;
    const slot = W / n;
    const barW = Math.max(2, slot * 0.56);
    const mid = H / 2;
    const minH = Math.max(3 * this.dpr, H * 0.05);
    const motion = reducedMotion() ? 0.55 : 1;

    cx.save();
    cx.fillStyle = grad;
    if (!this.lowPower) {
      cx.shadowColor = palette[1];
      cx.shadowBlur = 14 * this.dpr;
    }
    for (let i = 0; i < n; i++) {
      const h = Math.max(minH, this.levels[i] * H * 0.94 * motion);
      const x = i * slot + (slot - barW) / 2;
      const y = mid - h / 2;
      cx.beginPath();
      if (typeof cx.roundRect === 'function') cx.roundRect(x, y, barW, h, barW / 2);
      else cx.rect(x, y, barW, h);
      cx.fill();
    }
    cx.restore();

    // Тонка лінія форми хвилі поверх стовпчиків.
    if (this.playing && this.analyser) {
      this.analyser.getByteTimeDomainData(this.wave);
      cx.save();
      cx.beginPath();
      const step = Math.max(1, Math.floor(this.wave.length / 160));
      for (let i = 0, x = 0; i < this.wave.length; i += step, x++) {
        const px = (i / (this.wave.length - 1)) * W;
        const py = mid + ((this.wave[i] - 128) / 128) * H * 0.3 * motion;
        if (i === 0) cx.moveTo(px, py);
        else cx.lineTo(px, py);
      }
      cx.lineWidth = 1.6 * this.dpr;
      cx.lineJoin = 'round';
      cx.strokeStyle = 'rgba(255,255,255,0.82)';
      if (!this.lowPower) {
        cx.shadowColor = palette[0];
        cx.shadowBlur = 8 * this.dpr;
      }
      cx.stroke();
      cx.restore();
    }
  }
}
