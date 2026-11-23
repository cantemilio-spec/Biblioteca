// Clássicos da Literatura: catálogo público (obras em domínio público) hospedado no próprio projeto.
// Os EPUBs só são baixados quando o leitor toca num livro; depois ficam no aparelho, marcados com source:'adamastor'
// para nunca se misturarem com os livros pessoais (a Biblioteca ignora esses registros).
import { h, icon, toast, menu, bimg } from './ui.js';
import * as db from './db.js';
import { importFile } from './importer.js';
import { norm } from './books.js';
import { libTabs, CLASSIC_TABS, isCatalogBook } from './lib-tabs.js';

export const CLASSICS_SOURCE = 'adamastor';
// Dois catálogos estáticos usam a mesma tela: os Clássicos (Projecto Adamastor) e a Estante (EPUBs que o dono coloca na pasta do repositório).
const CFG = {
  adamastor: { source: 'adamastor', dir: 'public/books/adamastor/', tabKey: 'todos', label: 'Buscar nos clássicos', hint: 'Livros disponíveis para ler: Clássicos da Literatura (domínio público, Projecto Adamastor) e os da sua Estante. Toque para abrir; o livro é baixado só na primeira vez.' },
  estante: { source: 'estante', dir: 'public/books/estante/', tabKey: 'estante', label: 'Buscar na estante', hint: 'Livros colocados na pasta public/books/estante do projeto. Toque para abrir; o livro é baixado só na primeira vez.' },
};

function tint(id) {
  let n = 0;
  for (const c of id) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${198 + (n % 14)} ${26 + (n % 10)}% ${34 + (n % 14)}%)`;
}

async function loadCatalog(cfg) {
  const r = await fetch(`${cfg.dir}catalogo.json`, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const list = Array.isArray(j?.livros) ? j.livros : [];
  // só aceita caminhos dentro da pasta do catálogo (o JSON nunca aponta para fora do projeto)
  const ok = (p) => typeof p === 'string' && p.startsWith(cfg.dir) && !p.includes('..');
  return { info: j, books: list.filter((b) => b && typeof b.id === 'string' && typeof b.titulo === 'string' && ok(b.epub)).map((b) => ({ ...b, capa: ok(b.capa) ? b.capa : null, _cfg: cfg })) };
}

/** Baixa o EPUB (sob demanda), valida e guarda no aparelho. Devolve o id do livro no banco. */
export async function fetchClassic(c, cfg = CFG.adamastor) {
  const r = await fetch(c.epub);
  if (!r.ok) throw new Error('Arquivo não encontrado no projeto.');
  const blob = await r.blob();
  const res = await importFile(new File([blob], `${c.id}.epub`, { type: 'application/epub+zip' }));
  if (res.status === 'duplicate') return res.book.id; // você já tem este mesmo arquivo; abre o que existe
  await db.updateBook(res.book.id, (b) => ({ ...b, source: cfg.source, classicId: c.id, classicCat: CLASSIC_TABS.find(([, l]) => l === c.categoria)?.[0] || '', title: c.titulo, author: c.autor || b.author, genre: c.genero || b.genre, publisher: c.credito || b.publisher }));
  return res.book.id;
}

export const mountClassics = (root, tab = '') => mountCatalog(root, tab, CFG.adamastor);
export const mountEstante = (root) => mountCatalog(root, '', CFG.estante);

async function mountCatalog(root, tab, cfg) {
  const st = { query: '', cat: CLASSIC_TABS.find(([k]) => k === tab)?.[1] || '', saved: new Map(), busy: new Set() };
  const grid = h('div', { class: 'books grid' });
  const bar = h('div', { class: 'lib-bar' });
  const count = h('p', { class: 'hint cl-count', 'aria-live': 'polite' });
  root.replaceChildren(
    h('div', { class: 'view-head head-brand' }, bimg(), h('div', {}, h('h1', {}, 'Biblioteca'), h('p', { class: 'hint' }, cfg.source === 'adamastor' && CLASSIC_TABS.some(([k]) => k === tab) ? 'Clássicos da Literatura (domínio público, Projecto Adamastor). Toque para abrir; o livro é baixado só na primeira vez.' : cfg.hint))),
    libTabs(cfg.source === 'estante' ? 'estante' : CLASSIC_TABS.some(([k]) => k === tab) ? tab : 'todos'), bar, count, grid);

  let cat;
  try { cat = await loadCatalog(cfg); } catch {
    grid.replaceWith(h('div', { class: 'empty small' }, icon('book', 40), h('h2', {}, 'Catálogo indisponível'), h('p', {}, 'Não foi possível carregar a lista agora. Verifique a conexão e tente de novo.'),
      h('button', { class: 'btn', type: 'button', onclick: () => mountCatalog(root, tab, cfg) }, 'Tentar de novo')));
    bar.remove(); count.remove(); return;
  }
  let books = cat.books;
  // "Disponíveis" mostra tudo que dá para ler: Clássicos + Estante (se o catálogo da Estante não existir, segue só com os Clássicos)
  if (cfg.source === 'adamastor' && !CLASSIC_TABS.some(([k]) => k === tab)) { try { books = [...books, ...(await loadCatalog(CFG.estante)).books]; } catch { /* sem Estante */ } }
  
  async function refreshSaved() {
    st.saved = new Map((await db.getAll('books')).filter(isCatalogBook).map((b) => [b.classicId, b]));
  }

  async function open(c) {
    if (!c.baixado) { toast('Este EPUB ainda não foi adicionado ao projeto.'); return; }
    const saved = st.saved.get(c.id);
    if (saved) { location.hash = `#ler-${saved.id}`; return; }
    if (st.busy.has(c.id)) return;
    st.busy.add(c.id); draw();
    try { const id = await fetchClassic(c, c._cfg || cfg); location.hash = `#ler-${id}`; }
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
    count.textContent = books.length || cfg.source !== 'estante' ? `${list.length} ${list.length === 1 ? 'obra' : 'obras'}` : '';
    const none = !books.length && cfg.source === 'estante'
      ? h('div', { class: 'empty small' }, icon('book', 40), h('h2', {}, 'Estante vazia'), h('p', {}, 'Envie arquivos .epub para a pasta public/books/estante do repositório no GitHub. Em poucos minutos eles aparecem aqui.'))
      : h('div', { class: 'empty small' }, icon('search', 36), h('p', {}, 'Nenhuma obra encontrada.'));
    grid.replaceChildren(...(list.length ? list.map(card) : [none]));
  }

  const search = h('input', { type: 'search', class: 'search', placeholder: 'Buscar título ou autor', 'aria-label': cfg.label, enterkeyhint: 'search', autocomplete: 'off' });
  const clear = h('button', { class: 'icon-btn clear', type: 'button', 'aria-label': 'Limpar busca', hidden: true, onclick: () => { search.value = ''; st.query = ''; clear.hidden = true; draw(); search.focus(); } }, icon('close', 20));
  search.addEventListener('input', () => { st.query = search.value; clear.hidden = !st.query; draw(); });
  bar.append(h('div', { class: 'toolbar' }, h('div', { class: 'search-wrap' }, icon('search', 22), search, clear)));
  if (cat.info?.licenca) root.append(h('p', { class: 'hint cl-license' }, `${cat.info.licenca}`));

  await refreshSaved(); draw();
}
