// Helpers de UI. Todo conteúdo dinâmico entra via textContent/nós DOM (nunca innerHTML) => sem XSS.
const SVG_NS = 'http://www.w3.org/2000/svg';

export const bimg = () => h('img', { class: 'hb', src: 'icons/boto.png', alt: '', width: 44, height: 44 });
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (['value', 'checked', 'disabled', 'selected'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  const add = (c) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  kids.forEach(add);
  return el;
}

const ICONS = {
  plus: 'M12 5v14M5 12h14',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3',
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  book: 'M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 19a2 2 0 0 1 2-2h13',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12l5 5 9-10',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M9 9h.01',
  swap: 'M7 7h13l-3-3M17 17H4l3 3',
  back: 'M15 5l-7 7 7 7',
  bookmark: 'M6 3h12v18l-6-4-6 4z',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  home: 'M4 11l8-7 8 7M6 10v10h4v-6h4v6h4V10',
  more: 'M12 5.5h.01M12 12h.01M12 18.5h.01',
  sort: 'M4 7h10M4 12h7M4 17h4M18 6v12M15 15l3 3 3-3',
  filter: 'M4 6h16M7 12h10M10 18h4',
  play: 'M8 5.5v13l10-6.5z',
  chevron: 'M9 5l7 7-7 7',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  clock: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  checklist: 'M4 7l2 2 3-4M4 16l2 2 3-4M12 7h8M12 17h8',
  tag: 'M4 4h8l8 8-8 8-8-8zM8.5 8.5h.01',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  chart: 'M4 20V10M10 20V4M16 20v-8M22 20H2',
  minus: 'M5 12h14',
  rotate: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  maximize: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
  note: 'M5 4h14v12H9l-4 4zM8 8h8M8 11h5',
  copy: 'M9 9h11v11H9zM5 15V5h10',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  share: 'M12 15V3M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7',
  info: 'M12 11v6M12 7.5h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
};

const STROKE = { more: 3.6 };
export function icon(name, size = 20) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': STROKE[name] || 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', ICONS[name] || '');
  svg.append(p);
  return svg;
}

export function toast(message, kind = 'info') {
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3500);
}

export function modal({ title, body, actions = [], wide = false, onClose }) {
  const dlg = h('dialog', { class: `modal${wide ? ' wide' : ''}`, 'aria-label': title });
  const close = () => { if (dlg.open) dlg.close(); };
  dlg.append(
    h('header', {}, h('h2', {}, title), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Fechar', onclick: close }, icon('close'))),
    h('div', { class: 'modal-body' }, body),
    actions.length ? h('footer', {}, actions.map((a) => h('button', {
      class: `btn ${a.kind || ''}`, type: 'button',
      onclick: async (e) => { const btn = e.currentTarget; btn.disabled = true; const r = await a.onClick?.({ close }); if (r === false) btn.disabled = false; else close(); },
    }, a.label))) : null,
  );
  dlg.addEventListener('close', () => { dlg.remove(); onClose?.(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  document.body.append(dlg);
  dlg.showModal();
  return { close, el: dlg };
}

export function confirmDialog(message, { confirmLabel = 'Confirmar', danger = false, title = 'Confirmar' } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (v) => { answered = true; resolve(v); };
    modal({
      title, body: h('p', {}, message),
      actions: [
        { label: 'Cancelar', onClick: () => answer(false) },
        { label: confirmLabel, kind: danger ? 'danger' : 'primary', onClick: () => answer(true) },
      ],
      onClose: () => { if (!answered) resolve(false); },
    });
  });
}

/**
 * Menu contextual (M3). Em telas estreitas vira uma folha inferior (alcance com uma mão); em telas largas abre junto ao ponto de toque.
 * items: { label, icon?, onClick, danger?, checked?, disabled? } | { divider: true } | { heading: 'texto' }
 */
export function menu(anchor, items, { x, y, title } = {}) {
  const sheet = window.matchMedia('(max-width: 599px)').matches;
  const back = h('div', { class: `menu-back${sheet ? ' sheet' : ''}` });
  const box = h('div', { class: `menu${sheet ? ' sheet' : ''}`, role: 'menu', 'aria-label': title || 'Opções' });
  let closed = false;
  const close = (restore = true) => {
    if (closed) return; closed = true;
    document.removeEventListener('keydown', onKey, true);
    back.remove();
    if (restore) anchor?.isConnected && anchor.focus?.({ preventScroll: true });
  };
  const btns = [];
  for (const it of items) {
    if (it.divider) { box.append(h('hr')); continue; }
    if (it.heading) { box.append(h('div', { class: 'menu-h' }, it.heading)); continue; }
    const b = h('button', { type: 'button', role: it.checked == null ? 'menuitem' : 'menuitemradio', 'aria-checked': it.checked == null ? null : String(!!it.checked), class: `menu-item${it.danger ? ' danger' : ''}${it.checked ? ' on' : ''}`, disabled: !!it.disabled,
      onclick: async () => { close(false); await it.onClick?.(); } },
    it.icon ? icon(it.icon, 20) : h('span', { class: 'menu-ic' }), h('span', { class: 'menu-l' }, it.label), it.checked ? icon('check', 18) : null);
    btns.push(b); box.append(b);
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'Tab') { close(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const live = btns.filter((b) => !b.disabled), i = live.indexOf(document.activeElement);
      live[(i + (e.key === 'ArrowDown' ? 1 : -1) + live.length) % live.length]?.focus();
    }
  }
  back.addEventListener('pointerdown', (e) => { if (e.target === back) { e.preventDefault(); close(); } });
  back.addEventListener('contextmenu', (e) => { e.preventDefault(); close(); });
  back.append(box); document.body.append(back);
  document.addEventListener('keydown', onKey, true);
  if (!sheet) {
    const r = anchor?.getBoundingClientRect?.(), W = window.innerWidth, H = window.innerHeight, bw = box.offsetWidth, bh = box.offsetHeight;
    let left = x != null ? x : (r ? r.right - bw : 8), top = y != null ? y : (r ? r.bottom + 4 : 8);
    if (left + bw > W - 8) left = W - bw - 8;
    if (top + bh > H - 8) top = Math.max(8, (r ? r.top - bh - 4 : H - bh - 8));
    box.style.left = `${Math.max(8, left)}px`; box.style.top = `${Math.max(8, top)}px`;
  }
  (btns.find((b) => b.classList.contains('on')) || btns.find((b) => !b.disabled))?.focus({ preventScroll: true });
  return { close };
}
