// Baixa os EPUBs listados em public/books/adamastor/catalogo.json a partir das páginas do Projecto Adamastor,
// valida cada arquivo, extrai a capa e atualiza o catálogo. Requer Node 18+ e o comando `unzip`.
// Uso: node tools/baixar-adamastor.mjs [id ...]   (sem ids = todos)
import { readFile, writeFile, mkdir, stat, readdir, rename, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const DIR = process.env.ADAMASTOR_DIR || 'public/books/adamastor', CAT = `${DIR}/catalogo.json`, MAX = 60 * 1024 * 1024;
export const unzipP = (file, entry) => execFileSync('unzip', ['-p', file, entry], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
export const attr = (xml, tag, name) => { const m = xml.match(new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]+)"`, 'i')); return m?.[1]; };

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

const plain = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const titleOf = (file) => { try { const opf = String(unzipP(file, attr(String(unzipP(file, 'META-INF/container.xml')), 'rootfile', 'full-path'))); return opf.match(/<dc:title[^>]*>([^<]+)</i)?.[1] || ''; } catch { return ''; } };

/** Registra EPUBs colocados à mão na pasta (qualquer nome): valida, casa com o catálogo pelo título e renomeia para <id>.epub. */
async function adoptLocal(doc) {
  for (const f of await readdir(DIR)) {
    if (!/\.epub$/i.test(f)) continue;
    const full = path.join(DIR, f);
    if (doc.livros.some((b) => path.basename(b.epub) === f)) continue;
    const t = plain(titleOf(full)), b = t && doc.livros.find((x) => { const n = plain(x.titulo); return t === n || t.startsWith(n) || n.startsWith(t); });
    if (b && !(await stat(path.join(DIR, path.basename(b.epub))).catch(() => null))) { await rename(full, path.join(DIR, path.basename(b.epub))); console.log('ADOTADO', f, '->', b.id); }
    else console.log('IGNORADO', f, '(título não consta no catálogo ou já existe)');
  }
}

async function fetchEpub(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60000), headers: { 'user-agent': 'BotoAzul-catalogo/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX) throw new Error('arquivo grande demais');
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('resposta não é um EPUB (ZIP)');
  return buf;
}

async function main() {
  const doc = JSON.parse(await readFile(CAT, 'utf8')), only = new Set(process.argv.slice(2));
  const pend = [];
  await mkdir(`${DIR}/capas`, { recursive: true });
  await adoptLocal(doc);
  for (const b of doc.livros) {
    if (only.size && !only.has(b.id)) continue;
    const file = path.join(DIR, path.basename(b.epub)), cover = path.join(DIR, 'capas', path.basename(b.capa));
    const errs = [];
    let ok = false;
    // 1) arquivo já presente no projeto  2) link direto oficial  3) link achado na página do livro  4) edição alternativa (Project Gutenberg)
    const sources = [['local', null], ['direto', b.epub_url], ['pagina', 'PAGE'], ['alternativa', b.epub_url_alt]];
    for (const [kind, url] of sources) {
      if (ok) break;
      try {
        let origin = null;
        if (kind === 'local') { if (!(await stat(file).catch(() => null))) continue; origin = 'arquivo enviado ao repositório'; }
        else {
          if (!url) continue;
          let u = url;
          if (url === 'PAGE') { const pg = await fetch(b.pagina_origem, { signal: AbortSignal.timeout(30000), headers: { 'user-agent': 'BotoAzul-catalogo/1.0' } }); if (!pg.ok) throw new Error(`página HTTP ${pg.status}`); u = findEpubLink(await pg.text()); if (!u) throw new Error('link do EPUB não encontrado na página'); }
          await writeFile(file, await fetchEpub(u)); origin = u;
        }
        const capa = inspectEpub(file); // valida mimetype/container/OPF; lança se inválido
        if (capa) { await writeFile(cover, capa); b.capa_ok = true; } else b.capa_ok = false;
        const buf = await readFile(file);
        b.baixado = true; b.tamanho = buf.length; b.sha256 = createHash('sha256').update(buf).digest('hex'); b.origem_download = origin;
        if (kind === 'alternativa') b.credito = 'Edição digital: Project Gutenberg (domínio público)';
        ok = true; console.log('OK  ', b.id, kind, b.tamanho);
      } catch (e) { errs.push(`${kind}: ${/unzip|mimetype|OPF/.test(e.message) ? 'arquivo não é um EPUB válido' : e.message}`); }
    }
    if (!ok) { await unlink(file).catch(() => {}); b.baixado = false; delete b.capa_ok; pend.push(`- ${b.titulo} (${b.id}) — ${errs.join(' | ') || 'sem fonte'}\n  - baixe manualmente: ${b.epub_url || b.pagina_origem} e envie para ${DIR}/`); console.log('FALHA', b.id, errs.join(' | ')); }
  }
  await writeFile(CAT, JSON.stringify(doc, null, 2) + '\n');
  await writeFile(`${DIR}/PENDENTES.md`, pend.length ? `# EPUBs pendentes\n\n${pend.join('\n')}\n` : '# Nenhum EPUB pendente\n');
}
if (import.meta.url === `file://${process.argv[1]}`) main();
