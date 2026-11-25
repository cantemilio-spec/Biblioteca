// Recuperação automática e contínua de capas. Roda dentro do app (não há servidor: os livros ficam no IndexedDB do aparelho).
// Reaproveita: banco (db.js), consultas Google Livros/Open Library + validação de correspondência (metadata.js) e
// normalização/otimização da imagem (covers.js via fetchCover). Nunca toca nos arquivos dos livros nem troca capa existente.
import * as db from './db.js';
import { getSetting, setSetting } from './settings.js';
import { searchBooks, score, fetchCover, CONFIDENT, CONFIDENT_NO_AUTHOR, MetadataUnavailable } from './metadata.js';
import { cleanIsbn, isValidIsbn } from './books.js';

const GAP_MS = 1500;                                   // limite de requisições: um livro por vez, com intervalo
const RETRY_MS = [10 * 60e3, 3600e3, 6 * 3600e3, 86400e3, 3 * 86400e3]; // novas tentativas por livro (backoff)
const MISS_MS = 14 * 86400e3;                          // depois de esgotar as tentativas, só revisita em 14 dias
const OFFLINE_MS = [60e3, 2 * 60e3, 5 * 60e3, 15 * 60e3, 30 * 60e3]; // pausa global quando as APIs não respondem
const POLL_MS = 10 * 60e3;
const KEY = 'coverQueue';

const subs = new Set();
let status = { state: 'idle', pending: 0, found: 0, missing: 0 };
let running = false, timer = 0, kickT = 0, offlineN = 0, pausedUntil = 0, sessionFound = 0, started = false;

export const getCoverStatus = () => status;
export function onCoverStatus(fn) { subs.add(fn); fn(status); return () => subs.delete(fn); }
const emit = (p) => { status = { ...status, ...p }; subs.forEach((f) => { try { f(status); } catch { /* ouvinte com erro não derruba o serviço */ } }); };

const enabled = () => getSetting('autoIdentify') !== false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readQ = () => { const q = getSetting(KEY); return q && typeof q === 'object' ? { ...q } : {}; };

/** Tenta achar a capa de um livro. Devolve 'found' | 'miss' | 'offline' | 'skip'. */
export async function resolveCover(book, { search = searchBooks, fetchImg = fetchCover } = {}) {
  const fresh = await db.get('books', book.id);
  if (!fresh || fresh.coverSource) return 'skip';
  const save = async (blob, src) => ((await db.setCoverIfMissing(fresh.id, blob, src)) ? 'found' : 'skip');
  let net = 0;
  // 1) ISBN válido: capa direta, correspondência garantida pelo próprio ISBN.
  const isbn = cleanIsbn(fresh.isbn);
  if (isbn && isValidIsbn(isbn)) {
    try { return await save(await fetchImg(`https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`), 'openlibrary'); } catch { /* tenta a busca */ }
  }
  // 2) Busca por ISBN / título + autor, aceitando só correspondência confiável (evita outra edição ou outro livro).
  let res;
  try { res = await search({ title: fresh.title, author: fresh.author, isbn: fresh.isbn }); } catch (e) { return e instanceof MetadataUnavailable ? 'offline' : 'miss'; }
  const need = fresh.author || isbn ? CONFIDENT : CONFIDENT_NO_AUTHOR;
  const ranked = res.candidates.map((c) => ({ c, s: score(fresh, c) })).filter((x) => x.c.coverUrl && x.s >= need).sort((a, b) => b.s - a.s).slice(0, 3);
  for (const { c } of ranked) {
    try { return await save(await fetchImg(c.coverUrl), c.source); } catch { net++; }
  }
  // Resultado só é conclusivo ('não existe') quando as DUAS fontes responderam; senão tenta de novo mais tarde sem gastar tentativa.
  return res.partial && (!ranked.length || net === ranked.length) ? 'offline' : 'miss';
}

async function pass() {
  if (running || !enabled() || !navigator.onLine || Date.now() < pausedUntil) return;
  running = true;
  try {
    const now = Date.now();
    const books = await db.getAll('books');
    const q = readQ();
    for (const id of Object.keys(q)) if (!books.some((b) => b.id === id)) delete q[id];
    const todo = books.filter((b) => !b.coverSource);
    for (const id of Object.keys(q)) if (!todo.some((b) => b.id === id)) delete q[id]; // ganhou capa por outro caminho
    const due = todo.filter((b) => !(q[b.id]?.next > now));
    emit({ pending: due.length, missing: todo.length - due.length });
    if (due.length) emit({ state: 'searching' });
    let left = due.length;
    for (const b of due) {
      if (!enabled() || !navigator.onLine) break;
      const r = await resolveCover(b).catch(() => 'miss');
      if (r === 'offline') { offlineN = Math.min(offlineN + 1, OFFLINE_MS.length); pausedUntil = Date.now() + OFFLINE_MS[offlineN - 1]; break; }
      offlineN = 0;
      if (r === 'found' || r === 'skip') { delete q[b.id]; if (r === 'found') { sessionFound++; emit({ found: sessionFound }); } }
      else { const n = (q[b.id]?.n || 0) + 1; q[b.id] = { n, next: Date.now() + (n > RETRY_MS.length ? MISS_MS : RETRY_MS[n - 1]) }; }
      left--; emit({ pending: left });
      await sleep(GAP_MS);
    }
    await setSetting(KEY, q).catch(() => {});
    const after = await db.getAll('books');
    const miss = after.filter((b) => !b.coverSource).length;
    const worked = due.length > 0;
    emit({ pending: 0, missing: miss, state: miss ? (worked || status.state === 'partial' ? 'partial' : 'idle') : (worked || sessionFound ? 'done' : 'idle') });
  } catch { emit({ state: 'idle' }); } finally { running = false; schedule(); }
}

function schedule() {
  clearTimeout(timer);
  const wait = Math.max(30e3, Math.min(POLL_MS, pausedUntil - Date.now() || POLL_MS, ...Object.values(readQ()).map((x) => x.next - Date.now()).filter((x) => x > 0)));
  timer = setTimeout(pass, wait);
}

/** Pede uma varredura em breve (vários pedidos seguidos viram um só). */
export function kickCovers(ms = 1500) { if (!started) return; clearTimeout(kickT); kickT = setTimeout(pass, ms); }

/** Liga o serviço: varre a biblioteca ao abrir e depois reage a livros novos, volta da rede e volta ao app. */
export function startCovers() {
  if (started) return; started = true;
  window.addEventListener('bd:library', () => kickCovers());
  window.addEventListener('online', () => { pausedUntil = 0; kickCovers(2000); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) kickCovers(2000); });
  kickCovers(2500);
}
