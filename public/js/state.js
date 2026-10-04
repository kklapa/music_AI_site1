/* Глобальний стан, шина подій і налаштування користувача (localStorage). */

export const bus = new EventTarget();

export function emit(name, detail) {
  bus.dispatchEvent(new CustomEvent(name, { detail }));
}

export function on(name, fn) {
  const handler = (e) => fn(e.detail);
  bus.addEventListener(name, handler);
  return () => bus.removeEventListener(name, handler);
}

export const state = {
  user: null,
  site: { siteName: 'AI Waves', registrationOpen: true, maxAudioMb: 100 },
  installPrompt: null,
};

const KEY = 'aiwaves.settings.v1';
const defaults = {
  crossfade: 3,
  volume: 0.9,
  webAudio: true,
  bubbles: true,
  shuffle: false,
  repeat: 'off',
};

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') || {};
  } catch (_) {
    return {};
  }
}

export const settings = { ...defaults, ...load() };

export function saveSettings(patch) {
  Object.assign(settings, patch);
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch (_) {
    /* приватний режим — ігноруємо */
  }
  emit('settings', settings);
}

/** Кеш треків за id: потрібен, щоб миттєво відкривати треки з кімнат і сторінок. */
export const trackCache = new Map();

export function cacheTrack(track) {
  if (!track || !track.id) return track;
  const prev = trackCache.get(track.id);
  const merged = prev ? Object.assign(prev, track) : track;
  trackCache.set(track.id, merged);
  return merged;
}

export function cacheTracks(list) {
  return list.map(cacheTrack);
}
