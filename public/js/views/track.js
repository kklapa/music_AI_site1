/* Сторінка треку: велика обкладинка, ШІ-промпт, текст, коментарі таймлайна. */

import { api } from '../api.js';
import { cacheTrack, on, state } from '../state.js';
import { el, coverEl, fmtDate, fmtNum, fmtTime, toast, copyText } from '../util.js';
import { ic, likeButton, commentComposer, commentList, shareLink, equalizer } from '../ui.js';
import { player } from '../player.js';
import { watchTrack, unwatchTrack } from '../comments.js';

export default async function trackView(ctx) {
  const id = Number(ctx.params.id);
  const data = await api.get(`/api/tracks/${id}`);
  const track = cacheTrack(data.track);
  ctx.setTitle(track.title);

  const isCurrent = () => player.current && player.current.id === track.id;
  const offs = [];

  /* ---- Шапка ---- */
  const playBtn = el(
    'button',
    { class: 'btn btn-primary btn-lg tp-play', type: 'button' },
    ic('play', 22, 'l-play'),
    ic('pause', 22, 'l-pause'),
    el('span', { class: 'l-play' }, 'Слухати'),
    el('span', { class: 'l-pause' }, 'Пауза')
  );
  playBtn.addEventListener('click', () => player.play(track, [track]));

  const tags = (track.tags || []).map((t) => el('a', { class: 'chip', href: `/?tag=${encodeURIComponent(t)}`, 'data-link': true }, `#${t}`));
  const stats = el(
    'p',
    { class: 'tp-stats muted' },
    `${fmtNum(track.plays)} прослуховувань · ${track.duration ? fmtTime(track.duration) : '—'} · ${fmtDate(track.created_at)}`
  );

  const head = el(
    'article',
    { class: 'track-page', dataset: { trackId: track.id } },
    el(
      'div',
      { class: 'tp-cover' },
      coverEl(track, 'xl'),
      equalizer()
    ),
    el(
      'div',
      { class: 'tp-info' },
      el('p', { class: 'eyebrow' }, ic('sparkles', 14), track.generator ? `Створено в ${track.generator}` : 'ШІ-трек', track.published ? null : el('span', { class: 'chip chip-warn' }, 'Чернетка')),
      el('h1', {}, track.title),
      track.artist ? el('a', { class: 'tp-artist', href: `/?q=${encodeURIComponent(track.artist)}`, 'data-link': true }, track.artist) : null,
      el('div', { class: 'chips' }, track.genre ? el('a', { class: 'chip chip-accent', href: `/?genre=${encodeURIComponent(track.genre)}`, 'data-link': true }, track.genre) : null, tags),
      el(
        'div',
        { class: 'tp-actions' },
        playBtn,
        likeButton(track, { cls: 'btn-like-lg' }),
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => shareLink(`/track/${track.id}`, track.title) }, ic('share', 18), 'Поділитися')
      ),
      stats
    )
  );

  /* ---- Як створено ---- */
  const kv = [];
  if (track.generator) kv.push(['Генератор', track.generator]);
  if (track.ai_model) kv.push(['Модель', track.ai_model]);
  const aiPanel = el('section', { class: 'panel ai-panel' }, el('h2', { class: 'section-title' }, ic('sparkles', 18), 'Як створено'));
  if (kv.length) aiPanel.append(el('dl', { class: 'kv' }, kv.map(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])));
  if (track.ai_prompt) {
    const copy = el('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, ic('copy', 16), 'Копіювати промпт');
    copy.addEventListener('click', async () => {
      const ok = await copyText(track.ai_prompt);
      toast(ok ? 'Промпт скопійовано' : 'Не вдалося скопіювати', ok ? 'success' : 'error');
    });
    aiPanel.append(el('pre', { class: 'prompt-text' }, track.ai_prompt), copy);
  } else {
    aiPanel.append(el('p', { class: 'muted' }, 'Автор не вказав промпт для цього треку.'));
  }

  const lyrics = track.lyrics ? el('details', { class: 'panel lyrics' }, el('summary', {}, 'Текст пісні'), el('pre', {}, track.lyrics)) : null;

  /* ---- Коментарі ---- */
  const composer = commentComposer({
    getTrackId: () => track.id,
    getTime: () => (isCurrent() ? player.position : 0),
  });
  const list = commentList(track.id, {
    onSeek: (t) => player.play(track, [track], { position: t }),
  });
  const commentsPanel = el(
    'section',
    { class: 'panel comments-panel' },
    el('h2', { class: 'section-title' }, ic('comment', 18), 'Коментарі таймлайна'),
    el('p', { class: 'muted small' }, 'Коментар прив’язується до секунди треку й з’являється маркером на смузі перемотування.'),
    composer,
    list.el
  );
  watchTrack(track.id);

  const timer = setInterval(() => {
    if (isCurrent() && player.playing) composer.refreshTime();
  }, 500);

  offs.push(
    on('auth', async () => {
      try {
        const fresh = cacheTrack((await api.get(`/api/tracks/${id}`)).track);
        Object.assign(track, fresh);
      } catch (_) {
        /* лишаємо як є */
      }
    })
  );

  const root = el('div', { class: 'page track' }, head, aiPanel, lyrics, commentsPanel);
  return {
    el: root,
    destroy() {
      clearInterval(timer);
      unwatchTrack(track.id);
      list.destroy();
      offs.forEach((off) => off());
    },
  };
}
