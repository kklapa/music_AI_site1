/* Сховище коментарів таймлайна + live-оновлення через socket.io. */

import { api } from './api.js';
import { emit } from './state.js';
import { getSocket } from './socket.js';

const store = new Map(); // trackId -> comment[]
const watching = new Map(); // trackId -> лічильник підписок
const inflight = new Map();
let bound = false;

function sortComments(list) {
  list.sort((a, b) => a.time - b.time || a.id - b.id);
}

function upsert(comment) {
  if (!comment || !comment.track_id) return;
  const list = store.get(comment.track_id) || [];
  const i = list.findIndex((c) => c.id === comment.id);
  if (i >= 0) list[i] = comment;
  else list.push(comment);
  sortComments(list);
  store.set(comment.track_id, list);
  emit('comments:changed', { trackId: comment.track_id });
}

function remove(id, trackId) {
  const list = store.get(trackId);
  if (!list) return;
  const next = list.filter((c) => c.id !== id);
  store.set(trackId, next);
  emit('comments:changed', { trackId });
}

function bindSocket() {
  const s = getSocket();
  if (!s || bound) return;
  bound = true;
  s.on('comment:new', upsert);
  s.on('comment:updated', upsert);
  s.on('comment:deleted', (d) => remove(d.id, d.track_id));
  s.on('connect', () => {
    // Після перепідключення сервер уже забув підписки — відновлюємо та підтягуємо пропущене.
    for (const id of watching.keys()) {
      s.emit('track:watch', { trackId: id });
      loadComments(id, true).catch(() => {});
    }
  });
}

export function getComments(trackId) {
  return store.get(trackId) || [];
}

export function hasLoaded(trackId) {
  return store.has(trackId);
}

export async function loadComments(trackId, force = false) {
  if (!trackId) return [];
  if (!force && store.has(trackId)) return store.get(trackId);
  if (inflight.has(trackId)) return inflight.get(trackId);
  const p = api
    .get(`/api/tracks/${trackId}/comments`)
    .then((data) => {
      store.set(trackId, data.comments || []);
      emit('comments:changed', { trackId });
      return store.get(trackId);
    })
    .finally(() => inflight.delete(trackId));
  inflight.set(trackId, p);
  return p;
}

export function watchTrack(trackId) {
  if (!trackId) return;
  bindSocket();
  const n = (watching.get(trackId) || 0) + 1;
  watching.set(trackId, n);
  if (n === 1) {
    const s = getSocket();
    if (s && s.connected) s.emit('track:watch', { trackId });
  }
}

export function unwatchTrack(trackId) {
  if (!trackId || !watching.has(trackId)) return;
  const n = watching.get(trackId) - 1;
  if (n > 0) {
    watching.set(trackId, n);
    return;
  }
  watching.delete(trackId);
  const s = getSocket();
  if (s && s.connected) s.emit('track:unwatch', { trackId });
}

export async function postComment(trackId, text, time) {
  const data = await api.post(`/api/tracks/${trackId}/comments`, { text, time });
  upsert(data.comment);
  return data.comment;
}

export async function editComment(comment, text) {
  const data = await api.put(`/api/comments/${comment.id}`, { text });
  upsert(data.comment);
  return data.comment;
}

export async function deleteComment(comment) {
  await api.del(`/api/comments/${comment.id}`);
  remove(comment.id, comment.track_id);
}
