/* Список Live Rooms: створення, приєднання за кодом/посиланням, публічні кімнати. */

import { api } from '../api.js';
import { on, state } from '../state.js';
import { el, coverEl, debounce, toast } from '../util.js';
import { ic, emptyState, spinner, pageHeader } from '../ui.js';
import { ensureAuth } from '../auth.js';
import { joinRoom, room as liveRoom } from '../live.js';

function parseRoomCode(text) {
  const t = String(text || '').trim();
  const m = /room\/([a-z0-9]+)/i.exec(t);
  if (m) return m[1].toLowerCase();
  return /^[a-z0-9]{4,16}$/i.test(t) ? t.toLowerCase() : null;
}

export default async function roomsView(ctx) {
  const offs = [];
  const list = el('div', { class: 'room-grid' }, spinner());

  /* ---- Створення ---- */
  const nameInput = el('input', { class: 'input', type: 'text', maxlength: '50', placeholder: 'Назва кімнати (необов’язково)' });
  const publicToggle = el('input', { type: 'checkbox', checked: true, id: 'roomPublic' });
  const createBtn = el('button', { class: 'btn btn-primary', type: 'submit' }, ic('radio', 18), 'Створити кімнату');
  const createForm = el(
    'form',
    { class: 'panel form-row' },
    el('div', { class: 'panel-head' }, el('h2', { class: 'section-title' }, ic('radio', 18), 'Нова кімната'), el('p', { class: 'muted small' }, 'Ви станете хостом: коли ви вмикаєте або перемотуєте трек, у всіх учасників відбувається те саме.')),
    el('div', { class: 'form-inline' }, nameInput, el('label', { class: 'switch' }, publicToggle, el('span', { class: 'switch-ui' }), el('span', {}, 'Публічна')), createBtn)
  );
  createForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!(await ensureAuth('Увійдіть, щоб створювати кімнати'))) return;
    createBtn.disabled = true;
    try {
      const { room } = await api.post('/api/rooms', { name: nameInput.value.trim(), isPublic: publicToggle.checked });
      const res = await joinRoom(room.id);
      if (!res.ok) toast(res.error, 'error');
      ctx.navigate(`/room/${room.id}`);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      createBtn.disabled = false;
    }
  });

  /* ---- Приєднання ---- */
  const codeInput = el('input', { class: 'input', type: 'text', placeholder: 'Код кімнати або посилання', autocomplete: 'off', spellcheck: 'false' });
  const joinForm = el(
    'form',
    { class: 'panel form-row' },
    el('h2', { class: 'section-title' }, ic('users', 18), 'Приєднатися за посиланням'),
    el('div', { class: 'form-inline' }, codeInput, el('button', { class: 'btn btn-ghost', type: 'submit' }, 'Перейти'))
  );
  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = parseRoomCode(codeInput.value);
    if (!code) return toast('Вставте посилання на кімнату або її код', 'error');
    ctx.navigate(`/room/${code}`);
  });

  /* ---- Список ---- */
  async function load() {
    try {
      const { rooms } = await api.get('/api/rooms');
      if (!rooms.length) {
        list.replaceChildren(emptyState('Зараз немає публічних кімнат. Створіть свою — і запросіть друзів.', 'radio'));
        return;
      }
      list.replaceChildren(
        ...rooms.map((r) =>
          el(
            'a',
            { class: `room-card ${liveRoom.id === r.id ? 'mine' : ''}`.trim(), href: `/room/${r.id}`, 'data-link': true },
            r.track ? coverEl(r.track, 'md') : el('span', { class: 'cover md cover-empty' }, ic('radio', 28)),
            el(
              'div',
              { class: 'room-card-body' },
              el('b', {}, r.name),
              el('span', { class: 'muted small' }, `Хост: ${r.hostName || r.ownerName}`),
              el('span', { class: 'room-track' }, r.track ? `${r.playing ? '▶ ' : '⏸ '}${r.track.title}` : 'Ще нічого не грає'),
              el('span', { class: 'chip' }, ic('users', 12), `${r.members}`)
            )
          )
        )
      );
    } catch (err) {
      list.replaceChildren(emptyState(err.message, 'zap'));
    }
  }

  offs.push(on('rooms:changed', debounce(load, 400)));
  offs.push(on('live:changed', debounce(load, 400)));
  load();

  const root = el(
    'div',
    { class: 'page rooms' },
    pageHeader('Live Rooms', 'Слухайте разом у реальному часі: хост керує, усі чують те саме в ту саму секунду.'),
    el('div', { class: 'two-col' }, createForm, joinForm),
    el('h2', { class: 'section-title' }, el('span', { class: 'live-dot' }), 'Публічні кімнати'),
    list
  );
  return { el: root, destroy: () => offs.forEach((off) => off()) };
}
