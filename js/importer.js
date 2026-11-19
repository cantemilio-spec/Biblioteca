// Importação segura de EPUB/PDF: valida, remove duplicatas (SHA-256), extrai metadados/capa. A busca de metadados
// nunca impede a importação; já a validação estrutural impede.
import { META_TIMEOUT_MS } from './config.js';
import { openPdf } from './pdf.js';
import { openZip, ZipError } from './zip.js';
import { byLocal, parseXml, resolvePath } from './epub.js';
import { findIsbn, titleFromFilename } from './books.js';
import { normalizeCover, sniffImage } from './covers.js';
import { plainText } from './text.js';
import { getSetting } from './settings.js';
import * as db from './db.js';

export class ImportError extends Error {}

const ext = (n) => (String(n).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
const NS_DC = 'http://purl.org/dc/elements/1.1/';

/* ---------- validação ---------- */

export async function validateFile(file, maxBytes = getSetting('maxFileMB') * 1024 * 1024) {
  const e = ext(file.name);
  if (e !== 'epub' && e !== 'pdf') throw new ImportError('Formato não suportado. Use EPUB ou PDF.');
  if (file.size === 0) throw new ImportError('O arquivo está vazio.');
  if (file.size > maxBytes) throw new ImportError(`Arquivo maior que o limite de ${Math.round(maxBytes / 1048576)} MB.`);
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  if (e === 'epub') {
    if (!(head[0] === 0x50 && head[1] === 0x4b && head[2] === 3 && head[3] === 4)) throw new ImportError('Não é um EPUB válido (não é um arquivo ZIP).');
  } else {
    if (!new TextDecoder('latin1').decode(head).includes('%PDF-')) throw new ImportError('Não é um PDF válido (cabeçalho ausente).');
    const tail = new TextDecoder('latin1').decode(new Uint8Array(await file.slice(Math.max(0, file.size - 2048)).arrayBuffer()));
    if (!tail.includes('%%EOF')) throw new ImportError('PDF incompleto ou corrompido (fim do arquivo ausente).');
  }
  return e;
}


/* ---------- EPUB ---------- */

async function readEpub(file) {
  let zip;
  try { zip = await openZip(file); } catch (e) {
    throw new ImportError(e instanceof ZipError ? `EPUB inválido: ${e.message}` : 'EPUB inválido.');
  }
  try {
    if (!zip.has('mimetype') || (await zip.text('mimetype')).trim() !== 'application/epub+zip') throw new ImportError('EPUB inválido (mimetype ausente ou incorreto).');
    if (!zip.has('META-INF/container.xml')) throw new ImportError('EPUB inválido (container.xml ausente).');
    const rf = byLocal(parseXml(await zip.text('META-INF/container.xml')), 'rootfile')[0];
    const opfPath = rf?.getAttribute('full-path');
    if (!opfPath || !zip.has(opfPath)) throw new ImportError('EPUB inválido (pacote OPF não encontrado).');
    const opf = parseXml(await zip.text(opfPath));
    if (!byLocal(opf, 'itemref').length) throw new ImportError('EPUB inválido (sem conteúdo de leitura).');
    return { zip, opf, opfPath };
  } catch (e) {
    if (e instanceof ImportError) throw e;
    throw new ImportError(e instanceof ZipError ? `EPUB inválido: ${e.message}` : 'EPUB malformado.');
  }
}

async function epubMeta({ zip, opf, opfPath }) {
  const dc = (n) => [...opf.getElementsByTagNameNS(NS_DC, n)].map((e) => plainText(e.textContent, 500)).filter(Boolean);
  const idents = dc('identifier');
  const meta = {
    title: dc('title')[0] || '',
    author: dc('creator').join(', '),
    publisher: dc('publisher')[0] || '',
    genre: dc('subject').slice(0, 3).join(', '),
    description: plainText([...opf.getElementsByTagNameNS(NS_DC, 'description')][0]?.textContent),
    isbn: findIsbn(idents),
  };
  let cover = null;
  try {
    const items = byLocal(opf, 'item');
    const coverId = byLocal(opf, 'meta').find((m) => m.getAttribute('name') === 'cover')?.getAttribute('content');
    const item = items.find((i) => (i.getAttribute('properties') || '').split(/\s+/).includes('cover-image')) || items.find((i) => i.getAttribute('id') === coverId);
    const href = item?.getAttribute('href');
    if (href) {
      const path = resolvePath(opfPath, href);
      if (zip.has(path) && zip.entries.get(path).usize <= 15 * 1024 * 1024) {
        const bytes = await zip.read(path);
        const type = sniffImage(bytes);
        if (type) cover = await normalizeCover(new Blob([bytes], { type }));
      }
    }
  } catch { /* capa é opcional */ }
  return { meta, cover };
}

/* ---------- PDF (PDF.js carregado sob demanda) ---------- */

async function pdfMeta(file) {
  let pdf;
  try { pdf = await openPdf(file); } catch (e) {
    if (e?.name === 'PasswordException') throw new ImportError('PDF protegido por senha não é suportado.');
    if (e?.name === 'InvalidPDFException') throw new ImportError('PDF inválido ou corrompido.');
    throw e;
  }
  try {
    const info = (await pdf.getMetadata().catch(() => ({}))).info || {};
    let cover = null;
    try {
      const page = await pdf.getPage(1);
      const vp0 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: 600 / vp0.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      cover = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
    } catch { /* sem capa */ }
    return { meta: { title: plainText(info.Title, 300), author: plainText(info.Author, 300), description: plainText(info.Subject), genre: '', publisher: '', isbn: '', pages: pdf.numPages }, cover };
  } finally { pdf.destroy?.(); }
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

/* ---------- API pública ---------- */

async function sha256(file) {
  if (!crypto?.subtle) throw new ImportError('Contexto inseguro: abra o app via HTTPS ou localhost.');
  const buf = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function extract(file, format) {
  if (format === 'epub') return epubMeta(await readEpub(file)); // erros estruturais sobem (ImportError)
  try { return await withTimeout(pdfMeta(file), META_TIMEOUT_MS); } catch (e) {
    if (e instanceof ImportError) throw e;
    return { meta: {}, cover: null, degraded: true }; // PDF.js indisponível: importa mesmo assim
  }
}

/** Importa um arquivo. Retorna { status: 'added'|'duplicate', book, degraded }. */
export async function importFile(file) {
  const format = await validateFile(file);
  const hash = await sha256(file);
  const existing = await db.findBookByHash(hash);
  if (existing) return { status: 'duplicate', book: existing };

  const { meta, cover, degraded } = await extract(file, format);
  const now = Date.now();
  const book = {
    id: crypto.randomUUID(), hash, format, fileName: file.name, size: file.size,
    title: meta.title || titleFromFilename(file.name), author: meta.author || '', publisher: meta.publisher || '',
    genre: meta.genre || '', description: meta.description || '', isbn: meta.isbn || '', pages: meta.pages || null,
    favorite: false, progress: 0, lastReadAt: null, finishedAt: null, collections: [],
    coverSource: cover ? 'file' : null, addedAt: now, updatedAt: now,
  };
  try {
    await db.addBookBundle({ book, blob: new Blob([file], { type: format === 'pdf' ? 'application/pdf' : 'application/epub+zip' }), cover });
  } catch (e) {
    if (e?.name === 'QuotaExceededError') throw new ImportError('Sem espaço de armazenamento no dispositivo.');
    throw new ImportError('Não foi possível salvar o livro.');
  }
  return { status: 'added', book, degraded };
}

/** Substitui o arquivo de um livro existente (mesmo formato), mantendo metadados, progresso e anotações. */
export async function replaceFile(book, file) {
  const format = await validateFile(file);
  if (format !== book.format) throw new ImportError(`O novo arquivo precisa ser ${book.format.toUpperCase()}.`);
  const hash = await sha256(file);
  const other = await db.findBookByHash(hash);
  if (other && other.id !== book.id) throw new ImportError(`Este arquivo já existe na biblioteca ("${other.title}").`);
  if (format === 'epub') await readEpub(file);
  const updated = { ...book, hash, size: file.size, fileName: file.name, updatedAt: Date.now() };
  await db.replaceBookFile(updated, new Blob([file], { type: format === 'pdf' ? 'application/pdf' : 'application/epub+zip' }));
  return updated;
}

/** Importa vários arquivos em sequência, reportando cada resultado sem interromper os demais. */
export async function importFiles(files, onResult) {
  const summary = { added: 0, duplicate: 0, failed: 0 };
  for (const file of files) {
    try {
      const r = await importFile(file);
      summary[r.status]++;
      onResult?.({ file, ...r });
    } catch (e) {
      summary.failed++;
      onResult?.({ file, status: 'error', message: e instanceof ImportError ? e.message : 'Erro inesperado ao importar.' });
    }
  }
  return summary;
}
