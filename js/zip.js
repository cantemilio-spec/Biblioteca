// Leitor ZIP mínimo e seguro (sem dependências). Lê sob demanda via Blob.slice e descompacta com
// DecompressionStream, impondo limites durante o fluxo (anti zip-bomb) e rejeitando caminhos perigosos (zip-slip).
import { ZIP_LIMITS } from './config.js';

export class ZipError extends Error {}

const EOCD = 0x06054b50, CEN = 0x02014b50, LOC = 0x04034b50;
const td = new TextDecoder('utf-8');

export async function openZip(blob, limits = ZIP_LIMITS) {
  const size = blob.size;
  if (size < 22) throw new ZipError('Arquivo ZIP muito pequeno.');
  const tailLen = Math.min(size, 65557);
  const tail = new DataView(await blob.slice(size - tailLen).arrayBuffer());
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === EOCD) { eocd = i; break; }
  if (eocd < 0) throw new ZipError('Estrutura ZIP inválida (diretório central não encontrado).');

  const total = tail.getUint16(eocd + 10, true);
  const cdSize = tail.getUint32(eocd + 12, true);
  const cdOff = tail.getUint32(eocd + 16, true);
  if (total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) throw new ZipError('ZIP64 não é suportado.');
  if (total > limits.maxEntries) throw new ZipError('Arquivo com entradas demais.');
  if (cdOff + cdSize > size) throw new ZipError('Diretório central fora dos limites do arquivo.');

  const cd = new DataView(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const entries = new Map();
  let p = 0, totalBytes = 0;
  for (let n = 0; n < total; n++) {
    if (p + 46 > cd.byteLength || cd.getUint32(p, true) !== CEN) throw new ZipError('Diretório central corrompido.');
    const flags = cd.getUint16(p + 8, true);
    const method = cd.getUint16(p + 10, true);
    const csize = cd.getUint32(p + 20, true);
    const usize = cd.getUint32(p + 24, true);
    const nlen = cd.getUint16(p + 28, true), xlen = cd.getUint16(p + 30, true), clen = cd.getUint16(p + 32, true);
    const off = cd.getUint32(p + 42, true);
    if (p + 46 + nlen > cd.byteLength) throw new ZipError('Diretório central corrompido.');
    const name = td.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nlen));
    p += 46 + nlen + xlen + clen;

    if (flags & 1) throw new ZipError('Entradas criptografadas não são suportadas.');
    if (name.startsWith('/') || name.includes('\\') || name.includes('\0') || name.split('/').includes('..') || /^[a-zA-Z]:/.test(name)) {
      throw new ZipError('Caminho inseguro dentro do arquivo.');
    }
    if (usize > limits.maxEntryBytes) throw new ZipError('Entrada descompactada grande demais.');
    totalBytes += usize;
    if (totalBytes > limits.maxTotalBytes) throw new ZipError('Conteúdo descompactado grande demais.');
    if (usize > 1024 * 1024 && csize > 0 && usize / csize > limits.maxRatio) throw new ZipError('Taxa de compressão suspeita.');
    if (entries.has(name)) throw new ZipError('Entradas duplicadas.');
    entries.set(name, { name, method, csize, usize, off, dir: name.endsWith('/') });
  }

  async function read(name) {
    const e = entries.get(name);
    if (!e || e.dir) throw new ZipError(`Arquivo ausente: ${name}`);
    const h = new DataView(await blob.slice(e.off, e.off + 30).arrayBuffer());
    if (h.byteLength < 30 || h.getUint32(0, true) !== LOC) throw new ZipError('Cabeçalho local corrompido.');
    const start = e.off + 30 + h.getUint16(26, true) + h.getUint16(28, true);
    if (start + e.csize > size) throw new ZipError('Dados da entrada fora dos limites.');
    const raw = blob.slice(start, start + e.csize);
    if (e.method === 0) {
      if (e.csize !== e.usize) throw new ZipError('Entrada inconsistente.');
      return new Uint8Array(await raw.arrayBuffer());
    }
    if (e.method !== 8) throw new ZipError('Método de compressão não suportado.');
    const reader = raw.stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const chunks = [];
    let got = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (got > e.usize) { await reader.cancel(); throw new ZipError('Entrada excede o tamanho declarado.'); }
        chunks.push(value);
      }
    } catch (err) {
      if (err instanceof ZipError) throw err;
      throw new ZipError('Falha ao descompactar (dados corrompidos).');
    }
    if (got !== e.usize) throw new ZipError('Tamanho descompactado inconsistente.');
    const out = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  return {
    entries,
    has: (n) => entries.has(n) && !entries.get(n).dir,
    read,
    text: async (n) => td.decode(await read(n)),
  };
}
