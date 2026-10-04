/* Спільні UI-компоненти: картки, рядки, лайки, коментарі, модальне вікно ШІ-промпту. */

import { api } from './api.js';
import { state, emit, on, trackCache } from './state.js';
import { el, icon, coverEl, fmtNum, fmtTime, parseTime, timeAgo, initials, toast, copyText } from './util.js';
import { openModal, confirmDialog } from './modal.js';
import { ensureAuth } from './auth.js';
import { getComments, loadComments, postComment, deleteComment, editComment } from './comments.js';

/** Іконка як <span>. */
export function ic(name, size = 20, cls = '') {
  return el('span', { class: `ic ${cls}`.trim(), html: icon(name, size) });
}

export function spinner(label = 'Завантаження…') {
  return el('div', { class: 'loading', role: 'status' }, el('span', { class: 'spinner' }), el('span', {}, label));
}

export function emptyState(text, iconName = 'music', action = null) {
  return el('div', { class: 'empty' }, ic(iconName, 36), el('p', {}, text), action);
}

export function equalizer() {
  return el('span', { class: 'eq', 'aria-hidden': 'true' }, el('i'), el('i'), el('i'), el('i'));
}

/* ----------------------- Стан "зараз грає" для карток -------------------- */

const now = { id: null, playing: false };

export function setNowPlaying(id, playing) {
  now.id = id;
  now.playing = !!playing;
  applyNowPlaying(document);
}

export function applyNowPlaying(root) {
  root.querySelectorAll('[data-track-id]').forEach((node) => {
    const mine = now.id !== null && Number(node.dataset.trackId) === now.id;
    node.classList.toggle('is-current', mine);
    node.classList.toggle('is-playing', mine && now.playing);
  });
}

/* ------------------------------- Лайки ----------------------------------- */

export function likeButton(track, { showCount = true, cls = '' } = {}) {
  const btn = el('button', { class: `btn-like ${cls}`.trim(), type: 'button' });
  const render = () => {
    const t = trackCache.get(track.id) || track;
    btn.classList.toggle('liked', !!t.liked);
    btn.setAttribute('aria-pressed', String(!!t.liked));
    btn.setAttribute('aria-label', t.liked ? 'Прибрати лайк' : 'Поставити лайк');
    btn.title = t.liked ? 'Прибрати лайк' : 'Подобається';
    btn.replaceChildren(ic(t.liked ? 'heart-fill' : 'heart', 20));
    if (showCount) btn.append(el('span', { class: 'count' }, fmtNum(t.likes)));
  };
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!(await ensureAuth('Увійдіть, щоб ставити лайки'))) return;
    btn.disabled = true;
    try {
      const r = await api.post(`/api/tracks/${track.id}/like`);
      applyLikeResult(track, r);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
  const off = on('like:changed', (d) => {
    if (!btn.isConnected) {
      // Елемент вилучено з DOM — відписуємось, але лише якщо він колись був підключений.
      if (btn.dataset.seen) off();
      return;
    }
    btn.dataset.seen = '1';
    if (d.id === track.id) render();
  });
  const offAuth = on('auth', () => {
    if (!btn.isConnected && btn.dataset.seen) {
      offAuth();
      return;
    }
    render();
  });
  render();
  return btn;
}

export function applyLikeResult(track, result) {
  const cached = trackCache.get(track.id);
  for (const t of [track, cached]) {
    if (t) {
      t.liked = result.liked;
      t.likes = result.likes;
    }
  }
  emit('like:changed', { id: track.id, liked: result.liked, likes: result.likes });
}

/* ------------------------------ Картки ----------------------------------- */

function genreChip(genre) {
  if (!genre) return null;
  return el('a', { class: 'chip', href: `/?genre=${encodeURIComponent(genre)}`, 'data-link': true }, genre);
}

export function trackCard(track, { onPlay } = {}) {
  const playBtn = el(
    'button',
    {
      class: 'card-cover',
      type: 'button',
      'aria-label': `Слухати: ${track.title}`,
      onclick: () => onPlay && onPlay(track),
    },
    coverEl(track),
    el('span', { class: 'card-play' }, ic('play', 24, 'i-play'), ic('pause', 24, 'i-pause')),
    equalizer()
  );
  const card = el(
    'article',
    { class: 'card', dataset: { trackId: track.id } },
    playBtn,
    el(
      'div',
      { class: 'card-body' },
      el('a', { class: 'card-title', href: `/track/${track.id}`, 'data-link': true, title: track.title }, track.title),
      track.artist
        ? el('a', { class: 'card-artist', href: `/?q=${encodeURIComponent(track.artist)}`, 'data-link': true }, track.artist)
        : el('span', { class: 'card-artist muted' }, track.generator ? `ШІ · ${track.generator}` : 'ШІ-музика'),
      el(
        'div',
        { class: 'card-meta' },
        genreChip(track.genre),
        el('span', { class: 'stat', title: 'Прослуховувань' }, ic('headphones', 14), fmtNum(track.plays)),
        el('span', { class: 'stat', title: 'Лайків' }, ic('heart', 14), fmtNum(track.likes)),
        track.published ? null : el('span', { class: 'chip chip-warn' }, 'Чернетка')
      )
    )
  );
  applyNowPlaying(card);
  return card;
}

export function trackRow(track, { onPlay, index = null, extra = null } = {}) {
  const row = el(
    'div',
    { class: 'row', dataset: { trackId: track.id } },
    el(
      'button',
      { class: 'row-play', type: 'button', 'aria-label': `Слухати: ${track.title}`, onclick: () => onPlay && onPlay(track) },
      index !== null ? el('span', { class: 'row-index' }, String(index + 1)) : null,
      coverEl(track, 'sm'),
      el('span', { class: 'row-state' }, ic('play', 18, 'i-play'), ic('pause', 18, 'i-pause'), equalizer())
    ),
    el(
      'div',
      { class: 'row-main' },
      el('a', { class: 'row-title', href: `/track/${track.id}`, 'data-link': true }, track.title),
      el('span', { class: 'row-sub' }, [track.artist, track.genre].filter(Boolean).join(' · ') || 'ШІ-музика')
    ),
    extra,
    el('span', { class: 'row-dur' }, track.duration ? fmtTime(track.duration) : ''),
    likeButton(track, { showCount: false })
  );
  applyNowPlaying(row);
  return row;
}

/* ------------------------- ШІ-промпт (модальне) -------------------------- */

export function promptModal(track) {
  if (!track) return null;
  const body = el('div', { class: 'prompt-box' });
  const meta = [];
  if (track.generator) meta.push(['Генератор', track.generator]);
  if (track.ai_model) meta.push(['Модель', track.ai_model]);
  if (track.genre) meta.push(['Жанр', track.genre]);
  if (meta.length) {
    body.append(
      el('dl', { class: 'kv' }, meta.map(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]))
    );
  }
  if (track.tags && track.tags.length) {
    body.append(el('div', { class: 'chips' }, track.tags.map((t) => el('a', { class: 'chip', href: `/?tag=${encodeURIComponent(t)}`, 'data-link': true }, `#${t}`))));
  }
  if (track.ai_prompt) {
    const copy = el('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, ic('copy', 16), 'Копіювати');
    copy.addEventListener('click', async () => {
      const ok = await copyText(track.ai_prompt);
      toast(ok ? 'Промпт скопійовано' : 'Не вдалося скопіювати', ok ? 'success' : 'error');
    });
    body.append(el('div', { class: 'prompt-head' }, el('h4', {}, 'Промпт'), copy), el('pre', { class: 'prompt-text' }, track.ai_prompt));
  } else {
    body.append(el('p', { class: 'muted' }, 'Автор не вказав промпт для цього треку.'));
  }
  if (track.lyrics) {
    body.append(el('details', { class: 'lyrics' }, el('summary', {}, 'Текст пісні'), el('pre', {}, track.lyrics)));
  }
  return openModal({ title: `ШІ-промпт · ${track.title}`, size: 'md', body });
}

/* --------------------------- Коментарі таймлайна ------------------------- */

/**
 * Поле додавання коментаря, прив'язаного до секунди.
 * getTrackId() -> id треку, getTime() -> поточна секунда. Поки поле не у фокусі й порожнє, мітка часу "біжить" разом із треком.
 */
export function commentComposer({ getTrackId, getTime, onPosted, compact = false }) {
  let pinned = null;
  const timeChip = el('button', { class: 'compose-time', type: 'button', title: 'Час коментаря (натисніть, щоб змінити)' }, '@ 0:00');
  const input = el('input', {
    class: 'input compose-input',
    type: 'text',
    maxlength: '300',
    placeholder: 'Коментар до цієї секунди…',
    autocomplete: 'off',
    enterkeyhint: 'send',
  });
  const send = el('button', { class: 'btn-icon compose-send', type: 'submit', 'aria-label': 'Надіслати' }, ic('send', 18));
  const form = el('form', { class: `compose ${compact ? 'compact' : ''}`.trim() }, timeChip, input, send);

  const currentTime = () => (pinned !== null ? pinned : Math.max(0, getTime() || 0));
  const paint = () => {
    timeChip.textContent = `@ ${fmtTime(currentTime())}`;
  };
  const unlock = () => {
    if (!input.value.trim() && document.activeElement !== input) pinned = null;
    paint();
  };

  function applyGuest() {
    const guest = !state.user;
    input.disabled = false;
    input.placeholder = guest ? 'Увійдіть, щоб залишити коментар…' : 'Коментар до цієї секунди…';
    input.readOnly = guest;
    form.classList.toggle('guest', guest);
  }

  input.addEventListener('focus', async () => {
    if (!state.user) {
      input.blur();
      if (await ensureAuth('Увійдіть, щоб коментувати таймлайн')) {
        applyGuest();
        input.focus();
      }
      return;
    }
    pinned = Math.max(0, getTime() || 0);
    paint();
  });
  input.addEventListener('blur', unlock);
  input.addEventListener('keydown', (e) => e.stopPropagation());

  timeChip.addEventListener('click', () => {
    const raw = window.prompt('Час коментаря (наприклад 1:23)', fmtTime(currentTime()));
    if (raw === null) return;
    const t = parseTime(raw);
    if (t === null) return toast('Невірний формат часу. Приклад: 1:23', 'error');
    pinned = t;
    paint();
    if (state.user) input.focus();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.user) {
      if (await ensureAuth('Увійдіть, щоб коментувати таймлайн')) applyGuest();
      return;
    }
    const text = input.value.trim();
    if (!text) return;
    send.disabled = true;
    try {
      const c = await postComment(getTrackId(), text, currentTime());
      input.value = '';
      pinned = null;
      paint();
      if (onPosted) onPosted(c);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      send.disabled = false;
    }
  });

  const offAuth = on('auth', () => {
    if (!form.isConnected) return offAuth();
    applyGuest();
  });
  applyGuest();
  paint();
  form.refreshTime = unlock;
  return form;
}

/**
 * Список коментарів треку з live-оновленням.
 * Повертає { el, destroy }.
 */
export function commentList(trackId, { onSeek, compact = false } = {}) {
  const list = el('ul', { class: `comment-list ${compact ? 'compact' : ''}`.trim() });

  function item(c) {
    const mine = state.user && state.user.id === c.user_id;
    const canDelete = mine || (state.user && state.user.role === 'admin');
    const time = el('button', { class: 'comment-time', type: 'button', title: 'Перейти до цього моменту' }, fmtTime(c.time));
    time.addEventListener('click', () => onSeek && onSeek(c.time, c));
    const actions = [];
    if (mine) {
      actions.push(
        el('button', { class: 'btn-icon sm', type: 'button', title: 'Редагувати', 'aria-label': 'Редагувати', onclick: () => edit(c) }, ic('edit', 14))
      );
    }
    if (canDelete) {
      actions.push(
        el(
          'button',
          {
            class: 'btn-icon sm',
            type: 'button',
            title: 'Видалити',
            'aria-label': 'Видалити',
            onclick: async () => {
              if (!(await confirmDialog('Видалити цей коментар?', { okText: 'Видалити', danger: true }))) return;
              try {
                await deleteComment(c);
              } catch (err) {
                toast(err.message, 'error');
              }
            },
          },
          ic('trash', 14)
        )
      );
    }
    return el(
      'li',
      { class: 'comment', dataset: { commentId: c.id } },
      el('span', { class: `avatar ${c.role === 'admin' ? 'admin' : ''}`.trim(), 'aria-hidden': 'true' }, initials(c.username)),
      el(
        'div',
        { class: 'comment-main' },
        el(
          'div',
          { class: 'comment-head' },
          el('b', {}, c.username),
          c.role === 'admin' ? el('span', { class: 'chip chip-accent' }, 'адмін') : null,
          time,
          el('span', { class: 'muted small' }, timeAgo(c.created_at))
        ),
        el('p', { class: 'comment-text' }, c.text)
      ),
      el('div', { class: 'comment-actions' }, actions)
    );
  }

  async function edit(c) {
    const next = window.prompt('Редагувати коментар', c.text);
    if (next === null) return;
    const text = next.trim();
    if (!text || text === c.text) return;
    try {
      await editComment(c, text);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function render() {
    const comments = getComments(trackId);
    if (!comments.length) {
      list.replaceChildren(el('li', { class: 'comment-empty muted' }, 'Поки що тут тихо. Залишіть перший коментар на потрібній секунді.'));
      return;
    }
    list.replaceChildren(...comments.map(item));
  }

  const offs = [
    on('comments:changed', (d) => {
      if (d.trackId === trackId) render();
    }),
    on('auth', render),
  ];
  loadComments(trackId).catch(() => {});
  render();
  return { el: list, destroy: () => offs.forEach((off) => off()) };
}

/* ------------------------------- Різне ----------------------------------- */

export function fmtTrackLine(track) {
  return [track.artist, track.genre].filter(Boolean).join(' · ');
}

export function pageHeader(title, subtitle = '', actions = null) {
  return el(
    'header',
    { class: 'page-head' },
    el('div', {}, el('h1', {}, title), subtitle ? el('p', { class: 'muted' }, subtitle) : null),
    actions ? el('div', { class: 'page-actions' }, actions) : null
  );
}

export async function shareLink(url, title) {
  const full = new URL(url, location.origin).href;
  if (navigator.share && window.matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ title, url: full });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  const ok = await copyText(full);
  toast(ok ? 'Посилання скопійовано' : full, ok ? 'success' : 'info', ok ? 2400 : 8000);
}
