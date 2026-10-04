/* Модальні вікна: стек, Esc, фокус-пастка, підтвердження. */

import { el, icon } from './util.js';

const stack = [];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function onKeydown(e) {
  const top = stack[stack.length - 1];
  if (!top) return;
  if (e.key === 'Escape' && top.dismissible) {
    e.preventDefault();
    e.stopPropagation();
    top.close();
    return;
  }
  if (e.key === 'Tab') {
    const nodes = Array.from(top.dialog.querySelectorAll(FOCUSABLE)).filter((n) => n.offsetParent !== null);
    if (!nodes.length) {
      e.preventDefault();
      return;
    }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

/**
 * Відкриває модальне вікно.
 * @param {object} opts { title, body: Node|string, footer: Node, size: 'sm'|'md'|'lg', dismissible, onClose, className }
 * @returns {{ close: Function, body: HTMLElement, dialog: HTMLElement }}
 */
export function openModal(opts = {}) {
  const { title = '', body = null, footer = null, size = 'md', dismissible = true, onClose = null, className = '' } = opts;
  const root = document.getElementById('modal-root');
  const prevFocus = document.activeElement;

  const overlay = el('div', { class: 'modal-overlay' });
  const closeBtn = el('button', { class: 'btn-icon sm modal-x', type: 'button', 'aria-label': 'Закрити', html: icon('x', 18) });
  const head = el('div', { class: 'modal-head' }, el('h3', {}, title), dismissible ? closeBtn : null);
  const content = el('div', { class: 'modal-body' });
  if (typeof body === 'string') content.textContent = body;
  else if (body) content.append(body);
  const dialog = el(
    'div',
    { class: `modal modal-${size} ${className}`.trim(), role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Діалог', tabindex: '-1' },
    title || dismissible ? head : null,
    content,
    footer ? el('div', { class: 'modal-foot' }, footer) : null
  );
  overlay.append(dialog);
  root.append(overlay);
  document.body.classList.add('modal-open');

  let closed = false;
  const handle = {
    body: content,
    dialog,
    close() {
      if (closed) return;
      closed = true;
      const i = stack.indexOf(handle);
      if (i >= 0) stack.splice(i, 1);
      overlay.classList.add('closing');
      setTimeout(() => overlay.remove(), 180);
      if (!stack.length) {
        document.body.classList.remove('modal-open');
        document.removeEventListener('keydown', onKeydown, true);
      }
      if (prevFocus && typeof prevFocus.focus === 'function' && document.contains(prevFocus)) {
        try {
          prevFocus.focus({ preventScroll: true });
        } catch (_) {
          /* елемент недоступний */
        }
      }
      if (typeof onClose === 'function') onClose();
    },
    dialog,
    dismissible,
  };

  closeBtn.addEventListener('click', () => handle.close());
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay && dismissible) handle.close();
  });

  if (!stack.length) document.addEventListener('keydown', onKeydown, true);
  stack.push(handle);

  requestAnimationFrame(() => {
    overlay.classList.add('show');
    const auto = dialog.querySelector('[autofocus]') || dialog.querySelector('input, textarea, select');
    (auto || dialog).focus({ preventScroll: true });
  });
  return handle;
}

export function confirmDialog(message, { title = 'Підтвердіть дію', okText = 'Так', cancelText = 'Скасувати', danger = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
      modal.close();
    };
    const ok = el('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'button', onclick: () => finish(true) }, okText);
    const cancel = el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => finish(false) }, cancelText);
    const modal = openModal({
      title,
      size: 'sm',
      body: el('p', { class: 'modal-text' }, message),
      footer: [cancel, ok],
      onClose: () => finish(false),
    });
    setTimeout(() => ok.focus(), 30);
  });
}

export function closeAllModals() {
  while (stack.length) stack[stack.length - 1].close();
}
