// Coleções: grupos criados pelo usuário. Um livro pode estar em várias (book.collections = [ids]).
import { h, icon, toast, modal, confirmDialog, bimg } from './ui.js';
import * as db from './db.js';
import { setSetting } from './settings.js';

const MAX_NAME = 60;
export const listCollections = async () => (await db.getAll('collections')).sort((a, b) => a.name.localeCompare(b.name, 'pt', { sensitivity: 'base' }));

/** Valida e normaliza o nome; devolve mensagem de erro ou null. */
export function nameError(name, all, selfId = null) {
  if (!name) return 'Digite um nome.';
  if (name.length > MAX_NAME) return `Use até ${MAX_NAME} caracteres.`;
  if (all.some((c) => c.id !== selfId && c.name.toLowerCase() === name.toLowerCase())) return 'Já existe uma coleção com esse nome.';
  return null;
}

export async function createCollection(rawName) {
  const name = rawName.replace(/\s+/g, ' ').trim(), all = await db.getAll('collections');
  const err = nameError(name, all);
  if (err) throw new Error(err);
  const now = Date.now(), c = { id: crypto.randomUUID(), name, createdAt: now, updatedAt: now };
  await db.put('collections', c);
  return c;
}

export async function renameCollection(id, rawName) {
  const name = rawName.replace(/\s+/g, ' ').trim(), all = await db.getAll('collections');
  const err = nameError(name, all, id);
  if (err) throw new Error(err);
  const cur = all.find((c) => c.id === id);
  if (cur) await db.put('collections', { ...cur, name, updatedAt: Date.now() });
}

/** Janela para marcar/desmarcar coleções dos livros informados (aceita vários livros: estado "parcial"). */
export async function openCollectionPicker(books, onDone) {
  let cols = await listCollections();
  const touched = new Map(); // id -> true (adicionar) | false (remover)
  const list = h('div', { class: 'coll-pick' });
  const nameIn = h('input', { type: 'text', maxlength: MAX_NAME, placeholder: 'Nova coleção', 'aria-label': 'Nome da nova coleção' });
  const state = (id) => { const n = books.filter((b) => b.collections?.includes(id)).length; return n === books.length ? 'all' : n ? 'some' : 'none'; };
  function draw() {
    list.replaceChildren(...(cols.length ? cols.map((c) => {
      const s = state(c.id), t = touched.get(c.id);
      const cb = h('input', { type: 'checkbox', checked: t ?? s === 'all', 'aria-label': c.name });
      cb.indeterminate = t === undefined && s === 'some';
      cb.addEventListener('change', () => touched.set(c.id, cb.checked));
      return h('label', { class: 'field inline' }, h('span', {}, c.name), cb);
    }) : [h('p', { class: 'hint' }, 'Você ainda não tem coleções. Crie a primeira abaixo.')]));
  }
  const add = async () => {
    try { const c = await createCollection(nameIn.value); cols = await listCollections(); touched.set(c.id, true); nameIn.value = ''; draw(); }
    catch (e) { toast(e.message, 'error'); nameIn.focus(); }
  };
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  draw();
  modal({
    title: books.length === 1 ? 'Coleções do livro' : `Coleções (${books.length} livros)`,
    body: h('div', {}, list, h('div', { class: 'coll-new' }, nameIn, h('button', { class: 'btn', type: 'button', onclick: add }, icon('plus', 18), 'Criar'))),
    actions: [{ label: 'Cancelar' }, { label: 'Salvar', kind: 'primary', onClick: async () => {
      try { await db.setBooksCollections(books.map((b) => b.id), touched); } catch { toast('Não foi possível salvar as coleções.', 'error'); return false; }
      toast('Coleções atualizadas.'); await onDone?.();
    } }],
  });
}

/** Tela de gerenciamento de coleções. */
export async function mountCollections(root) {
  const [cols, books] = await Promise.all([listCollections(), db.getAll('books')]).then(([c, b]) => [c, b.filter((x) => x.source !== 'adamastor')]);
  const count = (id) => books.filter((b) => b.collections?.includes(id)).length;
  const reload = () => mountCollections(root);
  const nameIn = h('input', { type: 'text', maxlength: MAX_NAME, placeholder: 'Nova coleção', 'aria-label': 'Nome da nova coleção' });
  const create = async () => { try { await createCollection(nameIn.value); toast('Coleção criada.'); await reload(); } catch (e) { toast(e.message, 'error'); nameIn.focus(); } };
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } });

  const openIn = async (c) => { await setSetting('collection', c.id); location.hash = '#biblioteca'; };
  function rename(c) {
    const input = h('input', { type: 'text', maxlength: MAX_NAME, value: c.name, 'aria-label': 'Novo nome' });
    modal({ title: 'Renomear coleção', body: h('label', { class: 'field' }, h('span', {}, 'Nome'), input), actions: [{ label: 'Cancelar' }, { label: 'Salvar', kind: 'primary', onClick: async () => {
      try { await renameCollection(c.id, input.value); } catch (e) { toast(e.message, 'error'); return false; }
      await reload();
    } }] });
    setTimeout(() => input.select(), 30);
  }
  async function remove(c) {
    if (!(await confirmDialog(`Excluir a coleção "${c.name}"? Os livros não serão apagados, apenas removidos dela.`, { confirmLabel: 'Excluir', danger: true, title: 'Excluir coleção' }))) return;
    try { await db.deleteCollection(c.id); toast('Coleção excluída.'); await reload(); } catch { toast('Não foi possível excluir.', 'error'); }
  }

  root.replaceChildren(
    h('div', { class: 'view-head head-brand' }, bimg(), h('div', {}, h('h1', {}, 'Coleções'), h('p', { class: 'hint' }, 'Agrupe livros do seu jeito. Para incluir livros, use "Selecionar" na Biblioteca ou os detalhes do livro.'))),
    h('section', { class: 'panel' }, h('div', { class: 'coll-new' }, nameIn, h('button', { class: 'btn primary', type: 'button', onclick: create }, icon('plus', 18), 'Criar coleção'))),
    cols.length ? h('ul', { class: 'coll-list' }, cols.map((c) => h('li', { class: 'coll-item' },
      h('button', { class: 'coll-open', type: 'button', onclick: () => openIn(c) }, icon('folder', 22), h('span', { class: 'coll-name' }, c.name), h('span', { class: 'hint' }, `${count(c.id)} livro(s)`)),
      h('button', { class: 'btn', type: 'button', 'aria-label': `Renomear ${c.name}`, onclick: () => rename(c) }, 'Renomear'),
      h('button', { class: 'btn danger', type: 'button', 'aria-label': `Excluir ${c.name}`, onclick: () => remove(c) }, icon('trash', 18))))) :
      h('div', { class: 'empty' }, icon('folder', 44), h('h2', {}, 'Nenhuma coleção'), h('p', {}, 'Crie coleções como "Para ler", "Faculdade" ou "Ficção".')));
}
