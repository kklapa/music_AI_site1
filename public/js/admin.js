/* Адмін-панель: огляд, треки (завантаження/редагування/видалення), модерація, користувачі, вебхуки. */

import { api, uploadForm } from './api.js';
import { state } from './state.js';
import { el, icon, fmtBytes, fmtDate, fmtNum, fmtTime, timeAgo, toast, coverEl } from './util.js';
import { openModal, confirmDialog } from './modal.js';

const app = document.getElementById('app');
const ic = (name, size = 18) => el('span', { class: 'ic', html: icon(name, size) });
const GENERATORS = ['Suno', 'Udio', 'Stable Audio', 'MusicGen', 'Riffusion', 'ElevenLabs Music', 'Інше'];
const TABS = [
  ['overview', 'Огляд', 'chart'],
  ['tracks', 'Треки', 'music'],
  ['comments', 'Коментарі', 'comment'],
  ['users', 'Користувачі', 'users'],
  ['settings', 'Вебхуки та сайт', 'zap'],
];

let tab = 'overview';
let panel = null;

/* --------------------------------- Вхід ---------------------------------- */

function renderLogin(message) {
  const username = el('input', { class: 'input', name: 'username', autocomplete: 'username', placeholder: 'Логін адміністратора', required: true, autofocus: true });
  const password = el('input', { class: 'input', type: 'password', name: 'password', autocomplete: 'current-password', placeholder: 'Пароль', required: true });
  const error = el('div', { class: 'form-error', hidden: !message }, message || '');
  const submit = el('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Увійти');
  const form = el('form', { class: 'panel' }, el('h1', {}, 'Адмін-панель'), el('p', { class: 'muted' }, 'Доступ лише для адміністраторів.'), username, password, error, submit, el('a', { class: 'muted small', href: '/' }, '← На сайт'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = true;
    try {
      const data = await api.post('/api/auth/login', { username: username.value.trim(), password: password.value });
      if (data.user.role !== 'admin') {
        await api.post('/api/auth/logout');
        throw new Error('Цей акаунт не має прав адміністратора');
      }
      state.user = data.user;
      renderShell();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
  app.replaceChildren(el('div', { class: 'adm adm-login' }, form));
}

/* ------------------------------- Каркас ---------------------------------- */

function renderShell() {
  const tabs = el(
    'div',
    { class: 'adm-tabs' },
    el(
      'div',
      { class: 'tabs', role: 'tablist' },
      TABS.map(([key, label, iconName]) =>
        el('button', { class: `tab ${key === tab ? 'active' : ''}`.trim(), type: 'button', role: 'tab', dataset: { tab: key }, onclick: () => showTab(key) }, ic(iconName, 16), label)
      )
    )
  );
  panel = el('div', { class: 'adm-panel' });
  app.replaceChildren(
    el(
      'div',
      { class: 'adm' },
      el(
        'header',
        { class: 'adm-top' },
        el('h1', {}, ic('shield', 28), 'Адмін-панель'),
        el(
          'div',
          { class: 'btn-row' },
          el('span', { class: 'chip chip-accent' }, state.user.username),
          el('a', { class: 'btn btn-ghost btn-sm', href: '/' }, '← На сайт'),
          el(
            'button',
            {
              class: 'btn btn-ghost btn-sm',
              type: 'button',
              onclick: async () => {
                try {
                  await api.post('/api/auth/logout');
                } catch (_) {
                  /* ігноруємо */
                }
                state.user = null;
                renderLogin();
              },
            },
            ic('log-out', 16),
            'Вийти'
          )
        )
      ),
      tabs,
      panel
    )
  );
  showTab(tab);
}

async function showTab(name) {
  tab = name;
  app.querySelectorAll('.adm-tabs .tab').forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  panel.replaceChildren(el('div', { class: 'loading' }, el('span', { class: 'spinner' }), 'Завантаження…'));
  try {
    const node = await ({ overview, tracks, comments, users, settings }[name])();
    panel.replaceChildren(node);
  } catch (err) {
    if (err.status === 401 || err.status === 403) return renderLogin('Сесія завершилась — увійдіть знову');
    panel.replaceChildren(el('div', { class: 'empty' }, ic('zap', 32), el('p', {}, err.message)));
  }
}

/* -------------------------------- Огляд ---------------------------------- */

async function overview() {
  const s = await api.get('/api/admin/stats');
  const card = (value, label) => el('div', { class: 'stat-card' }, el('b', {}, value), el('span', {}, label));
  return el(
    'div',
    {},
    el('div', { class: 'stats' }, card(fmtNum(s.tracks), 'треків'), card(fmtNum(s.plays), 'прослуховувань'), card(fmtNum(s.likes), 'лайків'), card(fmtNum(s.comments), 'коментарів'), card(fmtNum(s.users), 'користувачів'), card(fmtNum(s.rooms), 'активних кімнат'), card(fmtBytes(s.diskBytes), 'файлів на диску')),
    el(
      'section',
      { class: 'panel' },
      el('h2', { class: 'section-title' }, ic('chart', 18), 'Топ-5 за прослуховуваннями'),
      s.top.length
        ? el('ol', { class: 'top-list' }, s.top.map((t) => el('li', {}, el('a', { href: `/track/${t.id}` }, t.title), el('span', {}, `${fmtNum(t.plays)} ▶`))))
        : el('p', { class: 'muted' }, 'Ще немає даних.')
    )
  );
}

/* --------------------------------- Треки --------------------------------- */

function readDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const done = (v) => {
      URL.revokeObjectURL(url);
      resolve(v);
    };
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) ? audio.duration : 0);
    audio.onerror = () => done(0);
    setTimeout(() => done(0), 8000);
    audio.src = url;
  });
}

function trackFormFields(t = {}) {
  const f = {};
  f.title = el('input', { class: 'input', name: 'title', required: true, maxlength: '140', value: t.title || '', placeholder: 'Назва треку' });
  f.artist = el('input', { class: 'input', name: 'artist', maxlength: '80', value: t.artist || '', placeholder: 'Автор / псевдонім' });
  f.genre = el('input', { class: 'input', name: 'genre', maxlength: '40', value: t.genre || '', placeholder: 'Жанр (synthwave, lo-fi…)' });
  f.tags = el('input', { class: 'input', name: 'tags', value: (t.tags || []).join(', '), placeholder: 'Теги через кому' });
  const known = GENERATORS.includes(t.generator) ? t.generator : t.generator ? 'Інше' : '';
  f.generatorSel = el('select', { class: 'select', 'aria-label': 'Генератор' }, el('option', { value: '' }, '— не вказано —'), GENERATORS.map((g) => el('option', { value: g, selected: g === known }, g)));
  f.generatorOther = el('input', { class: 'input', maxlength: '40', value: known === 'Інше' ? t.generator : '', placeholder: 'Назва генератора', hidden: known !== 'Інше' });
  f.generatorSel.addEventListener('change', () => {
    f.generatorOther.hidden = f.generatorSel.value !== 'Інше';
  });
  f.model = el('input', { class: 'input', name: 'ai_model', maxlength: '80', value: t.ai_model || '', placeholder: 'Модель (напр. Suno v4.5)' });
  f.prompt = el('textarea', { class: 'input', name: 'ai_prompt', maxlength: '4000', placeholder: 'Промпт, за яким згенеровано пісню' }, t.ai_prompt || '');
  f.lyrics = el('textarea', { class: 'input', name: 'lyrics', maxlength: '8000', placeholder: 'Текст пісні (необов’язково)' }, t.lyrics || '');
  f.published = el('input', { type: 'checkbox', checked: t.published === undefined ? true : !!t.published });
  f.audio = el('input', { class: 'input', type: 'file', accept: '.mp3,.wav,.ogg,.flac,.m4a,audio/*' });
  f.cover = el('input', { class: 'input', type: 'file', accept: '.jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp' });
  f.removeCover = el('input', { type: 'checkbox' });
  return f;
}

function trackFormBody(f, { editing, track }) {
  const field = (label, node, cls = '') => el('label', { class: `field ${cls}`.trim() }, el('span', {}, label), node);
  return el(
    'div',
    { class: 'form-grid cols-2' },
    field(editing ? 'Замінити аудіо (необов’язково)' : 'Аудіо (MP3, WAV, OGG, FLAC, M4A) *', f.audio, 'span-2'),
    field(editing ? 'Замінити обкладинку' : 'Обкладинка (JPG, PNG, WEBP)', f.cover),
    editing && track.cover_url
      ? el('div', { class: 'field' }, el('span', {}, 'Поточна обкладинка'), el('div', { class: 'btn-row' }, el('div', { class: 'cover-preview' }, coverEl(track)), el('label', { class: 'check-row' }, f.removeCover, 'Прибрати')))
      : el('div'),
    field('Назва *', f.title),
    field('Автор', f.artist),
    field('Жанр', f.genre),
    field('Теги', f.tags),
    field('Генератор', el('div', { class: 'form-grid' }, f.generatorSel, f.generatorOther)),
    field('Модель', f.model),
    field('ШІ-промпт', f.prompt, 'span-2'),
    field('Текст пісні', f.lyrics, 'span-2'),
    el('label', { class: 'switch span-2' }, f.published, el('span', { class: 'switch-ui' }), el('span', {}, 'Опубліковано (видно слухачам)'))
  );
}

function collect(f, extra = {}) {
  const fd = new FormData();
  const generator = f.generatorSel.value === 'Інше' ? f.generatorOther.value.trim() : f.generatorSel.value;
  fd.set('title', f.title.value.trim());
  fd.set('artist', f.artist.value.trim());
  fd.set('genre', f.genre.value.trim());
  fd.set('tags', f.tags.value.trim());
  fd.set('generator', generator);
  fd.set('ai_model', f.model.value.trim());
  fd.set('ai_prompt', f.prompt.value);
  fd.set('lyrics', f.lyrics.value);
  fd.set('published', f.published.checked ? '1' : '0');
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  // Файли додаємо останніми: multer читає текстові поля, що йдуть до них.
  if (f.cover.files[0]) fd.set('cover', f.cover.files[0]);
  if (f.audio.files[0]) fd.set('audio', f.audio.files[0]);
  return fd;
}

async function tracks() {
  const wrap = el('div', {});
  const f = trackFormFields();
  const bar = el('i');
  const progress = el('div', { class: 'progress', hidden: true }, bar);
  const submit = el('button', { class: 'btn btn-primary', type: 'submit' }, ic('upload', 18), 'Завантажити трек');
  const form = el('form', { class: 'panel' }, el('h2', { class: 'section-title' }, ic('upload', 18), 'Новий трек'), trackFormBody(f, { editing: false }), progress, el('div', { class: 'btn-row' }, submit));
  const tableBox = el('div', {});

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const audio = f.audio.files[0];
    if (!audio) return toast('Оберіть аудіофайл', 'error');
    if (!f.title.value.trim()) return toast('Вкажіть назву треку', 'error');
    submit.disabled = true;
    progress.hidden = false;
    bar.style.width = '0%';
    try {
      const duration = await readDuration(audio);
      const fd = collect(f, { duration: String(duration || 0) });
      await uploadForm('POST', '/api/tracks', fd, (r) => (bar.style.width = `${Math.round(r * 100)}%`));
      toast('Трек завантажено', 'success');
      showTab('tracks');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      submit.disabled = false;
      progress.hidden = true;
    }
  });

  async function loadTable() {
    const data = await api.get('/api/tracks?limit=100&sort=new');
    if (!data.tracks.length) {
      tableBox.replaceChildren(el('div', { class: 'empty' }, ic('music', 32), el('p', {}, 'Треків ще немає — завантажте перший вище.')));
      return;
    }
    const rows = data.tracks.map((t) => {
      const pub = el('input', { type: 'checkbox', checked: t.published, 'aria-label': 'Опубліковано' });
      pub.addEventListener('change', async () => {
        try {
          await api.put(`/api/tracks/${t.id}`, { published: pub.checked });
          toast(pub.checked ? 'Опубліковано' : 'Приховано', 'success', 1800);
        } catch (err) {
          pub.checked = !pub.checked;
          toast(err.message, 'error');
        }
      });
      return el(
        'tr',
        {},
        el('td', {}, el('div', { class: 'cell-track' }, el('div', { class: 'cover-preview', style: { width: '46px' } }, coverEl(t, 'sm')), el('div', {}, el('a', { href: `/track/${t.id}` }, el('b', {}, t.title)), el('small', {}, t.artist || '—')))),
        el('td', {}, t.genre || '—'),
        el('td', {}, [t.generator, t.ai_model].filter(Boolean).join(' · ') || '—'),
        el('td', { class: 'num' }, t.duration ? fmtTime(t.duration) : '—'),
        el('td', { class: 'num' }, fmtNum(t.plays)),
        el('td', { class: 'num' }, fmtNum(t.likes)),
        el('td', { class: 'num' }, fmtNum(t.comments)),
        el('td', {}, el('label', { class: 'switch' }, pub, el('span', { class: 'switch-ui' }))),
        el(
          'td',
          {},
          el(
            'div',
            { class: 'actions' },
            el('button', { class: 'btn-icon sm', type: 'button', title: 'Редагувати', 'aria-label': 'Редагувати', onclick: () => editTrack(t) }, ic('edit', 16)),
            el(
              'button',
              {
                class: 'btn-icon sm',
                type: 'button',
                title: 'Видалити назавжди',
                'aria-label': 'Видалити',
                onclick: async () => {
                  if (!(await confirmDialog(`Видалити «${t.title}»? Аудіо та обкладинку буде стерто з диска, коментарі й лайки — також.`, { okText: 'Видалити назавжди', danger: true }))) return;
                  try {
                    await api.del(`/api/tracks/${t.id}`);
                    toast('Трек і файли видалено', 'success');
                    showTab('tracks');
                  } catch (err) {
                    toast(err.message, 'error');
                  }
                },
              },
              ic('trash', 16)
            )
          )
        )
      );
    });
    tableBox.replaceChildren(
      el(
        'div',
        { class: 'table-wrap' },
        el(
          'table',
          { class: 'tbl' },
          el('thead', {}, el('tr', {}, ['Трек', 'Жанр', 'ШІ', 'Тривалість', '▶', '♥', '💬', 'Публ.', ''].map((h, i) => el('th', { class: i >= 3 && i <= 6 ? 'num' : '' }, h)))),
          el('tbody', {}, rows)
        )
      )
    );
  }

  wrap.append(form, el('h2', { class: 'section-title' }, ic('list', 18), 'Усі треки'), tableBox);
  await loadTable();
  return wrap;
}

function editTrack(t) {
  const f = trackFormFields(t);
  const submit = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Зберегти');
  const bar = el('i');
  const progress = el('div', { class: 'progress', hidden: true }, bar);
  const form = el('form', {}, trackFormBody(f, { editing: true, track: t }), progress);
  const modal = openModal({ title: `Редагувати: ${t.title}`, size: 'lg', body: form, footer: [el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => modal.close() }, 'Скасувати'), submit] });
  const run = async () => {
    if (!f.title.value.trim()) return toast('Назва не може бути порожньою', 'error');
    submit.disabled = true;
    progress.hidden = false;
    try {
      const extra = {};
      if (f.removeCover.checked) extra.remove_cover = '1';
      const audio = f.audio.files[0];
      if (audio) extra.duration = String((await readDuration(audio)) || 0);
      await uploadForm('PUT', `/api/tracks/${t.id}`, collect(f, extra), (r) => (bar.style.width = `${Math.round(r * 100)}%`));
      toast('Збережено', 'success');
      modal.close();
      showTab('tracks');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      submit.disabled = false;
      progress.hidden = true;
    }
  };
  submit.addEventListener('click', run);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    run();
  });
}

/* ------------------------------- Коментарі ------------------------------- */

async function comments() {
  const { comments: list } = await api.get('/api/admin/comments?limit=200');
  if (!list.length) return el('div', { class: 'empty' }, ic('comment', 32), el('p', {}, 'Коментарів поки немає.'));
  const rows = list.map((c) =>
    el(
      'tr',
      {},
      el('td', {}, el('b', {}, c.username), c.role === 'admin' ? el('span', { class: 'chip chip-accent' }, 'адмін') : null),
      el('td', {}, el('a', { href: `/track/${c.track_id}` }, c.track_title), el('small', { class: 'muted' }, ` @ ${fmtTime(c.time)}`)),
      el('td', { class: 'cell-text' }, c.text),
      el('td', {}, timeAgo(c.created_at)),
      el(
        'td',
        {},
        el(
          'button',
          {
            class: 'btn-icon sm',
            type: 'button',
            title: 'Видалити',
            'aria-label': 'Видалити коментар',
            onclick: async () => {
              if (!(await confirmDialog('Видалити цей коментар?', { okText: 'Видалити', danger: true }))) return;
              try {
                await api.del(`/api/comments/${c.id}`);
                showTab('comments');
              } catch (err) {
                toast(err.message, 'error');
              }
            },
          },
          ic('trash', 16)
        )
      )
    )
  );
  return el('div', { class: 'table-wrap' }, el('table', { class: 'tbl' }, el('thead', {}, el('tr', {}, ['Автор', 'Трек', 'Текст', 'Коли', ''].map((h) => el('th', {}, h)))), el('tbody', {}, rows)));
}

/* ------------------------------ Користувачі ------------------------------ */

async function users() {
  const { users: list } = await api.get('/api/users');
  const wrap = el('div', {});

  const username = el('input', { class: 'input', placeholder: 'Логін', minlength: '3', maxlength: '24', required: true, autocomplete: 'off' });
  const password = el('input', { class: 'input', type: 'password', placeholder: 'Пароль (від 8 символів)', minlength: '8', required: true, autocomplete: 'new-password' });
  const role = el('select', { class: 'select' }, el('option', { value: 'user' }, 'Користувач'), el('option', { value: 'admin' }, 'Адміністратор'));
  const add = el('form', { class: 'panel' }, el('h2', { class: 'section-title' }, ic('plus', 18), 'Додати користувача'), el('div', { class: 'form-inline' }, username, password, role, el('button', { class: 'btn btn-primary', type: 'submit' }, 'Створити')));
  add.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.post('/api/users', { username: username.value.trim(), password: password.value, role: role.value });
      toast('Користувача створено', 'success');
      showTab('users');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  const rows = list.map((u) => {
    const self = state.user && u.id === state.user.id;
    return el(
      'tr',
      {},
      el('td', {}, el('b', {}, u.username), self ? el('small', { class: 'muted' }, ' (ви)') : null),
      el('td', {}, u.role === 'admin' ? el('span', { class: 'chip chip-accent' }, 'адмін') : el('span', { class: 'chip' }, 'користувач')),
      el('td', { class: 'num' }, fmtNum(u.likes)),
      el('td', { class: 'num' }, fmtNum(u.comments)),
      el('td', {}, fmtDate(u.created_at)),
      el(
        'td',
        {},
        el(
          'div',
          { class: 'actions' },
          el(
            'button',
            {
              class: 'btn-icon sm',
              type: 'button',
              title: u.role === 'admin' ? 'Зробити звичайним користувачем' : 'Зробити адміністратором',
              'aria-label': 'Змінити роль',
              onclick: async () => {
                try {
                  await api.put(`/api/users/${u.id}`, { role: u.role === 'admin' ? 'user' : 'admin' });
                  showTab('users');
                } catch (err) {
                  toast(err.message, 'error');
                }
              },
            },
            ic('shield', 16)
          ),
          el(
            'button',
            {
              class: 'btn-icon sm',
              type: 'button',
              title: 'Скинути пароль',
              'aria-label': 'Скинути пароль',
              onclick: () => resetPassword(u),
            },
            ic('lock', 16)
          ),
          self
            ? null
            : el(
                'button',
                {
                  class: 'btn-icon sm',
                  type: 'button',
                  title: 'Видалити',
                  'aria-label': 'Видалити користувача',
                  onclick: async () => {
                    if (!(await confirmDialog(`Видалити користувача «${u.username}» разом з його лайками та коментарями?`, { okText: 'Видалити', danger: true }))) return;
                    try {
                      await api.del(`/api/users/${u.id}`);
                      showTab('users');
                    } catch (err) {
                      toast(err.message, 'error');
                    }
                  },
                },
                ic('trash', 16)
              )
        )
      )
    );
  });
  wrap.append(add, el('div', { class: 'table-wrap', style: { marginTop: '18px' } }, el('table', { class: 'tbl' }, el('thead', {}, el('tr', {}, ['Логін', 'Роль', '♥', '💬', 'Реєстрація', ''].map((h, i) => el('th', { class: i === 2 || i === 3 ? 'num' : '' }, h)))), el('tbody', {}, rows))));
  return wrap;
}

function resetPassword(u) {
  const input = el('input', { class: 'input', type: 'password', minlength: '8', maxlength: '128', placeholder: 'Новий пароль', autocomplete: 'new-password', required: true });
  const save = el('button', { class: 'btn btn-primary', type: 'button' }, 'Зберегти');
  const modal = openModal({ title: `Новий пароль для ${u.username}`, size: 'sm', body: el('label', { class: 'field' }, el('span', {}, 'Пароль'), input), footer: [save] });
  const run = async () => {
    try {
      await api.put(`/api/users/${u.id}`, { password: input.value });
      toast('Пароль оновлено', 'success');
      modal.close();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  save.addEventListener('click', run);
  input.addEventListener('keydown', (e) => e.key === 'Enter' && run());
}

/* ----------------------- Налаштування та Smart Home ---------------------- */

async function settings() {
  const s = await api.get('/api/admin/settings');
  const wh = s.webhook;
  const wrap = el('div', {});

  const siteName = el('input', { class: 'input', maxlength: '40', value: s.siteName });
  const reg = el('input', { type: 'checkbox', checked: s.registrationOpen });
  const siteForm = el(
    'form',
    { class: 'panel' },
    el('h2', { class: 'section-title' }, ic('settings', 18), 'Сайт'),
    el('div', { class: 'form-grid cols-2' }, el('label', { class: 'field' }, el('span', {}, 'Назва сайту'), siteName), el('label', { class: 'switch' }, reg, el('span', { class: 'switch-ui' }), el('span', {}, 'Відкрита реєстрація'))),
    el('div', { class: 'btn-row', style: { marginTop: '14px' } }, el('button', { class: 'btn btn-primary btn-sm', type: 'submit' }, 'Зберегти'))
  );
  siteForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.put('/api/admin/settings', { siteName: siteName.value.trim(), registrationOpen: reg.checked });
      toast('Збережено', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  const url = el('input', { class: 'input', type: 'url', value: wh.url, placeholder: 'http://homeassistant.local:8123/api/webhook/ai-waves' });
  const secret = el('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: wh.hasSecret ? '•••••• збережено (залиште порожнім, щоб не змінювати)' : 'Необов’язковий секрет для підпису' });
  const clearSecret = el('input', { type: 'checkbox' });
  const enabled = el('input', { type: 'checkbox', checked: wh.enabled });
  const scope = el('select', { class: 'select' }, el('option', { value: 'admin', selected: wh.scope === 'admin' }, 'Лише коли слухає адміністратор'), el('option', { value: 'all', selected: wh.scope === 'all' }, 'Коли слухає будь-хто'));
  const evChecks = [
    ['play', 'Старт / продовження'],
    ['pause', 'Пауза'],
    ['track_change', 'Зміна треку'],
  ].map(([key, label]) => ({ key, box: el('input', { type: 'checkbox', checked: wh.events.includes(key) }), label }));
  const last = el('div', { class: 'adm-note' });
  const paintLast = (r) => {
    if (!r) {
      last.textContent = 'Запитів ще не було.';
      return;
    }
    last.replaceChildren(el('b', { class: r.ok ? 'result-ok' : 'result-bad' }, r.ok ? `OK ${r.status}` : `Помилка: ${r.error || r.status}`), ` · подія «${r.event}» · ${timeAgo(r.at)}`);
  };
  paintLast(wh.last);

  const test = el('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, ic('zap', 16), 'Надіслати тест');
  const hookForm = el(
    'form',
    { class: 'panel' },
    el('h2', { class: 'section-title' }, ic('zap', 18), 'Smart Home Webhook'),
    el('p', { class: 'muted small' }, 'При старті, паузі та зміні треку сервер надсилає POST із JSON: метадані треку, кольори обкладинки, позиція. Використовуйте для Home Assistant, ESP32, Node-RED тощо.'),
    el(
      'div',
      { class: 'form-grid' },
      el('label', { class: 'field' }, el('span', {}, 'URL (локальна адреса теж підходить)'), url),
      el('label', { class: 'field' }, el('span', {}, 'Секрет (Bearer + HMAC-підпис X-AIWaves-Signature)'), secret),
      wh.hasSecret ? el('label', { class: 'check-row' }, clearSecret, 'Видалити збережений секрет') : null,
      el('label', { class: 'field' }, el('span', {}, 'Коли відправляти'), scope),
      el('div', { class: 'field' }, el('span', {}, 'Події'), el('div', { class: 'check-row' }, evChecks.map((c) => el('label', {}, c.box, c.label)))),
      el('label', { class: 'switch' }, enabled, el('span', { class: 'switch-ui' }), el('span', {}, 'Вебхук увімкнено'))
    ),
    el('div', { class: 'btn-row', style: { margin: '16px 0 12px' } }, el('button', { class: 'btn btn-primary btn-sm', type: 'submit' }, 'Зберегти'), test),
    last
  );
  hookForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { url: url.value.trim(), enabled: enabled.checked, scope: scope.value, events: evChecks.filter((c) => c.box.checked).map((c) => c.key) };
    if (clearSecret.checked) body.secret = '';
    else if (secret.value) body.secret = secret.value;
    try {
      await api.put('/api/admin/settings', { webhook: body });
      toast('Вебхук збережено', 'success');
      showTab('settings');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  test.addEventListener('click', async () => {
    test.disabled = true;
    try {
      const { result } = await api.post('/api/admin/webhook/test');
      paintLast(result);
      toast(result.ok ? 'Тест доставлено' : `Не вдалося: ${result.error}`, result.ok ? 'success' : 'error');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      test.disabled = false;
    }
  });

  const sample = JSON.stringify(
    {
      source: 'ai-waves',
      event: 'track_change',
      timestamp: '2026-01-01T20:00:00.000Z',
      playing: true,
      position: 0,
      room: null,
      user: 'admin',
      colors: ['#7c5cff', '#00e5ff', '#ff3d9a'],
      track: { id: 7, title: 'Neon Rain', artist: 'AI', genre: 'synthwave', tags: ['night'], generator: 'Suno', model: 'v4.5', duration: 184.2, cover_url: 'https://example.com/uploads/covers/….jpg', page_url: 'https://example.com/track/7' },
    },
    null,
    2
  );
  const ha = `# Home Assistant: automation.yaml
alias: AI Waves → світло
trigger:
  - platform: webhook
    webhook_id: ai-waves
    allowed_methods: [POST]
    local_only: false
action:
  - service: light.turn_on
    target: { entity_id: light.led_strip }
    data:
      rgb_color: >
        {% set c = trigger.json.colors[0].lstrip('#') %}
        {{ [c[0:2]|int(base=16), c[2:4]|int(base=16), c[4:6]|int(base=16)] }}
      brightness_pct: "{{ 80 if trigger.json.playing else 25 }}"`;
  const docs = el('section', { class: 'panel' }, el('h2', { class: 'section-title' }, ic('list', 18), 'Формат запиту'), el('pre', { class: 'code-block' }, sample), el('h3', { style: { margin: '18px 0 10px' } }, 'Приклад для Home Assistant'), el('pre', { class: 'code-block' }, ha));

  wrap.append(siteForm, hookForm, docs);
  return wrap;
}

/* --------------------------------- Старт --------------------------------- */

(async function start() {
  try {
    const { user } = await api.get('/api/auth/me');
    if (user && user.role === 'admin') {
      state.user = user;
      renderShell();
    } else {
      renderLogin(user ? 'Цей акаунт не має прав адміністратора. Увійдіть під адміном.' : '');
    }
  } catch (err) {
    renderLogin(err.message);
  }
})();
