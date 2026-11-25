import { h, icon, toast, modal, confirmDialog, menu, bimg } from './ui.js';
import { libTabs, isCatalogBook } from './lib-tabs.js';
import * as db from './db.js';
import { getSetting, setSetting } from './settings.js';
import { listCollections, openCollectionPicker } from './collections.js';
import { importFiles, replaceFile } from './importer.js';
import { normalizeCover } from './covers.js';
import { autoIdentify, MetadataUnavailable } from './metadata.js';
import { openMetadataPicker } from './metadata-ui.js';
import { onCoverStatus, getCoverStatus } from './capas.js';
import { applyView, bookStatus, formatBytes, genresOf } from './books.js';
import { loadSessions, byDay, dayKey, fmtDuration, DEFAULT_GOALS } from './stats.js';

const FILTER_LABELS = [['todos', 'Todos'], ['favoritos', 'Favoritos'], ['andamento', 'Em andamento'], ['nao-iniciado', 'Não iniciados'], ['concluido', 'Concluídos'], ['recentes', 'Recentes']];
const SORTS = [['added-desc', 'Adicionados recentemente'], ['read-desc', 'Última leitura'], ['title', 'Título'], ['author', 'Autor']];

function tint(id) {
  let n = 0;
  for (const c of id) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${198 + (n % 14)} ${26 + (n % 10)}% ${34 + (n % 14)}%)`;
}

export function mountLibrary(root, { onlyFavorites = false, home = false } = {}) {
  const st = {
    books: [], collections: [], collection: getSetting('collection') || '', genre: getSetting('genre') || '', todaySec: 0, coverUrls: new Map(), query: '', filter: 'todos', selected: new Set(), selecting: false,
    sort: getSetting('sort'), view: getSetting('view'),
  };
  const content = h('div', { class: 'lib-content' });
  const input = h('input', { type: 'file', id: 'import-input', accept: '.epub,.pdf', multiple: true, hidden: true });
  input.addEventListener('change', () => { const f = [...input.files]; input.value = ''; doImport(f); });

  async function load() {
    const all = await db.getAll('books');
    st.books = all.filter((b) => !isCatalogBook(b)); // os Clássicos ficam na própria seção
    st.classics = all.filter(isCatalogBook); // só entram no Início (o que você está lendo)
    st.collections = await listCollections();
    st.genres = genresOf(st.books);
    if (st.genre && !st.genres.some((g) => g.key === st.genre)) st.genre = '';
    if (home) { try { st.todaySec = byDay(await loadSessions()).get(dayKey()) || 0; } catch { st.todaySec = 0; } }
    if (st.collection && !st.collections.some((c) => c.id === st.collection)) st.collection = ''; // coleção apagada
    const covers = await db.getAll('covers');
    st.coverUrls.forEach((u) => URL.revokeObjectURL(u));
    st.coverUrls = new Map(covers.map((c) => [c.id, URL.createObjectURL(c.blob)]));
    st.selected = new Set([...st.selected].filter((id) => st.books.some((b) => b.id === id)));
    render();
  }

  async function doImport(files) {
    if (!files.length) return;
    const busy = h('div', { class: 'busy', role: 'status' }, `Importando ${files.length} arquivo(s)…`);
    root.append(busy);
    const added = [];
    const sum = await importFiles(files, (r) => {
      if (r.status === 'added') added.push(r.book);
      if (r.status === 'added') toast(`Importado: ${r.book.title}${r.degraded ? ' (metadados limitados: leitor de PDF indisponível offline)' : ''}`);
      else if (r.status === 'duplicate') toast(`Já está na biblioteca: ${r.book.title}`);
      else toast(`${r.file.name}: ${r.message}`, 'error');
    });
    busy.remove();
    if (sum.added) db.requestPersistence();
    await load();
    identifyInBackground(added); // não bloqueia a importação
  }

  // Busca capa e dados online para livros recém-importados. Falhas de rede são silenciosas (um aviso só).
  let identifying = Promise.resolve();
  function identifyInBackground(books) {
    if (!getSetting('autoIdentify') || !books.length) return;
    identifying = identifying.then(async () => {
      let warned = false;
      for (const b of books) {
        try {
          const r = await autoIdentify(b);
          if (r.changed) { toast(r.cover ? `Capa encontrada: ${b.title}` : `Informações completadas: ${b.title}`); await load(); }
        } catch (e) {
          if (e instanceof MetadataUnavailable && !warned) { warned = true; toast('Sem acesso às bases online agora. Você pode buscar capas depois, nos detalhes do livro.'); }
        }
      }
    });
  }

  async function toggleFavorite(book) {
    const cur = st.books.find((x) => x.id === book.id) || book;
    await db.put('books', { ...cur, favorite: !cur.favorite, updatedAt: Date.now() });
    await load();
  }

  async function removeBooks(ids) {
    const label = ids.length === 1 ? 'este livro' : `${ids.length} livros`;
    if (!(await confirmDialog(`Excluir ${label}? O arquivo, a capa, as anotações e o progresso serão apagados deste dispositivo.`, { confirmLabel: 'Excluir', danger: true, title: 'Excluir' }))) return false;
    for (const id of ids) await db.deleteBook(id);
    st.selected.clear(); st.selecting = false;
    toast(ids.length === 1 ? 'Livro excluído.' : `${ids.length} livros excluídos.`);
    await load();
    return true;
  }

  function coverEl(b, cls = '') {
    const url = st.coverUrls.get(b.id);
    if (url) return h('div', { class: `cover ${cls}` }, h('img', { src: url, alt: '', loading: 'lazy', draggable: 'false' }));
    const c = h('div', { class: `cover placeholder ${cls}` }, h('span', { class: 'ph-title' }, b.title), b.author ? h('span', { class: 'ph-author' }, b.author) : null);
    c.style.setProperty('--tint', tint(b.id));
    return c;
  }

  function progressBar(b) {
    const pct = Math.round((b.progress || 0) * 100);
    return h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct, 'aria-label': 'Progresso de leitura' }, h('span', {}));
  }
  const setPct = (el, b) => { el.firstChild.style.width = `${Math.round((b.progress || 0) * 100)}%`; return el; };

  function openBook(b) {
    if (st.selecting) { st.selected.has(b.id) ? st.selected.delete(b.id) : st.selected.add(b.id); render(); return; }
    location.hash = `#ler-${b.id}`;
  }

  function bookMenu(b, anchor, pt = {}) {
    menu(anchor, [
      { label: 'Abrir', icon: 'book', onClick: () => { location.hash = `#ler-${b.id}`; } },
      { label: 'Detalhes e edição', icon: 'edit', onClick: () => openDetails(b) },
      { label: b.favorite ? 'Remover dos favoritos' : 'Favoritar', icon: 'star', onClick: () => toggleFavorite(b) },
      { label: 'Coleções', icon: 'folder', onClick: () => openCollectionPicker([b], load) },
      { label: 'Selecionar', icon: 'checklist', onClick: () => { st.selecting = true; st.selected.add(b.id); render(); } },
      { divider: true },
      { label: 'Excluir', icon: 'trash', danger: true, onClick: () => removeBooks([b.id]) },
    ], { ...pt, title: b.title });
  }

  /** Cartão de livro. `mode` força grade (usado nas linhas do Início). */
  function card(b, mode = st.view) {
    const sel = st.selected.has(b.id);
    const fav = b.favorite ? h('span', { class: 'fav-badge', title: 'Favorito' }, icon('star', 14)) : null;
    const check = st.selecting ? h('span', { class: `check${sel ? ' on' : ''}`, 'aria-hidden': 'true' }, sel ? icon('check', 14) : null) : null;
    const prog = setPct(progressBar(b), b);
    const el = h('article', {
      class: `book ${mode}${sel ? ' selected' : ''}`, tabindex: 0, role: 'button', 'data-id': b.id,
      'aria-label': `${b.title}${b.author ? `, ${b.author}` : ''}`, 'aria-pressed': st.selecting ? String(sel) : null,
      onclick: () => openBook(b),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBook(b); } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); bookMenu(b, el); } },
      oncontextmenu: (e) => { e.preventDefault(); if (!st.selecting) bookMenu(b, el, { x: e.clientX, y: e.clientY }); }, // toque longo (Android) ou botão direito
    },
    h('div', { class: 'cover-wrap' }, coverEl(b), fav, check, mode === 'grid' ? prog : null),
    h('div', { class: 'meta' },
      h('div', { class: 'book-title' }, b.title),
      h('div', { class: 'book-author' }, b.author || 'Autor desconhecido'),
      h('button', { class: 'info-btn', type: 'button', 'aria-label': `Mais opções de ${b.title}`, 'aria-haspopup': 'menu', onclick: (e) => { e.stopPropagation(); bookMenu(b, e.currentTarget); }, onkeydown: (e) => e.stopPropagation() }, icon('more', 18)),
      h('div', { class: 'book-info' }, `${b.format.toUpperCase()} · ${{ concluido: 'Concluído', andamento: `${Math.round((b.progress || 0) * 100)}%`, 'nao-iniciado': 'Não iniciado' }[bookStatus(b)]}`),
      mode === 'list' ? prog : null));
    return el;
  }

  function render() { root.classList.toggle('selecting', st.selecting); renderContent(); renderBar(); }

  const emptyLibrary = () => h('div', { class: 'empty' }, h('img', { class: 'empty-logo', src: 'icons/boto.png', alt: 'Boto Azul', width: 96, height: 96 }), h('h2', {}, 'Sua biblioteca está vazia'),
    h('p', {}, 'Importe livros em EPUB ou PDF para começar. Você também pode arrastar os arquivos para esta janela.'),
    h('button', { class: 'btn primary', type: 'button', onclick: () => input.click() }, icon('plus', 18), 'Importar livros'));

  function ago(ts) {
    const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if (m < 2) return 'agora há pouco'; if (m < 60) return `há ${m} min`;
    const hh = Math.round(m / 60); if (hh < 24) return `há ${hh} h`;
    const d = Math.round(hh / 24); return d === 1 ? 'ontem' : d < 30 ? `há ${d} dias` : new Date(ts).toLocaleDateString('pt-BR');
  }
  const goHash = (hash) => { location.hash = hash; };

  function renderHome() {
    const byRead = (x, y) => (y.lastReadAt || 0) - (x.lastReadAt || 0);
    const pool = [...st.books, ...(st.classics || [])]; // o livro em andamento aparece no Início mesmo sendo um clássico
    const reading = pool.filter((b) => b.lastReadAt && bookStatus(b) !== 'concluido').sort(byRead);
    const fresh = st.books.filter((b) => bookStatus(b) === 'nao-iniciado').sort((x, y) => y.addedAt - x.addedAt);
    const hero = reading[0] || fresh[0] || null;
    const recent = pool.filter((b) => b.lastReadAt && b !== hero).sort(byRead).slice(0, 12);
    const added = [...st.books].sort((x, y) => y.addedAt - x.addedAt).slice(0, 12);
    const row = (list) => h('div', { class: 'row' }, list.map((b) => card(b, 'grid')));
    const sec = (title, body, link) => h('section', { class: 'sec', 'aria-label': title }, h('div', { class: 'sec-h' }, h('h2', {}, title), link ? h('button', { class: 'link', type: 'button', onclick: link[1] }, link[0]) : null), body);
    const out = [];
    if (hero) {
      const resume = !!hero.lastReadAt, pct = Math.round((hero.progress || 0) * 100);
      const go = () => goHash(`#ler-${hero.id}`);
      out.push(h('section', { class: 'hero', 'aria-label': resume ? 'Continuar lendo' : 'Comece por aqui', onclick: go },
        coverEl(hero),
        h('div', { class: 'hero-body' },
          h('div', { class: 'hero-kicker' }, resume ? 'Continuar lendo' : 'Comece por aqui'),
          h('div', { class: 'hero-title' }, hero.title), h('div', { class: 'hero-author' }, hero.author || 'Autor desconhecido'),
          setPct(progressBar(hero), hero),
          h('div', { class: 'hero-meta' }, h('span', {}, resume ? `${pct}% concluído` : `${hero.format.toUpperCase()}${hero.pages ? ` · ${hero.pages} págs.` : ''}`), resume ? h('span', {}, ago(hero.lastReadAt)) : null),
          h('button', { class: 'btn', type: 'button', onclick: (e) => { e.stopPropagation(); go(); } }, icon('play', 18), resume ? 'Continuar' : 'Começar a ler'))));
      const goalMin = (getSetting('goals') || DEFAULT_GOALS).dailyMin || DEFAULT_GOALS.dailyMin, goalSec = goalMin * 60;
      out.push(h('a', { class: 'goal-line', href: '#estatisticas', 'aria-label': `Meta de hoje: ${fmtDuration(st.todaySec)} de ${goalMin} min` }, icon('clock', 20),
        h('span', {}, 'Hoje ', h('strong', {}, fmtDuration(st.todaySec)), ` de ${goalMin} min`),
        h('div', { class: 'meter', 'aria-hidden': 'true' }, h('i', { style: `width:${Math.min(100, (st.todaySec / goalSec) * 100)}%` }))));
    }
    if (recent.length) out.push(sec('Leitura recente', row(recent), ['Ver tudo', async () => { await setSetting('sort', 'read-desc'); goHash('#biblioteca'); }]));
    if (added.length) out.push(sec('Adicionados recentemente', row(added), ['Ver tudo', () => goHash('#biblioteca')]));
    out.push(sec('Coleções', h('div', { class: 'pills' },
      st.collections.map((c) => h('button', { class: 'pill', type: 'button', onclick: async () => { await setSetting('collection', c.id); await setSetting('genre', ''); goHash('#biblioteca'); } }, icon('folder', 20), h('span', {}, c.name), h('span', { class: 'pill-n' }, String(st.books.filter((b) => b.collections?.includes(c.id)).length)))),
      h('button', { class: 'pill', type: 'button', onclick: () => goHash('#colecoes') }, icon('plus', 20), h('span', {}, st.collections.length ? 'Gerenciar' : 'Criar coleção'))), null));
    if (st.genres.length) out.push(sec('Categorias', h('div', { class: 'pills' }, st.genres.slice(0, 12).map((g) => h('button', { class: 'pill tag', type: 'button', onclick: async () => { await setSetting('genre', g.key); await setSetting('collection', ''); goHash('#biblioteca'); } }, h('span', {}, g.label), h('span', { class: 'pill-n' }, String(g.count)))))));
    content.replaceChildren(...out);
  }

  function renderContent() {
    if (!st.books.length && !(home && st.classics?.some((b) => b.lastReadAt))) { content.replaceChildren(emptyLibrary()); return; }
    if (home && !st.query) { renderHome(); return; }
    const shown = applyView(st.books, { query: st.query, filter: st.filter, sort: st.sort, onlyFavorites, collection: st.collection, genre: st.genre });
    content.replaceChildren();
    if (!shown.length) {
      content.append(h('div', { class: 'empty' }, h('h2', {}, onlyFavorites && !st.query && st.filter === 'todos' ? 'Nenhum favorito ainda' : 'Nenhum livro encontrado'),
        h('p', {}, onlyFavorites && !st.query && st.filter === 'todos' ? 'Toque em um livro e marque como favorito.' : st.collection ? 'Esta coleção não tem livros com esses filtros. Use "Selecionar" para incluir livros nela.' : 'Ajuste a busca ou os filtros.')));
    } else {
      content.append(h('div', { class: `books ${home ? 'grid' : st.view}` }, shown.map((b) => card(b, home ? 'grid' : st.view))));
    }
    const c = bar.querySelector('.count');
    if (c) c.textContent = `${shown.length} livro(s)`;
  }

  /* ---------- barras ---------- */
  const bar = h('div', { class: 'lib-bar' });
  const toolsEl = h('div', { class: 'top-tools' });
  const SORT_SHORT = { 'added-desc': 'Recentes', 'read-desc': 'Última leitura', title: 'Título', author: 'Autor' };
  function renderBar() {
    const count = applyView(st.books, { query: st.query, filter: st.filter, sort: st.sort, onlyFavorites, collection: st.collection, genre: st.genre }).length;
    bar.replaceChildren(); toolsEl.replaceChildren();
    if (st.selecting) {
      const ids = [...st.selected];
      bar.append(h('div', { class: 'sel-bar' },
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Cancelar seleção', onclick: () => { st.selecting = false; st.selected.clear(); render(); } }, icon('close')),
        h('strong', {}, `${ids.length} selecionado(s)`),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn', type: 'button', disabled: !ids.length, onclick: async () => {
          const all = st.books.filter((b) => st.selected.has(b.id));
          const makeFav = !all.every((b) => b.favorite);
          for (const b of all) await db.put('books', { ...b, favorite: makeFav, updatedAt: Date.now() });
          await load();
        } }, icon('star', 18), 'Favoritar'),
        h('button', { class: 'btn', type: 'button', disabled: !ids.length, onclick: () => openCollectionPicker(st.books.filter((b) => st.selected.has(b.id)), () => { st.selecting = false; st.selected.clear(); return load(); }) }, icon('folder', 18), 'Coleções'),
        h('button', { class: 'btn danger', type: 'button', disabled: !ids.length, onclick: () => removeBooks(ids) }, icon('trash', 18), 'Excluir'),
        h('button', { class: 'btn', type: 'button', onclick: () => { st.selecting = false; st.selected.clear(); render(); } }, 'Cancelar')));
      return;
    }
    const search = h('input', { type: 'search', class: 'search', placeholder: 'Buscar na biblioteca', 'aria-label': 'Buscar livros', value: st.query, enterkeyhint: 'search', autocomplete: 'off' });
    const clear = h('button', { class: 'icon-btn clear', type: 'button', 'aria-label': 'Limpar busca', hidden: !st.query, onclick: () => { search.value = ''; st.query = ''; clear.hidden = true; render(); search.focus(); } }, icon('close', 20));
    search.addEventListener('input', () => { st.query = search.value; clear.hidden = !st.query; clearTimeout(search._t); search._t = setTimeout(renderContent, 150); });
    const homeSearching = home && st.query;
    const tools = home ? [] : [
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Selecionar livros', disabled: !st.books.length, onclick: () => { st.selecting = true; render(); } }, icon('checklist')),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': st.view === 'grid' ? 'Exibir em lista' : 'Exibir em grade', onclick: async () => { st.view = st.view === 'grid' ? 'list' : 'grid'; await setSetting('view', st.view); render(); } }, icon(st.view === 'grid' ? 'list' : 'grid'))];
    toolsEl.replaceChildren(...tools);
    bar.append(h('div', { class: 'toolbar' }, h('div', { class: 'search-wrap' }, icon('search', 22), search, clear)));
    if (home) return;
    const mchip = (ic, label, active, items, title) => h('button', { class: `chip${active ? ' on' : ''}`, type: 'button', 'aria-haspopup': 'menu', onclick: (e) => menu(e.currentTarget, items, { title }) }, icon(ic, 18), label, icon('down', 16));
    const chips = [
      mchip('sort', SORT_SHORT[st.sort] || 'Ordenar', false, [{ heading: 'Ordenar por' }, ...SORTS.map(([v, l]) => ({ label: l, checked: v === st.sort, onClick: async () => { st.sort = v; await setSetting('sort', v); render(); } }))], 'Ordenar'),
    ];
    if (st.collections.length) {
      const cur = st.collections.find((c) => c.id === st.collection);
      chips.push(mchip('folder', cur ? cur.name : 'Coleção', !!cur, [{ heading: 'Coleção' }, { label: 'Todas as coleções', checked: !cur, onClick: () => { st.collection = ''; render(); } },
        ...st.collections.map((c) => ({ label: c.name, checked: c.id === st.collection, onClick: () => { st.collection = c.id; render(); } })), { divider: true }, { label: 'Gerenciar coleções', icon: 'edit', onClick: () => goHash('#colecoes') }], 'Coleção'));
    }
    if (st.genres.length) {
      const cur = st.genres.find((g) => g.key === st.genre);
      chips.push(mchip('tag', cur ? cur.label : 'Categoria', !!cur, [{ heading: 'Categoria' }, { label: 'Todas as categorias', checked: !cur, onClick: () => { st.genre = ''; render(); } },
        ...st.genres.map((g) => ({ label: `${g.label} (${g.count})`, checked: g.key === st.genre, onClick: () => { st.genre = g.key; render(); } }))], 'Categoria'));
    }
    bar.append(h('div', { class: 'chips', role: 'group', 'aria-label': 'Filtros' }, chips, h('span', { class: 'chip-sep', 'aria-hidden': 'true' }),
      FILTER_LABELS.map(([v, l]) => h('button', { type: 'button', class: `chip${st.filter === v ? ' on' : ''}`, 'aria-pressed': String(st.filter === v), onclick: () => { st.filter = v; render(); } }, l)),
      h('span', { class: 'count' }, `${count} livro(s)`)));
  }

  /* ---------- detalhes / edição ---------- */
  function openDetails(book) {
    const field = (label, el) => h('label', { class: 'field' }, h('span', {}, label), el);
    const f = {
      title: h('input', { value: book.title, maxlength: 300, required: true }),
      author: h('input', { value: book.author, maxlength: 300 }),
      publisher: h('input', { value: book.publisher, maxlength: 300 }),
      genre: h('input', { value: book.genre, maxlength: 200 }),
      isbn: h('input', { value: book.isbn, maxlength: 20, inputmode: 'numeric' }),
      description: h('textarea', { rows: 4, maxlength: 4000 }, book.description),
    };
    f.description.value = book.description;
    const coverHolder = h('div', { class: 'cover-holder' }, coverEl(book, 'big'));
    const coverInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/gif,image/webp', hidden: true });
    const fileInput = h('input', { type: 'file', accept: book.format === 'pdf' ? '.pdf' : '.epub', hidden: true });
    let cur = book;
    function openPicker() {
      openMetadataPicker({
        book: cur,
        onData: (d) => { for (const k of ['title', 'author', 'publisher', 'genre', 'isbn']) if (d[k]) f[k].value = d[k]; if (d.description) f.description.value = d.description; },
        onCover: async (blob, source) => {
          await db.setCover(book.id, blob, source);
          cur = (await db.get('books', book.id)) || cur;
          await load();
          coverHolder.replaceChildren(coverEl(cur, 'big'));
        },
      });
    }
    const dlg = modal({
      title: 'Detalhes do livro', wide: true,
      body: h('div', { class: 'details' },
        h('div', { class: 'details-side' }, coverHolder,
          h('button', { class: 'btn', type: 'button', onclick: () => coverInput.click() }, icon('image', 18), 'Trocar capa'),
          h('button', { class: 'btn', type: 'button', onclick: openPicker }, icon('search', 18), 'Buscar online'),
          h('button', { class: 'btn', type: 'button', onclick: () => openCollectionPicker([cur], load) }, icon('folder', 18), 'Coleções'),
          h('button', { class: 'btn', type: 'button', onclick: () => fileInput.click() }, icon('swap', 18), 'Substituir arquivo'),
          h('p', { class: 'hint' }, `${book.format.toUpperCase()} · ${formatBytes(book.size)}${book.pages ? ` · ${book.pages} págs.` : ''}`),
          coverInput, fileInput),
        h('div', { class: 'details-form' }, field('Título', f.title), field('Autor', f.author), field('Editora', f.publisher), field('Gênero', f.genre), field('ISBN', f.isbn), field('Descrição', f.description))),
      actions: [
        { label: 'Excluir', kind: 'danger', onClick: async ({ close }) => { const ok = await removeBooks([book.id]); if (ok) close(); return false; } },
        { label: 'Ler', kind: 'primary', onClick: () => { location.hash = `#ler-${book.id}`; } },
        { label: book.favorite ? 'Remover dos favoritos' : 'Favoritar', onClick: async () => { await toggleFavorite(cur); } },
        { label: 'Salvar', onClick: async () => {
          const title = f.title.value.trim();
          if (!title) { toast('O título é obrigatório.', 'error'); f.title.focus(); return false; }
          const fresh = (await db.get('books', book.id)) || cur;
          await db.put('books', { ...fresh, title, author: f.author.value.trim(), publisher: f.publisher.value.trim(), genre: f.genre.value.trim(), isbn: f.isbn.value.replace(/[^0-9Xx-]/g, '').trim(), description: f.description.value.trim(), updatedAt: Date.now() });
          toast('Alterações salvas.');
          await load();
        } },
      ],
    });
    coverInput.addEventListener('change', async () => {
      const file = coverInput.files[0]; coverInput.value = '';
      if (!file) return;
      try {
        await db.setCover(book.id, await normalizeCover(file), 'manual');
        cur = (await db.get('books', book.id)) || cur;
        await load();
        coverHolder.replaceChildren(coverEl(cur, 'big'));
        toast('Capa atualizada.');
      } catch (e) { toast(e.message || 'Não foi possível usar esta imagem.', 'error'); }
    });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0]; fileInput.value = '';
      if (!file) return;
      try {
        cur = await replaceFile((await db.get('books', book.id)) || cur, file);
        toast('Arquivo substituído. Progresso e anotações foram mantidos.');
        await load();
      } catch (e) { toast(e.message || 'Não foi possível substituir o arquivo.', 'error'); }
    });
    return dlg;
  }

  /* ---------- montagem ---------- */
  const fab = h('button', { class: 'fab', type: 'button', 'aria-label': 'Importar livros', onclick: () => input.click() }, icon('plus', 24), h('span', { class: 'fab-l' }, 'Importar'));
  const onScroll = () => fab.classList.toggle('min', window.scrollY > 120);
  window.addEventListener('scroll', onScroll, { passive: true });
  // Indicação de status da busca automática de capas (serviço em capas.js)
  const cvStat = h('div', { class: 'cv-status', role: 'status', 'aria-live': 'polite', hidden: true });
  let cvTimer = 0, cvPrev = getCoverStatus(), cvFound = cvPrev.found, cvReload = 0, cvFlash = false;
  const cvShow = (txt, kind = '') => { cvStat.hidden = !txt; cvStat.className = `cv-status ${kind}`; cvStat.textContent = txt || ''; };
  const offCovers = onCoverStatus((s) => {
    if (s.found !== cvFound) { cvFound = s.found; clearTimeout(cvReload); cvReload = setTimeout(() => load().catch(() => {}), 800); }
    if (s.state === 'searching') { cvFlash = false; clearTimeout(cvTimer); cvShow(`Procurando capas…${s.pending ? ` (${s.pending} restante${s.pending > 1 ? 's' : ''})` : ''}`, 'busy'); }
    else if (cvPrev.state === 'searching' && (s.state === 'done' || s.state === 'partial')) {
      const end = () => { cvFlash = false; cvShow(s.state === 'partial' ? 'Algumas capas não foram localizadas.' : 'Sincronização concluída.', s.state === 'partial' ? 'warn' : 'ok'); if (s.state === 'done') cvTimer = setTimeout(() => cvShow(''), 5000); };
      if (s.found > 0) { cvFlash = true; cvShow('Capas encontradas.', 'ok'); cvTimer = setTimeout(end, 3000); } else end();
    } else if (!cvFlash && s.state === 'partial' && cvStat.hidden) cvShow('Algumas capas não foram localizadas.', 'warn');
    cvPrev = s;
  });
  const hour = new Date().getHours(), greeting = hour < 5 ? 'Boa madrugada' : hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  root.replaceChildren(
    home ? h('div', { class: 'greet head-brand' }, bimg(), h('div', {}, h('h1', {}, greeting), h('p', { class: 'hint' }, 'Continue de onde parou.')))
      : h('div', { class: 'view-head top-row' }, bimg(), h('h1', {}, onlyFavorites ? 'Favoritos' : 'Biblioteca'), toolsEl),
    ...(home ? [bar] : [h('div', { class: 'lib-sticky' }, libTabs('meus'), bar)]), ...(home ? [] : [cvStat]), content, input,
    fab);
  if (st.collection || st.genre) { setSetting('collection', ''); setSetting('genre', ''); } // filtro vindo do Início/Coleções vale só para esta visita

  // arrastar e soltar
  const onDragOver = (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); root.classList.add('dragging'); } };
  const onDragLeave = (e) => { if (e.target === root || !root.contains(e.relatedTarget)) root.classList.remove('dragging'); };
  const onDrop = (e) => { e.preventDefault(); root.classList.remove('dragging'); doImport([...e.dataTransfer.files]); };
  root.addEventListener('dragover', onDragOver); root.addEventListener('dragleave', onDragLeave); root.addEventListener('drop', onDrop);

  load().catch(() => toast('Não foi possível abrir o armazenamento local.', 'error'));
  return () => { offCovers(); clearTimeout(cvTimer); clearTimeout(cvReload); window.removeEventListener('scroll', onScroll); st.coverUrls.forEach((u) => URL.revokeObjectURL(u)); root.removeEventListener('dragover', onDragOver); root.removeEventListener('dragleave', onDragLeave); root.removeEventListener('drop', onDrop); };
}
