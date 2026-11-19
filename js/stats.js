// Estatísticas de leitura: tempo ativo por sessão (loja "sessions") + funções puras de agregação.
// Cada registro = um livro em um dia local: { id, bookId, day:'AAAA-MM-DD', seconds, updatedAt }.
import * as db from './db.js';

export const DEFAULT_GOALS = { dailyMin: 20, monthlyBooks: 2 };
const IDLE_MS = 3 * 60 * 1000, TICK_MS = 5000, FLUSH_MS = 15000;

export const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const monthKey = (d = new Date()) => dayKey(d).slice(0, 7);
export const parseDay = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (k, n) => { const d = parseDay(k); d.setDate(d.getDate() + n); return dayKey(d); };

/** Soma segundos por dia. */
export function byDay(sessions) {
  const m = new Map();
  for (const s of sessions) m.set(s.day, (m.get(s.day) || 0) + (s.seconds || 0));
  return m;
}
export function byBook(sessions) {
  const m = new Map();
  for (const s of sessions) m.set(s.bookId, (m.get(s.bookId) || 0) + (s.seconds || 0));
  return m;
}

/** Sequência de dias seguidos com leitura (>= minSec). Se hoje ainda não leu, a sequência de ontem continua valendo. */
export function streaks(days, today = dayKey(), minSec = 60) {
  const read = (k) => (days.get(k) || 0) >= minSec;
  let cur = 0, k = read(today) ? today : addDays(today, -1);
  while (read(k)) { cur++; k = addDays(k, -1); }
  const keys = [...days.keys()].filter(read).sort();
  let best = 0, run = 0, prev = null;
  for (const key of keys) { run = prev && addDays(prev, 1) === key ? run + 1 : 1; best = Math.max(best, run); prev = key; }
  return { current: cur, best };
}

/** Últimos n dias (do mais antigo ao mais novo) com segundos lidos. */
export function lastDays(days, n, today = dayKey()) {
  return Array.from({ length: n }, (_, i) => { const k = addDays(today, i - (n - 1)); return { day: k, seconds: days.get(k) || 0 }; });
}

export const sumMonth = (days, mk) => [...days].filter(([k]) => k.startsWith(mk)).reduce((a, [, v]) => a + v, 0);

export function booksFinishedIn(books, mk) {
  return books.filter((b) => b.finishedAt && monthKey(new Date(b.finishedAt)) === mk).length;
}

export function fmtDuration(sec) {
  const m = Math.round(sec / 60);
  if (m < 1) return sec >= 5 ? '<1 min' : '0 min';
  if (m < 60) return `${m} min`;
  const hh = Math.floor(m / 60), mm = m % 60;
  return mm ? `${hh} h ${mm} min` : `${hh} h`;
}

export const loadSessions = () => db.getAll('sessions');

/**
 * Mede o tempo de leitura ativo: conta só com a aba visível e interação recente (ping/entrada do usuário).
 * Grava a cada 15 s e ao sair, então um fechamento brusco perde no máximo alguns segundos.
 */
export function startTracking(bookId) {
  const sid = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let last = Date.now(), lastAct = last, day = dayKey(), acc = 0, stopped = false;
  const rec = new Map(); // day -> seconds já gravados nesta sessão

  const ping = () => { lastAct = Date.now(); };
  const evs = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'];
  evs.forEach((e) => window.addEventListener(e, ping, { passive: true, capture: true }));

  function tick() {
    const now = Date.now(), dt = Math.min(now - last, TICK_MS * 3);
    last = now;
    if (document.visibilityState === 'visible' && now - lastAct < IDLE_MS) {
      if (dayKey() !== day) { flush(); day = dayKey(); acc = 0; } // virou o dia: fecha o registro anterior e recomeça
      acc += dt;
    }
  }
  async function flush() {
    const d = day, sec = Math.floor(acc / 1000);
    if (sec < 5 || sec === rec.get(d)) return;
    rec.set(d, sec);
    try { await db.put('sessions', { id: `${sid}-${d}`, bookId, day: d, seconds: sec, updatedAt: Date.now() }); } catch { rec.delete(d); /* tenta de novo no próximo ciclo */ }
  }
  const t1 = setInterval(tick, TICK_MS), t2 = setInterval(flush, FLUSH_MS);
  const onHide = () => { tick(); flush(); };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onHide);
  return {
    ping,
    async stop() {
      if (stopped) return; stopped = true;
      clearInterval(t1); clearInterval(t2); tick();
      evs.forEach((e) => window.removeEventListener(e, ping, { capture: true }));
      document.removeEventListener('visibilitychange', onHide); window.removeEventListener('pagehide', onHide);
      await flush();
    },
  };
}
