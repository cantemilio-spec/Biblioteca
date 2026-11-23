// Cataloga os EPUBs colocados em public/books/estante/: valida cada arquivo, lê título/autor, extrai a capa e gera o catalogo.json.
// Uso: node tools/catalogar-estante.mjs   (Node 18+ e o comando `unzip`)
import { readFile, writeFile, readdir, rename, unlink, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { inspectEpub, unzipP, attr } from './baixar-adamastor.mjs';

const DIR = process.env.ESTANTE_DIR || 'public/books/estante', MAX = 95 * 1024 * 1024;
const slugOf = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\.epub$/i, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'livro';
const tag = (opf, name) => { const m = opf.match(new RegExp(`<dc:${name}\\b[^>]*>([\\s\\S]*?)</dc:${name}>`, 'i')); return m ? m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ').trim() : ''; };

await mkdir(`${DIR}/capas`, { recursive: true });
const livros = [], problemas = [], usados = new Set();
for (const f of (await readdir(DIR)).sort()) {
  if (!/\.epub$/i.test(f)) continue;
  let file = path.join(DIR, f);
  try {
    const size = (await stat(file)).size;
    if (size > MAX) throw new Error('arquivo acima de 95 MB (limite do GitHub: 100 MB)');
    const capa = inspectEpub(file); // valida mimetype/container/OPF
    const opf = String(unzipP(file, attr(String(unzipP(file, 'META-INF/container.xml')), 'rootfile', 'full-path')));
    let slug = slugOf(f); for (let i = 2; usados.has(slug); i++) slug = `${slugOf(f)}-${i}`; usados.add(slug);
    if (f !== `${slug}.epub`) { await rename(file, path.join(DIR, `${slug}.epub`)); file = path.join(DIR, `${slug}.epub`); }
    const buf = await readFile(file);
    if (capa) await writeFile(path.join(DIR, 'capas', `${slug}.jpg`), capa);
    livros.push({ id: `estante-${slug}`, titulo: tag(opf, 'title') || path.basename(f, path.extname(f)), autor: tag(opf, 'creator'), categoria: 'Estante', genero: '', capa: capa ? `public/books/estante/capas/${slug}.jpg` : null, capa_ok: !!capa, epub: `public/books/estante/${slug}.epub`, credito: 'Enviado pelo dono do app', baixado: true, tamanho: size, sha256: createHash('sha256').update(buf).digest('hex') });
  } catch (e) { problemas.push(`- ${f}: ${/unzip|mimetype|OPF|container/i.test(e.message) ? 'não é um EPUB válido' : e.message}`); }
}
for (const c of await readdir(`${DIR}/capas`).catch(() => [])) if (c.endsWith('.jpg') && !usados.has(c.slice(0, -4))) await unlink(path.join(DIR, 'capas', c)); // capa de livro removido
livros.sort((a, b) => a.titulo.localeCompare(b.titulo, 'pt', { sensitivity: 'base' }));
const doc = { colecao: 'Estante', licenca: 'Arquivos enviados por você ao repositório. O app e o repositório são públicos: mantenha aqui apenas obras que você tem direito de distribuir.', livros };
await writeFile(`${DIR}/catalogo.json`, JSON.stringify(doc, null, 2) + '\n');
await writeFile(`${DIR}/PROBLEMAS.md`, problemas.length ? `# Arquivos recusados\n\n${problemas.join('\n')}\n` : '# Nenhum problema\n');
console.log(`${livros.length} livro(s) catalogado(s), ${problemas.length} recusado(s).`);
