/* Сторінка кімнати спільного прослуховування. */

import { api } from '../api.js';
import { cacheTracks, on, state } from '../state.js';
import { el, coverEl, copyText, debounce, toast, initials } from '../util.js';
import { ic, emptyState, spinner, trackRow, shareLink } from '../ui.js';
import { confirmDialog } from '../modal.js';
import { player } from '../player.js';
import { room, joinRoom, leaveRoom, closeRoom, chatPanel, reactionBar } from '../live.js';

export default async function roomView(ctx) {
  const id = String(ctx.params.id).toLowerCase();
  let info = null;
  try {
    info = (await api.get(`/api/rooms/${id}`)).room;
  } catch (err) {
    ctx.setTitle('Кімнату не знайдено');
    return {
      el: el(
        'div',
        { class: 'page' },
        emptyState(err.status === 404 ? 'Кімнату не знайдено або вона вже закрита' : err.message, 'radio', el('a', { class: 'btn btn-primary', href: '/rooms', 'data-link': true }, 'До списку кімнат'))
      ),
    };
  }
  ctx.setTitle(info.name);

  const root = el('div', { class: 'page room' });
  const offs = [];
  let chat = null;
  let libraryAbort = 0;

  const inviteUrl = () => `${location.origin}/room/${id}`;

  /* ---- Екран приєднання ---- */
  function renderJoin() {
    const btn = el('button', { class: 'btn btn-primary btn-lg', type: 'button' }, ic('headphones', 20), 'Приєднатися та слухати');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const res = await joinRoom(id);
      btn.disabled = false;
      if (!res.ok) return toast(res.error, 'error');
      render();
    });
    root.replaceChildren(
      el(
        'div',
        { class: 'join-card' },
        info.track ? coverEl(info.track, 'xl') : el('span', { class: 'cover xl cover-empty' }, ic('radio', 56)),
        el('p', { class: 'eyebrow' }, el('span', { class: 'live-dot' }), info.isPublic ? 'Публічна кімната' : 'Приватна кімната'),
        el('h1', {}, info.name),
        el('p', { class: 'muted' }, `Власник: ${info.ownerName} · учасників: ${info.members}`),
        info.track ? el('p', {}, `${info.playing ? '▶ Зараз грає' : '⏸ На паузі'}: ${info.track.title}${info.track.artist ? ` — ${info.track.artist}` : ''}`) : el('p', { class: 'muted' }, 'Хост ще не увімкнув жодного треку'),
        btn,
        el('p', { class: 'muted small' }, 'Натискання кнопки потрібне браузеру, щоб дозволити відтворення звуку.')
      )
    );
  }

  /* ---- Екран кімнати ---- */
  const nowBox = el('div', { class: 'room-now' });
  const memberList = el('ul', { class: 'members' });
  const memberCount = el('span', { class: 'muted' });
  const roleNote = el('p', { class: 'room-role' });
  const libraryBox = el('section', { class: 'panel library' });

  function paintNow() {
    const t = player.current;
    const layer = el('div', { class: 'react-layer', 'aria-hidden': 'true' });
    const cover = t ? coverEl(t, 'xl') : el('span', { class: 'cover xl cover-empty' }, ic('radio', 56));
    const text = el(
      'div',
      { class: 'room-now-text' },
      el('p', { class: 'eyebrow' }, el('span', { class: `live-dot ${player.playing ? '' : 'paused'}`.trim() }), player.playing ? 'Зараз грає' : 'Пауза'),
      el('h2', {}, t ? t.title : 'Чекаємо на перший трек'),
      t && t.artist ? el('p', { class: 'muted' }, t.artist) : null,
      t ? el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => player.openFull() }, ic('chevron-up', 16), 'Відкрити плеєр') : null
    );
    nowBox.replaceChildren(el('div', { class: 'room-cover' }, cover, layer), text);
  }

  function paintMembers() {
    memberCount.textContent = `(${room.members.length})`;
    memberList.replaceChildren(
      ...room.members.map((m) =>
        el(
          'li',
          { class: `member ${m.isHost ? 'host' : ''}`.trim() },
          el('span', { class: 'avatar' }, initials(m.name)),
          el('span', { class: 'member-name' }, m.name, m.id === room.selfId ? el('small', {}, ' (ви)') : null),
          m.isHost ? el('span', { class: 'chip chip-accent' }, ic('zap', 12), 'хост') : null
        )
      )
    );
    roleNote.textContent = room.isHost
      ? 'Ви хост: усе, що ви вмикаєте або перемотуєте, чують усі учасники.'
      : room.connected
      ? 'Керує хост. Ваша кнопка ▶ повертає вас до спільного ефіру.'
      : 'З’єднання втрачено — перепідключаємось…';
  }

  async function paintLibrary() {
    if (!room.isHost) {
      libraryBox.hidden = true;
      return;
    }
    libraryBox.hidden = false;
    const my = ++libraryAbort;
    const search = el('input', { class: 'input', type: 'search', placeholder: 'Знайти трек для кімнати…', autocomplete: 'off' });
    const rows = el('div', { class: 'rows' }, spinner());
    libraryBox.replaceChildren(el('h2', { class: 'section-title' }, ic('music', 18), 'Оберіть трек для ефіру'), el('label', { class: 'search' }, ic('search', 18), search), rows);
    let tracks = [];
    const draw = () => {
      if (!tracks.length) rows.replaceChildren(emptyState('Нічого не знайдено', 'music'));
      else rows.replaceChildren(...tracks.map((t, i) => trackRow(t, { index: i, onPlay: (tr) => player.play(tr, tracks) })));
    };
    const load = async () => {
      try {
        const data = await api.get(`/api/tracks?limit=50&sort=new${search.value.trim() ? `&q=${encodeURIComponent(search.value.trim())}` : ''}`);
        if (my !== libraryAbort) return;
        tracks = cacheTracks(data.tracks);
        draw();
      } catch (err) {
        rows.replaceChildren(emptyState(err.message, 'zap'));
      }
    };
    search.addEventListener('input', debounce(load, 300));
    load();
  }

  function renderRoom() {
    if (chat) chat.destroy();
    chat = chatPanel();
    const isOwner = !!state.user && (room.isOwner || state.user.role === 'admin');

    const copyBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, ic('copy', 16), 'Копіювати посилання');
    copyBtn.addEventListener('click', async () => {
      const ok = await copyText(inviteUrl());
      toast(ok ? 'Посилання на кімнату скопійовано' : inviteUrl(), ok ? 'success' : 'info', ok ? 2400 : 9000);
    });
    const shareBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => shareLink(`/room/${id}`, info.name) }, ic('share', 16), 'Запросити');
    const leaveBtn = el(
      'button',
      {
        class: 'btn btn-ghost btn-sm',
        type: 'button',
        onclick: () => {
          leaveRoom();
          ctx.navigate('/rooms');
        },
      },
      ic('log-out', 16),
      'Вийти'
    );
    const closeBtn = isOwner
      ? el(
          'button',
          {
            class: 'btn btn-danger btn-sm',
            type: 'button',
            onclick: async () => {
              if (await confirmDialog('Закрити кімнату для всіх учасників?', { okText: 'Закрити', danger: true })) closeRoom();
            },
          },
          ic('x', 16),
          'Закрити кімнату'
        )
      : null;

    root.replaceChildren(
      el(
        'div',
        { class: 'room-layout' },
        el(
          'section',
          { class: 'room-main' },
          el(
            'header',
            { class: 'room-head' },
            el('div', {}, el('p', { class: 'eyebrow' }, el('span', { class: 'live-dot' }), info.isPublic ? 'Публічна кімната' : 'Приватна кімната'), el('h1', {}, info.name)),
            el('div', { class: 'room-actions' }, copyBtn, shareBtn, leaveBtn, closeBtn)
          ),
          roleNote,
          nowBox,
          reactionBar(),
          libraryBox
        ),
        el('aside', { class: 'room-side panel' }, el('h3', {}, 'Учасники ', memberCount), memberList, el('h3', {}, 'Чат'), chat.el)
      )
    );
    paintNow();
    paintMembers();
    paintLibrary();
  }

  function render() {
    if (room.id === id) renderRoom();
    else renderJoin();
  }

  let lastHost = null;
  offs.push(
    on('live:changed', () => {
      if (room.id !== id) {
        if (chat) {
          chat.destroy();
          chat = null;
        }
        renderJoin();
        return;
      }
      if (!chat) return renderRoom();
      paintMembers();
      if (lastHost !== room.isHost) {
        lastHost = room.isHost;
        paintLibrary();
      }
    })
  );
  offs.push(on('player:track', paintNow));
  offs.push(on('player:state', paintNow));
  offs.push(on('auth', () => render()));

  lastHost = room.isHost;
  render();

  return {
    el: root,
    destroy() {
      offs.forEach((off) => off());
      if (chat) chat.destroy();
    },
  };
}
