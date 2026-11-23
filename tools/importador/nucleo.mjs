// Núcleo do importador: rede com tentativas progressivas, validação de EPUB, hash, estado em disco. Sem dependências externas.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export const UA = 'BotoAzul-importador/2.0 (+https://github.com/cantemilio-spec/Biblioteca)';
export const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export const plain = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export const decode = (s) => String(s).replace(/&amp;|&#038;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();
export const slugOf = (s) => plain(s).replace(/ /g, '-').slice(0, 70) || 'livro';
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
export const nomeNormal = (n) => { const m = String(n).match(/^([^,]+),\s*(.+)$/); return m ? `${m[2].replace(/\s*\(.*?\)\s*/g, ' ').trim()} ${m[1]}`.trim() : String(n); };

/** Erro de rede/indisponibilidade (tentar de novo depois). Erros "definitivos" (404, 403) são Error comum com .status. */
export class ErroRede extends Error { constructor(m, causa) { super(m); this.name = 'ErroRede'; this.causa = causa; } }

/** GET com timeout e tentativas com intervalo progressivo (2 s, 4 s, 8 s...). 429/5xx/timeout = ErroRede. 4xx = erro definitivo. */
export async function http(url, { tipo = 'text', tent = 3, ms = 20000, headers = {} } = {}) {
  let ultimo;
  for (let i = 1; i <= tent; i++) {
    try {
      const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(ms), headers: { 'user-agent': UA, ...headers } });
      if (r.status === 429 || r.status >= 500) throw new ErroRede(`HTTP ${r.status}`);
      if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
      const ct = r.headers?.get?.('content-type') || '';
      const v = tipo === 'json' ? await r.json() : tipo === 'buf' ? Buffer.from(await r.arrayBuffer()) : await r.text();
      return tipo === 'buf' ? Object.assign(v, { contentType: ct }) : v;
    } catch (e) {
      if (e.status) throw e; // 4xx: não adianta repetir
      ultimo = e instanceof ErroRede ? e : new ErroRede(`${e.name}: ${e.message}${e.cause?.code ? ` (${e.cause.code})` : ''}`, e);
      if (i < tent) await pause(Number(process.env.BACKOFF_MS ?? 2000) * 2 ** (i - 1));
    }
  }
  throw ultimo;
}

const unzipP = (file, entry) => execFileSync('unzip', ['-p', file, entry], { maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
const attr = (xml, tag, name) => xml.match(new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]+)"`, 'i'))?.[1];

/** Confere que é um EPUB íntegro e abrível: não é PDF, ZIP sem erro de CRC, mimetype, container, OPF, spine com todos os capítulos presentes. */
export function validarEpub(file, buf) {
  if (buf && buf.subarray(0, 5).toString() === '%PDF-') throw new Error('PDF não é aceito (somente EPUB)');
  if (buf && !(buf[0] === 0x50 && buf[1] === 0x4b)) throw new Error('não é um arquivo ZIP/EPUB');
  try { execFileSync('unzip', ['-tq', file], { stdio: 'ignore' }); } catch { throw new Error('EPUB corrompido ou incompleto (falha no teste de integridade do ZIP)'); }
  if (String(unzipP(file, 'mimetype')).trim() !== 'application/epub+zip') throw new Error('mimetype inválido');
  const opfPath = attr(String(unzipP(file, 'META-INF/container.xml')), 'rootfile', 'full-path');
  if (!opfPath) throw new Error('container.xml sem OPF');
  const opf = String(unzipP(file, opfPath));
  const nomes = new Set(execFileSync('unzip', ['-Z1', file], { maxBuffer: 64 * 1024 * 1024 }).toString().split('\n').filter(Boolean));
  const manifest = new Map([...opf.matchAll(/<item\b[^>]*>/gi)].map((m) => [m[0].match(/\bid="([^"]*)"/)?.[1], m[0].match(/\bhref="([^"]*)"/)?.[1]]));
  const spine = [...opf.matchAll(/<itemref\b[^>]*\bidref="([^"]+)"/gi)].map((m) => m[1]);
  if (!spine.length) throw new Error('EPUB sem capítulos (spine vazio)');
  const dir = path.posix.dirname(opfPath);
  const faltando = spine.filter((id) => { const h = manifest.get(id); if (!h) return true; return !nomes.has(path.posix.normalize(path.posix.join(dir, decodeURIComponent(h)))); });
  if (faltando.length) throw new Error(`EPUB incompleto: ${faltando.length} capítulo(s) ausente(s) no arquivo`);
  const titulo = decode(opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1] || '');
  return { capitulos: spine.length, titulo, opfPath };
}

export async function lerJson(p, padrao) { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return padrao; } }
export async function gravarJson(p, obj) { await mkdir(path.dirname(p), { recursive: true }); const t = `${p}.tmp`; await writeFile(t, JSON.stringify(obj, null, 2) + '\n'); await rename(t, p); }
