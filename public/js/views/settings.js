/* Налаштування плеєра (зберігаються локально в браузері). */

import { state, settings, saveSettings } from '../state.js';
import { el, toast } from '../util.js';
import { openModal } from '../modal.js';
import { ic } from '../ui.js';

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

export function openSettings() {
  const cfLabel = el('output', { class: 'range-out' }, `${settings.crossfade} с`);
  const crossfade = el('input', { type: 'range', min: '0', max: '12', step: '1', value: String(settings.crossfade), 'aria-label': 'Тривалість кросфейду' });
  crossfade.addEventListener('input', () => {
    cfLabel.textContent = crossfade.value === '0' ? 'вимкнено' : `${crossfade.value} с`;
    saveSettings({ crossfade: Number(crossfade.value) });
  });
  if (settings.crossfade === 0) cfLabel.textContent = 'вимкнено';

  const toggle = (key, label, hint, onChange) => {
    const input = el('input', { type: 'checkbox', checked: !!settings[key] });
    input.addEventListener('change', () => {
      saveSettings({ [key]: input.checked });
      if (onChange) onChange(input.checked);
    });
    return el('label', { class: 'setting switch-row' }, el('span', { class: 'setting-text' }, el('b', {}, label), el('small', { class: 'muted' }, hint)), el('span', { class: 'switch' }, input, el('span', { class: 'switch-ui' })));
  };

  const body = el(
    'div',
    { class: 'settings' },
    el('div', { class: 'setting' }, el('span', { class: 'setting-text' }, el('b', {}, 'Кросфейд між треками'), el('small', { class: 'muted' }, 'Плавний перехід: наступний трек вмикається, поки закінчується поточний.')), el('div', { class: 'range-row' }, crossfade, cfLabel)),
    toggle('webAudio', 'Візуалізатор і Web Audio', 'Анімація частот у повноекранному плеєрі. Якщо на iPhone звук обривається при блокуванні екрана — вимкніть і перезавантажте сторінку.', (on) => {
      if (!on) toast('Перезавантажте сторінку, щоб повністю вимкнути Web Audio', 'info', 4500);
    }),
    toggle('bubbles', 'Бульбашки коментарів', 'Показувати коментар над обкладинкою, коли трек доходить до його секунди.'),
    el(
      'div',
      { class: 'setting' },
      el('span', { class: 'setting-text' }, el('b', {}, 'Гарячі клавіші')),
      el(
        'dl',
        { class: 'hotkeys' },
        [
          ['Пробіл', 'грати / пауза'],
          ['← →', 'перемотка ±5 с'],
          ['↑ ↓', 'гучність'],
          ['N / P', 'наступний / попередній'],
          ['M', 'вимкнути звук'],
          ['Esc', 'згорнути плеєр'],
        ].map(([k, v]) => [el('dt', {}, el('kbd', {}, k)), el('dd', {}, v)])
      )
    )
  );

  if (state.installPrompt) {
    body.append(
      el(
        'div',
        { class: 'setting' },
        el('span', { class: 'setting-text' }, el('b', {}, 'Встановити застосунок'), el('small', { class: 'muted' }, 'Іконка на робочому столі, повноекранний режим і керування з екрана блокування.')),
        el('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => document.getElementById('installBtn').click() }, ic('download', 16), 'Встановити')
      )
    );
  } else if (isIos() && !isStandalone()) {
    body.append(el('div', { class: 'setting' }, el('span', { class: 'setting-text' }, el('b', {}, 'Встановити на iPhone / iPad'), el('small', { class: 'muted' }, 'Safari → «Поділитися» → «На початковий екран».'))));
  }

  openModal({ title: 'Налаштування', body, size: 'md' });
}
