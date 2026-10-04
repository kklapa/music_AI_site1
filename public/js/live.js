/*
 * Live Listen Room (клієнт): socket.io-кімната, синхронізація плеєра,
 * чат і плаваючі емодзі-реакції над обкладинкою.
 */

import { state, emit, on } from './state.js';
import { getSocket, whenConnected } from './socket.js';
import { player } from './player.js';
import { el, toast, hashString, hslToHex, initials, reducedMotion } from './util.js';
import { ic } from './ui.js';

export const REACTIONS = ['❤️', '🔥', '😍', '🎉', '👏', '😮', '🤯', '💜', '✨', '🙌'];

export const room = {
  id: null,
  info: null,
  isHost: false,
  isOwner: false,
  hostId: null,
  selfId: null,
  members: [],
  chat: [],
  connected: true,
  offset: 0,
};

let tickTimer = 0;
let npChat = null;
let npReactFor = null;
let initialized = false;

/* ------------------------------ Допоміжне -------------------------------- */

function emitAck(event, payload, ms = 6000) {
  const s = getSocket();
  return new Promise((resolve) => {
    if (!s) return resolve({ ok: false, error: 'Немає з’єднання з сервером' });
    s.timeout(ms).emit(event, payload, (err, res) => {
      if (err) resolve({ ok: false, error: 'Сервер не відповів. Спробуйте ще раз' });
      else resolve(res || { ok: false, error: 'Порожня відповідь сервера' });
    });
  });
}

/** Різниця годинників клієнт↔сервер за найменшим RTT з кількох вимірів. */
async function syncClock() {
  const s = getSocket();
  if (!s) return;
  let best = null;
  for (let i = 0; i < 4; i++) {
    const t0 = performance.now();
    const server = await new Promise((resolve) => {
      s.timeout(2000).emit('time:sync', (err, value) => resolve(err ? null : value));
    });
    if (server === null) continue;
    const rtt = performance.now() - t0;
    const offset = server + rtt / 2 - Date.now();
    if (!best || rtt < best.rtt) best = { rtt, offset };
  }
  if (best) room.offset = best.offset;
}

function controlEmitter() {
  return (st, reason) => {
    const s = getSocket();
    if (s && s.connected && room.id) s.emit('room:control', { state: st, reason });
  };
}

function startTick() {
  stopTick();
  tickTimer = setInterval(() => {
    if (!room.isHost || !player.playing) return;
    const st = player.getRoomState();
    if (st) controlEmitter()(st, 'tick');
  }, 4000);
}

function stopTick() {
  clearInterval(tickTimer);
  tickTimer = 0;
}

function setRole(isHost, serverState) {
  room.isHost = isHost;
  player.setRoomMode({ role: isHost ? 'host' : 'follower', roomId: room.id, emit: controlEmitter() });
  if (isHost) {
    startTick();
    if (player.current) {
      const st = player.getRoomState();
      if (st) controlEmitter()(st, 'track');
    } else if (serverState && serverState.trackId) {
      player.applyRoomState(serverState, room.offset);
    }
  } else {
    stopTick();
    if (serverState && serverState.trackId) player.applyRoomState(serverState, room.offset);
    else if (!serverState) player.resyncRoom();
  }
  emit('live:changed');
}

function applyJoin(res) {
  room.id = res.room.id;
  room.info = res.room;
  room.selfId = res.selfId;
  room.hostId = res.hostId;
  room.members = res.members || [];
  room.chat = res.chat || [];
  room.isOwner = !!res.isOwner;
  room.connected = true;
  syncClock().then(() => setRole(!!res.isHost, res.state));
  emit('live:changed');
}

function resetRoom() {
  stopTick();
  player.setRoomMode(null);
  Object.assign(room, { id: null, info: null, isHost: false, isOwner: false, hostId: null, selfId: null, members: [], chat: [], offset: 0 });
  emit('live:reset');
  emit('live:changed');
}

/* ------------------------------ Публічне API ----------------------------- */

export async function joinRoom(id) {
  id = String(id || '').toLowerCase();
  if (!getSocket()) return { ok: false, error: 'Немає з’єднання з сервером' };
  if (!(await whenConnected())) return { ok: false, error: 'Не вдалося підключитися до сервера' };
  if (room.id === id) return { ok: true, already: true };
  if (room.id) leaveRoom();
  const res = await emitAck('room:join', { roomId: id });
  if (!res.ok) return res;
  applyJoin(res);
  return { ok: true };
}

export function leaveRoom() {
  const s = getSocket();
  if (s && room.id) s.emit('room:leave');
  resetRoom();
}

export function closeRoom() {
  const s = getSocket();
  if (s && room.id) s.emit('room:close');
}

export function sendChat(text) {
  const s = getSocket();
  if (s && room.id && text) s.emit('room:chat', { text });
}

export function sendReaction(emoji) {
  const s = getSocket();
  if (s && room.id && REACTIONS.includes(emoji)) s.emit('room:reaction', { emoji });
}

/* ------------------------- Реакції та чат (UI) --------------------------- */

export function floatEmoji(layer, emoji, name) {
  if (!layer || layer.childElementCount > 40) return;
  const node = el('span', { class: 'float-emoji', title: name || '' }, emoji);
  node.style.left = `${8 + Math.random() * 84}%`;
  node.style.setProperty('--dx', `${Math.round((Math.random() * 2 - 1) * 46)}px`);
  node.style.setProperty('--rot', `${Math.round((Math.random() * 2 - 1) * 24)}deg`);
  node.style.setProperty('--dur', `${(reducedMotion() ? 1.2 : 2.2 + Math.random() * 1.2).toFixed(2)}s`);
  node.addEventListener('animationend', () => node.remove());
  layer.append(node);
}

function nameColor(name) {
  return hslToHex(hashString(String(name)) % 360, 80, 68);
}

function messageNode(m) {
  const mine = state.user && m.userId && m.userId === state.user.id;
  return el(
    'li',
    { class: `chat-msg ${mine ? 'mine' : ''}`.trim() },
    el('b', { style: { color: nameColor(m.name) } }, m.name),
    el('span', {}, m.text)
  );
}

/** Панель чату (журнал + форма). Повертає { el, destroy }. */
export function chatPanel({ compact = false } = {}) {
  const log = el('ul', { class: 'chat-log', 'aria-live': 'polite' });
  const input = el('input', {
    class: 'input',
    type: 'text',
    maxlength: '300',
    placeholder: 'Повідомлення в чат…',
    autocomplete: 'off',
    enterkeyhint: 'send',
  });
  input.addEventListener('keydown', (e) => e.stopPropagation());
  const form = el('form', { class: 'chat-form' }, input, el('button', { class: 'btn-icon', type: 'submit', 'aria-label': 'Надіслати' }, ic('send', 18)));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    sendChat(text);
    input.value = '';
  });
  const wrap = el('div', { class: `chat ${compact ? 'compact' : ''}`.trim() }, log, form);

  const add = (m) => {
    log.append(messageNode(m));
    while (log.childElementCount > 100) log.firstElementChild.remove();
    log.scrollTop = log.scrollHeight;
  };
  room.chat.forEach(add);
  const offs = [on('live:chat', add), on('live:reset', () => log.replaceChildren())];
  return { el: wrap, destroy: () => offs.forEach((off) => off()) };
}

export function reactionBar() {
  return el(
    'div',
    { class: 'react-bar', role: 'group', 'aria-label': 'Реакції' },
    REACTIONS.slice(0, 7).map((emoji) =>
      el('button', { class: 'react-btn', type: 'button', 'aria-label': `Реакція ${emoji}`, onclick: () => sendReaction(emoji) }, emoji)
    )
  );
}

/* --------------------- Глобальні елементи інтерфейсу --------------------- */

function paintGlobal() {
  const pill = document.getElementById('roomPill');
  const pillText = document.getElementById('roomPillText');
  const badge = document.getElementById('npRoomBadge');
  const badgeText = document.getElementById('npRoomBadgeText');
  const react = document.getElementById('npReact');
  const inRoom = !!room.id;

  if (pill) {
    pill.hidden = !inRoom;
    if (inRoom) {
      pill.setAttribute('href', `/room/${room.id}`);
      pillText.textContent = `${room.info ? room.info.name : 'Кімната'} · ${room.members.length}`;
      pill.classList.toggle('offline', !room.connected);
    }
  }
  if (badge) {
    badge.hidden = !inRoom;
    if (inRoom) badgeText.textContent = room.isHost ? `Ви хост · ${room.members.length}` : `У кімнаті · ${room.members.length}`;
  }
  if (react) {
    react.hidden = !inRoom;
    if (inRoom && npReactFor !== room.id) {
      if (npChat) npChat.destroy();
      npChat = chatPanel({ compact: true });
      react.replaceChildren(reactionBar(), npChat.el);
      npReactFor = room.id;
    } else if (!inRoom && npChat) {
      npChat.destroy();
      npChat = null;
      npReactFor = null;
      react.replaceChildren();
    }
  }
}

function updateHost(hostId, serverState) {
  if (!room.id) return;
  room.hostId = hostId;
  const amHost = hostId === room.selfId;
  if (amHost !== room.isHost) {
    if (amHost) toast('Тепер ви хост кімнати — слухачі йдуть за вашим плеєром', 'success', 4500);
    setRole(amHost, amHost ? serverState : null);
  }
}

export function initLive() {
  if (initialized) return;
  initialized = true;
  const s = getSocket();
  if (!s) return;

  s.on('room:state', (d) => {
    if (!room.id || room.isHost || !d || !d.state) return;
    player.applyRoomState(d.state, undefined, d.reason);
  });
  s.on('room:host', (d) => updateHost(d.hostId, d.state));
  s.on('room:members', (d) => {
    if (!room.id) return;
    room.members = d.members || [];
    updateHost(d.hostId, null);
    emit('live:changed');
  });
  s.on('room:chat', (m) => {
    if (!room.id) return;
    room.chat.push(m);
    if (room.chat.length > 100) room.chat.shift();
    emit('live:chat', m);
  });
  s.on('room:reaction', (d) => {
    if (!room.id) return;
    document.querySelectorAll('.react-layer').forEach((layer) => {
      if (layer.offsetParent !== null) floatEmoji(layer, d.emoji, d.name);
    });
    emit('live:reaction', d);
  });
  s.on('room:closed', (d) => {
    if (!room.id) return;
    toast((d && d.reason) || 'Кімнату закрито', 'info', 4500);
    resetRoom();
    emit('live:closed');
  });
  s.on('disconnect', () => {
    if (!room.id) return;
    room.connected = false;
    emit('live:changed');
  });
  s.on('connect', async () => {
    if (!room.id) return;
    const id = room.id;
    const res = await emitAck('room:join', { roomId: id });
    if (res.ok) {
      applyJoin(res);
    } else {
      toast(res.error || 'Кімнату закрито', 'info');
      resetRoom();
      emit('live:closed');
    }
  });

  on('live:changed', paintGlobal);
  document.getElementById('npRoomBadge')?.addEventListener('click', () => {
    if (room.id) emit('navigate', { to: `/room/${room.id}` });
  });
  paintGlobal();
}
