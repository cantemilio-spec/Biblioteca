// Leitor PDF independente (PDF.js). Páginas são desenhadas sob demanda (só as próximas à tela) e liberadas ao sair,
// então documentos grandes não consomem memória em excesso. Modos: contínuo ou página única; zoom por gesto,
// ajuste à largura/altura, rotação, miniaturas, sumário, busca, marcadores e destaques com notas.
import { h, icon, toast, menu } from './ui.js';
import * as db from './db.js';
import { getSetting, setSetting } from './settings.js';
import * as ann from './annotations.js';
import { loadPdfjs, openPdf } from './pdf.js';
import { startTracking } from './stats.js';
import { copyToClipboard, colorDots, barButton, placeBar, openNoteEditor, renderAnnPanel, attachDim, brightnessControl, keepAwake } from './annot-ui.js';

const SCALE_MIN = 0.25, SCALE_MAX = 6, MAX_PIXELS = 16e6, PAD_X = 12, PAD_Y = 60;
const DEFAULT_PREFS = { mode: 'continuous', fit: 'width', scale: 1 };

/* ---------- geometria de destaques (independente da rotação) ---------- */
// Retângulos [x, y, l, a] em frações da página. "base" = página sem rotação do usuário; "view" = como está na tela.
const mapPt = { 0: (x, y) => [x, y], 90: (x, y) => [1 - y, x], 180: (x, y) => [1 - x, 1 - y], 270: (x, y) => [y, 1 - x] };
const mapPtInv = { 0: (x, y) => [x, y], 90: (x, y) => [y, 1 - x], 180: (x, y) => [1 - x, 1 - y], 270: (x, y) => [1 - y, x] };
function mapRect(fn, [x, y, w, hh]) {
  const [ax, ay] = fn(x, y), [bx, by] = fn(x + w, y + hh);
  return [Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay)];
}
export const toBase = (r, rot) => mapRect(mapPtInv[rot % 360], r);
export const fromBase = (r, rot) => mapRect(mapPt[rot % 360], r);

/** Junta retângulos da mesma linha (a seleção devolve um por trecho de texto). */
export function mergeRects(rects) {
  const sorted = [...rects].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const out = [];
  for (const r of sorted) {
    const p = out[out.length - 1];
    const sameLine = p && Math.abs(p[1] - r[1]) < Math.max(p[3], r[3]) * 0.5 && r[0] <= p[0] + p[2] + 0.01;
    if (sameLine) {
      const x2 = Math.max(p[0] + p[2], r[0] + r[2]), y1 = Math.min(p[1], r[1]), y2 = Math.max(p[1] + p[3], r[1] + r[3]);
      p[0] = Math.min(p[0], r[0]); p[1] = y1; p[2] = x2 - p[0]; p[3] = y2 - y1;
    } else out.push([...r]);
  }
  return out;
}

const normStr = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export async function mountPdfReader(root, book, blob) {
  let pdf;
  try { pdf = await openPdf(blob); } catch (e) {
    toast(e?.name === 'PasswordException' ? 'PDF protegido por senha não é suportado.' : 'Não foi possível abrir este PDF (arquivo inválido ou corrompido).', 'error');
    location.hash = '#biblioteca'; return;
  }
  const lib = await loadPdfjs();
  const prefs = { ...DEFAULT_PREFS, ...(getSetting('pdfReader') || {}) };
  const N = pdf.numPages;
  const st = { page: 1, scale: 1, fit: prefs.fit, mode: prefs.mode, rot: book.rotation || 0, sizes: [], dirty: false, annots: [], query: '', chromeOn: true, jump: false };
  const first = await pdf.getPage(1);
  { const v = first.getViewport({ scale: 1 }); st.sizes[1] = { w: v.width, h: v.height }; }
  if (st.fit === 'custom') st.scale = clamp(prefs.scale, SCALE_MIN, SCALE_MAX);

  /* ---------- DOM ---------- */
  const mkBtn = (label, ic, extra = {}) => h('button', { class: 'icon-btn', type: 'button', 'aria-label': label, ...extra }, icon(ic));
  const bmBtn = mkBtn('Adicionar marcador de página', 'bookmark', { 'aria-pressed': 'false' });
  const searchBtn = mkBtn('Buscar no documento', 'search', { 'aria-expanded': 'false' });
  const moreBtn = mkBtn('Mais opções', 'more', { 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
  const viewBtn = mkBtn('Exibição', 'sliders', { 'aria-expanded': 'false' });
  const top = h('header', { class: 'r-top' }, mkBtn('Voltar à biblioteca', 'back', { onclick: () => { location.hash = '#biblioteca'; } }), h('div', { class: 'r-title' }, book.title), bmBtn, searchBtn, viewBtn, moreBtn);
  const pgInput = h('input', { type: 'number', min: 1, max: N, value: 1, class: 'pg-input', 'aria-label': 'Página atual' });
  const pgSlider = h('input', { type: 'range', min: 1, max: N, value: 1, 'aria-label': 'Posição no documento' });
  const zoomLabel = h('span', { class: 'r-pct' }, '100%');
  const bottom = h('footer', { class: 'r-bottom' }, pgInput, h('span', { class: 'pg-total' }, `/ ${N}`), pgSlider, zoomLabel);
  const panel = (cls, label) => h('aside', { class: `r-panel ${cls}`, hidden: true, 'aria-label': label });
  const pagesPanel = panel('pdf-nav', 'Páginas e sumário'), searchPanel = panel('pdf-search', 'Buscar no documento'), annPanel = panel('ann', 'Marcações e anotações'), viewPanel = panel('settings', 'Exibição');
  const selBar = h('div', { class: 'r-selbar', hidden: true, role: 'toolbar', 'aria-label': 'Marcar trecho' });
  const pagesEl = h('div', { class: 'pdf-pages' });
  const viewer = h('div', { class: 'pdf-viewer', tabindex: '0', 'aria-label': 'Documento PDF' }, pagesEl);
  const reader = h('div', { class: 'reader pdf' }, viewer, top, bottom, pagesPanel, searchPanel, annPanel, viewPanel, selBar);
  reader.dataset.rtheme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  root.replaceChildren(reader);
  const applyDim = attachDim(reader);

  /* ---------- tamanho e escala ---------- */
  const sizeOf = (n) => st.sizes[n] || st.sizes[1];
  const viewSize = (n) => { const s = sizeOf(n); return st.rot % 180 ? { w: s.h, h: s.w } : s; };
  const computeFit = () => {
    const ref = viewSize(1);
    const cw = Math.max(80, viewer.clientWidth - 2 * PAD_X), ch = Math.max(80, viewer.clientHeight - 2 * PAD_Y);
    return clamp(st.fit === 'height' ? Math.min(ch / ref.h, cw / ref.w * 4) : cw / ref.w, SCALE_MIN, SCALE_MAX);
  };
  const keyNow = () => `${st.scale.toFixed(4)}|${st.rot}`;

  /* ---------- páginas ---------- */
  let views = [], io = null, searchId = 0;
  const queue = [];
  let busy = false;

  function makeView(n) {
    const el = h('div', { class: 'pdf-page', 'data-page': n });
    const pv = { n, el, canvas: h('canvas'), tl: h('div', { class: 'textLayer' }), hl: h('div', { class: 'pdf-hl-layer' }), state: 'idle', key: '', task: null, wanted: false, page: null };
    el.append(pv.canvas, pv.hl, pv.tl);
    el.__pv = pv;
    applySize(pv);
    return pv;
  }
  function applySize(pv) {
    const { w, h: hh } = viewSize(pv.n);
    pv.el.style.width = `${w * st.scale}px`; pv.el.style.height = `${hh * st.scale}px`;
  }

  function schedule(pv) { if (!queue.includes(pv)) queue.push(pv); pump(); }
  async function pump() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        queue.sort((a, b) => Math.abs(a.n - st.page) - Math.abs(b.n - st.page));
        const pv = queue.shift();
        if (pv.wanted) await renderView(pv).catch(() => {});
      }
    } finally { busy = false; }
  }

  async function renderView(pv) {
    const key = keyNow();
    if (pv.state === 'done' && pv.key === key) return;
    pv.state = 'rendering';
    const page = pv.page || (pv.page = await pdf.getPage(pv.n));
    if (!st.sizes[pv.n]) { const v0 = page.getViewport({ scale: 1 }); st.sizes[pv.n] = { w: v0.width, h: v0.height }; }
    const vp = page.getViewport({ scale: st.scale, rotation: (page.rotate + st.rot) % 360 });
    pv.el.style.width = `${vp.width}px`; pv.el.style.height = `${vp.height}px`;
    const out = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_PIXELS / (vp.width * vp.height)));
    const cv = h('canvas');
    cv.width = Math.max(1, Math.floor(vp.width * out)); cv.height = Math.max(1, Math.floor(vp.height * out));
    const task = page.render({ canvasContext: cv.getContext('2d'), canvas: cv, viewport: vp, transform: out !== 1 ? [out, 0, 0, out, 0, 0] : null });
    pv.task = task;
    try { await task.promise; } catch (e) { if (e?.name === 'RenderingCancelledException') { pv.state = 'idle'; return; } throw e; }
    pv.task = null;
    const tl = h('div', { class: 'textLayer' });
    tl.style.setProperty('--total-scale-factor', String(vp.scale));
    tl.style.width = `${vp.width}px`; tl.style.height = `${vp.height}px`;
    try { await new lib.TextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: vp }).render(); } catch { /* sem texto selecionável */ }
    if (!pv.wanted) { cv.width = cv.height = 0; pv.state = 'idle'; return; }
    pv.canvas.width = pv.canvas.height = 0; // libera o desenho anterior
    pv.canvas.replaceWith(cv); pv.canvas = cv;
    pv.tl.replaceWith(tl); pv.tl = tl;
    pv.state = 'done'; pv.key = key;
    drawHighlights(pv); markSearch(pv);
    if (pv.key !== keyNow() && pv.wanted) schedule(pv); // a escala mudou durante o desenho
  }

  function release(pv) {
    pv.wanted = false;
    try { pv.task?.cancel(); } catch { /* já terminou */ }
    pv.task = null;
    if (pv.state !== 'idle') { pv.canvas.width = pv.canvas.height = 0; pv.tl.replaceChildren(); pv.hl.replaceChildren(); pv.page?.cleanup?.(); pv.state = 'idle'; pv.key = ''; }
  }

  function buildPages() {
    io?.disconnect(); views.forEach(release); queue.length = 0;
    pagesEl.replaceChildren();
    if (st.mode === 'continuous') {
      views = Array.from({ length: N }, (_, i) => makeView(i + 1));
      pagesEl.append(...views.map((v) => v.el));
      io = new IntersectionObserver((entries) => {
        for (const e of entries) { const pv = e.target.__pv; pv.wanted = e.isIntersecting; if (pv.wanted) schedule(pv); else release(pv); }
      }, { root: viewer, rootMargin: '120% 0px' });
      views.forEach((v) => io.observe(v.el));
    } else {
      const pv = makeView(st.page); pv.wanted = true; views = [pv];
      pagesEl.append(pv.el); schedule(pv);
    }
  }

  function relayout() {
    if (st.fit !== 'custom') st.scale = computeFit();
    views.forEach(applySize);
    views.forEach((pv) => { if (pv.wanted && !(pv.state === 'done' && pv.key === keyNow())) schedule(pv); });
    zoomLabel.textContent = `${Math.round(st.scale * 100)}%`;
    if (!viewPanel.hidden) buildView();
  }

  /* ---------- navegação ---------- */
  const pageTop = (pv) => pagesEl.offsetTop + pv.el.offsetTop;
  function scrollToPage(n, frac = 0) {
    const pv = views[n - 1];
    if (!pv) return;
    viewer.scrollTop = pageTop(pv) - 8 + frac * pv.el.offsetHeight;
  }
  function goPage(n, frac = 0) {
    n = clamp(Math.round(n) || 1, 1, N);
    st.page = n; st.jump = true;
    if (st.mode === 'continuous') {
      scrollToPage(n, frac);
      requestAnimationFrame(() => scrollToPage(n, frac)); // tamanhos estimados podem mudar ao desenhar
    } else { buildPages(); viewer.scrollTop = 0; viewer.scrollLeft = 0; }
    clearTimeout(goPage.t); goPage.t = setTimeout(() => { st.jump = false; updateCurrent(); }, 250);
    updateUI();
  }
  function updateCurrent() {
    if (st.mode !== 'continuous' || st.jump) return;
    const mid = viewer.scrollTop + viewer.clientHeight / 2;
    let lo = 0, hi = views.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (pageTop(views[m]) <= mid) lo = m; else hi = m - 1; }
    const n = lo + 1;
    if (n !== st.page) { st.page = n; st.dirty = true; updateUI(); }
  }
  const fracInPage = () => {
    if (st.mode !== 'continuous') return 0;
    const pv = views[st.page - 1];
    return pv ? clamp((viewer.scrollTop - pageTop(pv) + 8) / Math.max(1, pv.el.offsetHeight), 0, 0.99) : 0;
  };
  const nextPage = () => { st.dirty = true; hideChrome(); goPage(st.page + 1); };
  const prevPage = () => { st.dirty = true; hideChrome(); goPage(st.page - 1); };

  function updateUI() {
    pgInput.value = String(st.page); pgSlider.value = String(st.page);
    updateBookmarkBtn();
    pagesPanel.querySelectorAll('.thumb').forEach((t) => t.classList.toggle('on', Number(t.dataset.n) === st.page));
    if (st.dirty) { clearTimeout(saveT); saveT = setTimeout(save, 600); }
  }
  const tracker = startTracking(book.id);
  let saveT;
  async function save() {
    clearTimeout(saveT);
    if (!st.dirty) return;
    st.dirty = false;
    try { await db.saveProgress(book.id, st.page / N, { page: st.page, frac: fracInPage() }); } catch { toast('Não foi possível salvar o progresso.', 'error'); }
  }

  /* ---------- zoom ---------- */
  function setScale(s, cx = viewer.clientWidth / 2, cy = viewer.clientHeight / 2) {
    s = clamp(s, SCALE_MIN, SCALE_MAX);
    const fx = (viewer.scrollLeft + cx) / Math.max(1, viewer.scrollWidth), fy = (viewer.scrollTop + cy) / Math.max(1, viewer.scrollHeight);
    st.fit = 'custom'; st.scale = s;
    relayout();
    viewer.scrollLeft = fx * viewer.scrollWidth - cx; viewer.scrollTop = fy * viewer.scrollHeight - cy;
    setSetting('pdfReader', { ...prefs, mode: st.mode, fit: 'custom', scale: s }).catch(() => {});
  }
  function setFit(fit) {
    const f = fracInPage(), p = st.page;
    st.fit = fit; relayout();
    goPage(p, f);
    setSetting('pdfReader', { ...prefs, mode: st.mode, fit, scale: st.scale }).catch(() => {});
  }
  function setMode(mode) {
    if (mode === st.mode) return;
    const f = fracInPage(), p = st.page;
    st.mode = mode;
    buildPages(); relayout(); goPage(p, f);
    setSetting('pdfReader', { ...prefs, mode, fit: st.fit, scale: st.scale }).catch(() => {});
  }
  function rotate() {
    const f = fracInPage(), p = st.page;
    st.rot = (st.rot + 90) % 360;
    db.updateBook(book.id, (cur) => ({ ...cur, rotation: st.rot })).catch(() => {});
    views.forEach((pv) => { pv.key = ''; });
    relayout(); goPage(p, f);
  }
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else (reader.requestFullscreen?.() || Promise.reject()).catch(() => toast('Este navegador não permitiu tela cheia.', 'error'));
  }

  /* ---------- painéis ---------- */
  const panels = [[pagesPanel, moreBtn], [searchPanel, searchBtn], [annPanel, moreBtn], [viewPanel, viewBtn]];
  function closePanels() { panels.forEach(([p, b]) => { p.hidden = true; b.setAttribute('aria-expanded', 'false'); }); }
  const panelsClosed = () => panels.every(([p]) => p.hidden);
  function togglePanel(p, b, build) {
    const open = p.hidden;
    closePanels();
    if (open) { build(); p.hidden = false; b.setAttribute('aria-expanded', 'true'); }
  }
  searchBtn.addEventListener('click', () => togglePanel(searchPanel, searchBtn, buildSearch));
  moreBtn.addEventListener('click', () => menu(moreBtn, [
    { label: 'Páginas e sumário', icon: 'grid', onClick: () => togglePanel(pagesPanel, moreBtn, buildPagesPanel) },
    { label: 'Marcações e anotações', icon: 'note', onClick: () => togglePanel(annPanel, moreBtn, buildAnn) },
    { label: 'Tela cheia', icon: 'maximize', onClick: () => toggleFullscreen() },
  ], { title: 'Mais opções' }));
  viewBtn.addEventListener('click', () => togglePanel(viewPanel, viewBtn, buildView));

  const seg = (opts, cur, pick) => {
    const el = h('div', { class: 'seg', role: 'group' }, opts.map(([val, label]) => h('button', { type: 'button', class: val === cur ? 'on' : '', 'aria-pressed': String(val === cur), onclick: () => {
      pick(val);
      el.querySelectorAll('button').forEach((b, i) => { const on = opts[i][0] === val; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    } }, label)));
    return el;
  };
  const row = (label, ctl) => h('div', { class: 'r-row' }, h('span', {}, label), ctl);

  function buildView() {
    viewPanel.replaceChildren(h('h2', {}, 'Exibição'), brightnessControl(applyDim),
      row('Modo', seg([['continuous', 'Contínuo'], ['single', 'Página única']], st.mode, setMode)),
      row('Ajuste', seg([['width', 'À largura'], ['height', 'À altura']], st.fit === 'custom' ? '' : st.fit, setFit)),
      row('Zoom', h('div', { class: 'stepper' }, h('button', { class: 'btn', type: 'button', 'aria-label': 'Diminuir zoom', onclick: () => setScale(st.scale / 1.25) }, icon('minus', 18)), h('span', { class: 'r-val' }, `${Math.round(st.scale * 100)}%`), h('button', { class: 'btn', type: 'button', 'aria-label': 'Aumentar zoom', onclick: () => setScale(st.scale * 1.25) }, icon('plus', 18)))),
      h('div', { class: 'r-row' }, h('div', { class: 'view-actions' },
        h('button', { class: 'btn', type: 'button', onclick: rotate }, icon('rotate', 18), 'Girar páginas'),
        h('button', { class: 'btn', type: 'button', onclick: toggleFullscreen }, icon('maximize', 18), 'Tela cheia'))));
  }

  /* --- miniaturas e sumário --- */
  let thumbIO = null, outline;
  const thumbQueue = [];
  let thumbBusy = false;
  async function pumpThumbs() {
    if (thumbBusy) return;
    thumbBusy = true;
    try {
      while (thumbQueue.length) {
        const item = thumbQueue.shift();
        if (!item.isConnected || item.dataset.done) continue;
        const n = Number(item.dataset.n);
        try {
          const page = await pdf.getPage(n);
          const rotation = (page.rotate + st.rot) % 360;
          const v0 = page.getViewport({ scale: 1, rotation });
          const out = window.devicePixelRatio || 1, sc = 112 / v0.width;
          const vp = page.getViewport({ scale: sc * out, rotation });
          const cv = item.querySelector('canvas');
          cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
          await page.render({ canvasContext: cv.getContext('2d'), canvas: cv, viewport: vp }).promise;
          item.dataset.done = '1'; page.cleanup();
        } catch { /* miniatura indisponível */ }
      }
    } finally { thumbBusy = false; }
  }
  async function buildPagesPanel() {
    thumbIO?.disconnect();
    if (outline === undefined) { try { outline = await pdf.getOutline(); } catch { outline = null; } }
    const hasOutline = !!outline?.length;
    const body = h('div', { class: 'pdf-pages-body' });
    const showThumbs = () => {
      const ref = viewSize(1);
      const grid = h('div', { class: 'thumbs' }, Array.from({ length: N }, (_, i) => h('button', { type: 'button', class: `thumb${i + 1 === st.page ? ' on' : ''}`, 'data-n': i + 1, 'aria-label': `Página ${i + 1}`, onclick: () => { closePanels(); hideChrome(); st.dirty = true; goPage(i + 1); } },
        h('span', { class: 'thumb-box', style: `aspect-ratio:${ref.w}/${ref.h}` }, h('canvas')), h('span', { class: 'thumb-n' }, String(i + 1)))));
      body.replaceChildren(grid);
      thumbIO = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { thumbQueue.push(e.target); thumbIO.unobserve(e.target); } pumpThumbs(); }, { root: pagesPanel, rootMargin: '200px' });
      grid.querySelectorAll('.thumb').forEach((t) => thumbIO.observe(t));
      requestAnimationFrame(() => grid.querySelector('.thumb.on')?.scrollIntoView({ block: 'center' }));
    };
    const flat = [];
    (function walk(items, level) { for (const it of items || []) { flat.push({ it, level }); walk(it.items, level + 1); } })(outline, 0);
    const showOutline = () => body.replaceChildren(h('ul', { class: 'outline' }, flat.slice(0, 2000).map(({ it, level }) => h('li', {}, h('button', { type: 'button', style: `padding-left:${12 + Math.min(level, 4) * 16}px`, onclick: () => gotoDest(it.dest) }, it.title || '(sem título)')))));
    const tabs = hasOutline ? seg([['thumbs', 'Páginas'], ['outline', 'Sumário']], 'thumbs', (v) => (v === 'thumbs' ? showThumbs() : showOutline())) : null;
    pagesPanel.replaceChildren(h('h2', {}, hasOutline ? 'Páginas e sumário' : 'Páginas'), tabs, body);
    showThumbs();
  }
  async function gotoDest(dest) {
    try {
      const d = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
      if (!Array.isArray(d)) return;
      const idx = typeof d[0] === 'object' ? await pdf.getPageIndex(d[0]) : Number(d[0]);
      closePanels(); hideChrome(); st.dirty = true; goPage(idx + 1);
    } catch { toast('Não foi possível abrir este item do sumário.', 'error'); }
  }

  /* --- busca --- */
  const textCache = new Map();
  async function getText(n) {
    if (textCache.has(n)) return textCache.get(n);
    const page = await pdf.getPage(n);
    const tc = await page.getTextContent();
    const raw = tc.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim();
    const o = { raw, norm: normStr(raw) };
    textCache.set(n, o); page.cleanup();
    return o;
  }
  let results = [], resultIdx = -1;
  function buildSearch() {
    const input = h('input', { type: 'search', placeholder: 'Buscar no documento', 'aria-label': 'Buscar no documento', value: st.query });
    const status = h('p', { class: 'hint', role: 'status' });
    const list = h('ul', { class: 'results' });
    const renderResults = () => list.replaceChildren(...results.slice(0, 300).map((r, i) => h('li', {}, h('button', { type: 'button', class: i === resultIdx ? 'on' : '', onclick: () => openResult(i) },
      h('span', { class: 'res-p' }, `Pág. ${r.n}`), h('span', { class: 'res-t' }, r.before, h('mark', {}, r.hit), r.after)))));
    const go = async () => {
      const q = input.value.trim();
      const id = ++searchId;
      results = []; resultIdx = -1; list.replaceChildren();
      setQuery(q);
      if (q.length < 2) { status.textContent = q ? 'Digite ao menos 2 letras.' : ''; return; }
      const nq = normStr(q);
      for (let n = 1; n <= N; n++) {
        if (id !== searchId) return;
        const t = await getText(n);
        const base = t.norm.length === t.raw.length ? t.raw : t.norm;
        for (let i = t.norm.indexOf(nq), c = 0; i >= 0 && c < 30 && results.length < 500; i = t.norm.indexOf(nq, i + nq.length), c++) {
          results.push({ n, before: `${i > 40 ? '…' : ''}${base.slice(Math.max(0, i - 40), i)}`, hit: base.slice(i, i + nq.length), after: `${base.slice(i + nq.length, i + nq.length + 50)}${base.length > i + nq.length + 50 ? '…' : ''}` });
        }
        if (n % 10 === 0 || n === N) { status.textContent = n < N ? `Buscando… ${n} de ${N} páginas` : ''; renderResults(); }
      }
      const pagesHit = new Set(results.map((r) => r.n)).size;
      status.textContent = results.length ? `${results.length >= 500 ? '500+' : results.length} resultado(s) em ${pagesHit} página(s).` : 'Nenhum resultado.';
      renderResults();
      if (results.length) openResult(0, false);
    };
    function openResult(i, close = true) {
      resultIdx = i; const r = results[i];
      st.dirty = true; goPage(r.n);
      list.querySelectorAll('button').forEach((b, k) => b.classList.toggle('on', k === i));
      if (close && window.innerWidth < 700) { closePanels(); hideChrome(); }
    }
    const step = (d) => { if (results.length) openResult((resultIdx + d + results.length) % results.length, false); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (results.length && input.value.trim() === st.query) step(e.shiftKey ? -1 : 1); else go(); } e.stopPropagation(); });
    searchPanel.replaceChildren(h('h2', {}, 'Buscar'),
      h('div', { class: 'search-row' }, input, h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Resultado anterior', onclick: () => step(-1) }, icon('up')), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Próximo resultado', onclick: () => step(1) }, icon('down'))),
      status, list);
    if (results.length) renderResults();
    setTimeout(() => input.focus(), 30);
  }
  function setQuery(q) { st.query = q; views.forEach((pv) => { if (pv.state === 'done') markSearch(pv); }); }
  function markSearch(pv) {
    pv.tl.querySelectorAll('mark.srch').forEach((m) => m.replaceWith(m.textContent));
    if (!st.query || st.query.length < 2) return;
    const nq = normStr(st.query);
    for (const span of pv.tl.querySelectorAll('span')) {
      if (span.childElementCount || !span.firstChild) continue;
      const t = span.textContent, nt = normStr(t);
      if (nt.length !== t.length || !nt.includes(nq)) continue;
      const parts = [];
      let last = 0;
      for (let i = nt.indexOf(nq); i >= 0; i = nt.indexOf(nq, i + nq.length)) {
        parts.push(t.slice(last, i), h('mark', { class: 'srch' }, t.slice(i, i + nq.length)));
        last = i + nq.length;
      }
      parts.push(t.slice(last));
      span.replaceChildren(...parts);
    }
  }

  /* ---------- marcadores, destaques e anotações ---------- */
  const chapterOf = (spine) => `Página ${spine + 1}`;
  const copyText = (t) => copyToClipboard(t);
  const refreshPanels = () => { if (!annPanel.hidden) buildAnn(); updateBookmarkBtn(); };
  const bookmarkHere = () => st.annots.find((a) => a.type === 'bookmark' && a.spine === st.page - 1);
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
        const text = (await getText(st.page).catch(() => ({ raw: '' }))).raw.slice(0, 140);
        const a = { id: ann.newId(), bookId: book.id, type: 'bookmark', spine: st.page - 1, frac: 0, text, note: '', createdAt: now, updatedAt: now };
        await ann.save(a); st.annots.push(a); toast('Marcador adicionado.');
      }
      refreshPanels();
    } catch { toast('Não foi possível salvar o marcador.', 'error'); }
  }
  bmBtn.addEventListener('click', toggleBookmark);

  function drawHighlights(pv) {
    pv.hl.replaceChildren();
    for (const a of st.annots) {
      if (a.type !== 'highlight' || a.spine !== pv.n - 1) continue;
      for (const r of a.rects || []) {
        const [x, y, w, hh] = fromBase(r, st.rot);
        const d = h('div', { class: `pdf-hl hl-${a.color}${a.note ? ' has-note' : ''}`, 'data-id': a.id });
        d.style.cssText = `left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${hh * 100}%`;
        pv.hl.append(d);
      }
    }
  }
  const redrawPage = (n) => views.forEach((pv) => { if (pv.n === n + 1 && pv.state === 'done') drawHighlights(pv); });

  let selT, pending = null, editingId = null;
  function hideSel() { selBar.hidden = true; pending = null; editingId = null; }
  document.addEventListener('selectionchange', () => {
    clearTimeout(selT);
    selT = setTimeout(() => {
      const sel = document.getSelection();
      const tlOf = (n) => n?.parentElement?.closest?.('.textLayer');
      if (!sel || !sel.rangeCount || sel.isCollapsed || !tlOf(sel.anchorNode) || tlOf(sel.anchorNode) !== tlOf(sel.focusNode)) { if (!editingId) hideSel(); return; }
      const pageEl = tlOf(sel.anchorNode).closest('.pdf-page'), pv = pageEl.__pv, r = sel.getRangeAt(0);
      const pr = pageEl.getBoundingClientRect();
      const rects = mergeRects([...r.getClientRects()].filter((q) => q.width > 1 && q.height > 1).map((q) => [(q.left - pr.left) / pr.width, (q.top - pr.top) / pr.height, q.width / pr.width, q.height / pr.height]))
        .map((q) => toBase(q, st.rot));
      const text = sel.toString().replace(/\s+/g, ' ').trim();
      if (!rects.length || !text || text.length > 5000) { hideSel(); return; }
      pending = { n: pv.n, rects, text }; editingId = null;
      selBar.replaceChildren(...colorDots(null, (k) => createHighlight(k)), barButton('note', 'Nota', () => createHighlight('yellow', true)), barButton('copy', 'Copiar', copySelection));
      placeBar(selBar, reader, r.getBoundingClientRect());
    }, 250);
  });
  async function copySelection() {
    const t = pending?.text;
    toast(t && (await copyText(t)) ? 'Texto copiado.' : 'Não foi possível copiar. Use o menu do navegador.', t ? 'info' : 'error');
    hideSel();
  }
  async function createHighlight(color, withNote = false) {
    if (!pending) return;
    const { n, rects, text } = pending, now = Date.now();
    const a = { id: ann.newId(), bookId: book.id, type: 'highlight', spine: n - 1, frac: Math.min(...rects.map((q) => q[1])), rects, quote: text, text: text.slice(0, 600), color, note: '', createdAt: now, updatedAt: now };
    document.getSelection().removeAllRanges(); hideSel();
    try { await ann.save(a); st.annots.push(a); } catch { toast('Não foi possível salvar o destaque.', 'error'); return; }
    redrawPage(a.spine); refreshPanels();
    if (withNote) editNote(a.id);
  }
  function openEdit(id, rect) {
    const a = st.annots.find((x) => x.id === id);
    if (!a) return;
    editingId = id; pending = null;
    selBar.replaceChildren(...colorDots(a.color, async (k) => { a.color = k; a.updatedAt = Date.now(); await ann.save(a).catch(() => toast('Não foi possível salvar a cor.', 'error')); redrawPage(a.spine); openEdit(id, rect); refreshPanels(); }),
      barButton('note', a.note ? 'Editar nota' : 'Nota', () => editNote(id)), barButton('trash', 'Excluir', () => deleteAnn(a)));
    placeBar(selBar, reader, rect);
  }
  function editNote(id) {
    const a = st.annots.find((x) => x.id === id);
    if (!a) return;
    hideSel();
    openNoteEditor(a, async (note) => { a.note = note; a.updatedAt = Date.now(); await ann.save(a); redrawPage(a.spine); refreshPanels(); });
  }
  async function deleteAnn(a) {
    try { await ann.remove(a.id); } catch { toast('Não foi possível excluir.', 'error'); return; }
    st.annots = st.annots.filter((x) => x.id !== a.id);
    redrawPage(a.spine); hideSel(); refreshPanels();
  }
  function goTo(a) {
    closePanels(); hideChrome(); st.dirty = true;
    const f = a.type === 'highlight' && a.rects?.[0] ? Math.max(0, fromBase(a.rects[0], st.rot)[1] - 0.05) : 0;
    goPage(a.spine + 1, f);
  }
  function buildAnn() { renderAnnPanel(annPanel, { book, annots: st.annots, chapterOf, goTo, remove: deleteAnn, copy: copyText }); }

  /* ---------- entrada ---------- */
  function showChrome(on) { st.chromeOn = on; reader.classList.toggle('chrome-off', !on); if (!on) closePanels(); }
  const hideChrome = () => { if (st.chromeOn) showChrome(false); };

  function highlightAt(pageEl, e) {
    const pr = pageEl.getBoundingClientRect(), px = (e.clientX - pr.left) / pr.width, py = (e.clientY - pr.top) / pr.height;
    const n = pageEl.__pv.n;
    for (const a of st.annots) {
      if (a.type !== 'highlight' || a.spine !== n - 1) continue;
      for (const r of a.rects || []) { const [x, y, w, hh] = fromBase(r, st.rot); if (px >= x && px <= x + w && py >= y && py <= y + hh) return a; }
    }
    return null;
  }
  viewer.addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    const pageEl = e.target.closest('.pdf-page');
    if (!selBar.hidden) { hideSel(); document.getSelection().removeAllRanges(); return; }
    if (!document.getSelection().isCollapsed) return;
    if (!panelsClosed()) { closePanels(); return; }
    if (pageEl) {
      const a = highlightAt(pageEl, e);
      if (a) { const d = pageEl.querySelector(`.pdf-hl[data-id="${CSS.escape(a.id)}"]`); openEdit(a.id, (d || pageEl).getBoundingClientRect()); return; }
    }
    const x = e.clientX / viewer.clientWidth;
    const fitsWidth = viewer.scrollWidth <= viewer.clientWidth + 2;
    if (st.mode === 'single' && fitsWidth && x < 0.25) prevPage();
    else if (st.mode === 'single' && fitsWidth && x > 0.75) nextPage();
    else showChrome(!st.chromeOn);
  });

  // pinça com dois dedos, deslizar entre páginas (modo página única) e Ctrl+roda
  let pinch = null, swipe = null;
  const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  viewer.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      const [a, b] = e.touches, vr = viewer.getBoundingClientRect();
      pinch = { d0: dist(a, b), s0: st.scale, cx: (a.clientX + b.clientX) / 2 - vr.left, cy: (a.clientY + b.clientY) / 2 - vr.top, r: 1 };
      pagesEl.style.transformOrigin = `${pinch.cx + viewer.scrollLeft - pagesEl.offsetLeft}px ${pinch.cy + viewer.scrollTop - pagesEl.offsetTop}px`;
      swipe = null;
    } else if (e.touches.length === 1) swipe = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
  }, { passive: true });
  viewer.addEventListener('touchmove', (e) => {
    if (pinch && e.touches.length === 2) {
      e.preventDefault();
      pinch.r = clamp(dist(e.touches[0], e.touches[1]) / pinch.d0, SCALE_MIN / pinch.s0, SCALE_MAX / pinch.s0);
      pagesEl.style.transform = `scale(${pinch.r})`;
    }
  }, { passive: false });
  viewer.addEventListener('touchend', (e) => {
    if (pinch && e.touches.length < 2) {
      const p = pinch; pinch = null;
      pagesEl.style.transform = ''; pagesEl.style.transformOrigin = '';
      if (Math.abs(p.r - 1) > 0.02) setScale(p.s0 * p.r, p.cx, p.cy);
      return;
    }
    if (swipe && st.mode === 'single' && viewer.scrollWidth <= viewer.clientWidth + 2) {
      const t = e.changedTouches[0], dx = t.clientX - swipe.x, dy = t.clientY - swipe.y;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - swipe.t < 800) (dx < 0 ? nextPage : prevPage)();
    }
    swipe = null;
  }, { passive: true });
  viewer.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setScale(st.scale * Math.exp(-e.deltaY * 0.0025), e.clientX - viewer.getBoundingClientRect().left, e.clientY - viewer.getBoundingClientRect().top);
  }, { passive: false });

  let rafScroll = 0, lastTop = 0;
  viewer.addEventListener('scroll', () => {
    if (!rafScroll) rafScroll = requestAnimationFrame(() => {
      rafScroll = 0; updateCurrent();
      if (Math.abs(viewer.scrollTop - lastTop) > 40) { lastTop = viewer.scrollTop; hideChrome(); }
    });
  }, { passive: true });

  pgInput.addEventListener('change', () => { st.dirty = true; goPage(Number(pgInput.value)); });
  pgInput.addEventListener('keydown', (e) => e.stopPropagation());
  pgSlider.addEventListener('input', () => { pgInput.value = pgSlider.value; });
  pgSlider.addEventListener('change', () => { st.dirty = true; goPage(Number(pgSlider.value)); });

  function onKey(e) {
    if (document.querySelector('dialog[open]')) return;
    const k = e.key;
    if (e.target.matches?.('input[type=text],input[type=search],input[type=number],textarea')) return;
    if (k === 'Escape') { if (!selBar.hidden) hideSel(); else if (!panelsClosed()) closePanels(); else if (!document.fullscreenElement) location.hash = '#biblioteca'; return; }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'f') { e.preventDefault(); showChrome(true); togglePanel(searchPanel, searchBtn, buildSearch); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === 'ArrowRight' || (k === 'PageDown' && st.mode === 'single')) { e.preventDefault(); nextPage(); }
    else if (k === 'ArrowLeft' || (k === 'PageUp' && st.mode === 'single')) { e.preventDefault(); prevPage(); }
    else if (k === 'Home') { e.preventDefault(); st.dirty = true; goPage(1); }
    else if (k === 'End') { e.preventDefault(); st.dirty = true; goPage(N); }
    else if (k === '+' || k === '=') { e.preventDefault(); setScale(st.scale * 1.25); }
    else if (k === '-') { e.preventDefault(); setScale(st.scale / 1.25); }
    else if (k === '0') { e.preventDefault(); setFit('width'); }
    else if (k === 'b' || k === 'B') toggleBookmark();
    else if (k === 'r' || k === 'R') rotate();
  }
  document.addEventListener('keydown', onKey);
  const onHide = () => { if (document.visibilityState === 'hidden') save(); };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', save);
  let resizeT;
  const ro = new ResizeObserver(() => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (st.fit !== 'custom') { const f = fracInPage(), p = st.page; relayout(); goPage(p, f); } }, 120); });
  ro.observe(viewer);

  /* ---------- início: retomada automática ---------- */
  try { st.annots = await ann.list(book.id); } catch { toast('Não foi possível carregar suas marcações.', 'error'); }
  if (!book.pages) db.updateBook(book.id, (cur) => ({ ...cur, pages: N })).catch(() => {});
  const loc = book.location;
  if (loc && Number.isInteger(loc.page)) st.page = clamp(loc.page, 1, N);
  buildPages(); relayout();
  goPage(st.page, loc && typeof loc.frac === 'number' ? loc.frac : 0);
  updateUI();
  setTimeout(hideChrome, loc ? 1800 : 3500);
  const releaseAwake = keepAwake();

  return () => {
    save(); tracker.stop(); releaseAwake();
    clearTimeout(resizeT); clearTimeout(goPage.t);
    ro.disconnect(); io?.disconnect(); thumbIO?.disconnect();
    views.forEach(release);
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', save);
    if (document.fullscreenElement) document.exitFullscreen?.();
    pdf.destroy?.();
  };
}
