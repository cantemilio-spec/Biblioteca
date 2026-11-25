// Camada de armazenamento local (IndexedDB). Todos os registros têm updatedAt (preparado para sincronização);
// exclusões geram "tombstones" para que um futuro sync não ressuscite dados apagados.
import { APP } from './config.js';

let dbPromise;

export function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(APP.dbName, APP.dbVersion);
      r.onupgradeneeded = () => {
        const db = r.result, has = (n) => db.objectStoreNames.contains(n);
        if (!has('books')) db.createObjectStore('books', { keyPath: 'id' }).createIndex('hash', 'hash', { unique: true });
        for (const n of ['files', 'covers', 'collections', 'tombstones']) if (!has(n)) db.createObjectStore(n, { keyPath: 'id' });
        if (!has('settings')) db.createObjectStore('settings', { keyPath: 'key' });
        for (const n of ['annotations', 'sessions']) if (!has(n)) db.createObjectStore(n, { keyPath: 'id' }).createIndex('bookId', 'bookId');
        if (!has('cache')) db.createObjectStore('cache', { keyPath: 'key' }); // v2: cache de consultas online
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('Banco de dados bloqueado por outra aba.'));
    });
  }
  return dbPromise;
}

const wrap = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

async function tx(stores, mode, fn) {
  const db = await open();
  const t = db.transaction(stores, mode);
  const done = new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Transação cancelada.'));
  });
  const out = await fn(...[].concat(stores).map((s) => t.objectStore(s)));
  await done;
  return out;
}

export const getAll = (store) => tx(store, 'readonly', (s) => wrap(s.getAll()));
export const getAllByIndex = (store, index, key) => tx(store, 'readonly', (s) => wrap(s.index(index).getAll(key)));
export const get = (store, key) => tx(store, 'readonly', (s) => wrap(s.get(key)));
export const put = (store, value) => tx(store, 'readwrite', (s) => wrap(s.put(value)));
export const del = (store, key) => tx(store, 'readwrite', (s) => wrap(s.delete(key)));
/** Troca a capa e o campo coverSource do livro de forma atômica. */
export function setCover(id, blob, source) {
  return tx(['books', 'covers'], 'readwrite', async (b, c) => {
    const book = await wrap(b.get(id));
    if (!book) throw new Error('Livro não encontrado.');
    const now = Date.now();
    c.put({ id, blob, source, updatedAt: now });
    b.put({ ...book, coverSource: source, updatedAt: now });
  });
}

/** Grava a capa SÓ se o livro ainda não tiver uma (nunca substitui capa existente). Devolve true se gravou. */
export function setCoverIfMissing(id, blob, source) {
  return tx(['books', 'covers'], 'readwrite', async (b, c) => {
    const book = await wrap(b.get(id));
    if (!book || book.coverSource || (await wrap(c.get(id)))) return false;
    const now = Date.now();
    c.put({ id, blob, source, updatedAt: now });
    b.put({ ...book, coverSource: source, updatedAt: now });
    return true;
  });
}

/** Avisa serviços internos (ex.: busca automática de capas) que a biblioteca mudou. */
const changed = () => { try { window.dispatchEvent(new Event('bd:library')); } catch { /* sem window */ } };

/** Lê-modifica-grava um livro numa só transação. `fn` devolve o novo registro ou null para não gravar. */
export function updateBook(id, fn) {
  return tx('books', 'readwrite', async (b) => {
    const cur = await wrap(b.get(id));
    if (!cur) return null;
    const next = fn(cur);
    if (next) b.put({ ...next, updatedAt: Date.now() });
    return next;
  });
}

/** Grava progresso e posição de leitura; marca como concluído ao passar de 98%. */
export function saveProgress(id, progress, location) {
  return updateBook(id, (cur) => {
    const now = Date.now();
    return { ...cur, progress, location, lastReadAt: now, finishedAt: cur.finishedAt || (progress >= 0.98 ? now : null) };
  });
}

export async function pruneCache(maxAgeMs) {
  const rows = await getAll('cache');
  const old = rows.filter((r) => Date.now() - r.at > maxAgeMs);
  for (const r of old) await del('cache', r.key);
}

export const findBookByHash = (hash) => tx('books', 'readonly', (s) => wrap(s.index('hash').get(hash)));

/** Grava livro + arquivo + capa de forma atômica (tudo ou nada). */
export function addBookBundle({ book, blob, cover }) {
  return tx(['books', 'files', 'covers'], 'readwrite', async (b, f, c) => {
    b.put(book);
    f.put({ id: book.id, blob, updatedAt: book.updatedAt });
    if (cover) c.put({ id: book.id, blob: cover, source: book.coverSource || 'file', updatedAt: book.updatedAt });
    await Promise.resolve();
  }).then((r) => { changed(); return r; });
}

export function replaceBookFile(book, blob) {
  return tx(['books', 'files'], 'readwrite', async (b, f) => {
    b.put(book);
    f.put({ id: book.id, blob, updatedAt: book.updatedAt });
    await Promise.resolve();
  });
}

/** Remove o livro e TODOS os dados ligados a ele. */
export async function deleteBook(id) {
  await tx(['books', 'files', 'covers', 'annotations', 'sessions', 'tombstones'], 'readwrite', async (b, f, c, a, s, t) => {
    b.delete(id); f.delete(id); c.delete(id);
    for (const [store, idx] of [[a, 'bookId'], [s, 'bookId']]) {
      const keys = await wrap(store.index(idx).getAllKeys(id));
      keys.forEach((k) => store.delete(k));
    }
    t.put({ id, type: 'book', deletedAt: Date.now() });
  });
}

/** Remove a coleção e a retira de todos os livros (atômico); registra tombstone. */
export function deleteCollection(id) {
  return tx(['collections', 'books', 'tombstones'], 'readwrite', async (c, b, t) => {
    const now = Date.now();
    for (const bk of await wrap(b.getAll())) if (bk.collections?.includes(id)) b.put({ ...bk, collections: bk.collections.filter((x) => x !== id), updatedAt: now });
    c.delete(id); t.put({ id, type: 'collection', deletedAt: now });
  });
}

/** Aplica mudanças de coleção a vários livros: changes = Map(collId -> true adiciona | false remove). */
export function setBooksCollections(bookIds, changes) {
  return tx('books', 'readwrite', async (b) => {
    const now = Date.now();
    for (const id of bookIds) {
      const bk = await wrap(b.get(id));
      if (!bk) continue;
      const set = new Set(bk.collections || []);
      for (const [cid, on] of changes) on ? set.add(cid) : set.delete(cid);
      b.put({ ...bk, collections: [...set], updatedAt: now });
    }
  });
}

export async function storageInfo() {
  const out = { usage: null, quota: null, persisted: null };
  try {
    const e = await navigator.storage.estimate();
    out.usage = e.usage; out.quota = e.quota;
    out.persisted = await navigator.storage.persisted();
  } catch { /* indisponível */ }
  return out;
}

export async function requestPersistence() {
  try { return await navigator.storage.persist(); } catch { return false; }
}
