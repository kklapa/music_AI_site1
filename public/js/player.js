/*
 * Глобальний sticky-плеєр:
 *  - два <audio> (деки) + кросфейд рівної потужності;
 *  - Web Audio: аналізатор для візуалізатора;
 *  - Media Session API (екран блокування, навушники);
 *  - таймлайн-коментарі (маркери на seek bar + "бульбашка");
 *  - хоткеї, жести свайпу, режим Live Room (host / follower);
 *  - події для Smart Home вебхуків.
 */

import { api } from './api.js';
import { state, settings, saveSettings, emit, on, trackCache, cacheTrack, cacheTracks } from './state.js';
import { $, $$, el, clamp, fmtTime, initials, setCover, setIcon, toast, mimeForImage, hydrateIcons } from './util.js';
import { paletteFor, applyAmbient, getPalette } from './colors.js';
import { likeButton, promptModal, commentComposer, commentList, setNowPlaying, ic } from './ui.js';
import { getComments, loadComments, watchTrack, unwatchTrack } from './comments.js';
import { Visualizer } from './visualizer.js';

const AudioCtx = window.AudioContext || window.webkitAudioContext;
const LAST_KEY = 'aiwaves.last.v1';

/* ------------------------------ Стан ------------------------------------- */

const ui = {};
const engine = { ctx: null, master: null, analyser: null, failed: false };
const decks = [];
let active = 0;
let current = null;
let playing = false;
let switching = false;
let muted = false;
let fade = null;
let queue = [];
let order = [];
let pos = -1;
let roomMode = null; // { role: 'host' | 'follower', roomId, emit(state, reason) }
let lastRoomState = null;
let roomOffset = 0;
let roomChain = Promise.resolve();
let seekMini = null;
let seekNp = null;
let viz = null;
let uiRaf = 0;
let listened = 0;
let counted = false;
let lastTick = 0;
let errorStreak = 0;
let hookLast = { event: '', t: 0 };
let commentsUi = null;
let npOpen = false;
let bubbleTimer = 0;
let lastCommentCheck = -1;
let lastSave = 0;
let lastMsPosition = 0;
let initialized = false;
let startSeq = 0;
let lastWhole = -1;

const curve = (v) => v * v;
const position = () => (decks[active] ? decks[active].el.currentTime || 0 : 0);
const duration = () => {
  const el_ = decks[active] && decks[active].el;
  if (el_ && Number.isFinite(el_.duration) && el_.duration > 0) return el_.duration;
  return (current && current.duration) || 0;
};
const isFollower = () => !!(roomMode && roomMode.role === 'follower');
const isHost = () => !!(roomMode && roomMode.role === 'host');

function guard() {
  if (isFollower()) {
    toast('У кімнаті керує лише хост', 'info');
    return false;
  }
  return true;
}

/* --------------------------- Аудіо-движок -------------------------------- */

function createDeck(i) {
  const audio = new Audio();
  audio.preload = 'metadata';
  audio.setAttribute('playsinline', '');
  const deck = { i, el: audio, node: null, gain: null, track: null, level: i === 0 ? 1 : 0, token: 0 };
  audio.addEventListener('timeupdate', () => onTimeUpdate(deck));
  audio.addEventListener('ended', () => onEnded(deck));
  audio.addEventListener('error', () => onError(deck));
  audio.addEventListener('loadedmetadata', () => {
    if (deck !== decks[active]) return;
    if (current && Number.isFinite(audio.duration) && audio.duration > 0 && Math.abs((current.duration || 0) - audio.duration) > 1) {
      current.duration = audio.duration;
    }
    updateProgress();
    renderMarkers();
  });
  audio.addEventListener('durationchange', () => {
    if (deck === decks[active]) {
      updateProgress();
      renderMarkers();
    }
  });
  audio.addEventListener('progress', () => deck === decks[active] && updateBuffered());
  audio.addEventListener('pause', () => {
    if (deck !== decks[active] || switching || audio.ended || !deck.track) return;
    if (playing) setPlaying(false);
  });
  audio.addEventListener('play', () => {
    if (deck !== decks[active] || switching || !deck.track) return;
    if (!playing) setPlaying(true);
  });
  audio.addEventListener('playing', () => {
    errorStreak = 0;
    ui.player && ui.player.classList.remove('buffering');
  });
  audio.addEventListener('waiting', () => deck === decks[active] && ui.player && ui.player.classList.add('buffering'));
  audio.addEventListener('canplay', () => ui.player && ui.player.classList.remove('buffering'));
  return deck;
}

function ensureGraph() {
  if (engine.ctx || engine.failed || !settings.webAudio || !AudioCtx) return;
  // Контекст, створений без жесту користувача, лишиться "suspended" і заглушить звук.
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
  try {
    const ctx = new AudioCtx({ latencyHint: 'playback' });
    const master = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.82;
    const nodes = decks.map((d) => {
      const node = ctx.createMediaElementSource(d.el);
      const gain = ctx.createGain();
      gain.gain.value = d.level;
      return { node, gain };
    });
    nodes.forEach(({ node, gain }, i) => {
      node.connect(gain);
      gain.connect(master);
      decks[i].node = node;
      decks[i].gain = gain;
      decks[i].el.volume = 1;
    });
    master.connect(analyser);
    analyser.connect(ctx.destination);
    engine.ctx = ctx;
    engine.master = master;
    engine.analyser = analyser;
    if (viz) viz.setAnalyser(analyser);
    applyMaster();
  } catch (err) {
    console.warn('[player] Web Audio недоступний, працюємо без візуалізатора:', err);
    engine.failed = true;
    engine.ctx = null;
  }
}

function resumeCtx() {
  if (engine.ctx && engine.ctx.state !== 'running') engine.ctx.resume().catch(() => {});
}

function masterGain() {
  return muted ? 0 : curve(clamp(settings.volume, 0, 1));
}

function applyMaster() {
  if (engine.ctx) {
    engine.master.gain.value = masterGain();
  } else {
    decks.forEach((d) => setLevel(d, d.level));
  }
}

function setLevel(deck, v) {
  deck.level = clamp(v, 0, 1);
  if (deck.gain) deck.gain.gain.value = deck.level;
  else deck.el.volume = clamp(deck.level * masterGain(), 0, 1);
}

function stopDeck(deck) {
  deck.token++;
  try {
    deck.el.pause();
  } catch (_) {
    /* ігноруємо */
  }
  deck.track = null;
  setLevel(deck, 0);
  deck.el.removeAttribute('src');
  try {
    deck.el.load();
  } catch (_) {
    /* ігноруємо */
  }
}

function startFade(from, to, seconds) {
  finishFade();
  const t0 = performance.now();
  const dur = Math.max(0.25, seconds) * 1000;
  fade = { from, to };
  fade.timer = setInterval(() => {
    const p = clamp((performance.now() - t0) / dur, 0, 1);
    setLevel(to, Math.sin((p * Math.PI) / 2));
    setLevel(from, Math.cos((p * Math.PI) / 2));
    if (p >= 1) finishFade();
  }, 40);
}

function finishFade() {
  if (!fade) return;
  clearInterval(fade.timer);
  const { from, to } = fade;
  fade = null;
  setLevel(to, 1);
  if (from !== decks[active]) stopDeck(from);
}

function handlePlayError(err) {
  if (!err) return;
  if (err.name === 'NotAllowedError') {
    toast('Браузер заблокував автозапуск — натисніть ▶', 'info', 4500);
  } else if (err.name === 'NotSupportedError') {
    toast('Не вдалося відтворити цей файл', 'error');
  }
}

/**
 * Запускає трек на вільній деці. fadeSec > 0 — кросфейд із поточною.
 * Повертає true, якщо відтворення почалося.
 */
async function startTrack(track, { position: startPos = 0, autoplay = true, fadeSec = 0, room = true } = {}) {
  ensureGraph();
  resumeCtx();
  finishFade();
  const outgoing = decks[active];
  const incoming = decks[1 - active];
  const doFade = autoplay && playing && fadeSec > 0.05 && !!outgoing.track && !outgoing.el.paused;

  switching = true;
  const seq = ++startSeq;
  const token = ++incoming.token;
  incoming.track = track;
  incoming.el.preload = 'auto';
  incoming.el.src = track.audio_url;
  if (startPos > 0.05) {
    incoming.el.addEventListener(
      'loadedmetadata',
      () => {
        try {
          incoming.el.currentTime = startPos;
        } catch (_) {
          /* ігноруємо */
        }
      },
      { once: true }
    );
  }
  setLevel(incoming, doFade ? 0 : 1);

  const prevId = current ? current.id : null;
  active = incoming.i;
  current = track;
  listened = 0;
  counted = false;
  lastTick = 0;
  lastCommentCheck = -1;
  renderTrackUI(track, prevId);

  let started = false;
  if (autoplay) {
    try {
      await incoming.el.play();
      started = true;
    } catch (err) {
      if (err && err.name === 'AbortError') {
        /* src змінили під час завантаження */
      } else handlePlayError(err);
    }
  }
  if (seq !== startSeq || token !== incoming.token) return false; // нас випередив інший запит

  if (doFade && started) startFade(outgoing, incoming, fadeSec);
  else if (outgoing !== incoming) stopDeck(outgoing);
  switching = false;

  setPlaying(started, { hook: false, room: false });
  if (started) sendHook('track_change');
  if (room) roomEmit('track');
  updateProgress();
  saveLast(true);
  return started;
}

/* ------------------------------ Черга ------------------------------------ */

function rebuildOrder(focus = current) {
  const idx = focus ? queue.findIndex((t) => t.id === focus.id) : -1;
  order = queue.map((_, i) => i);
  if (settings.shuffle && order.length > 1) {
    const rest = order.filter((i) => i !== idx);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    order = idx >= 0 ? [idx, ...rest] : rest;
    pos = idx >= 0 ? 0 : -1;
  } else {
    pos = Math.max(0, idx);
  }
}

function setQueue(list, track) {
  const clean = (list || []).filter((t) => t && t.id && t.audio_url);
  queue = clean.some((t) => t.id === track.id) ? clean.slice() : [track, ...clean];
  rebuildOrder(track);
}

function nextPos(manual) {
  if (!order.length) return -1;
  const p = pos + 1;
  if (p < order.length) return p;
  if (settings.repeat === 'all' || (manual && order.length > 1)) return 0;
  return -1;
}

function prevPos() {
  if (!order.length) return -1;
  const p = pos - 1;
  if (p >= 0) return p;
  return settings.repeat === 'all' || order.length > 1 ? order.length - 1 : 0;
}

const peekNext = () => {
  const p = nextPos(false);
  return p >= 0 ? queue[order[p]] : null;
};

async function fillQueue(track) {
  try {
    const data = await api.get('/api/tracks?sort=new&limit=40');
    const more = cacheTracks(data.tracks || []).filter((t) => t.id !== track.id);
    if (current && current.id === track.id && queue.length <= 1) {
      queue = [track, ...more];
      rebuildOrder();
    }
  } catch (_) {
    /* черга лишається з одного треку */
  }
}

async function goNext({ auto = false, fadeSec = null } = {}) {
  const p = nextPos(!auto);
  if (p < 0) {
    if (auto) {
      setPlaying(false);
      seekTo(0, { silent: true });
    }
    return false;
  }
  pos = p;
  const track = queue[order[p]];
  const cf = fadeSec !== null ? fadeSec : auto ? settings.crossfade : Math.min(settings.crossfade, 1.2);
  return startTrack(track, { fadeSec: cf });
}

async function goPrev() {
  if (position() > 3 || queue.length < 2) {
    seekTo(0);
    return;
  }
  const p = prevPos();
  if (p < 0) return;
  pos = p;
  await startTrack(queue[order[p]], { fadeSec: Math.min(settings.crossfade, 1.2) });
}

/* --------------------------- Події движка -------------------------------- */

function onTimeUpdate(deck) {
  if (deck !== decks[active] || !current) return;
  const cur = deck.el.currentTime;
  const dur = duration();
  const now = performance.now();

  if (playing && lastTick) {
    const delta = (now - lastTick) / 1000;
    if (delta < 1.5) listened += delta;
  }
  lastTick = now;
  if (!counted && listened >= 8) {
    counted = true;
    api.post(`/api/tracks/${current.id}/play`).catch(() => {});
    current.plays = (current.plays || 0) + 1;
  }

  if (document.hidden || !uiRaf) updateProgress();
  checkCommentBubble(cur);
  updateMediaPosition();
  saveLast(false);

  // Автоматичний кросфейд до наступного треку (у кімнаті — лише хост).
  if (playing && !fade && !isFollower() && dur > 0 && settings.crossfade > 0 && settings.repeat !== 'one') {
    const remain = dur - cur;
    if (remain > 0.2 && remain <= settings.crossfade + 0.15 && peekNext()) {
      goNext({ auto: true, fadeSec: Math.min(settings.crossfade, remain) });
    }
  }
}

function onEnded(deck) {
  if (deck !== decks[active] || switching) return;
  if (isFollower()) {
    setPlaying(false, { hook: true, room: false });
    return;
  }
  if (settings.repeat === 'one') {
    seekTo(0, { silent: true });
    deck.el.play().catch(() => {});
    return;
  }
  goNext({ auto: true, fadeSec: 0 });
}

function onError(deck) {
  if (deck !== decks[active] || !deck.track) return;
  errorStreak++;
  toast('Не вдалося завантажити трек', 'error');
  setPlaying(false, { hook: false });
  if (!isFollower() && errorStreak < 3 && peekNext()) setTimeout(() => goNext({ auto: true, fadeSec: 0 }), 700);
}

/* ------------------------- Відтворення (публічні) ------------------------ */

function setPlaying(v, { hook = true, room = true } = {}) {
  v = !!v;
  if (v === playing) return;
  playing = v;
  paintPlayState();
  if (hook && current) sendHook(v ? 'play' : 'pause');
  if (room) roomEmit(v ? 'play' : 'pause');
  emit('player:state', { playing: v });
  if (v) startUiLoop();
}

function paintPlayState() {
  const name = playing ? 'pause' : 'play';
  for (const id of ['miniPlay', 'npPlay']) {
    const btn = ui[id];
    if (!btn) continue;
    const holder = btn.querySelector('[data-icon]');
    setIcon(holder, name, id === 'npPlay' ? 30 : 22);
    btn.setAttribute('aria-label', playing ? 'Пауза' : 'Грати');
  }
  document.body.classList.toggle('player-playing', playing);
  if (viz) viz.setPlaying(playing);
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  setNowPlaying(current ? current.id : null, playing);
}

async function resume() {
  if (!current) return;
  ensureGraph();
  resumeCtx();
  const d = decks[active];
  if (!d.track) return;
  try {
    await d.el.play();
    setPlaying(true);
  } catch (err) {
    handlePlayError(err);
  }
}

function pause() {
  if (!current) return;
  finishFade();
  decks[active].el.pause();
  setPlaying(false);
}

async function toggle() {
  if (!current) return;
  if (isFollower()) {
    // Для слухача кнопка "грати" = синхронізуватись із кімнатою.
    if (playing) {
      pause();
      toast('Ви на паузі. Натисніть ▶, щоб повернутись до ефіру', 'info');
    } else {
      await resyncRoom();
    }
    return;
  }
  if (playing) pause();
  else await resume();
}

function seekTo(sec, { silent = false } = {}) {
  if (!current) return;
  const dur = duration();
  const t = clamp(sec, 0, dur > 0 ? Math.max(0, dur - 0.05) : Math.max(0, sec));
  try {
    decks[active].el.currentTime = t;
  } catch (_) {
    /* метадані ще не готові */
  }
  lastCommentCheck = -1;
  updateProgress();
  if (!silent) roomEmit('seek');
}

function seekGuarded(sec) {
  if (!guard()) return;
  seekTo(sec);
}

function seekBy(delta) {
  if (!current || !guard()) return;
  seekTo(position() + delta);
}

async function playTrack(track, list = null, { position: startPos = 0 } = {}) {
  if (!track || !guard()) return false;
  cacheTrack(track);
  ensureGraph();
  resumeCtx();
  if (current && current.id === track.id) {
    if (startPos > 0) {
      seekTo(startPos);
      if (!playing) await resume();
    } else {
      await toggle();
    }
    return true;
  }
  if (list && list.length) setQueue(list, track);
  else {
    setQueue([track], track);
    fillQueue(track);
  }
  return startTrack(track, { position: startPos, fadeSec: Math.min(settings.crossfade, 1.2) });
}

function toggleShuffle() {
  if (!guard()) return;
  saveSettings({ shuffle: !settings.shuffle });
  rebuildOrder();
  paintModes();
}

function cycleRepeat() {
  if (!guard()) return;
  const next = settings.repeat === 'off' ? 'all' : settings.repeat === 'all' ? 'one' : 'off';
  saveSettings({ repeat: next });
  paintModes();
}

function paintModes() {
  for (const id of ['miniShuffle', 'npShuffle']) ui[id] && ui[id].classList.toggle('active', !!settings.shuffle);
  for (const id of ['miniRepeat', 'npRepeat']) {
    const btn = ui[id];
    if (!btn) continue;
    btn.classList.toggle('active', settings.repeat !== 'off');
    setIcon(btn.querySelector('[data-icon]'), settings.repeat === 'one' ? 'repeat-one' : 'repeat', 20);
    btn.title = settings.repeat === 'one' ? 'Повтор: один трек' : settings.repeat === 'all' ? 'Повтор: усі' : 'Повтор вимкнено';
  }
}

/* -------------------------- Веб-хуки (Smart Home) ------------------------ */

function sendHook(event) {
  if (!current) return;
  const t = performance.now();
  if (hookLast.event === event && t - hookLast.t < 400) return;
  hookLast = { event, t };
  api
    .post('/api/player/event', {
      event,
      trackId: current.id,
      position: position(),
      roomId: roomMode ? roomMode.roomId : null,
      colors: getPalette(),
    })
    .catch(() => {});
}

/* ----------------------------- Live Room --------------------------------- */

function roomEmit(reason) {
  if (!isHost() || !current) return;
  roomMode.emit({ trackId: current.id, playing, position: position() }, reason);
}

function setRoomMode(mode) {
  roomMode = mode || null;
  const locked = isFollower();
  ui.player && ui.player.classList.toggle('locked', locked);
  ui.np && ui.np.classList.toggle('locked', locked);
  if (seekMini) seekMini.disabled = locked;
  if (seekNp) seekNp.disabled = locked;
  if (!roomMode) lastRoomState = null;
}

function getRoomState() {
  if (!current) return null;
  return { trackId: current.id, playing, position: position() };
}

async function getTrack(id) {
  const cached = trackCache.get(id);
  if (cached && cached.audio_url) return cached;
  const data = await api.get(`/api/tracks/${id}`);
  return cacheTrack(data.track);
}

async function doApplyRoomState(rs, reason) {
  if (!rs) return;
  if (!rs.trackId) {
    if (playing) pause();
    return;
  }
  const drift = rs.playing ? Math.max(0, Date.now() + roomOffset - rs.updatedAt) / 1000 : 0;
  const expected = rs.position + drift;
  if (!current || current.id !== rs.trackId) {
    const track = await getTrack(rs.trackId);
    setQueue([track], track);
    await startTrack(track, { position: expected, autoplay: !!rs.playing, fadeSec: 0.8, room: false });
    return;
  }
  const cur = position();
  if (rs.playing) {
    if (Math.abs(cur - expected) > 1.3 || reason === 'seek') seekTo(expected, { silent: true });
    if (!playing || decks[active].el.paused) {
      ensureGraph();
      resumeCtx();
      try {
        await decks[active].el.play();
        setPlaying(true, { room: false });
      } catch (err) {
        handlePlayError(err);
      }
    }
  } else {
    if (playing) {
      decks[active].el.pause();
      setPlaying(false, { room: false });
    }
    if (Math.abs(cur - expected) > 0.5) seekTo(expected, { silent: true });
  }
}

function applyRoomState(rs, offsetMs, reason) {
  if (typeof offsetMs === 'number') roomOffset = offsetMs;
  lastRoomState = rs;
  roomChain = roomChain.then(() => doApplyRoomState(rs, reason)).catch((err) => console.warn('[player] room sync', err));
  return roomChain;
}

function resyncRoom() {
  if (!lastRoomState) {
    toast('Кімната ще нічого не грає', 'info');
    return Promise.resolve();
  }
  return applyRoomState(lastRoomState, undefined, 'seek');
}

/* ------------------------------ Прогрес / UI ----------------------------- */

class Seek {
  constructor(root, { onSeek, onPreview }) {
    this.root = root;
    this.fill = $('.seek-fill', root);
    this.buffer = $('.seek-buffer', root);
    this.thumb = $('.seek-thumb', root);
    this.markersEl = $('.markers', root);
    this.onSeek = onSeek;
    this.onPreview = onPreview;
    this.duration = 0;
    this.dragging = false;
    this.disabled = false;
    this.value = 0;
    this.bind();
  }

  bind() {
    const root = this.root;
    root.addEventListener('pointerdown', (e) => {
      if (this.disabled) {
        guard();
        return;
      }
      if ((e.button !== undefined && e.button > 0) || !this.duration) return;
      this.dragging = true;
      try {
        root.setPointerCapture(e.pointerId);
      } catch (_) {
        /* ігноруємо */
      }
      root.classList.add('dragging');
      this.move(e);
    });
    root.addEventListener('pointermove', (e) => this.dragging && this.move(e));
    const end = (e, commit) => {
      if (!this.dragging) return;
      this.dragging = false;
      root.classList.remove('dragging');
      if (commit) {
        this.move(e);
        this.onSeek(this.value * this.duration);
      }
    };
    root.addEventListener('pointerup', (e) => end(e, true));
    root.addEventListener('pointercancel', (e) => end(e, false));
    root.addEventListener('keydown', (e) => {
      if (!this.duration) return;
      const cur = this.value * this.duration;
      let t = null;
      const step = e.shiftKey ? 15 : 5;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') t = cur - step;
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') t = cur + step;
      else if (e.key === 'Home') t = 0;
      else if (e.key === 'End') t = this.duration - 0.5;
      if (t === null) return;
      e.preventDefault();
      e.stopPropagation();
      this.onSeek(clamp(t, 0, this.duration));
    });
  }

  move(e) {
    const rect = this.root.getBoundingClientRect();
    const r = clamp((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    this.render(r);
    if (this.onPreview) this.onPreview(r * this.duration);
  }

  render(ratio) {
    this.value = ratio;
    const pct = `${(ratio * 100).toFixed(3)}%`;
    this.fill.style.width = pct;
    this.thumb.style.left = pct;
  }

  set(time, dur) {
    this.duration = dur || 0;
    if (this.dragging) return;
    const r = dur > 0 ? clamp(time / dur, 0, 1) : 0;
    this.render(r);
    this.root.setAttribute('aria-valuenow', String(Math.round(r * 100)));
    this.root.setAttribute('aria-valuetext', `${fmtTime(time)} з ${fmtTime(dur)}`);
  }

  setBuffered(ratio) {
    this.buffer.style.width = `${clamp(ratio, 0, 1) * 100}%`;
  }

  setMarkers(comments, dur, onClick) {
    this.markersEl.replaceChildren();
    if (!dur || !comments.length) return;
    const buckets = new Map();
    for (const c of comments) {
      const r = clamp(c.time / dur, 0, 1);
      const key = Math.round(r * 120);
      const b = buckets.get(key);
      if (b) b.n++;
      else buckets.set(key, { c, n: 1, r });
    }
    const frag = document.createDocumentFragment();
    for (const { c, n, r } of buckets.values()) {
      const m = el(
        'button',
        {
          class: `marker ${n > 1 ? 'multi' : ''}`.trim(),
          type: 'button',
          style: { left: `${r * 100}%` },
          title: `${c.username} @ ${fmtTime(c.time)}: ${c.text}${n > 1 ? ` (ще ${n - 1})` : ''}`,
          'aria-label': `Коментар ${c.username} на ${fmtTime(c.time)}`,
        },
        el('i', {}, initials(c.username))
      );
      m.addEventListener('pointerdown', (e) => e.stopPropagation());
      m.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick(c);
      });
      frag.append(m);
    }
    this.markersEl.append(frag);
  }
}

function updateProgress() {
  const cur = position();
  const dur = duration();
  if (seekMini) seekMini.set(cur, dur);
  if (seekNp) seekNp.set(cur, dur);
  const curText = fmtTime(cur);
  const durText = dur ? fmtTime(dur) : '0:00';
  if (ui.miniCur.textContent !== curText) ui.miniCur.textContent = curText;
  if (ui.npCur.textContent !== curText && !(seekNp && seekNp.dragging)) ui.npCur.textContent = curText;
  if (ui.miniDur.textContent !== durText) ui.miniDur.textContent = durText;
  if (ui.npDur.textContent !== durText) ui.npDur.textContent = durText;
  const bar = ui.miniProgress && ui.miniProgress.firstElementChild;
  if (bar) bar.style.width = `${dur > 0 ? clamp(cur / dur, 0, 1) * 100 : 0}%`;
  const whole = Math.floor(cur);
  if (whole !== lastWhole) {
    lastWhole = whole;
    if (commentsUi && commentsUi.composer && !ui.npCompose.contains(document.activeElement)) commentsUi.composer.refreshTime();
  }
}

function updateBuffered() {
  const d = decks[active].el;
  const dur = duration();
  if (!dur || !d.buffered || !d.buffered.length) return;
  const cur = d.currentTime;
  let end = 0;
  for (let i = 0; i < d.buffered.length; i++) {
    if (d.buffered.start(i) <= cur + 0.5 && d.buffered.end(i) >= end) end = d.buffered.end(i);
  }
  const r = end / dur;
  seekMini && seekMini.setBuffered(r);
  seekNp && seekNp.setBuffered(r);
}

function startUiLoop() {
  if (uiRaf) return;
  const loop = () => {
    if (!playing || document.hidden) {
      uiRaf = 0;
      return;
    }
    updateProgress();
    uiRaf = requestAnimationFrame(loop);
  };
  uiRaf = requestAnimationFrame(loop);
}

function renderMarkers() {
  const comments = current ? getComments(current.id) : [];
  const dur = duration();
  const click = (c) => {
    if (guard()) seekTo(c.time);
    showBubble(c);
  };
  seekMini && seekMini.setMarkers(comments, dur, click);
  seekNp && seekNp.setMarkers(comments, dur, click);
}

function showBubble(c) {
  if (!settings.bubbles || !ui.npBubble) return;
  ui.npBubble.replaceChildren(el('b', {}, c.username), el('span', {}, c.text));
  ui.npBubble.hidden = false;
  ui.npBubble.classList.remove('pop');
  void ui.npBubble.offsetWidth;
  ui.npBubble.classList.add('pop');
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => {
    ui.npBubble.hidden = true;
  }, 4200);
}

function checkCommentBubble(cur) {
  if (!current || !npOpen || !playing) {
    lastCommentCheck = cur;
    return;
  }
  const prev = lastCommentCheck;
  lastCommentCheck = cur;
  if (prev < 0 || cur < prev || cur - prev > 1.6) return;
  const hit = getComments(current.id).find((c) => c.time > prev && c.time <= cur);
  if (hit) showBubble(hit);
}

/* ----------------------- Відмальовування треку --------------------------- */

function renderTrackUI(track, prevId) {
  ui.player.hidden = false;
  document.body.classList.add('has-player');

  setCover(ui.miniCover, track);
  setCover(ui.npCover, track);
  ui.npCoverWrap.classList.remove('swap');
  void ui.npCoverWrap.offsetWidth;
  ui.npCoverWrap.classList.add('swap');
  ui.miniTitle.textContent = track.title;
  ui.miniArtist.textContent = track.artist || (track.generator ? `ШІ · ${track.generator}` : 'ШІ-музика');
  ui.npTitle.textContent = track.title;
  ui.npArtist.textContent = track.artist || (track.generator ? `ШІ · ${track.generator}` : 'ШІ-музика');
  if (track.artist) ui.npArtist.setAttribute('href', `/?q=${encodeURIComponent(track.artist)}`);
  else ui.npArtist.removeAttribute('href');
  ui.miniLikeSlot.replaceChildren(likeButton(track, { showCount: false }));
  ui.npLikeSlot.replaceChildren(likeButton(track));
  ui.npBubble.hidden = true;

  const hasPrompt = !!(track.ai_prompt || track.generator || track.ai_model || track.lyrics);
  ui.miniPrompt.disabled = !hasPrompt;
  ui.npPrompt.disabled = !hasPrompt;

  if (prevId !== track.id) {
    if (prevId) unwatchTrack(prevId);
    watchTrack(track.id);
  }
  buildCommentsPanel(track);
  loadComments(track.id)
    .then(renderMarkers)
    .catch(() => {});
  renderMarkers();
  updateProgress();
  setNowPlaying(track.id, playing);
  updateMediaMetadata(track);

  paletteFor(track).then((palette) => {
    if (current && current.id === track.id) applyAmbient(palette);
  });
  emit('player:track', { track });
}

function buildCommentsPanel(track) {
  if (commentsUi) {
    commentsUi.list.destroy();
    commentsUi = null;
  }
  const composer = commentComposer({
    getTrackId: () => (current ? current.id : track.id),
    getTime: () => position(),
    compact: true,
  });
  const list = commentList(track.id, {
    compact: true,
    onSeek: (t) => seekGuarded(t),
  });
  commentsUi = { composer, list };
  ui.npCompose.replaceChildren(el('h4', { class: 'np-section' }, ic('comment', 16), 'Коментарі таймлайна'), composer, list.el);
}

/* ---------------------------- Media Session ------------------------------ */

function updateMediaMetadata(track) {
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined' || !track) return;
  const artwork = track.cover_url
    ? [{ src: new URL(track.cover_url, location.href).href, sizes: '512x512', type: mimeForImage(track.cover_url) }]
    : [
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      ];
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist || (track.generator ? `ШІ · ${track.generator}` : 'ШІ-музика'),
      album: track.genre || state.site.siteName || 'AI Waves',
      artwork,
    });
  } catch (_) {
    /* неповна підтримка */
  }
}

function updateMediaPosition() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  const now = Date.now();
  if (now - lastMsPosition < 1000) return;
  lastMsPosition = now;
  const dur = duration();
  if (!dur) return;
  try {
    navigator.mediaSession.setPositionState({ duration: dur, position: clamp(position(), 0, dur), playbackRate: 1 });
  } catch (_) {
    /* некоректні значення */
  }
}

function bindMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const set = (action, fn) => {
    try {
      navigator.mediaSession.setActionHandler(action, fn);
    } catch (_) {
      /* дія не підтримується */
    }
  };
  set('play', () => (isFollower() ? resyncRoom() : resume()));
  set('pause', () => pause());
  set('previoustrack', () => guard() && goPrev());
  set('nexttrack', () => guard() && goNext());
  set('seekbackward', (d) => seekBy(-(d && d.seekOffset ? d.seekOffset : 10)));
  set('seekforward', (d) => seekBy(d && d.seekOffset ? d.seekOffset : 10));
  set('seekto', (d) => d && typeof d.seekTime === 'number' && seekGuarded(d.seekTime));
  set('stop', () => pause());
}

/* ------------------------- Повноекранний плеєр --------------------------- */

function openNP({ push = true } = {}) {
  if (!current || npOpen) return;
  npOpen = true;
  ui.np.classList.add('open');
  ui.np.setAttribute('aria-hidden', 'false');
  document.body.classList.add('np-open');
  if (push) history.pushState({ np: true }, '');
  viz.start();
  updateProgress();
  renderMarkers();
  ui.npClose.focus({ preventScroll: true });
  emit('np:toggle', { open: true });
}

function closeNP({ fromPop = false } = {}) {
  if (!npOpen) return;
  npOpen = false;
  ui.np.classList.remove('open');
  ui.np.style.transform = '';
  ui.np.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('np-open');
  viz.stop();
  if (!fromPop && history.state && history.state.np) history.back();
  emit('np:toggle', { open: false });
}

/* ------------------------------- Жести ----------------------------------- */

function swipeable(node, { onLeft, onRight, onUp, onDown, onDrag, canDown, ignore, threshold = 70 }) {
  let sx = 0;
  let sy = 0;
  let dx = 0;
  let dy = 0;
  let tracking = false;
  let axis = null;
  let moved = false;
  let blockClickUntil = 0;

  node.addEventListener(
    'click',
    (e) => {
      if (Date.now() < blockClickUntil) {
        e.stopPropagation();
        e.preventDefault();
      }
    },
    true
  );
  node.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1 || (ignore && ignore(e.target))) return;
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
      dx = 0;
      dy = 0;
      tracking = true;
      axis = null;
      moved = false;
    },
    { passive: true }
  );
  node.addEventListener(
    'touchmove',
    (e) => {
      if (!tracking) return;
      dx = e.touches[0].clientX - sx;
      dy = e.touches[0].clientY - sy;
      if (!axis) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        axis = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y';
      }
      const allowX = axis === 'x' && (onLeft || onRight);
      const allowDown = axis === 'y' && dy > 0 && onDown && (!canDown || canDown());
      const allowUp = axis === 'y' && dy < 0 && onUp;
      if (!(allowX || allowDown || allowUp)) {
        tracking = false;
        return;
      }
      moved = true;
      if (e.cancelable) e.preventDefault();
      if (onDrag) onDrag(axis, axis === 'x' ? dx : dy, false);
    },
    { passive: false }
  );
  const finish = (cancelled) => {
    if (!tracking) return;
    tracking = false;
    if (!moved) return;
    blockClickUntil = Date.now() + 350;
    let fired = false;
    if (!cancelled) {
      if (axis === 'x' && dx <= -threshold && onLeft) {
        onLeft();
        fired = true;
      } else if (axis === 'x' && dx >= threshold && onRight) {
        onRight();
        fired = true;
      } else if (axis === 'y' && dy >= threshold * 1.3 && onDown) {
        onDown();
        fired = true;
      } else if (axis === 'y' && dy <= -threshold * 0.8 && onUp) {
        onUp();
        fired = true;
      }
    }
    if (onDrag) onDrag(axis, 0, true, fired);
  };
  node.addEventListener('touchend', () => finish(false), { passive: true });
  node.addEventListener('touchcancel', () => finish(true), { passive: true });
}

function bindGestures() {
  // Міні-плеєр: свайп вгору — розгорнути, вліво/вправо — наступний/попередній.
  const miniMain = ui.player.querySelector('.mini-main');
  swipeable(miniMain, {
    ignore: (t) => !!(t.closest && t.closest('.seek, .volume, input')),
    onUp: () => openNP(),
    onLeft: () => guard() && goNext(),
    onRight: () => guard() && goPrev(),
    onDrag: (axis, delta, end) => {
      ui.miniInfo.style.transition = end ? 'transform .25s ease' : 'none';
      ui.miniInfo.style.transform = !end && axis === 'x' ? `translateX(${clamp(delta, -90, 90)}px)` : '';
    },
  });

  // Повноекранний: свайп вниз — закрити (з обкладинки/верхньої панелі), вліво/вправо — трек.
  const cover = ui.npCoverWrap;
  swipeable(cover, {
    onLeft: () => guard() && goNext(),
    onRight: () => guard() && goPrev(),
    onDown: () => closeNP(),
    canDown: () => ui.npBody.scrollTop <= 0,
    onDrag: (axis, delta, end) => {
      if (end) {
        cover.style.transition = 'transform .28s cubic-bezier(.2,.8,.2,1)';
        cover.style.transform = '';
        ui.np.style.transition = 'transform .28s cubic-bezier(.2,.8,.2,1)';
        ui.np.style.transform = '';
        return;
      }
      cover.style.transition = 'none';
      ui.np.style.transition = 'none';
      if (axis === 'x') cover.style.transform = `translateX(${clamp(delta, -140, 140)}px) rotate(${clamp(delta / 24, -6, 6)}deg)`;
      else ui.np.style.transform = `translateY(${Math.max(0, delta * 0.8)}px)`;
    },
  });
  swipeable(ui.npTop, {
    onDown: () => closeNP(),
    onDrag: (axis, delta, end) => {
      ui.np.style.transition = end ? 'transform .28s cubic-bezier(.2,.8,.2,1)' : 'none';
      ui.np.style.transform = end ? '' : `translateY(${Math.max(0, delta * 0.8)}px)`;
    },
  });
}

/* ------------------------------- Хоткеї ---------------------------------- */

function bindHotkeys() {
  const typing = (t) => !!(t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]'));
  const clickable = (t) => !!(t && t.closest && t.closest('button, a[href], summary, [role="button"]'));

  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (typing(e.target) || document.body.classList.contains('modal-open')) return;
    if (e.code === 'Escape' && npOpen) {
      e.preventDefault();
      closeNP();
      return;
    }
    if (!current) return;
    switch (e.code) {
      case 'Space':
        if (clickable(e.target)) return;
        e.preventDefault();
        toggle();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        seekBy(-5);
        break;
      case 'ArrowRight':
        e.preventDefault();
        seekBy(5);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setVolume(settings.volume + 0.05);
        break;
      case 'ArrowDown':
        e.preventDefault();
        setVolume(settings.volume - 0.05);
        break;
      case 'KeyM':
        toggleMute();
        break;
      case 'KeyN':
        guard() && goNext();
        break;
      case 'KeyP':
        guard() && goPrev();
        break;
      default:
    }
  });

  // Після кліку мишею знімаємо фокус із кнопок, щоб Пробіл керував плеєром, а не "натискав" кнопку знову.
  document.addEventListener('click', (e) => {
    if (e.detail === 0) return;
    const btn = e.target.closest && e.target.closest('button');
    if (btn && !btn.matches('input')) btn.blur();
  });
}

/* ------------------------------ Гучність --------------------------------- */

function setVolume(v) {
  const vol = clamp(Math.round(v * 100) / 100, 0, 1);
  muted = vol === 0;
  saveSettings({ volume: vol });
  ui.miniVolume.value = String(vol);
  applyMaster();
  paintVolume();
}

function toggleMute() {
  muted = !muted;
  if (!muted && settings.volume === 0) saveSettings({ volume: 0.6 });
  applyMaster();
  paintVolume();
}

function paintVolume() {
  ui.miniVolume.value = String(muted ? 0 : settings.volume);
  setIcon(ui.miniMute.querySelector('[data-icon]'), muted || settings.volume === 0 ? 'volume-x' : 'volume', 18);
}

/* --------------------------- Збереження позиції -------------------------- */

function saveLast(force) {
  const now = Date.now();
  if (!force && now - lastSave < 5000) return;
  lastSave = now;
  if (!current || isFollower()) return;
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify({ id: current.id, pos: Math.floor(position()) }));
  } catch (_) {
    /* ігноруємо */
  }
}

async function restoreLast() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(LAST_KEY) || 'null');
  } catch (_) {
    saved = null;
  }
  if (!saved || !saved.id || current) return;
  try {
    const data = await api.get(`/api/tracks/${saved.id}`);
    if (current) return;
    const track = cacheTrack(data.track);
    setQueue([track], track);
    await startTrack(track, { position: saved.pos || 0, autoplay: false, room: false });
    decks[active].el.preload = 'metadata';
    fillQueue(track);
  } catch (_) {
    try {
      localStorage.removeItem(LAST_KEY);
    } catch (__) {
      /* ігноруємо */
    }
  }
}

/* -------------------------------- Init ----------------------------------- */

function init() {
  if (initialized) return;
  initialized = true;
  const ids = [
    'player', 'miniProgress', 'miniInfo', 'miniCover', 'miniTitle', 'miniArtist', 'miniShuffle', 'miniPrev', 'miniPlay',
    'miniNext', 'miniRepeat', 'miniSeek', 'miniCur', 'miniDur', 'miniPrompt', 'miniLikeSlot', 'miniMute', 'miniVolume',
    'miniExpand', 'np', 'npTop', 'npClose', 'npCoverWrap', 'npCover', 'npBubble', 'viz', 'npTitle', 'npArtist',
    'npLikeSlot', 'npPrompt', 'npSeek', 'npCur', 'npDur', 'npShuffle', 'npPrev', 'npPlay', 'npNext', 'npRepeat',
    'npCompose', 'npSettings',
  ];
  for (const id of ids) ui[id] = document.getElementById(id);
  ui.npBody = $('.np-body', ui.np);

  decks.push(createDeck(0), createDeck(1));

  viz = new Visualizer(ui.viz, { getPalette });
  seekMini = new Seek(ui.miniSeek, {
    onSeek: seekGuarded,
    onPreview: (t) => (ui.miniCur.textContent = fmtTime(t)),
  });
  seekNp = new Seek(ui.npSeek, {
    onSeek: seekGuarded,
    onPreview: (t) => (ui.npCur.textContent = fmtTime(t)),
  });

  for (const id of ['miniPrev', 'miniNext', 'miniShuffle', 'miniRepeat', 'npPrev', 'npNext', 'npShuffle', 'npRepeat']) {
    ui[id].classList.add('lockable');
  }

  ui.miniPlay.addEventListener('click', toggle);
  ui.npPlay.addEventListener('click', toggle);
  ui.miniNext.addEventListener('click', () => guard() && goNext());
  ui.npNext.addEventListener('click', () => guard() && goNext());
  ui.miniPrev.addEventListener('click', () => guard() && goPrev());
  ui.npPrev.addEventListener('click', () => guard() && goPrev());
  ui.miniShuffle.addEventListener('click', toggleShuffle);
  ui.npShuffle.addEventListener('click', toggleShuffle);
  ui.miniRepeat.addEventListener('click', cycleRepeat);
  ui.npRepeat.addEventListener('click', cycleRepeat);
  ui.miniInfo.addEventListener('click', () => openNP());
  ui.miniExpand.addEventListener('click', () => openNP());
  ui.npClose.addEventListener('click', () => closeNP());
  ui.miniPrompt.addEventListener('click', () => promptModal(current));
  ui.npPrompt.addEventListener('click', () => promptModal(current));
  ui.npSettings.addEventListener('click', () => emit('open:settings'));
  ui.miniMute.addEventListener('click', toggleMute);
  ui.miniVolume.value = String(settings.volume);
  ui.miniVolume.addEventListener('input', () => setVolume(parseFloat(ui.miniVolume.value)));

  window.addEventListener('popstate', (e) => {
    if (npOpen && !(e.state && e.state.np)) closeNP({ fromPop: true });
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      resumeCtx();
      if (playing) startUiLoop();
    }
  });

  // Створюємо Web Audio лише після першого жесту користувача (політика автовідтворення).
  const unlock = () => {
    ensureGraph();
    resumeCtx();
    if (engine.ctx && engine.ctx.state === 'running') {
      ['pointerdown', 'keydown', 'touchend'].forEach((n) => document.removeEventListener(n, unlock, true));
    }
  };
  ['pointerdown', 'keydown', 'touchend'].forEach((n) => document.addEventListener(n, unlock, true));

  on('settings', () => {
    applyMaster();
    paintModes();
  });
  on('comments:changed', (d) => {
    if (current && d.trackId === current.id) renderMarkers();
  });
  on('auth', async () => {
    if (!current) return;
    try {
      const data = await api.get(`/api/tracks/${current.id}`);
      const t = cacheTrack(data.track);
      current = t;
      ui.miniLikeSlot.replaceChildren(likeButton(t, { showCount: false }));
      ui.npLikeSlot.replaceChildren(likeButton(t));
    } catch (_) {
      /* трек міг стати недоступним */
    }
  });

  bindMediaSession();
  bindHotkeys();
  bindGestures();
  paintModes();
  paintVolume();
  paintPlayState();
  hydrateIcons(ui.player);
  hydrateIcons(ui.np);
  if ('audioSession' in navigator) {
    try {
      navigator.audioSession.type = 'playback';
    } catch (_) {
      /* Safari <16.4 */
    }
  }
  restoreLast();
}

export const player = {
  init,
  play: playTrack,
  toggle,
  pause,
  resume,
  seek: seekGuarded,
  next: () => guard() && goNext(),
  prev: () => guard() && goPrev(),
  openFull: openNP,
  closeFull: closeNP,
  setRoomMode,
  applyRoomState,
  getRoomState,
  resyncRoom,
  get current() {
    return current;
  },
  get playing() {
    return playing;
  },
  get position() {
    return position();
  },
  get duration() {
    return duration();
  },
  get role() {
    return roomMode ? roomMode.role : null;
  },
  get analyser() {
    return engine.analyser;
  },
};
