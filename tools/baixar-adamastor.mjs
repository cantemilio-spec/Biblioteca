// Baixa os EPUBs listados em public/books/adamastor/catalogo.json a partir das páginas do Projecto Adamastor,
// valida cada arquivo, extrai a capa e atualiza o catálogo. Requer Node 18+ e o comando `unzip`.
// Uso: node tools/baixar-adamastor.mjs [id ...]   (sem ids = todos)
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const DIR = 'public/books/adamastor', CAT = `${DIR}/catalogo.json`, MAX = 60 * 1024 * 1024;
const unzipP = (file, entry) => execFileSync('unzip', ['-p', file, entry], { maxBuffer: 64 * 1024 * 1024 });
const attr = (xml, tag, name) => { const m = xml.match(new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]+)"`, 'i')); return m?.[1]; };

/** Acha o link do EPUB (não do MOBI) na página do livro. */
export function findEpubLink(html) {
  const links = [...html.matchAll(/href=["'](https?:\/\/projectoadamastor\.org\/download\/[^"']+?wpdmdl=\d+)["']/gi)].map((m) => m[1].replace(/&#038;|&amp;/g, '&'));
  return links.find((u) => !/mobi/i.test(u)) || null;
}

/** Valida o EPUB (ZIP + mimetype) e devolve a capa (Buffer) se existir. */
export function inspectEpub(file) {
  if (String(unzipP(file, 'mimetype')).trim() !== 'application/epub+zip') throw new Error('mimetype inválido');
  const opfPath = attr(String(unzipP(file, 'META-INF/container.xml')), 'rootfile', 'full-path');
  if (!opfPath) throw new Error('OPF não encontrado');
  const opf = String(unzipP(file, opfPath));
  const items = [...opf.matchAll(/<item\b[^>]*>/gi)].map((m) => m[0]);
  const get = (s, n) => s.match(new RegExp(`\\b${n}="([^"]*)"`))?.[1];
  const coverId = opf.match(/<meta\b[^>]*name="cover"[^>]*content="([^"]+)"/i)?.[1] || opf.match(/<meta\b[^>]*content="([^"]+)"[^>]*name="cover"/i)?.[1];
  const item = items.find((i) => /cover-image/.test(get(i, 'properties') || '')) || items.find((i) => get(i, 'id') === coverId);
  const href = item && get(item, 'href');
  if (!href) return null;
  const cp = path.posix.normalize(path.posix.join(path.posix.dirname(opfPath), decodeURIComponent(href)));
  try { return unzipP(file, cp); } catch { return null; }
}

async function main() {
  const doc = JSON.parse(await readFile(CAT, 'utf8')), only = new Set(process.argv.slice(2));
  const pend = [];
  await mkdir(`${DIR}/capas`, { recursive: true });
  for (const b of doc.livros) {
    if (only.size && !only.has(b.id)) continue;
    try {
      const page = await fetch(b.pagina_origem, { headers: { 'user-agent': 'BotoAzul-catalogo/1.0' } });
      if (!page.ok) throw new Error(`página HTTP ${page.status}`);
      const url = findEpubLink(await page.text());
      if (!url) throw new Error('link do EPUB não encontrado na página');
      const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'BotoAzul-catalogo/1.0' } });
      if (!res.ok) throw new Error(`download HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX) throw new Error('arquivo grande demais');
      if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('resposta não é um EPUB (ZIP)');
      await writeFile(b.epub, buf);
      const cover = inspectEpub(b.epub);
      if (cover) { await writeFile(b.capa, cover); b.capa_ok = true; } else b.capa_ok = false;
      b.baixado = true; b.tamanho = (await stat(b.epub)).size; b.sha256 = createHash('sha256').update(buf).digest('hex'); b.origem_download = url;
      console.log('OK  ', b.id, b.tamanho);
    } catch (e) { b.baixado = false; pend.push(`- ${b.titulo} (${b.id}): ${e.message}. Página: ${b.pagina_origem}`); console.log('FALHA', b.id, e.message); }
  }
  await writeFile(CAT, JSON.stringify(doc, null, 2) + '\n');
  await writeFile(`${DIR}/PENDENTES.md`, pend.length ? `# EPUBs pendentes\n\n${pend.join('\n')}\n` : '# Nenhum EPUB pendente\n');
}
if (import.meta.url === `file://${process.argv[1]}`) main();
