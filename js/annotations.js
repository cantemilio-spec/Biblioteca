// Marcadores, destaques e notas: armazenamento (IndexedDB) e exportação. Sem DOM.
import * as db from './db.js';

export const COLORS = [['yellow', 'Amarelo'], ['green', 'Verde'], ['blue', 'Azul'], ['pink', 'Rosa']];
export const newId = () => crypto.randomUUID();

export const list = (bookId) => db.getAllByIndex('annotations', 'bookId', bookId);
export const save = (a) => db.put('annotations', a);
export async function remove(id) {
  await db.del('annotations', id);
  await db.put('tombstones', { id, type: 'annotation', deletedAt: Date.now() });
}

export const sortAnnotations = (list) => [...list].sort((a, b) => a.spine - b.spine || a.frac - b.frac || a.createdAt - b.createdAt);

export function exportName(book) {
  const slug = String(book.title).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'livro';
  return `${slug}-anotacoes.md`;
}

/** Markdown organizado por capítulo. `chapterOf(spineIndex)` devolve o título do capítulo. */
export function toMarkdown(book, annots, chapterOf, now = new Date()) {
  const colorName = Object.fromEntries(COLORS);
  const quoteBlock = (t) => String(t).split(/\r?\n/).map((l) => `> ${l}`).join('\n');
  const lines = [`# ${book.title}`];
  if (book.author) lines.push(`*${book.author}*`);
  lines.push('', `Exportado em ${now.toLocaleDateString('pt-BR')} · ${annots.length} marcaç${annots.length === 1 ? 'ão' : 'ões'}`);
  let last = -1;
  for (const a of sortAnnotations(annots)) {
    if (a.spine !== last) { lines.push('', `## ${chapterOf(a.spine)}`); last = a.spine; }
    lines.push('');
    if (a.type === 'bookmark') {
      lines.push(`- **Marcador**${a.text ? `: ${a.text}…` : ''}`);
    } else {
      lines.push(quoteBlock(a.text || a.quote));
      lines.push('', `*Destaque ${(colorName[a.color] || a.color).toLowerCase()}*`);
      if (a.note) lines.push('', `**Nota:** ${a.note}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
