import { COVER } from './config.js';

export function sniffImage(bytes) {
  const b = bytes;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

/** Valida (por assinatura, nunca por extensão), redimensiona e reencoda como JPEG. SVG é recusado. */
export async function normalizeCover(blob, { minWidth = 0 } = {}) {
  if (blob.size > COVER.maxSourceBytes) throw new Error('Imagem de capa grande demais.');
  const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  if (!sniffImage(head)) throw new Error('Formato de imagem não suportado (use JPEG, PNG, GIF ou WebP).');
  const bmp = await createImageBitmap(blob);
  try {
    if (bmp.width < minWidth) throw new Error('A imagem é pequena demais para ser uma capa.');
    const scale = Math.min(1, COVER.maxSide / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    return await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Falha ao processar a capa.'))), 'image/jpeg', COVER.quality));
  } finally { bmp.close?.(); }
}
