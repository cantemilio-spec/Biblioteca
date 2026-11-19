// Identificação de livros e capas: Google Books API (1ª) e Open Library API (2ª). Sem chave, sem serviços pagos.
// Falhas de rede NUNCA impedem a importação; respostas são validadas e as capas só vêm de hosts permitidos.
import * as db from './db.js';
import { cleanIsbn, isValidIsbn, norm } from './books.js';
import { normalizeCover } from './covers.js';
import { plainText } from './text.js';

export class MetadataUnavailable extends Error {}

const TTL_MS = 7 * 86400000;
const TIMEOUT_MS = 8000;
const MAX_COVER_BYTES = 8 * 1024 * 1024;
export const CONFIDENT = 0.85;
export const CONFIDENT_NO_AUTHOR = 0.95; // sem autor nem ISBN o título sozinho precisa casar quase exatamente
export const SOURCE_LABEL = { google: 'Google Livros', openlibrary: 'Open Library' };

/* ---------- comparação (pura) ---------- */
const STOP = new Set(['a', 'o', 'as', 'os', 'de', 'da', 'do', 'das', 'dos', 'e', 'um', 'uma', 'the', 'of', 'and']);
const tokens = (s) => norm(s).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t && !STOP.has(t));

function tokenSim(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const jaccard = inter / (A.size + B.size - inter);
  const small = Math.min(A.size, B.size);
  const contained = small >= 2 ? (inter / small) * 0.9 : 0; // "Título" vs "Título: subtítulo"
  return Math.max(jaccard, contained);
}

/** 0..1: quão provável é que `cand` seja o mesmo livro que `book`. */
export function score(book, cand) {
  const bi = cleanIsbn(book.isbn);
  if (bi && (cand.isbns || []).some((x) => cleanIsbn(x) === bi)) return 1;
  const t = tokenSim(book.title, cand.title);
  if (!book.author) return t;
  const bt = new Set(tokens(book.author)), ct = new Set(tokens((cand.authors || []).join(' ')));
  let hit = 0;
  for (const x of bt) if (ct.has(x)) hit++;
  const a = bt.size ? hit / bt.size : 0;
  return 0.7 * t + 0.3 * a;
}

/* ---------- consultas e respostas ---------- */
export function buildQueries({ title = '', author = '', isbn = '' }) {
  const i = isValidIsbn(isbn) ? cleanIsbn(isbn) : '';
  const t = String(title).trim(), a = String(author).trim();
  if (!i && !t) return null;
  const fields = 'key,title,author_name,publisher,first_publish_year,isbn,cover_i,subject';
  const google = i
    ? `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(`isbn:${i}`)}&maxResults=10&printType=books`
    : `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(`intitle:"${t}"${a ? ` inauthor:"${a}"` : ''}`)}&maxResults=10&printType=books`;
  const ol = i
    ? `https://openlibrary.org/search.json?isbn=${i}&limit=10&fields=${fields}`
    : `https://openlibrary.org/search.json?title=${encodeURIComponent(t)}${a ? `&author=${encodeURIComponent(a)}` : ''}&limit=10&fields=${fields}`;
  return { google, ol };
}

const validIsbns = (arr, max = 5) => (arr || []).filter(isValidIsbn).slice(0, max);

export function parseGoogle(json) {
  return (json?.items || []).map((it) => {
    const v = it.volumeInfo || {};
    const link = v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail || '';
    return {
      source: 'google', id: it.id || '', title: plainText(v.title, 300), authors: (v.authors || []).map((x) => plainText(x, 200)),
      publisher: plainText(v.publisher, 200), year: String(v.publishedDate || '').slice(0, 4),
      description: plainText(v.description, 4000), isbns: validIsbns((v.industryIdentifiers || []).map((x) => x.identifier)),
      categories: (v.categories || []).map((x) => plainText(x, 100)).slice(0, 3),
      coverUrl: safeCover(link ? link.replace(/^http:/, 'https:').replace('&edge=curl', '') : ''),
    };
  }).filter((c) => c.title);
}

export function parseOpenLibrary(json) {
  return (json?.docs || []).map((d) => {
    const isbns = validIsbns(d.isbn);
    const coverUrl = d.cover_i ? `https://covers.openlibrary.org/b/id/${Number(d.cover_i)}-L.jpg?default=false` : isbns[0] ? `https://covers.openlibrary.org/b/isbn/${isbns[0]}-L.jpg?default=false` : '';
    return {
      source: 'openlibrary', id: String(d.key || ''), title: plainText(d.title, 300), authors: (d.author_name || []).map((x) => plainText(x, 200)).slice(0, 4),
      publisher: plainText((d.publisher || [])[0], 200), year: d.first_publish_year ? String(d.first_publish_year) : '', description: '',
      isbns, categories: (d.subject || []).map((x) => plainText(x, 100)).slice(0, 3), coverUrl,
    };
  }).filter((c) => c.title);
}

async function fetchJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new MetadataUnavailable(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    throw e instanceof MetadataUnavailable ? e : new MetadataUnavailable('Serviço indisponível.');
  } finally { clearTimeout(timer); }
}

let pruned = false;
async function cachedJson(url) {
  const key = `q:${url}`;
  try {
    const hit = await db.get('cache', key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  } catch { /* sem cache */ }
  const value = await fetchJson(url);
  db.put('cache', { key, value, at: Date.now() }).catch(() => {});
  if (!pruned) { pruned = true; db.pruneCache(TTL_MS).catch(() => {}); }
  return value;
}

/** Pesquisa nas duas fontes. Lança MetadataUnavailable só se AMBAS falharem. */
export async function searchBooks(q) {
  const urls = buildQueries(q);
  if (!urls) return { candidates: [], partial: false };
  const [g, o] = await Promise.allSettled([cachedJson(urls.google).then(parseGoogle), cachedJson(urls.ol).then(parseOpenLibrary)]);
  if (g.status === 'rejected' && o.status === 'rejected') throw new MetadataUnavailable('Nenhuma fonte respondeu.');
  const seen = new Set(), out = [];
  for (const c of [...(g.value || []), ...(o.value || [])]) {
    const k = `${c.source}:${c.id || c.title + c.year}`;
    if (!seen.has(k)) { seen.add(k); out.push(c); }
  }
  return { candidates: out, partial: g.status === 'rejected' || o.status === 'rejected' };
}

/** Só aceita URLs de capa dos hosts conhecidos: a resposta da API não decide para onde o app faz requisições. */
const safeCover = (url) => (isAllowedCoverUrl(url) ? url : '');

export const fieldsFrom = (c) => ({ title: c.title, author: c.authors.join(', '), publisher: c.publisher, genre: c.categories.join(', '), isbn: c.isbns[0] || '', description: c.description });

/* ---------- capas ---------- */
export function isAllowedCoverUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'books.google.com' || u.hostname === 'covers.openlibrary.org' || u.hostname === 'archive.org' || u.hostname.endsWith('.archive.org'));
  } catch { return false; }
}

/** Baixa, valida e normaliza a capa (JPEG, até 900px). Rejeita hosts fora da lista, imagens minúsculas e não-imagens. */
export async function fetchCover(url) {
  if (!isAllowedCoverUrl(url)) throw new Error('Origem da capa não permitida.');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS + 6000);
  try {
    const res = await fetch(url, { signal: ctl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new Error('A capa não está disponível.');
    if (Number(res.headers.get('content-length') || 0) > MAX_COVER_BYTES) throw new Error('Imagem grande demais.');
    const blob = await res.blob();
    if (blob.size > MAX_COVER_BYTES) throw new Error('Imagem grande demais.');
    return await normalizeCover(blob, { minWidth: 100 });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Tempo esgotado ao baixar a capa.');
    throw e;
  } finally { clearTimeout(timer); }
}

/* ---------- identificação automática ---------- */
/** Procura o livro e, se o casamento for confiável, completa SOMENTE campos vazios e a capa ausente. */
export async function autoIdentify(book) {
  const { candidates } = await searchBooks({ title: book.title, author: book.author, isbn: book.isbn });
  const best = candidates.map((c) => ({ c, s: score(book, c) })).sort((a, b) => b.s - a.s)[0];
  const need = book.author || book.isbn ? CONFIDENT : CONFIDENT_NO_AUTHOR;
  if (!best || best.s < need) return { changed: false, cover: false };
  const c = best.c;
  let cover = false;
  if (!book.coverSource && c.coverUrl) {
    try { await db.setCover(book.id, await fetchCover(c.coverUrl), c.source); cover = true; } catch { /* sem capa: segue com os dados */ }
  }
  const filled = await db.updateBook(book.id, (cur) => {
    const next = { ...cur };
    let any = false;
    const fill = (k, v) => { if (!cur[k] && v) { next[k] = v; any = true; } };
    fill('author', c.authors.join(', ')); fill('publisher', c.publisher); fill('genre', c.categories.join(', '));
    fill('description', c.description); fill('isbn', c.isbns[0] || '');
    return any ? next : null;
  });
  return { changed: cover || !!filled, cover, source: c.source };
}
