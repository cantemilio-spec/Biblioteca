// Abas da Biblioteca: Meus livros, Coleções e as categorias dos Clássicos da Literatura (cada uma é uma tela própria).
import { h } from './ui.js';

export const CLASSIC_TABS = [['br', 'Literatura brasileira'], ['pt', 'Literatura portuguesa'], ['in', 'Clássicos internacionais']];
// A Biblioteca abre em "Disponíveis" (todos os livros que dá para ler agora); "Meus livros" são os importados pelo próprio leitor.
const TABS = [['todos', 'Disponíveis', '#classicos'], ...CLASSIC_TABS.map(([k, l]) => [k, l, `#classicos-${k}`]), ['acervo', 'Acervo', '#acervo'], ['estante', 'Estante', '#estante'], ['meus', 'Meus livros', '#biblioteca'], ['colecoes', 'Coleções', '#colecoes']];

// Livros vindos de catálogos do projeto (Clássicos e Estante): ficam fora de "Meus livros" e das Coleções.
export const isCatalogBook = (b) => b?.source === 'adamastor' || b?.source === 'estante' || b?.source === 'acervo';

export function libTabs(active) {
  const nav = h('nav', { class: 'lib-tabs', 'aria-label': 'Seções da Biblioteca' },
    TABS.map(([k, label, href]) => h('a', { href, 'aria-current': k === active ? 'page' : null }, label)));
  setTimeout(() => { const a = nav.querySelector('[aria-current]'); if (a) nav.scrollLeft = Math.max(0, a.offsetLeft - 16); }, 0);
  return nav;
}
