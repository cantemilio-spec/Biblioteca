export const APP = { name: 'Boto Azul', dbName: 'biblioteca-digital', dbVersion: 2 };

export const DEFAULTS = {
  goals: { dailyMin: 20, monthlyBooks: 2 }, maxFileMB: 200, autoIdentify: true, theme: 'auto', uiScale: 100, contrast: 'normal', motion: 'auto', gridSize: 'medium', view: 'grid', sort: 'added-desc' };

// Limites de segurança para ZIP/EPUB (proteção contra zip-bomb e arquivos malformados).
export const ZIP_LIMITS = {
  maxEntries: 5000,
  maxEntryBytes: 100 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxRatio: 1000, // descompactado/compactado por entrada
};

export const COVER = { maxSide: 900, quality: 0.85, maxSourceBytes: 15 * 1024 * 1024 };

export const META_TIMEOUT_MS = 20000;
