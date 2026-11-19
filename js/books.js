// Funções puras (sem DOM/banco) para status, busca, filtros e ordenação. Testáveis em Node.

export const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export const cleanIsbn = (s) => String(s ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();

export function isValidIsbn(s) {
  const c = cleanIsbn(s);
  if (c.length === 13) {
    if (!/^97[89]\d{10}$/.test(c)) return false;
    let sum = 0;
    for (let i = 0; i < 13; i++) sum += Number(c[i]) * (i % 2 ? 3 : 1);
    return sum % 10 === 0;
  }
  if (c.length === 10) {
    if (!/^\d{9}[\dX]$/.test(c)) return false;
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += (c[i] === 'X' ? 10 : Number(c[i])) * (10 - i);
    return sum % 11 === 0;
  }
  return false;
}

export function findIsbn(strings) {
  for (const s of strings) {
    for (const m of String(s).match(/[0-9][0-9\- ]{8,16}[0-9Xx]/g) || []) {
      if (isValidIsbn(m)) return cleanIsbn(m);
    }
  }
  return '';
}

export function bookStatus(b) {
  if (b.finishedAt || (b.progress ?? 0) >= 0.98) return 'concluido';
  if ((b.progress ?? 0) > 0 || b.lastReadAt) return 'andamento';
  return 'nao-iniciado';
}

export function matchesQuery(b, query) {
  const tokens = norm(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const hay = norm(`${b.title} ${b.author}`);
  const isbn = cleanIsbn(b.isbn);
  return tokens.every((t) => hay.includes(t) || (cleanIsbn(t).length >= 4 && isbn.includes(cleanIsbn(t))));
}

const DAY = 86400000;
export const FILTERS = {
  todos: () => true,
  favoritos: (b) => !!b.favorite,
  recentes: (b, now = Date.now()) => now - b.addedAt < 30 * DAY,
  andamento: (b) => bookStatus(b) === 'andamento',
  'nao-iniciado': (b) => bookStatus(b) === 'nao-iniciado',
  concluido: (b) => bookStatus(b) === 'concluido',
};

const cmp = (a, b) => String(a || '').localeCompare(String(b || ''), 'pt', { sensitivity: 'base', numeric: true });

export function sortBooks(list, key) {
  const out = [...list];
  const by = {
    title: (a, b) => cmp(a.title, b.title),
    author: (a, b) => cmp(a.author || '￿', b.author || '￿') || cmp(a.title, b.title),
    'added-desc': (a, b) => b.addedAt - a.addedAt,
    'read-desc': (a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0) || b.addedAt - a.addedAt,
  }[key] || (() => 0);
  return out.sort(by);
}

export function applyView(books, { query = '', filter = 'todos', sort = 'added-desc', onlyFavorites = false, collection = '', genre = '' }) {
  const f = FILTERS[filter] || FILTERS.todos;
  return sortBooks(books.filter((b) => (!onlyFavorites || b.favorite) && (!collection || b.collections?.includes(collection)) && (!genre || norm(b.genre) === genre) && f(b) && matchesQuery(b, query)), sort);
}

export function titleFromFilename(name) {
  return String(name).replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Sem título';
}

export function formatBytes(n) {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

/** Categorias (gênero) presentes na biblioteca, da mais frequente para a menos: [{ key, label, count }]. */
export function genresOf(books, limit = 30) {
  const m = new Map();
  for (const b of books) {
    const label = String(b.genre || '').trim(); if (!label) continue;
    const key = norm(label), cur = m.get(key);
    cur ? cur.count++ : m.set(key, { key, label: label.slice(0, 40), count: 1 });
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'pt')).slice(0, limit);
}
