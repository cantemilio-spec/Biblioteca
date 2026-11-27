
// Catálogos públicos do Boto Azul.
// A Estante utiliza a API da Cloudflare; as demais fontes continuam estáticas.
import { h, icon, toast, menu, bimg } from './ui.js';
import * as db from './db.js';
import { importFile } from './importer.js';
import { norm } from './books.js';
import { libTabs, CLASSIC_TABS, isCatalogBook } from './lib-tabs.js';

export const CLASSICS_SOURCE = 'adamastor';

const API_BASE = 'https://boto-azul-api.cant-emilio.workers.dev';

const CFG = {
  adamastor: { source: 'adamastor', dir: 'public/books/adamastor/', tabKey: 'todos', label: 'Buscar nos clássicos', hint: 'Tudo o que dá para ler: Clássicos, Acervo, Internacional e Estante. Toque para abrir; o livro é baixado só na primeira vez.' },
  acervo: { source: 'acervo', dir: 'public/books/acervo/', label: 'Buscar no acervo', hint: 'Acervo de domínio público (Project Gutenberg): brasileiros, internacionais, filosofia e terror. Toque para abrir; o livro é baixado só na primeira vez.' },
  literatura: { source: 'literatura', dir: 'public/books/literatura-internacional/', label: 'Buscar na literatura internacional', hint: 'Clássicos da literatura mundial traduzidos para português, por nacionalidade. Toque para abrir; o livro é baixado só na primeira vez.' },
  estante: { source: 'estante', dir: 'public/books/estante/', tabKey: 'estante', label: 'Buscar na estante', hint: 'Livros autorizados disponibilizados pela nuvem do Boto Azul. Toque para abrir; o livro é baixado só na primeira vez.' },
};

function tint(id) {
  let n = 0;
  for (const c of id) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${198 + (n % 14)} ${26 + (n % 10)}% ${34 + (n % 14)}%)`;
}

async function loadCatalog(cfg) {
  // A Estante agora recebe os livros aprovados pela API da Cloudflare.
  if (cfg.source === 'estante') {
    const r = await fetch(`${API_BASE}/api/books`, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`API HTTP ${r.status}`);

    const data = await r.json();
    const list = Array.isArray(data?.books) ? data.books : [];

    const books = list
      .filter((b) =>
        b &&
        typeof b.id === 'string' &&
        /^[a-zA-Z0-9_-]+$/.test(b.id) &&
        typeof b.title === 'string' &&
        ['epub', 'pdf'].includes(String(b.format || '').toLowerCase())
      )
      .map((b) => {
        const format = String(b.format).toLowerCase();
        let cover = null;

        // Aceita somente capas com endereço HTTP ou HTTPS absoluto.
        if (typeof b.cover === 'string') {
          try {
            const u = new URL(b.cover);
            if (u.protocol === 'https:' || u.protocol === 'http:') {
              cover = u.href;
            }
          } catch {
            cover = null;
          }
        }

        return {
          id: b.id,
          titulo: b.title,
          autor: b.author || '',
          categoria: 'Estante',
          genero: format.toUpperCase(),
          capa: cover,
          epub: `${API_BASE}/api/book/${encodeURIComponent(b.id)}`,
          formato: format,
          baixado: true,
          tamanho: b.size || null,
          capa_ok: !!cover,
          _cfg: cfg,
        };
      });

    return {
      info: { licenca: 'Obras disponibilizadas conforme autorização de distribuição.' },
      books,
    };
  }

  // Os outros catálogos continuam sendo carregados do GitHub Pages.
  const r = await fetch(`${cfg.dir}catalogo.json`, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);

  const j = await r.json();
  const list = Array.isArray(j?.livros) ? j.livros : [];

  const ok = (p) =>
    typeof p === 'string' &&
    p.startsWith(cfg.dir) &&
    !p.includes('..');

  return {
    info: j,
    books: list
      .filter((b) =>
        b &&
        typeof b.id === 'string' &&
        typeof b.titulo === 'string' &&
        ok(b.epub)
      )
      .map((b) => ({
        ...b,
        capa: ok(b.capa) ? b.capa : null,
        _cfg: cfg,
      })),
  };
}

/** Baixa o livro sob demanda e guarda uma cópia no aparelho. */
export async function fetchClassic(c, cfg = CFG.adamastor) {
  const format = c.formato || 'epub';
  const extension = format === 'pdf' ? 'pdf' : 'epub';
  const mime = format === 'pdf' ? 'application/pdf' : 'application/epub+zip';

  const r = await fetch(c.epub);
  if (!r.ok) throw new Error('Arquivo não encontrado no projeto.');

  const blob = await r.blob();
  const file = new File([blob], `${c.id}.${extension}`, { type: mime });
  const res = await importFile(file);

  if (res.status === 'duplicate') return res.book.id;

  await db.updateBook(res.book.id, (b) => ({
    ...b,
    source: cfg.source,
    classicId: c.id,
    classicCat: CLASSIC_TABS.find(([, l]) => l === c.categoria)?.[0] || '',
    title: c.titulo,
    author: c.autor || b.author,
    genre: c.genero || b.genre,
    publisher: c.credito || b.publisher,
  }));

  return res.book.id;
}

export const mountClassics = (root, tab = '') =>
  mountCatalog(root, tab, CFG.adamastor);

export const mountEstante = (root) =>
  mountCatalog(root, '', CFG.estante);

export const mountAcervo = (root) =>
  mountCatalog(root, '', CFG.acervo);

export const mountLiteratura = (root) =>
  mountCatalog(root, '', CFG.literatura);

async function mountCatalog(root, tab, cfg) {
  const st = {
    query: '',
    cat: CLASSIC_TABS.find(([k]) => k === tab)?.[1] || '',
    saved: new Map(),
    busy: new Set(),
  };

  const grid = h('div', { class: 'books grid' });
  const bar = h('div', { class: 'lib-bar' });
  const count = h('p', {
    class: 'hint cl-count',
    'aria-live': 'polite',
  });

  root.replaceChildren(
    h('div', { class: 'view-head head-brand' },
      bimg(),
      h('div', {},
        h('h1', {}, 'Biblioteca'),
        h('p', { class: 'hint' },
          cfg.source === 'adamastor' && CLASSIC_TABS.some(([k]) => k === tab)
            ? 'Clássicos da Literatura (domínio público, Projecto Adamastor). Toque para abrir; o livro é baixado só na primeira vez.'
            : cfg.hint
        )
      )
    ),
    h('div', { class: 'lib-sticky' },
      libTabs(
        ['estante', 'acervo', 'literatura'].includes(cfg.source)
          ? cfg.source
          : CLASSIC_TABS.some(([k]) => k === tab)
            ? tab
            : 'todos'
      ),
      bar
    ),
    count,
    grid
  );

  let cat;

  try {
    cat = await loadCatalog(cfg);
  } catch {
    grid.replaceWith(
      h('div', { class: 'empty small' },
        icon('book', 40),
        h('h2', {}, 'Catálogo indisponível'),
        h('p', {}, 'Não foi possível carregar a lista agora. Verifique a conexão e tente de novo.'),
        h('button', {
          class: 'btn',
          type: 'button',
          onclick: () => mountCatalog(root, tab, cfg),
        }, 'Tentar de novo')
      )
    );
    bar.remove();
    count.remove();
    return;
  }

  let books = cat.books;

  // A tela de Clássicos também reúne as outras fontes.
  if (
    cfg.source === 'adamastor' &&
    !CLASSIC_TABS.some(([k]) => k === tab)
  ) {
    for (const extra of [CFG.acervo, CFG.literatura, CFG.estante]) {
      try {
        books = [...books, ...(await loadCatalog(extra)).books];
      } catch {
        // Uma fonte indisponível não impede as demais de aparecer.
      }
    }
  }

  async function refreshSaved() {
    st.saved = new Map(
      (await db.getAll('books'))
        .filter(isCatalogBook)
        .map((b) => [b.classicId, b])
    );
  }

  async function open(c) {
    if (!c.baixado) {
      toast('Este livro ainda não está disponível para baixar.');
      return;
    }

    const saved = st.saved.get(c.id);

    if (saved) {
      location.hash = `#ler-${saved.id}`;
      return;
    }

    if (st.busy.has(c.id)) return;

    st.busy.add(c.id);
    draw();

    try {
      const id = await fetchClassic(c, c._cfg || cfg);
      location.hash = `#ler-${id}`;
    } catch (e) {
      st.busy.delete(c.id);
      draw();

      toast(
        e?.name === 'TypeError'
          ? 'Sem conexão para baixar este livro agora.'
          : (e?.message || 'Não foi possível abrir este livro.'),
        'error'
      );
    }
  }

  function card(c) {
    const saved = st.saved.get(c.id);
    const pct = Math.round((saved?.progress || 0) * 100);
    const busy = st.busy.has(c.id);

    const ph = () => {
      const p = h('div', {
        class: 'cover placeholder',
      },
        h('span', { class: 'ph-title' }, c.titulo),
        c.autor ? h('span', { class: 'ph-author' }, c.autor) : null
      );

      p.style.setProperty('--tint', tint(c.id));
      return p;
    };

    let cover;

    if (c.baixado && c.capa && c.capa_ok !== false) {
      const img = h('img', {
        src: c.capa,
        alt: '',
        loading: 'lazy',
        draggable: 'false',
      });

      cover = h('div', { class: 'cover' }, img);

      img.addEventListener('error', () => cover.replaceWith(ph()), {
        once: true,
      });
    } else {
      cover = ph();
    }

    const el = h('article', {
      class: `book grid${c.baixado ? '' : ' pending'}${busy ? ' busy' : ''}`,
      tabindex: 0,
      role: 'button',
      'aria-label': `${c.titulo}, ${c.autor}${c.baixado ? '' : ' (arquivo pendente)'}`,
      'aria-busy': busy ? 'true' : null,
      onclick: () => open(c),
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open(c);
        }
      },
    },
      h('div', { class: 'cover-wrap' },
        cover,
        saved && pct
          ? h('div', {
              class: 'progress',
              role: 'progressbar',
              'aria-valuemin': 0,
              'aria-valuemax': 100,
              'aria-valuenow': pct,
            }, h('span', { style: `width:${pct}%` }))
          : null,
        busy
          ? h('div', { class: 'cl-busy', role: 'status' }, 'Baixando…')
          : null
      ),
      h('div', { class: 'meta' },
        h('div', { class: 'book-title' }, c.titulo),
        h('div', { class: 'book-author' }, c.autor || ''),
        h('div', { class: 'cl-tag' },
          c.baixado
            ? (pct >= 98 ? 'Concluído' : pct ? `${pct}%` : c.genero || '')
            : 'Pendente'
        ),
        saved
          ? h('button', {
              class: 'info-btn',
              type: 'button',
              'aria-label': `Mais opções de ${c.titulo}`,
              'aria-haspopup': 'menu',
              onclick: (e) => {
                e.stopPropagation();

                menu(e.currentTarget, [
                  {
                    label: 'Abrir',
                    icon: 'book',
                    onClick: () => open(c),
                  },
                  { divider: true },
                  {
                    label: 'Remover do aparelho',
                    icon: 'trash',
                    danger: true,
                    onClick: async () => {
                      await db.deleteBook(saved.id);
                      await refreshSaved();
                      draw();
                      toast('Removido do aparelho. Você pode baixar de novo quando quiser.');
                    },
                  },
                ], { title: c.titulo });
              },
              onkeydown: (e) => e.stopPropagation(),
            }, icon('more', 18))
          : null
      )
    );

    return el;
  }

  function filtered() {
    const qs = norm(st.query).split(/\s+/).filter(Boolean);

    return books.filter((b) => {
      const hay = norm(
        `${b.titulo} ${b.autor} ${b.genero} ${b.categoria}`
      );

      return (
        (!st.cat || b.categoria === st.cat) &&
        qs.every((w) => hay.includes(w))
      );
    });
  }

  function draw() {
    const list = filtered();

    count.textContent =
      books.length || !['estante', 'acervo', 'literatura'].includes(cfg.source)
        ? `${list.length} ${list.length === 1 ? 'obra' : 'obras'}`
        : '';

    const none = !books.length && cfg.source === 'literatura'
      ? h('div', { class: 'empty small' },
          icon('book', 40),
          h('h2', {}, 'Literatura internacional ainda não importada'),
          h('p', {}, 'No GitHub, rode o workflow “Importar livros” (Actions). Os livros aparecem aqui, separados por nacionalidade.')
        )
      : !books.length && cfg.source === 'acervo'
        ? h('div', { class: 'empty small' },
            icon('book', 40),
            h('h2', {}, 'Acervo ainda não importado'),
            h('p', {}, 'No GitHub, rode o workflow “Importar acervo” (Actions). Os livros aparecem aqui quando ele terminar.')
          )
        : !books.length && cfg.source === 'estante'
          ? h('div', { class: 'empty small' },
              icon('book', 40),
              h('h2', {}, 'Estante vazia'),
              h('p', {}, 'Ainda não há livros autorizados publicados na nuvem. Quando uma obra for adicionada ao catálogo da API, ela aparecerá aqui.')
            )
          : h('div', { class: 'empty small' },
              icon('search', 36),
              h('p', {}, 'Nenhuma obra encontrada.')
            );

    grid.replaceChildren(...(list.length ? list.map(card) : [none]));
  }

  const search = h('input', {
    type: 'search',
    class: 'search',
    placeholder: 'Buscar título ou autor',
    'aria-label': cfg.label,
    enterkeyhint: 'search',
    autocomplete: 'off',
  });

  const clear = h('button', {
    class: 'icon-btn clear',
    type: 'button',
    'aria-label': 'Limpar busca',
    hidden: true,
    onclick: () => {
      search.value = '';
      st.query = '';
      clear.hidden = true;
      draw();
      search.focus();
    },
  }, icon('close', 20));

  search.addEventListener('input', () => {
    st.query = search.value;
    clear.hidden = !st.query;
    draw();
  });

  bar.append(
    h('div', { class: 'toolbar' },
      h('div', { class: 'search-wrap' },
        icon('search', 22),
        search,
        clear
      )
    )
  );

  if (
    ['acervo', 'literatura'].includes(cfg.source) &&
    books.length
  ) {
    const cats = [
      '',
      ...[...new Set(books.map((b) => b.categoria))],
    ];

    const chips = h('div', {
      class: 'chips',
      role: 'group',
      'aria-label': 'Categorias do acervo',
    },
      cats.map((c) =>
        h('button', {
          type: 'button',
          class: `chip${st.cat === c ? ' on' : ''}`,
          'aria-pressed': String(st.cat === c),
          onclick: (e) => {
            st.cat = c;

            chips.querySelectorAll('.chip').forEach((x) => {
              const on = x === e.currentTarget;
              x.classList.toggle('on', on);
              x.setAttribute('aria-pressed', String(on));
            });

            draw();
          },
        }, c || 'Todos')
      )
    );

    bar.append(chips);
  }

  if (cat.info?.licenca) {
    root.append(
      h('p', { class: 'hint cl-license' }, cat.info.licenca)
    );
  }

  await refreshSaved();
  draw();
}
