// Importa o Acervo inicial (domínio público) do Project Gutenberg para public/books/acervo/.
// Para cada item de tools/acervo-lista.json: acha a obra, VERIFICA OS DIREITOS no cadastro oficial (RDF do Gutenberg), baixa o EPUB,
// valida, reduz a capa, grava catalogo.json e RELATORIO.md. Se os direitos não forem comprovados, a obra NÃO é incluída.
// Uso: LIMITE=10 node tools/importar-acervo.mjs   (LIMITE = total desejado, de 1 a 100; padrão 100). Node 18+, `unzip`, ImageMagick (opcional).
import { readFile, writeFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { inspectEpub, unzipP, attr } from './baixar-adamastor.mjs';

export const ANO_LIMITE = 1955; // Brasil: vida + 70 anos. Em 2026, obras de quem morreu até 1955 estão em domínio público.
export const CATS = { br: ['Brasileiros', 'brasileiros', 40], in: ['Internacionais', 'internacionais', 40], fi: ['Filosofia', 'filosofia', 10], te: ['Terror e suspense', 'terror-suspense', 10] };
const UA = 'BotoAzul-acervo/1.0 (+https://github.com/cantemilio-spec/Biblioteca)';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export const plain = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const decode = (s) => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();
export const slugOf = (s) => plain(s).replace(/ /g, '-').slice(0, 70) || 'livro';
export const nomeNormal = (n) => { const m = String(n).match(/^([^,]+),\s*(.+)$/); return m ? `${m[2].replace(/\s*\(.*?\)\s*/g, ' ').trim()} ${m[1]}`.trim() : String(n); };

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

const tokens = (t) => plain(t).split(' ').filter(Boolean);
export const casa = (cand, tit, aut) => { const h = plain(cand.titulo); const ha = plain(cand.autor || ''); return tokens(tit).every((w) => h.split(' ').includes(w)) && (!ha || String(aut).split('/').some((x) => ha.includes(plain(x)))); };

async function get(url, tipo = 'text', tent = 3) {
  for (let i = 1; i <= tent; i++) {
    try {
      const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(90000), headers: { 'user-agent': UA } });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.final = true; throw e; }
      return tipo === 'json' ? await r.json() : tipo === 'buf' ? Buffer.from(await r.arrayBuffer()) : await r.text();
    } catch (e) { if (e.final || i === tent) throw e; await pause(3000 * i); }
  }
}

/** Candidatos (ids do Gutenberg) para um item: Gutendex primeiro, busca OPDS do próprio Gutenberg como reserva. */
async function candidatos(tit, aut, idioma) {
  const q = encodeURIComponent(`${tit} ${String(aut).split('/')[0]}`);
  try {
    const j = await get(`https://gutendex.com/books/?search=${q}&languages=${idioma}&copyright=false`, 'json');
    const l = (j.results || []).map((b) => ({ id: b.id, titulo: b.title, autor: (b.authors || []).map((a) => a.name).join(' ') })).filter((c) => casa(c, tit, aut));
    if (l.length) return l;
  } catch { /* tenta a reserva */ }
  try {
    const x = await get(`https://www.gutenberg.org/ebooks/search.opds/?query=${q}`);
    return [...x.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => ({ id: Number(m[1].match(/ebooks\/(\d+)/)?.[1]), titulo: decode(m[1].match(/<title>([^<]*)/)?.[1] || ''), autor: decode(m[1].match(/<content[^>]*>([^<]*)/)?.[1] || '') })).filter((c) => c.id && casa(c, tit, aut));
  } catch { return []; }
}

async function baixarEpub(id) {
  for (const u of [`https://www.gutenberg.org/cache/epub/${id}/pg${id}-images.epub`, `https://www.gutenberg.org/ebooks/${id}.epub3.images`, `https://www.gutenberg.org/ebooks/${id}.epub.noimages`]) {
    try { const b = await get(u, 'buf'); if (b[0] === 0x50 && b[1] === 0x4b) return { buf: b, url: u }; } catch { /* próxima URL */ }
    await pause(1000);
  }
  throw new Error('não foi possível baixar o EPUB');
}

function reduzirCapa(buf) {
  const r = spawnSync('convert', ['-', '-resize', '360x>', '-strip', '-quality', '72', 'jpg:-'], { input: buf, maxBuffer: 32 * 1024 * 1024 });
  return r.status === 0 && r.stdout?.length > 500 ? r.stdout : buf;
}

export async function main() {
  const DIR = process.env.ACERVO_DIR || 'public/books/acervo', LIMITE = Math.max(1, Math.min(100, Number(process.env.LIMITE) || 100));
  const lista = JSON.parse(await readFile(process.env.ACERVO_LISTA || 'tools/acervo-lista.json', 'utf8')).itens;
  const catPath = `${DIR}/catalogo.json`;
  let doc; try { doc = JSON.parse(await readFile(catPath, 'utf8')); } catch { doc = null; }
  const livros = Array.isArray(doc?.livros) ? doc.livros : [];
  const falhas = Array.isArray(doc?.falhas) ? doc.falhas.filter((f) => !livros.some((l) => l.chave === f.chave)) : [];
  const outros = []; // títulos de outras coleções do app, para não duplicar
  for (const d of ['adamastor', 'estante']) { try { outros.push(...JSON.parse(await readFile(`${path.dirname(DIR)}/${d}/catalogo.json`, 'utf8')).livros.map((b) => plain(b.titulo))); } catch { /* sem catálogo */ } }
  const cota = Object.fromEntries(Object.entries(CATS).map(([k, [, , q]]) => [k, Math.ceil((q * LIMITE) / 100)]));
  const conta = (k) => livros.filter((l) => l.catKey === k).length;
  const usados = new Set(livros.map((l) => l.pg_id));
  await mkdir(`${DIR}/capas`, { recursive: true });

  const vezes = {};
  for (const [k, idioma, tit, aut] of lista) {
    const base = `${k}|${tit}|${aut}`; vezes[base] = (vezes[base] || 0) + 1;
    const chave = `${base}|${vezes[base]}`; // itens repetidos ("qualquer obra deste autor") pegam obras diferentes
    if (conta(k) >= cota[k] || livros.some((l) => l.chave === chave)) continue;
    const [catLabel, catDir] = CATS[k];
    const falha = (motivo) => { const i = falhas.findIndex((f) => f.chave === chave); const f = { chave, pedido: `${tit || 'obra de'} (${aut})`, categoria: catLabel, motivo }; i < 0 ? falhas.push(f) : (falhas[i] = f); console.log('PULADO', chave, '-', motivo); };
    try {
      const cands = await candidatos(tit, aut, idioma); await pause(1200);
      if (!cands.length) { falha('não encontrado no Project Gutenberg'); continue; }
      let escolhido = null; const motivos = [];
      for (const c of cands.slice(0, 6)) {
        if (usados.has(c.id)) { motivos.push(`#${c.id} já incluído`); continue; }
        let info; try { info = parseRdf(await get(`https://www.gutenberg.org/cache/epub/${c.id}/pg${c.id}.rdf`)); } catch (e) { motivos.push(`#${c.id}: cadastro indisponível (${e.message})`); continue; } finally { await pause(1200); }
        const dup = outros.find((o) => o && (plain(info.titulo).includes(o) || o.includes(plain(info.titulo))) && Math.min(o.length, plain(info.titulo).length) > 5);
        if (dup) { motivos.push(`#${c.id}: já existe na biblioteca ("${dup}")`); continue; }
        const v = checarDireitos(info, idioma);
        if (!v.ok) { motivos.push(`#${c.id} ${info.titulo.slice(0, 40)}: ${v.motivo}`); continue; }
        escolhido = { c, info, v }; break;
      }
      if (!escolhido) { falha(motivos.join(' | ') || 'sem candidato válido'); continue; }
      const { c, info, v } = escolhido;
      const { buf, url } = await baixarEpub(c.id);
      if (buf.length > 25 * 1024 * 1024) { falha(`#${c.id}: arquivo maior que 25 MB`); continue; }
      const slug = slugOf(`${info.titulo.split(/[;:]/)[0]}-${c.id}`), pasta = `${DIR}/${catDir}`;
      await mkdir(pasta, { recursive: true });
      const tmp = `${pasta}/${slug}.epub`; await writeFile(tmp, buf);
      let capa = null;
      try { capa = inspectEpub(tmp); } catch (e) { await unlink(tmp).catch(() => {}); falha(`#${c.id}: EPUB inválido (${e.message})`); continue; }
      const capaPath = capa ? `${DIR}/capas/${slug}.jpg` : null; if (capa) await writeFile(capaPath, reduzirCapa(capa));
      const autores = info.agentes.filter((a) => a.papel === 'creator');
      livros.push({ id: `acervo-${slug}`, chave, catKey: k, pg_id: c.id, titulo: info.titulo.replace(/\s*\n\s*/g, ' ').split(/\s*;\s*/)[0], autor: autores.map((a) => nomeNormal(a.nome)).join(', '), categoria: catLabel, idioma, genero: catLabel,
        capa: capaPath, capa_ok: !!capa, epub: tmp, fonte: `https://www.gutenberg.org/ebooks/${c.id}`, origem_download: url, credito: `Project Gutenberg #${c.id}`, licenca: v.licenca, avisos: v.avisos, baixado: true, tamanho: buf.length, sha256: createHash('sha256').update(buf).digest('hex') });
      usados.add(c.id); console.log('OK', conta(k), catLabel, '-', info.titulo.slice(0, 50));
      await salvar(); // grava a cada livro: se a execução cair, nada se perde
    } catch (e) { falha(e.message || String(e)); }
    await pause(1500);
  }
  async function salvar() {
    livros.sort((a, b) => a.categoria.localeCompare(b.categoria) || a.titulo.localeCompare(b.titulo, 'pt', { sensitivity: 'base' }));
    await writeFile(catPath, JSON.stringify({ colecao: 'Acervo', licenca: 'Obras em domínio público (verificadas no cadastro do Project Gutenberg: autor e tradutor falecidos até 1955, regra de vida + 70 anos do Brasil). Arquivos do Project Gutenberg, sem alteração.', livros, falhas }, null, 2) + '\n');
    const lin = (l) => `| ${l.categoria} | ${l.titulo.replace(/\|/g, '/')} | ${l.autor.replace(/\|/g, '/')} | ${l.idioma} | [#${l.pg_id}](${l.fonte}) | ${l.licenca.replace(/\|/g, '/')} |`;
    await writeFile(`${DIR}/RELATORIO.md`, `# Relatório do Acervo\n\nIncluídos: **${livros.length}** (${Object.entries(CATS).map(([k, [n]]) => `${n}: ${conta(k)}`).join(', ')})\n\n| Categoria | Título | Autor | Idioma | Fonte | Direitos |\n|---|---|---|---|---|---|\n${livros.map(lin).join('\n')}\n\n## Não incluídos (e por quê)\n\n${falhas.length ? falhas.map((f) => `- **${f.pedido}** (${f.categoria}): ${f.motivo}`).join('\n') : 'Nenhum.'}\n`);
  }
  await salvar();
  console.log(`Acervo: ${livros.length} livro(s); ${falhas.length} pulado(s).`);
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
