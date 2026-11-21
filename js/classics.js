// Clássicos da Literatura: catálogo público (obras em domínio público) hospedado no próprio projeto.
// Os EPUBs só são baixados quando o leitor toca num livro; depois ficam no aparelho, marcados com source:'adamastor'
// para nunca se misturarem com os livros pessoais (a Biblioteca ignora esses registros).
import { h, icon, toast, menu, bimg } from './ui.js';
import * as db from './db.js';
import { importFile } from './importer.js';
import { norm } from './books.js';

export const CLASSICS_SOURCE = 'adamastor';
const CATALOG_URL = 'public/books/adamastor/catalogo.json';

function tint(id) {
  let n = 0;
  for (const c of id) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${198 + (n % 14)} ${26 + (n % 10)}% ${34 + (n % 14)}%)`;
}

async function loadCatalog() {
  const r = await fetch(CATALOG_URL, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const list = Array.isArray(j?.livros) ? j.livros : [];
  // só aceita caminhos dentro da pasta do catálogo (o JSON nunca aponta para fora do projeto)
  const ok = (p) => typeof p === 'string' && p.startsWith('public/books/adamastor/') && !p.includes('..');
  return { info: j, books: list.filter((b) => b && typeof b.id === 'string' && typeof b.titulo === 'string' && ok(b.epub)).map((b) => ({ ...b, capa: ok(b.capa) ? b.capa : null })) };
}

/** Baixa o EPUB (sob demanda), valida e guarda no aparelho. Devolve o id do livro no banco. */
export async function fetchClassic(c) {
  const r = await fetch(c.epub);
  if (!r.ok) throw new Error('Arquivo não encontrado no projeto.');
  const blob = await r.blob();
  const res = await importFile(new File([blob], `${c.id}.epub`, { type: 'application/epub+zip' }));
  if (res.status === 'duplicate') return res.book.id; // você já tem este mesmo arquivo; abre o que existe
  await db.updateBook(res.book.id, (b) => ({ ...b, source: CLASSICS_SOURCE, classicId: c.id, title: c.titulo, author: c.autor || b.author, genre: c.genero || b.genre, publisher: c.credito || b.publisher }));
  return res.book.id;
}

export async function mountClassics(root) {
  const st = { query: '', cat: '', saved: new Map(), busy: new Set() };
  const grid = h('div', { class: 'books grid' });
  const bar = h('div', { class: 'lib-bar' });
  const count = h('p', { class: 'hint cl-count', 'aria-live': 'polite' });
  root.replaceChildren(
    h('div', { class: 'view-head head-brand' }, bimg(), h('div', {}, h('h1', { class: 'cl-h1' }, 'Clássicos da Literatura'), h('p', { class: 'hint' }, 'Obras em domínio público do Projecto Adamastor. Toque para ler; o livro é baixado só na primeira vez.'))),
    bar, count, grid);

  let cat;
  try { cat = await loadCatalog(); } catch {
    grid.replaceWith(h('div', { class: 'empty small' }, icon('book', 40), h('h2', {}, 'Catálogo indisponível'), h('p', {}, 'Não foi possível carregar a lista agora. Verifique a conexão e tente de novo.'),
      h('button', { class: 'btn', type: 'button', onclick: () => mountClassics(root) }, 'Tentar de novo')));
    bar.remove(); count.remove(); return;
  }
  const books = cat.books;
  const cats = [...new Set(books.map((b) => b.categoria).filter(Boolean))];

  async function refreshSaved() {
    st.saved = new Map((await db.getAll('books')).filter((b) => b.source === CLASSICS_SOURCE).map((b) => [b.classicId, b]));
  }

  async function open(c) {
    if (!c.baixado) { toast('Este EPUB ainda não foi adicionado ao projeto.'); return; }
    const saved = st.saved.get(c.id);
    if (saved) { location.hash = `#ler-${saved.id}`; return; }
    if (st.busy.has(c.id)) return;
    st.busy.add(c.id); draw();
    try { const id = await fetchClassic(c); location.hash = `#ler-${id}`; }
    catch (e) {
      st.busy.delete(c.id); draw();
      toast(e?.name === 'TypeError' ? 'Sem conexão para baixar este livro agora.' : (e?.message || 'Não foi possível abrir este livro.'), 'error');
    }
  }

  function card(c) {
    const saved = st.saved.get(c.id), pct = Math.round((saved?.progress || 0) * 100), busy = st.busy.has(c.id);
    const ph = () => { const p = h('div', { class: 'cover placeholder' }, h('span', { class: 'ph-title' }, c.titulo), c.autor ? h('span', { class: 'ph-author' }, c.autor) : null); p.style.setProperty('--tint', tint(c.id)); return p; };
    let cover;
    if (c.baixado && c.capa && c.capa_ok !== false) {
      const img = h('img', { src: c.capa, alt: '', loading: 'lazy', draggable: 'false' });
      cover = h('div', { class: 'cover' }, img);
      img.addEventListener('error', () => cover.replaceWith(ph()), { once: true });
    } else cover = ph();
    const el = h('article', {
      class: `book grid${c.baixado ? '' : ' pending'}${busy ? ' busy' : ''}`, tabindex: 0, role: 'button', 'aria-label': `${c.titulo}, ${c.autor}${c.baixado ? '' : ' (arquivo pendente)'}`, 'aria-busy': busy ? 'true' : null,
      onclick: () => open(c), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(c); } },
    },
    h('div', { class: 'cover-wrap' }, cover, saved && pct ? h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct }, h('span', { style: `width:${pct}%` })) : null,
      busy ? h('div', { class: 'cl-busy', role: 'status' }, 'Baixando…') : null),
    h('div', { class: 'meta' }, h('div', { class: 'book-title' }, c.titulo), h('div', { class: 'book-author' }, c.autor || ''),
      h('div', { class: 'cl-tag' }, c.baixado ? (pct >= 98 ? 'Concluído' : pct ? `${pct}%` : c.genero || '') : 'Pendente'),
      saved ? h('button', { class: 'info-btn', type: 'button', 'aria-label': `Mais opções de ${c.titulo}`, 'aria-haspopup': 'menu',
        onclick: (e) => { e.stopPropagation(); menu(e.currentTarget, [{ label: 'Abrir', icon: 'book', onClick: () => open(c) }, { divider: true }, { label: 'Remover do aparelho', icon: 'trash', danger: true, onClick: async () => { await db.deleteBook(saved.id); await refreshSaved(); draw(); toast('Removido do aparelho. Você pode baixar de novo quando quiser.'); } }], { title: c.titulo }); },
        onkeydown: (e) => e.stopPropagation() }, icon('more', 18)) : null));
    return el;
  }

  function filtered() {
    const qs = norm(st.query).split(/\s+/).filter(Boolean); // todas as palavras precisam aparecer (em qualquer ordem)
    return books.filter((b) => { const hay = norm(`${b.titulo} ${b.autor} ${b.genero} ${b.categoria}`); return (!st.cat || b.categoria === st.cat) && qs.every((w) => hay.includes(w)); });
  }
  function draw() {
    const list = filtered();
    count.textContent = `${list.length} ${list.length === 1 ? 'obra' : 'obras'}`;
    grid.replaceChildren(...(list.length ? list.map(card) : [h('div', { class: 'empty small' }, icon('search', 36), h('p', {}, 'Nenhuma obra encontrada.'))]));
  }

  const search = h('input', { type: 'search', class: 'search', placeholder: 'Buscar título ou autor', 'aria-label': 'Buscar nos clássicos', enterkeyhint: 'search', autocomplete: 'off' });
  const clear = h('button', { class: 'icon-btn clear', type: 'button', 'aria-label': 'Limpar busca', hidden: true, onclick: () => { search.value = ''; st.query = ''; clear.hidden = true; draw(); search.focus(); } }, icon('close', 20));
  search.addEventListener('input', () => { st.query = search.value; clear.hidden = !st.query; draw(); });
  const chipBtn = (label, val) => h('button', { type: 'button', class: `chip${st.cat === val ? ' on' : ''}`, 'aria-pressed': String(st.cat === val), onclick: () => { st.cat = val; chips.querySelectorAll('.chip').forEach((b, i) => { const on = [''].concat(cats)[i] === val; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }); draw(); } }, label);
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Categorias' }, chipBtn('Todos', ''), cats.map((c) => chipBtn(c, c)));
  bar.append(h('div', { class: 'toolbar' }, h('div', { class: 'search-wrap' }, icon('search', 22), search, clear)), chips);
  if (cat.info?.licenca) root.append(h('p', { class: 'hint cl-license' }, `${cat.info.licenca}`));

  await refreshSaved(); draw();
}
