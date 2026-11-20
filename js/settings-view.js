import { h, icon, toast } from './ui.js';
import * as db from './db.js';
import { getSetting, setSetting, applyTheme, applyAppearance } from './settings.js';
import { formatBytes } from './books.js';

const THEMES = [['auto', 'Automático'], ['light', 'Claro'], ['dark', 'Escuro']];

export async function mountSettings(root) {
  const info = await db.storageInfo();
  const count = (await db.getAll('books')).length;

  /* ---- blocos reutilizáveis ---- */
  const section = (ic, title, ...rows) => h('section', { class: 'panel set-sec' }, h('h2', {}, icon(ic, 20), title), ...rows);
  const row = (title, desc, control, stack = false) => h('div', { class: `set-row${stack ? ' stack' : ''}` },
    h('div', { class: 'set-txt' }, h('span', { class: 'set-title' }, title), desc ? h('span', { class: 'set-desc' }, desc) : null), control);
  const mark = (group, on) => group.querySelectorAll('button').forEach((b) => { const v = b.dataset.v === String(on); b.classList.toggle('on', v); b.setAttribute('aria-checked', String(v)); });

  /** Grupo de opções: grava na hora e reaplica a aparência. */
  const choice = (key, opts, label, { get = () => getSetting(key), set = (v) => setSetting(key, v), after } = {}) => {
    const g = h('div', { class: 'seg wide', role: 'radiogroup', 'aria-label': label }, opts.map(([val, l]) => h('button', {
      type: 'button', role: 'radio', 'data-v': String(val), onclick: async () => { await set(val); applyAppearance(); after?.(val); mark(g, val); },
    }, l)));
    mark(g, get());
    return g;
  };
  /** Interruptor liga/desliga. */
  const toggle = (label, isOn, change) => {
    const b = h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-label': label, 'aria-checked': String(!!isOn) }, h('span', { class: 'knob' }));
    b.addEventListener('click', async () => { const on = b.getAttribute('aria-checked') !== 'true'; b.setAttribute('aria-checked', String(on)); await change(on); });
    return b;
  };

  /* ---- Aparência ---- */
  const themeCards = h('div', { class: 'theme-cards', role: 'radiogroup', 'aria-label': 'Tema' }, THEMES.map(([v, l]) => h('button', {
    type: 'button', role: 'radio', 'data-v': v, class: 'theme-card', onclick: async () => { await setSetting('theme', v); applyTheme(v); mark(themeCards, v); },
  }, h('span', { class: `theme-prev ${v}` }, h('i'), h('i'), h('i')), h('span', {}, l))));
  mark(themeCards, getSetting('theme'));

  const resetBtn = h('button', { class: 'btn', type: 'button', onclick: async () => {
    for (const [k, v] of Object.entries({ theme: 'auto', uiScale: 100, contrast: 'normal', motion: 'auto', gridSize: 'medium', view: 'grid', sort: 'added-desc' })) await setSetting(k, v);
    applyTheme(); applyAppearance(); toast('Aparência restaurada.'); mountSettings(root);
  } }, 'Restaurar aparência padrão');

  /* ---- Leitor ---- */
  const rdr = () => getSetting('reader') || {};
  const readerTheme = choice('reader', [[null, 'Do app'], ['light', 'Claro'], ['sepia', 'Sépia'], ['dark', 'Escuro']], 'Tema padrão do leitor', {
    get: () => rdr().theme ?? null, set: (v) => setSetting('reader', { ...rdr(), theme: v }),
  });

  /* ---- Importação ---- */
  const mb = h('input', { type: 'number', min: 10, max: 2000, step: 10, value: getSetting('maxFileMB'), 'aria-label': 'Tamanho máximo por arquivo em MB' });
  mb.addEventListener('change', async () => {
    const v = Math.min(2000, Math.max(10, Math.round(Number(mb.value) || 200)));
    mb.value = v; await setSetting('maxFileMB', v); toast(`Limite de importação: ${v} MB.`);
  });

  /* ---- Armazenamento ---- */
  const pct = info.usage != null && info.quota ? Math.min(100, Math.max(1, (info.usage / info.quota) * 100)) : null;
  const persistBtn = !info.persisted && navigator.storage?.persist ? h('button', { class: 'btn', type: 'button', onclick: async (e) => {
    const b = e.currentTarget, ok = await navigator.storage.persist().catch(() => false);
    toast(ok ? 'Armazenamento protegido.' : 'O navegador não concedeu agora. Tente depois de usar o app por um tempo.', ok ? 'info' : 'error'); if (ok) b.remove();
  } }, 'Proteger meus livros') : null;

  root.replaceChildren(
    h('div', { class: 'view-head set-head' }, h('img', { src: 'icons/boto.png', alt: '', width: 44, height: 44 }), h('div', {}, h('h1', {}, 'Ajustes'), h('p', { class: 'hint' }, 'As mudanças são salvas e aplicadas na hora.'))),

    section('sun', 'Aparência',
      row('Tema', 'Automático segue o modo claro/escuro do seu aparelho.', themeCards, true),
      row('Tamanho da interface', 'Aumenta ou diminui textos e botões do app.', choice('uiScale', [[90, 'Pequeno'], [100, 'Padrão'], [115, 'Grande'], [130, 'Muito grande']], 'Tamanho da interface'), true),
      row('Contraste alto', 'Deixa textos e bordas mais fortes.', toggle('Contraste alto', getSetting('contrast') === 'high', async (on) => { await setSetting('contrast', on ? 'high' : 'normal'); applyAppearance(); })),
      row('Reduzir animações', 'Desliga transições e o efeito 3D de virar página.', toggle('Reduzir animações', getSetting('motion') === 'reduce', async (on) => { await setSetting('motion', on ? 'reduce' : 'auto'); applyAppearance(); })),
      resetBtn),

    section('book', 'Biblioteca',
      row('Exibição', 'Como os livros aparecem ao abrir a Biblioteca.', choice('view', [['grid', 'Grade'], ['list', 'Lista']], 'Exibição padrão'), true),
      row('Tamanho das capas', 'Quantas capas cabem por linha na grade.', choice('gridSize', [['small', 'Pequenas'], ['medium', 'Médias'], ['large', 'Grandes']], 'Tamanho das capas'), true),
      row('Ordenar por', null, choice('sort', [['added-desc', 'Recentes'], ['title', 'Título'], ['author', 'Autor'], ['read-desc', 'Lidos']], 'Ordenação padrão'), true)),

    section('bookmark', 'Leitor',
      row('Tema da página', 'Cor de fundo ao abrir um livro. Fonte, margens e brilho ficam no botão "Aa" dentro do livro.', readerTheme, true)),

    section('download', 'Importação',
      row('Tamanho máximo por arquivo', 'Em MB. Arquivos maiores são recusados.', mb),
      row('Buscar capas e dados online', 'Envia título, autor e ISBN ao Google Livros e ao Open Library. O arquivo do livro nunca sai do aparelho.', toggle('Buscar capas e dados online', !!getSetting('autoIdentify'), async (on) => { await setSetting('autoIdentify', on); toast(on ? 'Busca online ativada.' : 'Busca online desativada.'); }))),

    section('folder', 'Armazenamento',
      h('p', {}, `${count} livro(s) neste aparelho.`),
      pct != null ? h('div', { class: 'meter', role: 'img', 'aria-label': `${formatBytes(info.usage)} em uso de ${formatBytes(info.quota)}` }, h('i', { style: `width:${pct}%` })) : null,
      h('p', { class: 'hint' }, pct != null ? `${formatBytes(info.usage)} em uso de ${formatBytes(info.quota)} disponíveis. Proteção contra limpeza automática: ${info.persisted ? 'ativa' : 'desativada'}.` : 'Informações de armazenamento indisponíveis neste navegador.'),
      persistBtn,
      h('p', { class: 'hint' }, 'Os livros ficam só neste aparelho. Limpar os dados do site no navegador apaga a biblioteca.')),

    h('p', { class: 'hint set-about' }, 'Boto Azul · biblioteca digital de EPUB e PDF, offline e privada.'),
  );
}
