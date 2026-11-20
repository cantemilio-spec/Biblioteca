// Leitor EPUB. O conteúdo roda num iframe sandbox + CSP própria (script-src 'none'): nada de dentro do livro executa.
// allow-scripts é necessário só porque o WebKit (iPhone/Safari) NÃO entrega eventos de toque/clique aos ouvintes do app
// registrados num documento sandbox sem allow-scripts. Scripts continuam bloqueados pela CSP e removidos pelo sanitizador (epub.js). Paginação por colunas CSS; modo rolagem como alternativa.
import { h, icon, toast, menu } from './ui.js';
import * as db from './db.js';
import { getSetting, setSetting } from './settings.js';
import { loadEpub } from './epub.js';
import * as ann from './annotations.js';
import * as anchors from './anchors.js';
import { startTracking } from './stats.js';
import { copyToClipboard, colorDots, barButton, placeBar, openNoteEditor, renderAnnPanel, attachDim, brightnessControl, keepAwake } from './annot-ui.js';

export const FONTS = {
  serif: 'Georgia, "Iowan Old Style", "Palatino Linotype", "Times New Roman", serif',
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
  palatino: '"Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif',
  charter: 'Charter, "Bitstream Charter", "Sitka Text", Cambria, Georgia, serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};
const MARGINS = { small: 16, medium: 36, large: 72 };
const THEMES = {
  light: { bg: '#F7F9FA', fg: '#202830', link: '#2F6A87' },
  sepia: { bg: '#F4ECD8', fg: '#4A3B2A', link: '#7A4E2B' },
  dark: { bg: '#15191D', fg: '#E6EAED', link: '#6DA5C0' },
};
const DEFAULT_PREFS = { fontSize: 19, font: 'serif', lineHeight: 1.6, margin: 'medium', align: 'justify', theme: null, mode: 'paged', effect: 'flip', paraGap: 0.8, letter: 0, bold: false, hyphens: true, width: 'medium', taps: 'normal', awake: true, progress: true };
const PAD_Y = 48;
const WIDTHS = { narrow: 560, medium: 760, wide: 960 };

const SHELL = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; img-src blob:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'">
<style>
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);-webkit-text-size-adjust:100%;overscroll-behavior:none}
.paged body{touch-action:pinch-zoom}.scroll body{touch-action:pan-y pinch-zoom}
#v{position:absolute;overflow:hidden}
#c{font-family:var(--ff);font-size:var(--fs);line-height:var(--lh);text-align:var(--al);hyphens:var(--hy,auto);-webkit-hyphens:var(--hy,auto);letter-spacing:var(--ls,0);font-weight:var(--fw,400);overflow-wrap:break-word;box-sizing:border-box}
.paged #c{height:100%;column-fill:auto;transition:transform .28s ease}
.noanim #c{transition:none!important}
.scroll #v{overflow-y:auto;-webkit-overflow-scrolling:touch}
#c a{color:var(--link)}
#c img{display:block;max-width:100%;max-height:var(--ih);margin:1em auto;object-fit:contain;break-inside:avoid}
#c>:first-child{margin-top:0}
#c h1,#c h2,#c h3,#c h4,#c h5,#c h6{line-height:1.25;margin:1.1em 0 .6em;break-after:avoid}
#c p{margin:0 0 var(--pg,.8em)}#c blockquote{margin:1em 1.5em}#c pre{white-space:pre-wrap}
#c table{border-collapse:collapse;max-width:100%}#c td,#c th{padding:.2em .5em;border:1px solid currentColor}
#c hr{border:0;border-top:1px solid currentColor;opacity:.3;margin:1.5em 0}
.next-ch{display:block;margin:2em auto;padding:.7em 1.4em;border:1px solid currentColor;border-radius:10px;background:none;color:inherit;font:inherit;cursor:pointer}
mark.hl{color:inherit;border-radius:3px;cursor:pointer;-webkit-box-decoration-break:clone;box-decoration-break:clone}
mark.hl-yellow{background:rgba(242,201,76,.45)}mark.hl-green{background:rgba(111,207,151,.42)}mark.hl-blue{background:rgba(109,165,192,.55)}mark.hl-pink{background:rgba(240,128,170,.42)}
mark.hl[data-note]{border-bottom:2px solid currentColor}
::selection{background:#6DA5C0;color:#15191D}
.flip{position:fixed;inset:0;perspective:2200px;-webkit-perspective:2200px;pointer-events:none;z-index:9;overflow:hidden}
.leaf{position:absolute;inset:0;transform-origin:left center;transform-style:preserve-3d;-webkit-transform-style:preserve-3d;will-change:transform}
.face{position:absolute;inset:0;backface-visibility:hidden;-webkit-backface-visibility:hidden;background:var(--bg);overflow:hidden}
.face.back{transform:rotateY(180deg)}
.sh,.cast{position:absolute;inset:0;opacity:0}
.fsh{background:linear-gradient(to right,rgba(0,0,0,0) 35%,rgba(0,0,0,.3))}
.bsh{background:linear-gradient(to left,rgba(0,0,0,.34),rgba(0,0,0,0) 60%)}
.cast{background:linear-gradient(to right,rgba(0,0,0,.32),rgba(0,0,0,0) 55%)}
</style></head><body><div id="v"><div id="c"></div></div></body></html>`;

export function mountReader(root, bookId) {
  return start(root, bookId);
}

async function start(root, bookId) {
  const book = await db.get('books', bookId);
  const file = book && (await db.get('files', bookId));
  if (!book || !file) { toast('Livro não encontrado.', 'error'); location.hash = '#biblioteca'; return; }
  if (book.format === 'pdf') return (await import('./reader-pdf.js')).mountPdfReader(root, book, file.blob);
  let epub;
  try { epub = await loadEpub(file.blob); } catch { toast('Não foi possível abrir este EPUB (arquivo inválido).', 'error'); location.hash = '#biblioteca'; return; }

  const saved = getSetting('reader') || {};
  const prefs = { ...DEFAULT_PREFS, ...saved };
  if (!saved.effect && saved.animations === false) prefs.effect = 'none'; // migra a opção antiga "Animações"
  const themeName = () => prefs.theme || (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'reduce';

  const st = { idx: 0, page: 0, pages: 1, stride: 1, side: 36, dirty: false, annots: [], token: 0, cur: null, chromeOn: true };

  /* ---------- DOM ---------- */
  const iframe = h('iframe', { title: 'Conteúdo do livro', sandbox: 'allow-same-origin allow-scripts', class: 'r-frame' });
  const setBtn = h('button', { class: 'icon-btn aa', type: 'button', 'aria-label': 'Ajustes de leitura', 'aria-expanded': 'false' }, h('span', {}, 'Aa'));
  const moreBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Mais opções', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon('more'));
  const chapterLabel = h('button', { class: 'r-chapter', type: 'button', 'aria-label': 'Abrir sumário' });
  const pctLabel = h('span', { class: 'r-pct' }, '0%');
  const slider = h('input', { type: 'range', min: 0, max: 1000, value: 0, 'aria-label': 'Posição no livro' });
  const bmBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Adicionar marcador de página', 'aria-pressed': 'false' }, icon('bookmark'));
  const annPanel = h('aside', { class: 'r-panel ann', hidden: true, 'aria-label': 'Marcações e anotações' });
  const selBar = h('div', { class: 'r-selbar', hidden: true, role: 'toolbar', 'aria-label': 'Marcar trecho' });
  const tocPanel = h('aside', { class: 'r-panel toc', hidden: true, 'aria-label': 'Sumário' });
  const setPanel = h('aside', { class: 'r-panel settings', hidden: true, 'aria-label': 'Ajustes de leitura' });
  const status = h('div', { class: 'r-status', 'aria-hidden': 'true' });
  const top = h('header', { class: 'r-top' },
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Voltar à biblioteca', onclick: () => { location.hash = '#biblioteca'; } }, icon('back')),
    h('div', { class: 'r-title' }, book.title), bmBtn, setBtn, moreBtn);
  const bottom = h('footer', { class: 'r-bottom' }, chapterLabel, pctLabel, slider);
  const reader = h('div', { class: 'reader' }, h('div', { class: 'r-stage' }, iframe), status, top, bottom, tocPanel, setPanel, annPanel, selBar);
  // áreas seguras (notch, barra de gestos, cantos arredondados): lidas por um elemento-sonda e somadas ao layout do texto
  const probe = h('div', { class: 'r-probe', 'aria-hidden': 'true', style: 'position:absolute;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)' });
  const handle = h('button', { class: 'r-handle', type: 'button', 'aria-label': 'Mostrar controles', onclick: () => showChrome(true) }, h('span'));
  reader.append(probe, handle);
  const safe = () => { const cs = getComputedStyle(probe); return { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0, b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 }; };
  const applyDim = attachDim(reader);
  root.replaceChildren(reader);
  const stage = reader.querySelector('.r-stage');

  iframe.srcdoc = SHELL.replace('<html>', `<html lang="${String(book.language || navigator.language || 'pt-BR').replace(/[^A-Za-z-]/g, '').slice(0, 12) || 'pt-BR'}">`);
  await new Promise((r) => iframe.addEventListener('load', r, { once: true }));
  const doc = iframe.contentDocument;
  const v = doc.getElementById('v');
  const c = doc.getElementById('c');

  /* ---------- tema / layout ---------- */
  function applyTheme() {
    const t = THEMES[themeName()];
    reader.dataset.rtheme = themeName();
    const s = doc.documentElement.style;
    s.setProperty('--bg', t.bg); s.setProperty('--fg', t.fg); s.setProperty('--link', t.link);
    s.setProperty('--ff', FONTS[prefs.font]); s.setProperty('--fs', `${prefs.fontSize}px`);
    s.setProperty('--lh', String(prefs.lineHeight)); s.setProperty('--pg', `${prefs.paraGap}em`); s.setProperty('--ls', `${prefs.letter}em`); s.setProperty('--fw', prefs.bold ? '600' : '400'); s.setProperty('--hy', prefs.hyphens ? 'auto' : 'manual');
    status.hidden = !prefs.progress; s.setProperty('--al', prefs.align);
    doc.documentElement.className = `${prefs.mode === 'scroll' ? 'scroll' : 'paged'}${prefs.effect === 'slide' && !reduceMotion ? '' : ' noanim'}`;
  }

  const paged = () => prefs.mode !== 'scroll';
  const fracNow = () => (paged() ? st.page / st.pages : v.scrollTop / Math.max(1, v.scrollHeight));

  function measure() {
    endFlip();
    applyTheme();
    const iw = stage.clientWidth, ih = stage.clientHeight;
    const sf = safe(), padT = PAD_Y + sf.t, padB = PAD_Y + sf.b;
    const side = Math.max(MARGINS[prefs.margin], Math.floor((iw - (WIDTHS[prefs.width] || 760)) / 2), Math.max(sf.l, sf.r) + 12, 0);
    const W = Math.max(120, iw - 2 * side);
    doc.documentElement.style.setProperty('--ih', `${Math.max(100, ih - padT - padB - 8)}px`);
    st.side = side;
    if (paged()) {
      v.style.cssText = `left:${side}px;top:${padT}px;width:${W}px;height:${Math.max(100, ih - padT - padB)}px`;
      c.style.cssText = `width:${W}px;column-width:${W}px;column-gap:${2 * side}px;transform:none`;
      st.stride = W + 2 * side;
      st.pages = Math.max(1, Math.round((c.scrollWidth + 2 * side) / st.stride));
    } else {
      v.style.cssText = 'left:0;right:0;top:0;bottom:0';
      c.style.cssText = `padding:${padT}px ${side}px ${padB + 24}px`;
      st.pages = 1;
    }
  }

  function setPage(p, { user = false } = {}) {
    st.page = Math.min(Math.max(0, p), st.pages - 1);
    c.style.transform = `translateX(${-st.page * st.stride}px)`;
    if (user) st.dirty = true;
    hideSel();
    update();
  }

  /* ---------- efeito de virar página (3D) ---------- */
  // Uma "folha" com cópia da página atual gira em torno da lombada (CSS 3D + Web Animations: só transform/opacity, rodando no compositor).
  let leaf = null;
  function endFlip() {
    if (!leaf) return;
    const l = leaf; leaf = null;
    l.anims.forEach((a) => { try { a.cancel(); } catch { /* já terminou */ } });
    l.el.remove(); l.done?.();
  }
  const flipOK = () => paged() && prefs.effect === 'flip' && !reduceMotion && st.pages <= 200 && typeof v.animate === 'function';
  function flipTo(p, dir) {
    endFlip();
    p = Math.min(Math.max(0, p), st.pages - 1);
    if (p === st.page) return;
    if (!flipOK()) { setPage(p, { user: true }); return; }
    try { flipAnim(p, dir); } catch { endFlip(); setPage(p, { user: true }); }
  }
  function flipAnim(p, dir) {
    const shown = dir === 'next' ? st.page : p; // página que fica na face da folha
    const mk = (cls, parent) => { const e = doc.createElement('div'); e.className = cls; parent?.append(e); return e; };
    const wrap = mk('flip'), cast = mk('cast', wrap), leafEl = mk('leaf', wrap), front = mk('face', leafEl), back = mk('face back', leafEl);
    const fsh = mk('sh fsh', front), bsh = mk('sh bsh', back);
    const vv = v.cloneNode(false); vv.style.cssText = v.style.cssText;
    const cc = c.cloneNode(true); cc.style.cssText = `${c.style.cssText};transition:none;transform:translateX(${-shown * st.stride}px)`;
    cc.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id')); cc.id = 'c'; // ids repetidos não podem roubar âncoras do livro real
    vv.append(cc); front.prepend(vv);
    doc.body.append(wrap);
    const o = { duration: 500, easing: 'cubic-bezier(.45,.05,.2,1)', fill: 'both', direction: dir === 'next' ? 'normal' : 'reverse' };
    const anims = [
      leafEl.animate([{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(-180deg)' }], o),
      fsh.animate([{ opacity: 0 }, { opacity: 1, offset: 0.5 }, { opacity: 1 }], o),
      bsh.animate([{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1, offset: 0.52 }, { opacity: 0 }], o),
      cast.animate([{ opacity: 0 }, { opacity: 0.85, offset: 0.45 }, { opacity: 0 }], o),
    ];
    leaf = { el: wrap, anims, done: dir === 'next' ? null : () => setPage(p, { user: true }) };
    if (dir === 'next') setPage(p, { user: true }); // a página nova já está por baixo enquanto a folha gira
    const mine = leaf;
    anims[0].finished.then(() => { if (leaf === mine) endFlip(); }).catch(() => {});
    setTimeout(() => { if (leaf === mine) endFlip(); }, 800); // rede de segurança (WebKit pode não concluir a animação)
  }

  function restore(frac) {
    if (paged()) setPage(Math.floor(Math.min(0.9999, Math.max(0, frac)) * st.pages));
    else { v.scrollTop = frac * v.scrollHeight; update(); }
  }

  function goEl(el) {
    if (!el) return;
    const er = el.getBoundingClientRect(), cr = c.getBoundingClientRect();
    if (paged()) setPage(Math.floor(Math.max(0, er.left - cr.left) / st.stride), { user: true });
    else { v.scrollTop = er.top - cr.top - 8; st.dirty = true; update(); }
  }
  const goFrag = (id) => goEl(id ? doc.getElementById(id) : null);

  /* ---------- progresso ---------- */
  function overall() {
    const before = epub.weights.slice(0, st.idx).reduce((a, b) => a + b, 0);
    const inCh = paged() ? (st.page + 1) / st.pages : Math.min(1, (v.scrollTop + v.clientHeight) / Math.max(1, v.scrollHeight));
    return Math.min(1, (before + inCh * epub.weights[st.idx]) / epub.totalWeight);
  }

  let saveTimer;
  let tracker = null; // mede o tempo de leitura ativo (estatísticas)
  function scheduleSave() { tracker?.ping(); clearTimeout(saveTimer); saveTimer = setTimeout(save, 600); }
  async function save() {
    clearTimeout(saveTimer);
    if (!st.dirty) return;
    st.dirty = false;
    try { await db.saveProgress(book.id, overall(), { spine: st.idx, frac: fracNow() }); } catch { toast('Não foi possível salvar o progresso.', 'error'); }
  }

  function update() {
    const p = overall();
    pctLabel.textContent = `${Math.floor(p * 100)}%`;
    slider.value = String(Math.round(p * 1000));
    const entry = [...epub.toc].reverse().find((t) => t.spine <= st.idx);
    chapterLabel.textContent = entry ? entry.label : `Capítulo ${st.idx + 1}`;
    status.textContent = `${chapterLabel.textContent} · ${paged() ? `pág. ${st.page + 1}/${st.pages} · ` : ''}${Math.floor(p * 100)}%`;
    updateBookmarkBtn();
    if (st.dirty) scheduleSave();
  }

  /* ---------- navegação ---------- */
  async function openChapter(idx, where = 0) {
    endFlip();
    const t = ++st.token;
    let ch;
    try { ch = await epub.chapter(idx); } catch { ch = null; }
    if (t !== st.token) { ch?.revoke(); return; }
    if (!ch) { toast('Não foi possível carregar este capítulo.', 'error'); return; }
    st.cur?.revoke(); st.cur = ch; st.idx = idx;
    hideSel();
    c.replaceChildren(doc.importNode(ch.frag, true));
    for (const a of st.annots) if (a.type === 'highlight' && a.spine === idx) anchors.applyHighlight(doc, c, a);
    if (!paged()) {
      const more = idx < epub.spine.length - 1;
      if (more) c.append(Object.assign(doc.createElement('button'), { className: 'next-ch', textContent: 'Próximo capítulo' }));
    }
    v.scrollTop = 0;
    measure();
    if (where === 'end') { if (paged()) setPage(st.pages - 1); else { v.scrollTop = v.scrollHeight; update(); } }
    else if (typeof where === 'object') { setPage(0); if (where.hl) goEl(anchors.firstMark(c, where.hl)); else goFrag(where.frag); st.dirty = true; }
    else restore(where);
    update();
  }

  const next = () => {
    st.dirty = true; hideChrome();
    if (!paged()) { v.scrollBy({ top: v.clientHeight * 0.9, behavior: prefs.effect !== 'none' && !reduceMotion ? 'smooth' : 'auto' }); return; }
    endFlip();
    if (st.page < st.pages - 1) flipTo(st.page + 1, 'next');
    else if (st.idx < epub.spine.length - 1) openChapter(st.idx + 1, 0).then(() => { st.dirty = true; update(); });
  };
  const prev = () => {
    st.dirty = true; hideChrome();
    if (!paged()) { v.scrollBy({ top: -v.clientHeight * 0.9, behavior: prefs.effect !== 'none' && !reduceMotion ? 'smooth' : 'auto' }); return; }
    endFlip();
    if (st.page > 0) flipTo(st.page - 1, 'prev');
    else if (st.idx > 0) openChapter(st.idx - 1, 'end').then(() => { st.dirty = true; update(); });
  };

  slider.addEventListener('change', () => {
    const target = (Number(slider.value) / 1000) * epub.totalWeight;
    let acc = 0, i = 0;
    for (; i < epub.weights.length - 1; i++) { if (acc + epub.weights[i] > target) break; acc += epub.weights[i]; }
    st.dirty = true;
    openChapter(i, Math.min(0.999, (target - acc) / epub.weights[i])).then(() => { st.dirty = true; update(); });
  });

  /* ---------- controles ---------- */
  function showChrome(on) { st.chromeOn = on; reader.classList.toggle('chrome-off', !on); if (!on) closePanels(); }
  const hideChrome = () => { if (st.chromeOn && panelsClosed()) showChrome(false); }; // nunca esconde com painel de ajustes aberto
  function closePanels() {
    tocPanel.hidden = setPanel.hidden = annPanel.hidden = true;
    moreBtn.setAttribute('aria-expanded', 'false'); setBtn.setAttribute('aria-expanded', 'false');
  }
  function togglePanel(panel, btn, build) {
    const open = panel.hidden;
    closePanels();
    if (open) { build(); panel.hidden = false; btn.setAttribute('aria-expanded', 'true'); }
  }
  const openToc = () => togglePanel(tocPanel, moreBtn, buildToc), openNotes = () => togglePanel(annPanel, moreBtn, buildAnnPanel);
  chapterLabel.addEventListener('click', openToc);
  setBtn.addEventListener('click', () => togglePanel(setPanel, setBtn, buildSettings));
  moreBtn.addEventListener('click', () => menu(moreBtn, [
    { label: 'Sumário', icon: 'list', onClick: openToc },
    { label: 'Marcações e anotações', icon: 'note', onClick: openNotes },
    ...(reader.requestFullscreen ? [{ label: document.fullscreenElement ? 'Sair da tela cheia' : 'Tela cheia', icon: 'maximize', onClick: () => { if (document.fullscreenElement) document.exitFullscreen?.(); else (reader.requestFullscreen?.() || Promise.reject()).catch(() => toast('Este navegador não permitiu tela cheia.', 'error')); } }] : []),
  ], { title: 'Mais opções' }));

  function buildToc() {
    const curEntry = [...epub.toc].reverse().find((t) => t.spine <= st.idx);
    tocPanel.replaceChildren(h('h2', {}, 'Sumário'), h('ul', {}, epub.toc.map((t) => h('li', {},
      h('button', { type: 'button', class: t === curEntry ? 'on' : '', style: `padding-left:${12 + Math.min(t.level, 4) * 16}px`, onclick: () => { closePanels(); hideChrome(); openChapter(t.spine, t.frag ? { frag: t.frag } : 0).then(() => { st.dirty = true; update(); }); } }, t.label)))));
  }

  const seg = (opts, cur, pick) => {
    const el = h('div', { class: 'seg', role: 'group' }, opts.map(([val, label]) => h('button', { type: 'button', class: val === cur ? 'on' : '', 'aria-pressed': String(val === cur), onclick: () => {
      pick(val);
      el.querySelectorAll('button').forEach((b, i) => { const on = opts[i][0] === val; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    } }, label)));
    return el;
  };
  const row = (label, ctl) => h('div', { class: 'r-row' }, h('span', {}, label), ctl);

  async function changePref(patch, relayout = true) {
    const frac = fracNow();
    Object.assign(prefs, patch);
    setSetting('reader', { ...prefs }).catch(() => {});
    if (patch.mode) { await openChapter(st.idx, frac); return; }
    if (relayout) { measure(); restore(frac); } else applyTheme();
    if (patch.theme !== undefined) reader.dataset.rtheme = themeName();
  }

  const range = (label, min, max, step, val, on) => { const el = h('input', { type: 'range', min, max, step, value: val, 'aria-label': label }); el.addEventListener('input', () => on(Number(el.value))); return el; };
  const yesNo = (key, relayout) => seg([[true, 'Sim'], [false, 'Não']], !!prefs[key], (val) => changePref({ [key]: val }, relayout));

  function buildSettings() {
    const size = h('span', { class: 'r-val' }, `${prefs.fontSize}px`);
    const bump = (d) => { const n = Math.min(34, Math.max(13, prefs.fontSize + d)); size.textContent = `${n}px`; changePref({ fontSize: n }); };
    const lh = h('input', { type: 'range', min: 1.3, max: 2.1, step: 0.1, value: prefs.lineHeight, 'aria-label': 'Espaçamento entre linhas' });
    lh.addEventListener('input', () => changePref({ lineHeight: Number(lh.value) }));
    const swatches = h('div', { class: 'swatches', role: 'group', 'aria-label': 'Tema' }, [['light', 'Claro'], ['sepia', 'Sépia'], ['dark', 'Escuro']].map(([k, l]) => h('button', {
      type: 'button', class: 'swatch', 'aria-pressed': String(themeName() === k), 'aria-label': l, style: `background:${THEMES[k].bg};color:${THEMES[k].fg}`,
      onclick: () => { changePref({ theme: k }, false); swatches.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === swatches.querySelector(`[aria-label="${l}"]`)))); },
    }, h('b', {}, 'Aa'), h('small', {}, l))));
    const effectRow = row('Virar página', seg([['flip', 'Efeito 3D'], ['slide', 'Deslizar'], ['none', 'Nenhum']], prefs.effect, (val) => changePref({ effect: val }, false)));
    const sync = () => { effectRow.hidden = prefs.mode === 'scroll'; };
    sync();
    setPanel.replaceChildren(h('h2', {}, 'Ajustes de leitura'),
      brightnessControl(applyDim), swatches,
      h('h3', { class: 'r-sec' }, 'Texto'),
      row('Tamanho', h('div', { class: 'stepper' }, h('button', { class: 'btn', type: 'button', 'aria-label': 'Diminuir fonte', onclick: () => bump(-1) }, 'A−'), size, h('button', { class: 'btn', type: 'button', 'aria-label': 'Aumentar fonte', onclick: () => bump(1) }, 'A+'))),
      row('Fonte', seg([['serif', 'Georgia'], ['palatino', 'Palatino'], ['charter', 'Charter'], ['sans', 'Sem serifa'], ['mono', 'Mono']], prefs.font, (val) => changePref({ font: val }))),
      row('Espaçamento entre linhas', lh),
      row('Margens', seg([['small', 'Estreita'], ['medium', 'Média'], ['large', 'Larga']], prefs.margin, (val) => changePref({ margin: val }))),
      row('Alinhamento', seg([['left', 'Esquerda'], ['justify', 'Justificado']], prefs.align, (val) => changePref({ align: val }))),
      row('Espaçamento entre parágrafos', range('Espaçamento entre parágrafos', 0, 1.6, 0.2, prefs.paraGap, (v) => changePref({ paraGap: v }))),
      row('Espaçamento entre letras', range('Espaçamento entre letras', 0, 0.08, 0.02, prefs.letter, (v) => changePref({ letter: v }))),
      row('Largura do texto', seg([['narrow', 'Estreita'], ['medium', 'Média'], ['wide', 'Larga']], prefs.width, (val) => changePref({ width: val }))),
      row('Negrito', yesNo('bold', true)),
      row('Hifenização', yesNo('hyphens', true)),
      h('h3', { class: 'r-sec' }, 'Página'),
      row('Modo', seg([['paged', 'Páginas'], ['scroll', 'Rolagem']], prefs.mode, async (val) => { await changePref({ mode: val }); sync(); })),
      effectRow,
      h('h3', { class: 'r-sec' }, 'Controles'),
      row('Toques nas laterais', seg([['normal', 'Normal'], ['inverted', 'Invertido'], ['off', 'Desligado']], prefs.taps, (val) => changePref({ taps: val }, false))),
      row('Mostrar progresso', yesNo('progress', false)),
      row('Manter tela ligada', seg([[true, 'Sim'], [false, 'Não']], prefs.awake, (val) => { prefs.awake = val; setSetting('reader', { ...prefs }).catch(() => {}); releaseAwake(); releaseAwake = val ? keepAwake() : () => {}; })),
      h('button', { class: 'btn r-reset', type: 'button', onclick: async () => { await changePref({ ...DEFAULT_PREFS, theme: prefs.theme }); buildSettings(); } }, 'Restaurar padrões'));
  }

  /* ---------- marcadores, destaques e anotações ---------- */
  const chapterOf = (spine) => { const e = [...epub.toc].reverse().find((t) => t.spine <= spine); return e ? e.label : `Capítulo ${spine + 1}`; };
  const refreshPanels = () => { if (!annPanel.hidden) buildAnnPanel(); updateBookmarkBtn(); };

  function pageRange() {
    if (paged()) return [st.page / st.pages, (st.page + 1) / st.pages];
    const sh = Math.max(1, v.scrollHeight);
    return [v.scrollTop / sh, (v.scrollTop + v.clientHeight) / sh];
  }
  function visibleSnippet() {
    try {
      const x = st.side + 8, y = PAD_Y + 10;
      let node, off;
      if (doc.caretRangeFromPoint) { const r = doc.caretRangeFromPoint(x, y); node = r?.startContainer; off = r?.startOffset; }
      else if (doc.caretPositionFromPoint) { const p = doc.caretPositionFromPoint(x, y); node = p?.offsetNode; off = p?.offset; }
      if (node && c.contains(node)) {
        const r2 = doc.createRange(); r2.setStart(node, off); r2.setEnd(c, c.childNodes.length);
        return anchors.readable(r2.cloneContents()).slice(0, 140);
      }
    } catch { /* sem trecho */ }
    return '';
  }
  const bookmarkHere = () => { const [a, b] = pageRange(); return st.annots.find((x) => x.type === 'bookmark' && x.spine === st.idx && x.frac >= a - 1e-6 && x.frac < b - 1e-6); };
  function updateBookmarkBtn() {
    const on = !!bookmarkHere();
    bmBtn.setAttribute('aria-pressed', String(on));
    bmBtn.setAttribute('aria-label', on ? 'Remover marcador desta página' : 'Adicionar marcador de página');
  }
  async function toggleBookmark() {
    try {
      const ex = bookmarkHere();
      if (ex) { await ann.remove(ex.id); st.annots = st.annots.filter((x) => x.id !== ex.id); toast('Marcador removido.'); }
      else {
        const now = Date.now();
        const a = { id: ann.newId(), bookId: book.id, type: 'bookmark', spine: st.idx, frac: pageRange()[0], text: visibleSnippet(), note: '', createdAt: now, updatedAt: now };
        await ann.save(a); st.annots.push(a); toast('Marcador adicionado.');
      }
      refreshPanels();
    } catch { toast('Não foi possível salvar o marcador.', 'error'); }
  }
  bmBtn.addEventListener('click', toggleBookmark);

  // barra flutuante de seleção / edição de destaque
  let selT, pending = null, editingId = null;
  function hideSel() { selBar.hidden = true; pending = null; editingId = null; }
  const placeSelBar = (rect) => placeBar(selBar, reader, rect);
  const dots = colorDots, sbBtn = barButton;

  doc.addEventListener('selectionchange', () => {
    clearTimeout(selT);
    selT = setTimeout(() => {
      const sel = doc.getSelection();
      if (!sel || !sel.rangeCount || sel.isCollapsed || !c.contains(sel.anchorNode) || !c.contains(sel.focusNode)) { if (!editingId) hideSel(); return; }
      const r = sel.getRangeAt(0);
      const start = anchors.offsetOf(doc, c, r.startContainer, r.startOffset), end = anchors.offsetOf(doc, c, r.endContainer, r.endOffset);
      const quote = r.toString();
      if (end <= start || !quote.trim() || quote.length > 5000) { hideSel(); return; }
      pending = { start, end, quote, text: anchors.readable(r.cloneContents()) }; editingId = null;
      selBar.replaceChildren(...dots(null, (k) => createHighlight(k)), sbBtn('note', 'Nota', () => createHighlight('yellow', true)), sbBtn('copy', 'Copiar', copySelection));
      placeSelBar(r.getBoundingClientRect());
    }, 250);
  });

  const copyText = (text) => copyToClipboard(text, doc);
  async function copySelection() {
    const q = pending?.quote;
    if (q && (await copyText(q))) toast('Texto copiado.'); else toast('Não foi possível copiar. Use o menu do navegador.', 'error');
    hideSel();
  }

  async function createHighlight(color, withNote = false) {
    if (!pending) return;
    const { start, end, quote, text } = pending, now = Date.now();
    const a = { id: ann.newId(), bookId: book.id, type: 'highlight', spine: st.idx, start, end, quote, text: text.slice(0, 600), color, note: '', frac: start / Math.max(1, c.textContent.length), createdAt: now, updatedAt: now };
    doc.getSelection().removeAllRanges(); hideSel();
    anchors.applyHighlight(doc, c, a);
    try { await ann.save(a); st.annots.push(a); } catch { anchors.unwrap(c, a.id); toast('Não foi possível salvar o destaque.', 'error'); return; }
    refreshPanels();
    if (withNote) editNote(a.id);
  }

  function openEdit(id, rect) {
    const a = st.annots.find((x) => x.id === id);
    if (!a) return;
    editingId = id; pending = null;
    selBar.replaceChildren(...dots(a.color, (k) => recolor(a, k, rect)), sbBtn('note', a.note ? 'Editar nota' : 'Nota', () => editNote(id)), sbBtn('trash', 'Excluir', () => deleteAnn(a)));
    placeSelBar(rect);
  }
  async function recolor(a, color, rect) {
    a.color = color; a.updatedAt = Date.now();
    anchors.restyle(c, a);
    await ann.save(a).catch(() => toast('Não foi possível salvar a cor.', 'error'));
    openEdit(a.id, rect); refreshPanels();
  }
  function editNote(id) {
    const a = st.annots.find((x) => x.id === id);
    if (!a) return;
    hideSel();
    openNoteEditor(a, async (note) => { a.note = note; a.updatedAt = Date.now(); anchors.restyle(c, a); await ann.save(a); refreshPanels(); });
  }
  async function deleteAnn(a) {
    try { await ann.remove(a.id); } catch { toast('Não foi possível excluir.', 'error'); return; }
    if (a.type === 'highlight' && a.spine === st.idx) anchors.unwrap(c, a.id);
    st.annots = st.annots.filter((x) => x.id !== a.id);
    hideSel(); refreshPanels();
  }

  function goTo(a) {
    closePanels(); hideChrome();
    openChapter(a.spine, a.type === 'highlight' ? { hl: a.id } : a.frac).then(() => { st.dirty = true; update(); });
  }
  const buildAnnPanel = () => renderAnnPanel(annPanel, { book, annots: st.annots, chapterOf, goTo, remove: deleteAnn, copy: copyText });

  /* ---------- entrada: toque, mouse, teclado ---------- */
  function onClick(e) {
    if (!e.synthetic && Date.now() - gestureAt < 700) { if (e.target.closest?.('a')) e.preventDefault(); return; } // toque/deslize de dedo já tratado no touchend
    const mk = e.target.closest?.('mark.hl');
    if (!selBar.hidden && !mk) { hideSel(); doc.getSelection().removeAllRanges(); return; }
    if (mk && doc.getSelection().isCollapsed) { e.preventDefault(); openEdit(mk.dataset.id, mk.getBoundingClientRect()); return; }
    const a = e.target.closest?.('a');
    if (e.target.closest?.('.next-ch')) { e.preventDefault(); next2(); return; }
    if (a) {
      e.preventDefault();
      if (a.dataset.spine != null) openChapter(Number(a.dataset.spine), a.dataset.frag ? { frag: a.dataset.frag } : 0).then(() => { st.dirty = true; update(); });
      else if (a.dataset.frag && !a.dataset.ext) goFrag(a.dataset.frag);
      else if (a.dataset.ext) window.open(a.getAttribute('href'), '_blank', 'noopener,noreferrer');
      return;
    }
    if (!doc.getSelection().isCollapsed) return; // selecionando texto: não navegar
    if (!panelsClosed()) { closePanels(); return; }
    const w = doc.documentElement.clientWidth, x = e.clientX / w;
    const L = prefs.taps === 'inverted' ? next : prev, R = prefs.taps === 'inverted' ? prev : next;
    if (paged() && prefs.taps !== 'off' && x < 0.28) L();
    else if (paged() && prefs.taps !== 'off' && x > 0.72) R();
    else showChrome(!st.chromeOn);
  }
  const panelsClosed = () => tocPanel.hidden && setPanel.hidden && annPanel.hidden;
  const next2 = () => { if (st.idx < epub.spine.length - 1) openChapter(st.idx + 1, 0).then(() => { st.dirty = true; update(); }); };
  doc.addEventListener('click', onClick);

  // Deslizar para virar página (eventos de toque: iguais no Chrome/Android e no WebKit do iPhone).
  let t0 = null, gestureAt = 0;
  const pt = (e) => e.changedTouches[0];
  // Dedo: o próprio touchend decide entre deslizar (vira página) e tocar (zonas/links/marcações). No iOS o 'click' não é entregue de forma
  // confiável a elementos não interativos dentro do iframe, por isso o toque não depende dele; o click fica só para mouse/caneta.
  doc.addEventListener('touchstart', (e) => { t0 = e.touches.length === 1 ? { x: pt(e).clientX, y: pt(e).clientY, t: Date.now() } : null; }, { passive: true });
  doc.addEventListener('touchend', (e) => {
    const g = t0; t0 = null;
    if (!g) return;
    const p = pt(e), dx = p.clientX - g.x, dy = p.clientY - g.y, dt = Date.now() - g.t;
    if (paged() && Math.abs(dx) > 30 && Math.abs(dx) > Math.abs(dy) * 1.2 && dt < 1200 && doc.getSelection().isCollapsed) {
      gestureAt = Date.now(); if (e.cancelable) e.preventDefault(); (dx < 0 ? next : prev)();
    } else if (Math.hypot(dx, dy) < 12 && dt < 500) {
      gestureAt = Date.now(); if (e.cancelable) e.preventDefault();
      onClick({ synthetic: true, target: e.target, clientX: p.clientX, preventDefault() {} });
    }
  }, { passive: false });
  doc.addEventListener('touchcancel', () => { t0 = null; }, { passive: true });

  let wheelLock = 0;
  doc.addEventListener('wheel', (e) => {
    if (!paged() || Date.now() < wheelLock || Math.abs(e.deltaY) < 20) return;
    wheelLock = Date.now() + 450; (e.deltaY > 0 ? next : prev)();
  }, { passive: true });

  function onKey(e) {
    if (document.querySelector('dialog[open]')) return; // diálogos tratam o próprio teclado
    if (e.target.matches?.('input[type=text],textarea')) return;
    const k = e.key;
    if (k === 'Escape') { if (!panelsClosed()) closePanels(); else location.hash = '#biblioteca'; return; }
    if (e.target.closest?.('button,select,input') && (k === ' ' || k === 'Enter')) return;
    if (k === 'ArrowRight' || k === 'PageDown' || (k === ' ' && !e.shiftKey)) { e.preventDefault(); next(); }
    else if (k === 'ArrowLeft' || k === 'PageUp' || (k === ' ' && e.shiftKey)) { e.preventDefault(); prev(); }
    else if (k === 't' || k === 'T') openToc();
    else if (k === 'b' || k === 'B') toggleBookmark();
  }
  document.addEventListener('keydown', onKey);
  doc.addEventListener('keydown', onKey);

  // imagens que terminam de carregar mudam o layout: remede preservando a posição
  let relayoutT;
  doc.addEventListener('load', (e) => { if (!e.target.closest?.('.flip')) relayout(); }, true); // imagens que terminam de carregar mudam o número de páginas
  doc.fonts?.ready?.then(() => relayout()).catch(() => {});
  const relayout = () => { clearTimeout(relayoutT); relayoutT = setTimeout(() => { endFlip(); const f = fracNow(); measure(); restore(f); }, 120); }; // endFlip ANTES de ler a posição: a folha 'prev' só grava a página ao terminar
  c.addEventListener('load', relayout, true);
  let lastSize = `${stage.clientWidth}x${stage.clientHeight}`; // só refaz o layout se o tamanho realmente mudou (barra do navegador no celular dispara resize no meio do gesto)
  const ro = new ResizeObserver(() => { const k = `${stage.clientWidth}x${stage.clientHeight}`; if (k !== lastSize) { lastSize = k; relayout(); } }); ro.observe(stage);
  v.addEventListener('scroll', () => { if (!paged()) { st.dirty = true; update(); } }, { passive: true });
  const onHide = () => { if (document.visibilityState === 'hidden') save(); };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', save);

  /* ---------- início: retomada automática ---------- */
  try { st.annots = await ann.list(book.id); } catch { toast('Não foi possível carregar suas marcações.', 'error'); }
  const loc = book.location;
  tracker = startTracking(book.id);
  const startIdx = loc && Number.isInteger(loc.spine) && loc.spine >= 0 && loc.spine < epub.spine.length ? loc.spine : 0;
  await openChapter(startIdx, loc && typeof loc.frac === 'number' ? loc.frac : 0);
  const autoHide = setTimeout(hideChrome, loc ? 1800 : 3500); // modo imersivo: os controles somem sozinhos
  reader.addEventListener('pointerdown', (e) => { if (e.target.closest('.r-top,.r-bottom,.r-panel')) clearTimeout(autoHide); }, true); // mexeu nos controles: não esconder
  let releaseAwake = prefs.awake ? keepAwake() : () => {};

  return () => {
    save(); tracker?.stop(); releaseAwake(); endFlip(); clearTimeout(autoHide);
    clearTimeout(relayoutT);
    ro.disconnect();
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', save);
    st.cur?.revoke();
  };
}
