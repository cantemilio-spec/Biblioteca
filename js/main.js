import { h, icon } from './ui.js';
import { initSettings, applyTheme, applyAppearance, watchSystemTheme } from './settings.js';
import { mountLibrary } from './library.js';
import { mountSettings } from './settings-view.js';
import { mountReader } from './reader.js';
import { mountStats } from './stats-view.js';
import { mountCollections } from './collections.js';
import { mountClassics, mountEstante, mountAcervo } from './classics.js';
import { showWelcome } from './welcome.js';
import { mountPainel } from './painel.js';

const ROUTES = {
  inicio: { label: 'Início', icon: 'home', mount: (el) => mountLibrary(el, { home: true }) },
  biblioteca: { label: 'Biblioteca', icon: 'book', href: '#classicos', mount: (el) => mountLibrary(el) }, // o menu abre em "Disponíveis"; esta tela é "Meus livros"
  favoritos: { mount: (el) => mountLibrary(el, { onlyFavorites: true }), navKey: 'biblioteca' }, // atalho; na barra fica em "Biblioteca"
  estante: { mount: (el) => mountEstante(el), navKey: 'biblioteca' },
  acervo: { mount: (el) => mountAcervo(el), navKey: 'biblioteca' },
  classicos: { mount: (el, arg) => mountClassics(el, arg), navKey: 'biblioteca' }, // abas dentro da Biblioteca (#classicos-br/pt/in)
  colecoes: { mount: (el) => mountCollections(el), navKey: 'biblioteca' },
  importacao: { mount: (el) => mountPainel(el), navKey: 'configuracoes' }, // painel de acompanhamento (aberto pelos Ajustes)
  estatisticas: { label: 'Estatísticas', icon: 'chart', mount: (el) => mountStats(el) },
  configuracoes: { label: 'Ajustes', icon: 'sliders', mount: (el) => mountSettings(el) },
  ler: { fullscreen: true, mount: (el, id) => mountReader(el, id) },
};

let cleanup = null;
let routeToken = 0;
let enterT = 0;
async function route() {
  // aceita '#biblioteca', '#ler-<id>' e o formato antigo '#/ler/<id>'
  const raw = location.hash.replace(/^#\/?/, '');
  const cut = raw.search(/[-/]/);
  const seg = cut < 0 ? raw : raw.slice(0, cut), arg = cut < 0 ? '' : raw.slice(cut + 1);
  const key = ROUTES[seg] ? seg : 'inicio';
  const token = ++routeToken;
  document.querySelectorAll('nav a').forEach((a) => (a.dataset.route === (ROUTES[key].navKey || key) ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  cleanup?.(); cleanup = null;
  document.getElementById('app').classList.toggle('reading', !!ROUTES[key].fullscreen);
  const main = document.getElementById('main');
  main.classList.remove('enter'); void main.offsetWidth; main.classList.add('enter'); // animação de entrada da aba (some sozinha, para não repetir em buscas/filtros)
  clearTimeout(enterT); enterT = setTimeout(() => main.classList.remove('enter'), 900);
  const result = (await ROUTES[key].mount(main, arg)) || null;
  if (token !== routeToken) { result?.(); return; } // o usuário já navegou para outra rota
  cleanup = result;
  if (!ROUTES[key].fullscreen) main.focus({ preventScroll: true });
}

async function boot() {
  await initSettings();
  applyTheme(); applyAppearance();
  watchSystemTheme();
  document.getElementById('app').append(
    h('nav', { class: 'nav', 'aria-label': 'Principal' },
      h('div', { class: 'brand' }, h('img', { src: 'icons/boto.png', alt: '', width: 32, height: 32 }), h('span', {}, 'Boto Azul')),
      Object.entries(ROUTES).filter(([, r]) => r.label).map(([k, r]) => h('a', { href: r.href || `#${k}`, 'data-route': k }, h('span', { class: 'ind' }, icon(r.icon, 24)), h('span', { class: 'lbl' }, r.label)))),
    h('main', { id: 'main', tabindex: '-1' })
  );
  window.addEventListener('hashchange', route);
  const reading = /^#\/?ler/.test(location.hash); // reabriu direto num livro: não interrompe a leitura
  await route();
  if (!reading) showWelcome();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
