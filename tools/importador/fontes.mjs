// Fontes de livros. Cada fonte é independente: { id, nome, disponibilidade(), buscar(item), direitos(cand, item), baixar(cand) }.
// Só EPUB. Nenhuma fonte inclui obra sem autorização de redistribuição comprovada (direitos() decide).
import { http, ErroRede, plain, decode, nomeNormal, MAX_BYTES, mb } from './nucleo.mjs';

export const ANO_LIMITE = 1955; // Brasil: vida + 70 anos. Em 2026, autor falecido até 1955 = domínio público.
const tokens = (t) => plain(t).split(' ').filter(Boolean);
export const casa = (cand, tit, aut) => { const h = plain(cand.titulo); const ha = plain(cand.autor || ''); return tokens(tit).every((w) => h.split(' ').includes(w)) && (!ha || String(aut).split('/').some((x) => ha.includes(plain(x)))); };
const first = (aut) => String(aut).split('/')[0];

/** Lê o cadastro (RDF) de um livro do Gutenberg. */
export function parseRdf(xml) {
  const agents = [...xml.matchAll(/<(dcterms:creator|marcrel:[a-z]{3})>\s*<pgterms:agent[^>]*>([\s\S]*?)<\/pgterms:agent>/g)].map((m) => ({
    papel: m[1] === 'dcterms:creator' ? 'creator' : m[1].slice(8),
    nome: decode(m[2].match(/<pgterms:name>([^<]*)/)?.[1] || ''),
    morte: Number(m[2].match(/<pgterms:deathdate[^>]*>(\d+)</)?.[1]) || null,
    nasc: Number(m[2].match(/<pgterms:birthdate[^>]*>(\d+)</)?.[1]) || null,
  }));
  return {
    titulo: decode(xml.match(/<dcterms:title>([\s\S]*?)<\/dcterms:title>/)?.[1] || ''),
    idiomas: [...xml.matchAll(/<dcterms:language>([\s\S]*?)<\/dcterms:language>/g)].map((m) => m[1].match(/<rdf:value[^>]*>([^<]+)</)?.[1]?.trim()).filter(Boolean),
    direitos: decode(xml.match(/<dcterms:rights>([\s\S]*?)<\/dcterms:rights>/)?.[1] || ''),
    agentes: agents,
  };
}

/** Decide se a obra pode entrar. Retorna { ok, motivo, avisos, licenca }. */
export function checarDireitos(info, idioma) {
  const av = [];
  if (!/public domain/i.test(info.direitos)) return { ok: false, motivo: `cadastro não diz domínio público (${info.direitos || 'sem informação de direitos'})` };
  if (!info.idiomas.includes(idioma)) return { ok: false, motivo: `idioma ${info.idiomas.join('/') || '?'} diferente do esperado (${idioma})` };
  const autores = info.agentes.filter((a) => a.papel === 'creator');
  if (!autores.length) return { ok: false, motivo: 'autor não identificado' };
  for (const a of autores) {
    if (/anonymous|unknown/i.test(a.nome)) return { ok: false, motivo: 'autoria anônima: data de morte não comprovável' };
    if (!a.morte) return { ok: false, motivo: `autor sem data de morte no cadastro (${a.nome})` };
    if (a.morte > ANO_LIMITE) return { ok: false, motivo: `autor morreu em ${a.morte} (precisa ser até ${ANO_LIMITE})` };
  }
  for (const a of info.agentes.filter((x) => ['trl', 'ill'].includes(x.papel))) {
    const quem = a.papel === 'trl' ? 'tradutor' : 'ilustrador';
    if (a.morte && a.morte <= ANO_LIMITE) continue;
    if (a.morte) return { ok: false, motivo: `${quem} ${a.nome} morreu em ${a.morte} (direitos da ${a.papel === 'trl' ? 'tradução' : 'ilustração'} não expirados)` };
    if (a.papel === 'trl') return { ok: false, motivo: `tradutor ${a.nome} sem data de morte no cadastro (direitos da tradução não comprovados)` };
    av.push(`ilustrador ${a.nome} sem data no cadastro`);
  }
  const trad = info.agentes.filter((a) => a.papel === 'trl');
  const licenca = `Domínio público: ${autores.map((a) => `${nomeNormal(a.nome)} (†${a.morte})`).join(', ')}${trad.length ? `; tradução de ${trad.map((a) => `${nomeNormal(a.nome)} (†${a.morte})`).join(', ')}` : ' (texto no idioma original)'}. Cadastro do Project Gutenberg: "${info.direitos}"`;
  return { ok: true, avisos: av, licenca };
}


/* ------------------------------------------------------------------ Project Gutenberg */
export function gutenberg() {
  let gutendexOff = 0;
  return {
    id: 'gutenberg', nome: 'Project Gutenberg',
    async disponibilidade() {
      const t0 = Date.now(); const r = await http('https://www.gutenberg.org/cache/epub/345/pg345.rdf', { tent: 1, ms: 15000 });
      if (!/<pgterms:ebook/.test(r)) throw new Error('resposta inesperada');
      return { ms: Date.now() - t0, detalhe: 'cadastro RDF respondeu' };
    },
    async buscar(item) {
      const q = encodeURIComponent(`${item.tit} ${first(item.aut)}`);
      if (gutendexOff < 2) {
        try {
          const j = await http(`https://gutendex.com/books/?search=${q}&languages=${item.idioma}&copyright=false`, { tipo: 'json', tent: 2 });
          gutendexOff = 0;
          const l = (j.results || []).map((b) => ({ id: String(b.id), titulo: b.title, autor: (b.authors || []).map((a) => a.name).join(' ') })).filter((c) => casa(c, item.tit, item.aut));
          if (l.length) return l;
        } catch (e) { gutendexOff++; }
      }
      let x; try { x = await http(`https://www.gutenberg.org/ebooks/search.opds/?query=${q}`, { tent: 2 }); } catch (e) { if (e.status === 404) return []; throw e; } // ErroRede sobe e o item fica pendente
      return [...x.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => ({ id: m[1].match(/ebooks\/(\d+)/)?.[1], titulo: decode(m[1].match(/<title>([^<]*)/)?.[1] || ''), autor: decode(m[1].match(/<content[^>]*>([^<]*)/)?.[1] || '') })).filter((c) => c.id && casa(c, item.tit, item.aut));
    },
    async direitos(cand, item) {
      const info = parseRdf(await http(`https://www.gutenberg.org/cache/epub/${cand.id}/pg${cand.id}.rdf`, { tent: 2 }));
      const v = checarDireitos(info, item.idioma);
      if (!v.ok) return v;
      const autores = info.agentes.filter((a) => a.papel === 'creator');
      return { ...v, titulo: info.titulo.split(/\s*;\s*/)[0], autor: autores.map((a) => nomeNormal(a.nome)).join(', '), fonte: `https://www.gutenberg.org/ebooks/${cand.id}`, credito: `Project Gutenberg #${cand.id}`, traducao_verificada: true };
    },
    async baixar(cand) {
      const id = cand.id; let erro;
      for (const u of [`https://www.gutenberg.org/cache/epub/${id}/pg${id}-images.epub`, `https://www.gutenberg.org/ebooks/${id}.epub3.images`, `https://www.gutenberg.org/ebooks/${id}.epub.noimages`]) {
        try { return { buf: await http(u, { tipo: 'buf', tent: 2, ms: 60000 }), url: u }; } catch (e) { erro = e; }
      }
      throw erro;
    },
  };
}

/* ------------------------------------------------------------------ Internet Archive (APIs documentadas: advancedsearch, metadata, download) */
const IA = 'https://archive.org';
/** Só aceita licença explícita de redistribuição (CC0, Domínio Público/PDM, CC BY, CC BY-SA) ou declaração textual de domínio público. Nunca "lending library". */
export function direitosIA(meta) {
  const m = meta?.metadata || {}; const col = [].concat(m.collection || []).map(String);
  if (col.some((c) => /^(inlibrary|printdisabled|lendinglibrary|browserlending)$/i.test(c)) || String(m['access-restricted-item']) === 'true') return { ok: false, motivo: 'item de empréstimo/acesso restrito no Internet Archive (não redistribuível)' };
  const lic = String(m.licenseurl || '');
  if (/creativecommons\.org\/publicdomain\/(zero|mark)\//i.test(lic)) return { ok: true, licenca: `Domínio público/CC0 — ${lic}` };
  if (/creativecommons\.org\/licenses\/by(-sa)?\//i.test(lic) && !/-(nc|nd)/i.test(lic)) return { ok: true, licenca: `Creative Commons — ${lic} (mantenha crédito e licença; sem alterar o arquivo)` };
  const rights = [].concat(m.rights || []).join(' ');
  if (/dom[ií]nio p[uú]blico|public domain/i.test(rights) && !/not (in )?the public domain|n[aã]o.*dom[ií]nio/i.test(rights)) return { ok: true, licenca: `Declaração do item: "${rights.slice(0, 160)}"` };
  return { ok: false, motivo: `sem licença de redistribuição explícita (licenseurl: ${lic || 'nenhuma'}; possible-copyright-status: ${m['possible-copyright-status'] || 'n/d'})` };
}
export function internetArchive() {
  return {
    id: 'internet-archive', nome: 'Internet Archive',
    async disponibilidade() {
      const t0 = Date.now(); const j = await http(`${IA}/advancedsearch.php?q=identifier:dracula&fl[]=identifier&rows=1&output=json`, { tipo: 'json', tent: 1, ms: 15000 });
      if (!j?.response) throw new Error('resposta inesperada');
      return { ms: Date.now() - t0, detalhe: 'advancedsearch respondeu' };
    },
    async buscar(item) {
      const parts = [`mediatype:texts`, `(language:por OR language:Portuguese)`, `format:EPUB`, `-collection:(inlibrary OR printdisabled)`];
      if (item.tit) parts.push(`title:(${tokens(item.tit).join(' AND ')})`);
      parts.push(`creator:(${String(item.aut).split('/').map((v) => `"${v}"`).join(' OR ')})`); // variantes de grafia: dostoievski/dostoyevsky/dostoiévski
      const u = `${IA}/advancedsearch.php?q=${encodeURIComponent(parts.join(' AND '))}&fl[]=identifier&fl[]=title&fl[]=creator&rows=8&sort[]=downloads+desc&output=json`;
      const j = await http(u, { tipo: 'json', tent: 2 });
      return (j?.response?.docs || []).map((d) => ({ id: d.identifier, titulo: [].concat(d.title || '').join(' '), autor: [].concat(d.creator || '').join(' ') })).filter((c) => c.id && casa(c, item.tit, item.aut));
    },
    async direitos(cand) {
      const meta = await http(`${IA}/metadata/${encodeURIComponent(cand.id)}`, { tipo: 'json', tent: 2 });
      const v = direitosIA(meta); if (!v.ok) return v;
      const epubs = (meta.files || []).filter((f) => /\.epub$/i.test(f.name || '') && /epub/i.test(f.format || 'epub')).sort((a, b) => Number(a.size || 0) - Number(b.size || 0));
      if (!epubs.length) return { ok: false, motivo: 'item sem arquivo EPUB (PDFs são ignorados)' };
      const arq = epubs.find((f) => Number(f.size || 0) > 20000 && Number(f.size || 0) <= MAX_BYTES); // o menor EPUB utilizável
      if (!arq) return { ok: false, motivo: `EPUB com ${mb(Number(epubs[epubs.length - 1].size || 0))} MB excede o limite de ${mb(MAX_BYTES)} MB (ou é pequeno demais para ser um livro)` };
      cand.arquivo = arq;
      const m = meta.metadata || {};
      return { ...v, titulo: [].concat(m.title || cand.titulo)[0], autor: [].concat(m.creator || cand.autor).join(', '), fonte: `${IA}/details/${cand.id}`, credito: `Internet Archive: ${cand.id}`, traducao_verificada: false /* licença declarada pelo uploader; tradução não verificada individualmente */ };
    },
    async baixar(cand) {
      const a = cand.arquivo; const url = `${IA}/download/${encodeURIComponent(cand.id)}/${a.name.split('/').map(encodeURIComponent).join('/')}`;
      const buf = await http(url, { tipo: 'buf', tent: 2, ms: 90000 });
      return { buf, url, md5: a.md5 };
    },
  };
}

/* ------------------------------------------------------------------ Projecto Adamastor (busca do WordPress do site + link de download na página da obra) */
export function adamastor(autores = {}) {
  const BASE = 'https://projectoadamastor.org';
  return {
    id: 'adamastor', nome: 'Projecto Adamastor',
    async disponibilidade() {
      const t0 = Date.now(); const r = await http(`${BASE}/`, { tent: 1, ms: 15000 });
      if (!/adamastor/i.test(r)) throw new Error('resposta inesperada');
      return { ms: Date.now() - t0, detalhe: 'site respondeu' };
    },
    async buscar(item) {
      if (item.idioma !== 'pt' || !item.tit) return []; // só procura obra específica em português
      const q = encodeURIComponent(`${item.tit} ${first(item.aut)}`);
      const html = await http(`${BASE}/?s=${q}`, { tent: 2 });
      const links = [...new Set([...html.matchAll(/href=["'](https:\/\/projectoadamastor\.org\/[a-z0-9-]+\/)["']/gi)].map((m) => m[1]))];
      return links.filter((u) => tokens(item.tit).every((w) => u.includes(w))).slice(0, 4).map((u) => ({ id: u.replace(BASE, '').replace(/\//g, ''), titulo: item.tit, autor: first(item.aut), pagina: u }));
    },
    async direitos(cand, item) {
      const a = autores[first(item.aut).split('/')[0]];
      if (!a?.pt) return { ok: false, motivo: 'autor não consta na tabela de autores de domínio público em português (sem comprovação)' };
      if (a.morte > ANO_LIMITE) return { ok: false, motivo: `autor morreu em ${a.morte}` };
      return { ok: true, licenca: `Domínio público (autor †${a.morte}); edição digital do Projecto Adamastor sob Creative Commons (variante não especificada pelo site) — mantenha o crédito e não altere o arquivo`, titulo: cand.titulo, autor: cand.autor, fonte: cand.pagina, credito: 'Edição digital: Projecto Adamastor', traducao_verificada: true };
    },
    async baixar(cand) {
      const pag = await http(cand.pagina, { tent: 2 });
      const link = [...pag.matchAll(/href=["'](https?:\/\/projectoadamastor\.org\/download\/[^"']+?wpdmdl=\d+)["']/gi)].map((m) => m[1].replace(/&#038;|&amp;/g, '&')).find((u) => !/mobi/i.test(u));
      if (!link) throw new Error('página da obra sem link de EPUB');
      return { buf: await http(link, { tipo: 'buf', tent: 2, ms: 90000 }), url: link };
    },
  };
}

/* ------------------------------------------------------------------ Wikisource em português (API MediaWiki + exportador oficial ws-export) */
export function wikisource() {
  const API = 'https://pt.wikisource.org/w/api.php', EXP = 'https://ws-export.wmcloud.org/';
  return {
    id: 'wikisource', nome: 'Wikisource (pt)',
    async disponibilidade() {
      const t0 = Date.now(); const j = await http(`${API}?action=query&meta=siteinfo&format=json`, { tipo: 'json', tent: 1, ms: 15000 });
      if (!j?.query?.general) throw new Error('resposta inesperada');
      return { ms: Date.now() - t0, detalhe: 'API respondeu' };
    },
    async buscar(item) {
      const q = encodeURIComponent(`${item.tit} ${first(item.aut)}`.trim());
      const j = await http(`${API}?action=query&list=search&srnamespace=0&srlimit=8&format=json&srsearch=${q}`, { tipo: 'json', tent: 2 });
      return (j?.query?.search || []).filter((r) => !r.title.includes('/')) // só a página-raiz do livro; o exportador inclui as subpáginas
        .map((r) => ({ id: r.title, titulo: r.title, autor: `${r.title} ${decode(String(r.snippet || '').replace(/<[^>]+>/g, ''))}` })).filter((c) => casa(c, item.tit, item.aut));
    },
    async direitos(cand, item) {
      return { ok: true, licenca: 'Wikisource em português: conteúdo livre (domínio público ou licença livre CC BY-SA). Atribuição: pt.wikisource.org e colaboradores. Edição/tradução específica não verificada individualmente.', titulo: cand.titulo, autor: first(item.aut), fonte: `https://pt.wikisource.org/wiki/${encodeURIComponent(cand.id.replace(/ /g, '_'))}`, credito: 'Wikisource (pt)', traducao_verificada: false };
    },
    async baixar(cand) {
      const url = `${EXP}?format=epub&lang=pt&page=${encodeURIComponent(cand.id)}`;
      const buf = await http(url, { tipo: 'buf', tent: 2, ms: 120000 });
      if (buf.length < 30000) throw new Error('exportação vazia ou muito pequena para ser um livro');
      return { buf, url };
    },
  };
}

export const FONTES = { gutenberg, 'internet-archive': internetArchive, wikisource, adamastor };
