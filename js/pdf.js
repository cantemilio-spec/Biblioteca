// PDF.js (Apache-2.0) embutido em vendor/pdfjs: funciona offline e sem CDN. Carregado só quando um PDF é aberto.
let libPromise;
const base = new URL('../vendor/pdfjs/', import.meta.url).href;

export function loadPdfjs() {
  if (!libPromise) {
    libPromise = import(base + 'pdf.min.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.mjs';
      return lib;
    }).catch((e) => { libPromise = null; throw e; });
  }
  return libPromise;
}

const OPTS = { isEvalSupported: false, enableXfa: false, cMapUrl: `${base}cmaps/`, cMapPacked: true, standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/`, iccUrl: `${base}iccs/` };
const FATAL = new Set(['PasswordException', 'InvalidPDFException']);

/** Abre um PDF a partir do Blob. Lê por faixas (só o que a página precisa), sem copiar o arquivo inteiro para a memória. */
export async function openPdf(blob) {
  const lib = await loadPdfjs();
  try {
    const first = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
    const transport = new lib.PDFDataRangeTransport(blob.size, first);
    transport.requestDataRange = (begin, end) => { blob.slice(begin, end).arrayBuffer().then((buf) => transport.onDataRange(begin, new Uint8Array(buf))); };
    return await lib.getDocument({ ...OPTS, range: transport, disableAutoFetch: true, disableStream: true }).promise;
  } catch (e) {
    if (FATAL.has(e?.name)) throw e;
    return lib.getDocument({ ...OPTS, data: new Uint8Array(await blob.arrayBuffer()) }).promise; // alternativa: arquivo inteiro
  }
}
