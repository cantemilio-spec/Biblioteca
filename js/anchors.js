// Ancoragem de destaques por deslocamento de texto dentro do capítulo. O texto sanitizado é determinístico,
// então (início, fim) + o trecho citado reencontram o mesmo lugar ao reabrir. Só manipula DOM do leitor.
const SKIP_WS = /^\s*$/;

/** Posição (em caracteres) de um ponto do DOM dentro do texto de `root`. */
export function offsetOf(doc, root, node, off) {
  const r = doc.createRange();
  r.selectNodeContents(root);
  r.setEnd(node, off);
  return r.toString().length;
}

function resolveRange(root, a) {
  const full = root.textContent, q = a.quote || '';
  if (full.slice(a.start, a.end) === q) return [a.start, a.end];
  const i = q ? full.indexOf(q) : -1; // arquivo substituído ou texto deslocado: procura o trecho
  return i >= 0 ? [i, i + q.length] : null;
}

function wrap(doc, root, s, e, a) {
  const walker = doc.createTreeWalker(root, 4 /* SHOW_TEXT */);
  const hits = [];
  let pos = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const len = n.data.length;
    const ns = Math.max(s, pos) - pos, ne = Math.min(e, pos + len) - pos;
    if (ne > ns && !SKIP_WS.test(n.data.slice(ns, ne))) hits.push([n, ns, ne]);
    pos += len;
    if (pos >= e) break;
  }
  for (const [node, ns, ne] of hits) {
    let mid = node;
    if (ns > 0) mid = node.splitText(ns);
    if (ne - ns < mid.data.length) mid.splitText(ne - ns);
    const m = doc.createElement('mark');
    m.className = `hl hl-${a.color}`;
    m.dataset.id = a.id;
    if (a.note) m.dataset.note = '1';
    mid.replaceWith(m);
    m.append(mid);
  }
  return hits.length > 0;
}

export function applyHighlight(doc, root, a) {
  const r = resolveRange(root, a);
  return r ? wrap(doc, root, r[0], r[1], a) : false;
}

const marks = (root, id) => root.querySelectorAll(`mark.hl[data-id="${CSS.escape(id)}"]`);

export function unwrap(root, id) {
  marks(root, id).forEach((m) => m.replaceWith(...m.childNodes));
  root.normalize();
}

export function restyle(root, a) {
  marks(root, a.id).forEach((m) => {
    m.className = `hl hl-${a.color}`;
    if (a.note) m.dataset.note = '1'; else delete m.dataset.note;
  });
}

export const firstMark = (root, id) => marks(root, id)[0] || null;

const BLOCK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'td', 'th', 'blockquote', 'section', 'article', 'aside', 'figure', 'figcaption', 'pre', 'br', 'dd', 'dt', 'header', 'footer', 'nav', 'table', 'ul', 'ol']);
/** Texto legível de um nó/fragmento: separa blocos com espaço e normaliza espaços. */
export function readable(node) {
  let out = '';
  (function walk(n) {
    for (const k of n.childNodes) {
      if (k.nodeType === 3) out += k.data;
      else if (k.nodeType === 1) { const b = BLOCK.has(k.localName); if (b) out += ' '; walk(k); if (b) out += ' '; }
    }
  })(node);
  return out.replace(/\s+/g, ' ').trim();
}
