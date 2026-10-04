/* Головна: пошук, жанри, сортування, сітка треків, "В ефірі зараз". */

import { api } from '../api.js';
import { cacheTracks, on, state } from '../state.js';
import { el, debounce, coverEl, fmtNum, toast } from '../util.js';
import { trackCard, emptyState, spinner, ic } from '../ui.js';
import { player } from '../player.js';

const PAGE = 24;
const SORTS = [
  ['new', 'Нові'],
  ['popular', 'Популярні'],
  ['liked', 'Улюблені'],
];

export default async function home(ctx) {
  const f = {
    q: ctx.query.get('q') || '',
    genre: ctx.query.get('genre') || '',
    tag: ctx.query.get('tag') || '',
    sort: SORTS.some(([k]) => k === ctx.query.get('sort')) ? ctx.query.get('sort') : 'new',
  };
  let tracks = [];
  let total = 0;
  let reqId = 0;
  let loading = false;
  const offs = [];

  /* ---- Каркас ---- */
  const search = el('input', {
    class: 'input search-input',
    type: 'search',
    placeholder: 'Назва, виконавець, жанр, модель…',
    value: f.q,
    'aria-label': 'Пошук',
    autocomplete: 'off',
    enterkeyhint: 'search',
  });
  const hero = el(
    'section',
    { class: 'hero' },
    el('p', { class: 'eyebrow' }, ic('sparkles', 14), 'Стрімінг ШІ-музики'),
    el('h1', {}, 'Музика, народжена ', el('span', { class: 'grad' }, 'штучним інтелектом')),
    el('p', { class: 'lead' }, 'Слухайте треки з відкритими промптами, коментуйте конкретну секунду та слухайте разом із друзями в реальному часі.'),
    el('label', { class: 'search' }, ic('search', 18), search)
  );

  const liveList = el('div', { class: 'live-list' });
  const liveStrip = el('section', { class: 'live-strip', hidden: true }, el('h2', { class: 'section-title' }, el('span', { class: 'live-dot' }), 'В ефірі зараз'), liveList);

  const genreChips = el('div', { class: 'chips scroll-x', role: 'group', 'aria-label': 'Жанри' });
  const sortSelect = el(
    'select',
    { class: 'select', 'aria-label': 'Сортування' },
    SORTS.map(([k, label]) => el('option', { value: k, selected: k === f.sort }, label))
  );
  const activeFilters = el('div', { class: 'chips active-filters' });
  const info = el('p', { class: 'muted result-info' });
  const grid = el('div', { class: 'grid' });
  const moreBtn = el('button', { class: 'btn btn-ghost', type: 'button', hidden: true }, 'Показати ще');
  const more = el('div', { class: 'more' }, moreBtn);

  const root = el(
    'div',
    { class: 'page home' },
    hero,
    liveStrip,
    el('section', { class: 'catalog' }, el('div', { class: 'toolbar' }, genreChips, sortSelect), activeFilters, info, grid, more)
  );

  /* ---- Дані ---- */
  const playFrom = (track) => player.play(track, tracks);

  function syncUrl() {
    const p = new URLSearchParams();
    if (f.q) p.set('q', f.q);
    if (f.genre) p.set('genre', f.genre);
    if (f.tag) p.set('tag', f.tag);
    if (f.sort !== 'new') p.set('sort', f.sort);
    const qs = p.toString();
    history.replaceState(history.state, '', location.pathname + (qs ? `?${qs}` : ''));
  }

  function paintFilters() {
    const pills = [];
    const pill = (label, clear) =>
      el(
        'button',
        { class: 'chip chip-accent removable', type: 'button', onclick: clear, title: 'Прибрати фільтр' },
        label,
        ic('x', 12)
      );
    if (f.q) pills.push(pill(`Пошук: ${f.q}`, () => ((search.value = ''), (f.q = ''), reload())));
    if (f.tag) pills.push(pill(`#${f.tag}`, () => ((f.tag = ''), reload())));
    activeFilters.replaceChildren(...pills);
    activeFilters.hidden = !pills.length;
  }

  function paintGrid() {
    if (!tracks.length) {
      const filtered = f.q || f.genre || f.tag;
      grid.replaceChildren(
        emptyState(filtered ? 'За цими фільтрами нічого не знайдено' : 'Поки що немає жодного треку. Адміністратор додасть їх у панелі /admin.', 'music')
      );
      grid.classList.add('is-empty');
    } else {
      grid.classList.remove('is-empty');
      grid.replaceChildren(...tracks.map((t) => trackCard(t, { onPlay: playFrom })));
    }
    info.textContent = total ? `Знайдено: ${fmtNum(total)}` : '';
    moreBtn.hidden = tracks.length >= total;
  }

  async function load(reset) {
    const my = ++reqId;
    loading = true;
    if (reset) grid.replaceChildren(spinner());
    const p = new URLSearchParams({ limit: String(PAGE), offset: String(reset ? 0 : tracks.length), sort: f.sort });
    if (f.q) p.set('q', f.q);
    if (f.genre) p.set('genre', f.genre);
    if (f.tag) p.set('tag', f.tag);
    try {
      const data = await api.get(`/api/tracks?${p}`);
      if (my !== reqId) return;
      const list = cacheTracks(data.tracks);
      tracks = reset ? list : tracks.concat(list);
      total = data.total;
      paintGrid();
    } catch (err) {
      if (my !== reqId) return;
      grid.replaceChildren(emptyState(err.message, 'zap'));
    } finally {
      if (my === reqId) loading = false;
    }
  }

  function reload() {
    syncUrl();
    paintFilters();
    paintGenres();
    load(true);
  }

  let genres = [];
  function paintGenres() {
    const all = el('button', { class: `chip ${f.genre ? '' : 'active'}`.trim(), type: 'button', onclick: () => ((f.genre = ''), reload()) }, 'Усі');
    const rest = genres.map((g) =>
      el(
        'button',
        {
          class: `chip ${f.genre.toLowerCase() === g.genre.toLowerCase() ? 'active' : ''}`.trim(),
          type: 'button',
          onclick: () => ((f.genre = f.genre.toLowerCase() === g.genre.toLowerCase() ? '' : g.genre), reload()),
        },
        g.genre,
        el('small', {}, String(g.n))
      )
    );
    genreChips.replaceChildren(all, ...rest);
  }

  async function loadGenres() {
    try {
      genres = (await api.get('/api/genres')).genres || [];
      paintGenres();
    } catch (_) {
      /* жанри — необов'язкова частина */
    }
  }

  async function loadRooms() {
    try {
      const { rooms } = await api.get('/api/rooms');
      liveStrip.hidden = !rooms.length;
      liveList.replaceChildren(
        ...rooms.slice(0, 8).map((r) =>
          el(
            'a',
            { class: 'live-card', href: `/room/${r.id}`, 'data-link': true },
            r.track ? coverEl(r.track, 'sm') : el('span', { class: 'cover sm cover-empty' }, ic('radio', 20)),
            el(
              'span',
              { class: 'live-info' },
              el('b', {}, r.name),
              el('small', {}, r.track ? `${r.track.title}${r.track.artist ? ` — ${r.track.artist}` : ''}` : 'Чекаємо на перший трек'),
              el('small', { class: 'muted' }, `${r.members} ${r.members === 1 ? 'слухач' : 'слухачів'}${r.playing ? ' · грає' : ''}`)
            )
          )
        )
      );
    } catch (_) {
      liveStrip.hidden = true;
    }
  }

  /* ---- Події ---- */
  search.addEventListener(
    'input',
    debounce(() => {
      f.q = search.value.trim();
      reload();
    }, 320)
  );
  sortSelect.addEventListener('change', () => {
    f.sort = sortSelect.value;
    reload();
  });
  moreBtn.addEventListener('click', () => !loading && load(false));

  const reloadSoft = debounce(() => load(true), 600);
  offs.push(on('tracks:changed', reloadSoft));
  offs.push(on('rooms:changed', debounce(loadRooms, 500)));
  offs.push(on('auth', () => load(true)));

  paintFilters();
  paintGenres();
  load(true);
  loadGenres();
  loadRooms();

  return {
    el: root,
    destroy: () => offs.forEach((off) => off()),
  };
}
