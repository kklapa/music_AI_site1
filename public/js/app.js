/* Точка входу: SPA-роутер, верхня панель, PWA, запуск плеєра та Live Rooms. */

import { api } from './api.js';
import { state, on, emit } from './state.js';
import { $, $$, el, hydrateIcons, toast, initials } from './util.js';
import { refreshUser, openAuth, isAdmin } from './auth.js';
import { getSocket } from './socket.js';
import { player } from './player.js';
import { initLive } from './live.js';
import { spinner, emptyState, applyNowPlaying, ic } from './ui.js';
import { openSettings } from './views/settings.js';
import { resetAmbient } from './colors.js';

const viewRoot = document.getElementById('view');

const routes = [
  { re: /^\/$/, nav: 'home', load: () => import('./views/home.js') },
  { re: /^\/track\/(\d+)$/, keys: ['id'], nav: 'home', load: () => import('./views/track.js') },
  { re: /^\/rooms$/, nav: 'rooms', load: () => import('./views/rooms.js') },
  { re: /^\/room\/([a-z0-9]+)$/i, keys: ['id'], nav: 'rooms', load: () => import('./views/room.js') },
  { re: /^\/me$/, nav: 'me', load: () => import('./views/me.js') },
];

let currentView = null;
let renderedUrl = '';
let navToken = 0;

export function setTitle(title) {
  const site = state.site.siteName || 'AI Waves';
  document.title = title ? `${title} — ${site}` : `${site} — стрімінг ШІ-музики`;
}

function paintNav(active) {
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === active));
}

async function render(url, { scroll = true, focus = false } = {}) {
  const token = ++navToken;
  const path = url.pathname.replace(/\/+$/, '') || '/';
  let params = {};
  let route = routes.find((r) => r.re.test(path));
  if (route && route.keys) {
    const m = route.re.exec(path);
    params = Object.fromEntries(route.keys.map((k, i) => [k, m[i + 1]]));
  }

  if (currentView && currentView.destroy) {
    try {
      currentView.destroy();
    } catch (err) {
      console.warn('[router] destroy', err);
    }
  }
  currentView = null;
  viewRoot.setAttribute('aria-busy', 'true');
  viewRoot.replaceChildren(spinner());
  paintNav(route ? route.nav : '');
  setTitle('');

  let result;
  try {
    if (!route) {
      result = {
        el: el(
          'div',
          { class: 'page' },
          emptyState('Сторінку не знайдено', 'search', el('a', { class: 'btn btn-primary', href: '/', 'data-link': true }, 'На головну'))
        ),
      };
    } else {
      const mod = await route.load();
      result = await mod.default({ params, query: url.searchParams, path, navigate, setTitle });
    }
  } catch (err) {
    console.error('[router]', err);
    result = {
      el: el(
        'div',
        { class: 'page' },
        emptyState(
          err && err.status === 404 ? 'Трек або сторінку не знайдено' : (err && err.message) || 'Не вдалося завантажити сторінку',
          err && err.status === 404 ? 'search' : 'zap',
          el('a', { class: 'btn btn-primary', href: '/', 'data-link': true }, 'На головну')
        )
      ),
    };
  }

  if (token !== navToken) {
    if (result && result.destroy) result.destroy();
    return;
  }
  currentView = result;
  viewRoot.replaceChildren(result.el);
  viewRoot.removeAttribute('aria-busy');
  viewRoot.classList.remove('enter');
  void viewRoot.offsetWidth;
  viewRoot.classList.add('enter');
  hydrateIcons(viewRoot);
  applyNowPlaying(viewRoot);
  renderedUrl = url.pathname + url.search;
  if (scroll) window.scrollTo(0, 0);
  if (focus) viewRoot.focus({ preventScroll: true });
}

export async function navigate(to, { replace = false } = {}) {
  let url;
  try {
    url = new URL(to, location.origin);
  } catch (_) {
    return;
  }
  if (url.origin !== location.origin) {
    location.href = url.href;
    return;
  }
  player.closeFull({ fromPop: true });
  const target = url.pathname + url.search;
  if (replace) history.replaceState(null, '', target);
  else if (target !== location.pathname + location.search) history.pushState(null, '', target);
  await render(url, { focus: true });
}

/* ------------------------ Верхня панель: користувач ---------------------- */

function renderUserSlot() {
  const slot = document.getElementById('userSlot');
  if (!slot) return;
  if (!state.user) {
    slot.replaceChildren(el('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => openAuth('login') }, 'Увійти'));
    return;
  }
  const bits = [];
  if (isAdmin()) bits.push(el('a', { class: 'btn-icon', href: '/admin', title: 'Адмін-панель', 'aria-label': 'Адмін-панель' }, ic('shield', 20)));
  bits.push(
    el(
      'a',
      { class: `avatar link ${isAdmin() ? 'admin' : ''}`.trim(), href: '/me', 'data-link': true, title: state.user.username, 'aria-label': `Кабінет: ${state.user.username}` },
      initials(state.user.username)
    )
  );
  slot.replaceChildren(...bits);
}

/* ------------------------------- PWA ------------------------------------- */

function setupPwa() {
  const btn = document.getElementById('installBtn');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installPrompt = e;
    btn.hidden = false;
  });
  btn.addEventListener('click', async () => {
    const prompt = state.installPrompt;
    if (!prompt) return;
    prompt.prompt();
    try {
      await prompt.userChoice;
    } catch (_) {
      /* користувач закрив діалог */
    }
    state.installPrompt = null;
    btn.hidden = true;
  });
  window.addEventListener('appinstalled', () => {
    state.installPrompt = null;
    btn.hidden = true;
    toast('Застосунок встановлено', 'success');
  });
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('/service-worker.js', { scope: '/' }).catch((err) => console.warn('[sw]', err));
  }
}

/* ------------------------------- Запуск ---------------------------------- */

function bindGlobalEvents() {
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest && e.target.closest('a[data-link]');
    if (!a) return;
    const href = a.getAttribute('href');
    e.preventDefault();
    if (!href || href === '#') return;
    navigate(href);
  });

  window.addEventListener('popstate', () => {
    const target = location.pathname + location.search;
    if (target === renderedUrl) return;
    render(new URL(location.href), { scroll: false });
  });

  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  on('open:settings', openSettings);
  on('navigate', (d) => d && d.to && navigate(d.to));
  on('auth', renderUserSlot);
  on('live:closed', () => {
    if (location.pathname.startsWith('/room/')) navigate('/rooms');
  });
}

async function boot() {
  hydrateIcons();
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  try {
    state.site = { ...state.site, ...(await api.get('/api/settings/public')) };
  } catch (_) {
    /* лишаємо значення за замовчуванням */
  }
  const logo = document.querySelector('.logo-text');
  if (logo && state.site.siteName) logo.textContent = state.site.siteName;

  bindGlobalEvents();
  setupPwa();
  resetAmbient();
  await refreshUser();
  renderUserSlot();
  getSocket();
  initLive();
  player.init();
  await render(new URL(location.href), { scroll: false });
}

boot().catch((err) => {
  console.error('[boot]', err);
  viewRoot.replaceChildren(emptyState('Не вдалося запустити застосунок. Оновіть сторінку.', 'zap'));
});
