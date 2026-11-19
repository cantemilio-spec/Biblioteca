// Parser de EPUB para leitura + sanitização do HTML dos capítulos (lista de permissão).
// Nenhum script, estilo, formulário, iframe ou recurso externo do livro chega à tela.
import { openZip } from './zip.js';
import { sniffImage } from './covers.js';

export class EpubError extends Error {}

/* ---------- utilitários XML/caminhos (também usados pelo importador) ---------- */
export function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new EpubError('XML inválido.');
  return doc;
}
export const byLocal = (doc, name) => [...doc.getElementsByTagName('*')].filter((e) => e.localName === name);
export const dirname = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
export function resolvePath(base, href) {
  let rel = href.split('#')[0];
  try { rel = decodeURIComponent(rel); } catch { /* mantém como está */ }
  const out = [];
  for (const s of (dirname(base) + rel).split('/')) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); }
  return out.join('/');
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const MAX_IMG = 15 * 1024 * 1024;
const MAX_IMGS_PER_CHAPTER = 200;

const DROP = new Set(['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input', 'button', 'select', 'textarea', 'option', 'link', 'meta', 'base', 'template', 'noscript', 'audio', 'video', 'source', 'track', 'canvas', 'head', 'title', 'math', 'foreignobject']);
const ALLOWED = new Set(['a', 'abbr', 'article', 'aside', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'caption', 'cite', 'code', 'dd', 'del', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'ins', 'kbd', 'li', 'main', 'mark', 'nav', 'ol', 'p', 'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'section', 'small', 'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul', 'var']);
const KEEP_ATTR = new Set(['id', 'lang', 'dir', 'title', 'colspan', 'rowspan', 'start', 'datetime']);

/** Abre o EPUB e devolve spine, sumário e um carregador de capítulos já sanitizados. */
export async function loadEpub(blob) {
  const zip = await openZip(blob);
  if (!zip.has('META-INF/container.xml')) throw new EpubError('container.xml ausente.');
  const opfPath = byLocal(parseXml(await zip.text('META-INF/container.xml')), 'rootfile')[0]?.getAttribute('full-path');
  if (!opfPath || !zip.has(opfPath)) throw new EpubError('Pacote OPF não encontrado.');
  const opf = parseXml(await zip.text(opfPath));

  const manifest = new Map();
  for (const it of byLocal(opf, 'item')) {
    const href = it.getAttribute('href');
    if (!href) continue;
    manifest.set(it.getAttribute('id'), { path: resolvePath(opfPath, href), type: it.getAttribute('media-type') || '', props: (it.getAttribute('properties') || '').split(/\s+/) });
  }
  const isHtml = (m) => /^(application\/xhtml\+xml|text\/html)$/.test(m.type);
  const spine = byLocal(opf, 'itemref')
    .filter((r) => r.getAttribute('linear') !== 'no')
    .map((r) => manifest.get(r.getAttribute('idref')))
    .filter((m) => m && isHtml(m) && zip.has(m.path))
    .map((m) => ({ path: m.path, size: Math.max(1, zip.entries.get(m.path).usize) }));
  if (!spine.length) throw new EpubError('EPUB sem capítulos legíveis.');
  const spineIndex = new Map(spine.map((s, i) => [s.path, i]));
  const weights = spine.map((s) => s.size);
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  const toc = await readToc();
  async function readToc() {
    const entries = [];
    const push = (label, base, href, level) => {
      const [p, frag = ''] = String(href || '').split('#');
      const idx = spineIndex.get(resolvePath(base, p || ''));
      if (label && idx != null) entries.push({ label: label.replace(/\s+/g, ' ').trim().slice(0, 200), spine: idx, frag, level });
    };
    try {
      const navItem = [...manifest.values()].find((m) => m.props.includes('nav') && zip.has(m.path));
      if (navItem) {
        const doc = new DOMParser().parseFromString(await zip.text(navItem.path), 'text/html');
        const nav = [...doc.querySelectorAll('nav')].find((n) => (n.getAttribute('epub:type') || '').split(/\s+/).includes('toc')) || doc.querySelector('nav');
        const walk = (ol, level) => {
          for (const li of ol?.children || []) {
            if (li.localName !== 'li') continue;
            const a = [...li.children].find((c) => c.localName === 'a' || c.localName === 'span');
            if (a) push(a.textContent, navItem.path, a.getAttribute('href'), level);
            walk([...li.children].find((c) => c.localName === 'ol'), level + 1);
          }
        };
        walk(nav?.querySelector('ol'), 0);
      }
      if (!entries.length) {
        const tocId = byLocal(opf, 'spine')[0]?.getAttribute('toc');
        const ncx = manifest.get(tocId) || [...manifest.values()].find((m) => m.type === 'application/x-dtbncx+xml');
        if (ncx && zip.has(ncx.path)) {
          const walk = (parent, level) => {
            for (const np of [...parent.children].filter((c) => c.localName === 'navPoint')) {
              const label = byLocal(np, 'text')[0]?.textContent || '';
              const src = [...np.children].find((c) => c.localName === 'content')?.getAttribute('src');
              push(label, ncx.path, src, level);
              walk(np, level + 1);
            }
          };
          const map = byLocal(parseXml(await zip.text(ncx.path)), 'navMap')[0];
          if (map) walk(map, 0);
        }
      }
    } catch { /* sumário é opcional */ }
    return entries.length ? entries : spine.map((_, i) => ({ label: `Capítulo ${i + 1}`, spine: i, frag: '', level: 0 }));
  }

  /** Carrega o capítulo `idx` como DocumentFragment sanitizado. revoke() libera as imagens. */
  async function chapter(idx) {
    const { path } = spine[idx];
    const src = new DOMParser().parseFromString(await zip.text(path), 'text/html');
    const pending = [];
    const frag = document.createDocumentFragment();

    const makeImg = (n) => {
      const raw = (n.getAttribute('src') || n.getAttribute('href') || n.getAttribute('xlink:href') || '').trim();
      if (!raw || SCHEME.test(raw) || pending.length >= MAX_IMGS_PER_CHAPTER) return null;
      const p = resolvePath(path, raw);
      if (!zip.has(p) || zip.entries.get(p).usize > MAX_IMG) return null;
      const img = document.createElement('img');
      img.alt = (n.getAttribute('alt') || '').slice(0, 300);
      pending.push([img, p]);
      return img;
    };
    const makeLink = (n) => {
      const a = document.createElement('a');
      const href = (n.getAttribute('href') || '').trim();
      if (!href) return a; // âncora de destino
      if (href.startsWith('#')) { try { a.dataset.frag = decodeURIComponent(href.slice(1)); } catch { a.dataset.frag = href.slice(1); } return a; }
      if (/^https?:\/\//i.test(href)) { a.setAttribute('href', href); a.dataset.ext = '1'; return a; }
      if (SCHEME.test(href)) return null; // javascript:, data:, file:, mailto: etc.
      const si = spineIndex.get(resolvePath(path, href));
      if (si == null) return null;
      a.dataset.spine = String(si);
      const f = href.split('#')[1];
      if (f) a.dataset.frag = f;
      return a;
    };
    const walk = (from, to) => {
      for (const n of from.childNodes) {
        if (n.nodeType === 3) { to.append(n.data); continue; }
        if (n.nodeType !== 1) continue;
        const tag = n.localName.toLowerCase();
        if (DROP.has(tag)) continue;
        if (tag === 'img' || tag === 'image') { const i = makeImg(n); if (i) to.append(i); continue; }
        if (!ALLOWED.has(tag)) { walk(n, to); continue; } // desembrulha (svg, font, center…)
        const el = tag === 'a' ? makeLink(n) : document.createElement(tag);
        if (!el) { walk(n, to); continue; }
        for (const { name, value } of n.attributes) {
          const k = name.toLowerCase();
          if (KEEP_ATTR.has(k) && !(tag === 'a' && k !== 'id' && k !== 'title' && k !== 'lang')) el.setAttribute(k, value.slice(0, 500));
          else if (tag === 'a' && k === 'name' && !n.getAttribute('id')) el.setAttribute('id', value.slice(0, 200));
        }
        walk(n, el);
        to.append(el);
      }
    };
    walk(src.body, frag);

    const urls = [];
    await Promise.all(pending.map(async ([img, p]) => {
      try {
        const bytes = await zip.read(p);
        const type = sniffImage(bytes); // SVG e outros formatos ativos são descartados
        if (!type) { img.remove(); return; }
        const u = URL.createObjectURL(new Blob([bytes], { type }));
        urls.push(u); img.src = u;
      } catch { img.remove(); }
    }));
    return { frag, revoke: () => urls.forEach((u) => URL.revokeObjectURL(u)) };
  }

  return { spine, toc, weights, totalWeight, chapter };
}
