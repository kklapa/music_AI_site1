/* Авторизація: поточний користувач, модальне вікно входу/реєстрації. */

import { api } from './api.js';
import { state, emit } from './state.js';
import { openModal } from './modal.js';
import { el, toast } from './util.js';
import { reconnectSocket } from './socket.js';

export function setUser(user) {
  state.user = user || null;
  emit('auth', state.user);
}

export async function refreshUser() {
  try {
    const data = await api.get('/api/auth/me');
    setUser(data.user);
  } catch (_) {
    setUser(null);
  }
}

export async function logout() {
  try {
    await api.post('/api/auth/logout');
  } catch (_) {
    /* навіть якщо мережа впала — локально виходимо */
  }
  setUser(null);
  reconnectSocket();
  toast('Ви вийшли з акаунту');
}

export const isAdmin = () => !!(state.user && state.user.role === 'admin');

/**
 * Показує форму входу/реєстрації. Повертає Promise<boolean>: true, якщо користувач увійшов.
 */
export function openAuth(initialMode = 'login', reason = '') {
  return new Promise((resolve) => {
    let mode = initialMode === 'register' && state.site.registrationOpen ? 'register' : 'login';
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      resolve(ok);
    };

    const error = el('div', { class: 'form-error', role: 'alert', hidden: true });
    const username = el('input', {
      class: 'input',
      name: 'username',
      type: 'text',
      required: true,
      minlength: '3',
      maxlength: '24',
      autocomplete: 'username',
      autocapitalize: 'none',
      spellcheck: 'false',
      placeholder: 'Логін',
      autofocus: true,
    });
    const password = el('input', {
      class: 'input',
      name: 'password',
      type: 'password',
      required: true,
      minlength: '8',
      maxlength: '128',
      autocomplete: 'current-password',
      placeholder: 'Пароль (мінімум 8 символів)',
    });
    const submit = el('button', { class: 'btn btn-primary btn-block', type: 'submit' });
    const hint = el('p', { class: 'form-hint' });
    const tabLogin = el('button', { class: 'tab', type: 'button', role: 'tab' }, 'Вхід');
    const tabReg = el('button', { class: 'tab', type: 'button', role: 'tab' }, 'Реєстрація');

    const form = el(
      'form',
      { class: 'form', novalidate: true },
      reason ? el('p', { class: 'form-reason' }, reason) : null,
      el('div', { class: 'tabs tabs-pill', role: 'tablist' }, tabLogin, state.site.registrationOpen ? tabReg : null),
      el('label', { class: 'field' }, el('span', {}, 'Логін'), username),
      el('label', { class: 'field' }, el('span', {}, 'Пароль'), password),
      error,
      submit,
      hint
    );

    const modal = openModal({
      title: 'Ласкаво просимо',
      size: 'sm',
      body: form,
      onClose: () => finish(!!state.user),
    });

    function paint() {
      const reg = mode === 'register';
      tabLogin.classList.toggle('active', !reg);
      tabReg.classList.toggle('active', reg);
      tabLogin.setAttribute('aria-selected', String(!reg));
      tabReg.setAttribute('aria-selected', String(reg));
      submit.textContent = reg ? 'Створити акаунт' : 'Увійти';
      password.autocomplete = reg ? 'new-password' : 'current-password';
      hint.textContent = reg
        ? 'Реєстрація дозволяє ставити лайки, коментувати таймлайн і створювати кімнати.'
        : state.site.registrationOpen
        ? 'Ще немає акаунту? Перейдіть на вкладку «Реєстрація».'
        : 'Реєстрацію вимкнено адміністратором.';
      error.hidden = true;
    }
    tabLogin.addEventListener('click', () => {
      mode = 'login';
      paint();
    });
    tabReg.addEventListener('click', () => {
      mode = 'register';
      paint();
    });
    paint();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.hidden = true;
      const u = username.value.trim();
      const p = password.value;
      if (u.length < 3) return showError('Логін: щонайменше 3 символи');
      if (p.length < 8) return showError('Пароль має містити щонайменше 8 символів');
      submit.disabled = true;
      try {
        const data = await api.post(mode === 'register' ? '/api/auth/register' : '/api/auth/login', {
          username: u,
          password: p,
        });
        setUser(data.user);
        reconnectSocket();
        toast(mode === 'register' ? `Вітаємо, ${data.user.username}!` : `З поверненням, ${data.user.username}`, 'success');
        finish(true);
        modal.close();
      } catch (err) {
        showError(err.message);
      } finally {
        submit.disabled = false;
      }
    });

    function showError(msg) {
      error.textContent = msg;
      error.hidden = false;
    }
  });
}

/** Гарантує, що користувач увійшов; інакше показує форму. */
export async function ensureAuth(reason = '') {
  if (state.user) return true;
  return openAuth('login', reason);
}
