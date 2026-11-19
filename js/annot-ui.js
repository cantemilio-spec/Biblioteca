// Peças de interface de marcações compartilhadas pelos leitores EPUB e PDF: barra flutuante, editor de nota,
// painel de marcações e exportação. A lógica específica de cada formato (ancoragem do trecho) fica em cada leitor.
import { h, icon, toast, modal } from './ui.js';
import * as ann from './annotations.js';
import { getSetting, setSetting } from './settings.js';

export async function copyToClipboard(text, fallbackDoc = document) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* tenta o método antigo */ }
  try { return fallbackDoc.execCommand('copy'); } catch { return false; }
}

export const colorDots = (current, pick) => ann.COLORS.map(([k, label]) => h('button', { type: 'button', class: `dot ${k}${k === current ? ' on' : ''}`, 'aria-label': label, title: label, onclick: () => pick(k) }));
export const barButton = (ic, label, fn) => h('button', { type: 'button', class: 'sb-btn', onclick: fn }, icon(ic, 16), label);

/** Posiciona a barra flutuante perto de `rect` (coordenadas da janela), dentro de `host`. */
export function placeBar(bar, host, rect) {
  bar.hidden = false;
  const w = bar.offsetWidth, hgt = bar.offsetHeight;
  let top = rect.top - hgt - 10;
  if (top < 60) top = rect.bottom + 14;
  bar.style.top = `${Math.min(Math.max(8, top), host.clientHeight - hgt - 8)}px`;
  bar.style.left = `${Math.min(Math.max(8, rect.left + rect.width / 2 - w / 2), host.clientWidth - w - 8)}px`;
}

/** Abre o editor de nota. `onSave(texto)` grava; se lançar erro, o diálogo permanece aberto. */
export function openNoteEditor(a, onSave) {
  const ta = h('textarea', { rows: 5, maxlength: 4000, placeholder: 'Escreva sua anotação…', 'aria-label': 'Anotação' });
  ta.value = a.note || '';
  modal({
    title: 'Anotação',
    body: h('div', { class: 'note-edit' }, h('blockquote', {}, a.text), ta),
    actions: [{ label: 'Cancelar' }, { label: 'Salvar', kind: 'primary', onClick: async () => {
      try { await onSave(ta.value.trim()); toast('Anotação salva.'); } catch { toast('Não foi possível salvar a anotação.', 'error'); return false; }
    } }],
  });
  setTimeout(() => ta.focus(), 50);
}

export function downloadMarkdown(book, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = h('a', { href: url, download: ann.exportName(book) });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('Arquivo de anotações gerado.');
}

/** Preenche o painel de marcações. goTo(a) navega; remove(a) exclui; copy(texto) copia. */
export function renderAnnPanel(panel, { book, annots, chapterOf, goTo, remove, copy }) {
  const list = ann.sortAnnotations(annots);
  const md = () => ann.toMarkdown(book, annots, chapterOf);
  const item = (a) => h('li', { class: 'ann-item' },
    h('button', { type: 'button', class: 'ann-go', onclick: () => goTo(a) },
      h('span', { class: `ann-mark ${a.type === 'bookmark' ? 'bm' : a.color}` }, a.type === 'bookmark' ? icon('bookmark', 14) : null),
      h('span', { class: 'ann-body' }, h('span', { class: 'ann-ch' }, chapterOf(a.spine)), h('span', { class: 'ann-text' }, a.text || '(página marcada)'), a.note ? h('span', { class: 'ann-note' }, a.note) : null)),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Excluir marcação', onclick: () => remove(a) }, icon('trash', 18)));
  panel.replaceChildren(
    h('div', { class: 'r-panel-head' }, h('h2', {}, `Marcações (${list.length})`),
      h('div', { class: 'r-panel-actions' },
        h('button', { class: 'btn', type: 'button', disabled: !list.length, onclick: async () => toast((await copy(md())) ? 'Anotações copiadas (Markdown).' : 'Não foi possível copiar.') }, icon('copy', 16), 'Copiar'),
        h('button', { class: 'btn', type: 'button', disabled: !list.length, onclick: () => downloadMarkdown(book, md()) }, icon('download', 16), 'Baixar'))),
    list.length ? h('ul', {}, list.map(item)) : h('p', { class: 'hint' }, 'Nada marcado ainda. Selecione um trecho para destacar ou use o marcador na barra superior.'));
}

/* ---------- conforto de leitura compartilhado (EPUB e PDF) ---------- */
/** Camada de escurecimento sobre o conteúdo: simula brilho menor sem depender de permissão do sistema. Devolve apply(0.3–1). */
export function attachDim(reader) {
  const dim = h('div', { class: 'r-dim', 'aria-hidden': 'true' });
  reader.append(dim);
  const apply = (b) => { dim.style.opacity = String(Math.max(0, (1 - b) * 0.75).toFixed(3)); };
  apply(getSetting('brightness') ?? 1);
  return apply;
}
export function brightnessControl(apply) {
  const input = h('input', { type: 'range', min: 0.3, max: 1, step: 0.05, value: getSetting('brightness') ?? 1, 'aria-label': 'Brilho' });
  input.addEventListener('input', () => apply(Number(input.value)));
  input.addEventListener('change', () => setSetting('brightness', Number(input.value)).catch(() => {}));
  return h('div', { class: 'bright' }, icon('sun', 16), input, icon('sun', 22));
}
/** Mantém a tela acesa durante a leitura (quando o navegador permite). Devolve a função que libera. */
export function keepAwake() {
  let lock = null, off = false;
  const req = async () => { try { if (!off && document.visibilityState === 'visible') lock = await navigator.wakeLock?.request('screen'); } catch { /* sem permissão */ } };
  document.addEventListener('visibilitychange', req); req();
  return () => { off = true; document.removeEventListener('visibilitychange', req); try { lock?.release?.()?.catch?.(() => {}); } catch { /* já liberado */ } };
}
