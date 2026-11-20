import { DEFAULTS } from './config.js';
import * as db from './db.js';

const cache = { ...DEFAULTS };

export async function initSettings() {
  try {
    for (const row of await db.getAll('settings')) cache[row.key] = row.value;
  } catch { /* usa padrões */ }
}

export const getSetting = (key) => cache[key];

const mq = window.matchMedia('(prefers-color-scheme: dark)');
export function applyTheme(pref = cache.theme) {
  const dark = pref === 'dark' || (pref === 'auto' && mq.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#111518' : '#F6F9FB');
}
/** Escala da interface, contraste, movimento e tamanho das capas. */
export function applyAppearance() {
  const d = document.documentElement;
  d.style.zoom = cache.uiScale && cache.uiScale !== 100 ? String(cache.uiScale / 100) : '';
  d.dataset.contrast = cache.contrast === 'high' ? 'high' : 'normal';
  d.dataset.motion = cache.motion === 'reduce' ? 'reduce' : 'auto';
  d.style.setProperty('--grid-k', String({ small: 0.82, medium: 1, large: 1.3 }[cache.gridSize] || 1));
}
export const watchSystemTheme = () => mq.addEventListener('change', () => cache.theme === 'auto' && applyTheme());

export async function setSetting(key, value) {
  cache[key] = value;
  await db.put('settings', { key, value, updatedAt: Date.now() });
}
