/* Особистий кабінет: лайки, історія, мої коментарі, безпека. */

import { api } from '../api.js';
import { state, on, cacheTracks } from '../state.js';
import { el, fmtDate, fmtTime, initials, timeAgo, toast } from '../util.js';
import { ic, emptyState, spinner, trackRow, pageHeader } from '../ui.js';
import { openAuth, logout, isAdmin } from '../auth.js';
import { confirmDialog } from '../modal.js';
import { player } from '../player.js';

const TABS = [
  ['likes', 'Лайки', 'heart'],
  ['history', 'Історія', 'clock'],
  ['comments', 'Мої коментарі', 'comment'],
  ['security', 'Безпека', 'lock'],
];

export default async function meView(ctx) {
  const root = el('div', { class: 'page me' });
  const offs = [];
  let tab = ['likes', 'history', 'comments', 'security'].includes(ctx.query.get('tab')) ? ctx.query.get('tab') : 'likes';

  function renderGuest() {
    root.replaceChildren(
      el(
        'div',
        { class: 'join-card' },
        el('span', { class: 'cover xl cover-empty' }, ic('user', 56)),
        el('h1', {}, 'Ваш кабінет'),
        el('p', { class: 'muted' }, 'Увійдіть, щоб зберігати лайки, бачити історію прослуховувань, коментувати таймлайн і створювати Live Rooms.'),
        el(
          'div',
          { class: 'btn-row' },
          el('button', { class: 'btn btn-primary', type: 'button', onclick: () => openAuth('login') }, 'Увійти'),
          state.site.registrationOpen ? el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => openAuth('register') }, 'Створити акаунт') : null
        )
      )
    );
  }

  const content = el('div', { class: 'tab-content' });

  async function showTab(name) {
    tab = name;
    tabButtons.forEach((b, i) => {
      const on_ = TABS[i][0] === name;
      b.classList.toggle('active', on_);
      b.setAttribute('aria-selected', String(on_));
    });
    history.replaceState(history.state, '', `/me${name === 'likes' ? '' : `?tab=${name}`}`);
    content.replaceChildren(spinner());
    try {
      if (name === 'likes') {
        const { tracks } = await api.get('/api/me/likes');
        cacheTracks(tracks);
        content.replaceChildren(listOf(tracks, 'Ви ще не вподобали жодного треку. Натисніть ♥ біля треку, який сподобався.', 'heart'));
      } else if (name === 'history') {
        const { tracks } = await api.get('/api/me/history');
        cacheTracks(tracks);
        const clear = el(
          'button',
          {
            class: 'btn btn-ghost btn-sm',
            type: 'button',
            onclick: async () => {
              if (!(await confirmDialog('Очистити історію прослуховувань?', { okText: 'Очистити', danger: true }))) return;
              try {
                await api.del('/api/me/history');
                showTab('history');
              } catch (err) {
                toast(err.message, 'error');
              }
            },
          },
          ic('trash', 16),
          'Очистити історію'
        );
        content.replaceChildren(
          tracks.length ? el('div', { class: 'tab-tools' }, clear) : null,
          listOf(tracks, 'Історія порожня. Увімкніть будь-який трек — він з’явиться тут.', 'clock', (t) => el('span', { class: 'row-when muted small' }, timeAgo(t.last_played)))
        );
      } else if (name === 'comments') {
        const { comments } = await api.get('/api/me/comments');
        if (!comments.length) {
          content.replaceChildren(emptyState('Ви ще не залишали коментарів. Відкрийте плеєр і додайте перший на потрібній секунді.', 'comment'));
        } else {
          content.replaceChildren(
            el(
              'ul',
              { class: 'comment-list my-comments' },
              comments.map((c) =>
                el(
                  'li',
                  { class: 'comment' },
                  el('span', { class: 'avatar' }, initials(c.username)),
                  el(
                    'div',
                    { class: 'comment-main' },
                    el(
                      'div',
                      { class: 'comment-head' },
                      el('a', { href: `/track/${c.track_id}`, 'data-link': true }, el('b', {}, c.track_title)),
                      el('span', { class: 'chip' }, `@ ${fmtTime(c.time)}`),
                      el('span', { class: 'muted small' }, timeAgo(c.created_at))
                    ),
                    el('p', { class: 'comment-text' }, c.text)
                  )
                )
              )
            )
          );
        }
      } else {
        content.replaceChildren(securityForm());
      }
    } catch (err) {
      content.replaceChildren(emptyState(err.message, 'zap'));
    }
  }

  function listOf(tracks, emptyText, emptyIcon, extra) {
    if (!tracks.length) return emptyState(emptyText, emptyIcon);
    return el(
      'div',
      { class: 'rows' },
      tracks.map((t, i) => trackRow(t, { index: i, onPlay: (tr) => player.play(tr, tracks), extra: extra ? extra(t) : null }))
    );
  }

  function securityForm() {
    const current = el('input', { class: 'input', type: 'password', autocomplete: 'current-password', required: true, placeholder: 'Поточний пароль' });
    const next = el('input', { class: 'input', type: 'password', autocomplete: 'new-password', required: true, minlength: '8', maxlength: '128', placeholder: 'Новий пароль (від 8 символів)' });
    const submit = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Змінити пароль');
    const form = el(
      'form',
      { class: 'panel form narrow' },
      el('h2', { class: 'section-title' }, ic('lock', 18), 'Зміна пароля'),
      el('label', { class: 'field' }, el('span', {}, 'Поточний пароль'), current),
      el('label', { class: 'field' }, el('span', {}, 'Новий пароль'), next),
      submit
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        await api.put('/api/me/password', { current: current.value, next: next.value });
        current.value = '';
        next.value = '';
        toast('Пароль змінено', 'success');
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        submit.disabled = false;
      }
    });
    return form;
  }

  const tabButtons = TABS.map(([key, label, icon]) =>
    el('button', { class: 'tab', type: 'button', role: 'tab', onclick: () => showTab(key) }, ic(icon, 16), label)
  );

  function renderUser() {
    const u = state.user;
    root.replaceChildren(
      el(
        'header',
        { class: 'me-head' },
        el('span', { class: `avatar xl ${u.role === 'admin' ? 'admin' : ''}`.trim() }, initials(u.username)),
        el(
          'div',
          { class: 'me-id' },
          el('h1', {}, u.username),
          el('p', { class: 'muted' }, u.role === 'admin' ? 'Адміністратор' : 'Слухач', ` · з ${fmtDate(u.created_at)}`)
        ),
        el(
          'div',
          { class: 'btn-row' },
          isAdmin() ? el('a', { class: 'btn btn-ghost', href: '/admin' }, ic('shield', 18), 'Адмін-панель') : null,
          el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => logout() }, ic('log-out', 18), 'Вийти')
        )
      ),
      el('div', { class: 'tabs', role: 'tablist' }, tabButtons),
      content
    );
    showTab(tab);
  }

  function render() {
    if (state.user) renderUser();
    else renderGuest();
  }

  offs.push(on('auth', render));
  offs.push(on('like:changed', () => tab === 'likes' && state.user && showTab('likes')));
  render();
  return { el: root, destroy: () => offs.forEach((off) => off()) };
}
