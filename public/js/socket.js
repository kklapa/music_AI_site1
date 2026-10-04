/* Єдине socket.io-з'єднання. Події сервера дублюються у внутрішню шину. */

import { emit } from './state.js';

let socket = null;

export function getSocket() {
  if (socket) return socket;
  if (typeof window.io !== 'function') return null;
  socket = window.io({ reconnectionDelayMax: 5000 });
  for (const name of ['tracks:changed', 'rooms:changed']) {
    socket.on(name, (data) => emit(name, data));
  }
  socket.on('connect', () => emit('socket:connect'));
  socket.on('disconnect', () => emit('socket:disconnect'));
  return socket;
}

/** Перепідключення після входу/виходу: cookie з токеном читається лише під час рукостискання. */
export function reconnectSocket() {
  if (!socket) return;
  socket.disconnect();
  socket.connect();
}

export function whenConnected(timeoutMs = 8000) {
  const s = getSocket();
  if (!s) return Promise.resolve(false);
  if (s.connected) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      s.off('connect', onConnect);
      resolve(false);
    }, timeoutMs);
    function onConnect() {
      clearTimeout(timer);
      resolve(true);
    }
    s.once('connect', onConnect);
  });
}
