// Importador de livros do Boto Azul (somente EPUB, somente obras com autorização de redistribuição comprovada).
// Fontes independentes com fallback: Project Gutenberg, Internet Archive, Projecto Adamastor. Retoma de onde parou (estado.json).
// Uso: LIMITE=100 LOTE=30 ORCAMENTO_MIN=40 node tools/importar-acervo.mjs      (veja docs no LEIA-ME-IMPORTACAO.md)
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { http, ErroRede, plain, slugOf, sha256, validarEpub, lerJson, gravarJson, MAX_BYTES, mb } from './importador/nucleo.mjs';
import { FONTES, parseRdf, checarDireitos, casa, ANO_LIMITE, direitosIA } from './importador/fontes.mjs';
import { inspectEpub } from './baixar-adamastor.mjs';
export { parseRdf, checarDireitos, casa, ANO_LIMITE, direitosIA, validarEpub };

export const CATS = { br: ['Brasileiros', 'brasileiros', 40], in: ['Internacionais', 'internacionais', 40], fi: ['Filosofia', 'filosofia', 10], te: ['Terror e suspense', 'terror-suspense', 10] };
// Coleção "literatura-internacional": clássicos estrangeiros em português, separados por nacionalidade (cota = a meta total por categoria; o teto é a meta geral).
export const CATS_LIT = { ru: ['Literatura Russa', 'literatura-russa', 100], fr: ['Literatura Francesa', 'literatura-francesa', 100], en: ['Literatura Inglesa', 'literatura-inglesa', 100], us: ['Literatura Norte-Americana', 'literatura-norte-americana', 100], de: ['Literatura Alemã', 'literatura-alema', 100], it: ['Literatura Italiana', 'literatura-italiana', 100], es: ['Literatura Espanhola', 'literatura-espanhola', 100], gr: ['Literatura Grega', 'literatura-grega', 100], un: ['Literatura Universal', 'literatura-universal', 100] };
const HORA = 3600 * 1000;
const proxima = (tent, agora) => new Date(agora + Math.min(6 * HORA * 2 ** Math.max(0, tent - 1), 48 * HORA)).toISOString();

function reduzirCapa(buf) {
  const r = spawnSync('convert', ['-', '-resize', '360x>', '-strip', '-quality', '72', 'jpg:-'], { input: buf, maxBuffer: 32 * 1024 * 1024 });
  return r.status === 0 && r.stdout?.length > 500 ? r.stdout : buf;
}

/** Executa um lote. `fontes`: objetos de fonte (injetáveis para teste). Retorna o resumo da execução. */
export async function executar({ dir, lista, fontes, cats = CATS, titulo = 'Acervo', totalMax = Infinity, limite = 100, lote = 30, orcamentoMin = 40, refazer = false, agora = () => Date.now(), outrosDirs = [], log = console.log }) {
  const inicio = agora(); const catPath = `${dir}/catalogo.json`, estPath = `${dir}/estado.json`;
  const cat = await lerJson(catPath, null); const livros = Array.isArray(cat?.livros) ? cat.livros : [];
  const est = await lerJson(estPath, null) || {}; est.versao = 2; est.itens ||= {}; est.rejeitados ||= {}; est.fontes ||= {}; est.execucoes ||= [];
  const ids = new Set(livros.flatMap((l) => l.ids || [])), hashes = new Set(livros.map((l) => l.sha256)), titulos = livros.map((l) => plain(l.titulo));
  const outros = []; for (const d of outrosDirs) { const c = await lerJson(`${d}/catalogo.json`, null); for (const b of c?.livros || []) { outros.push(plain(b.titulo)); if (b.sha256) hashes.add(b.sha256); } }
  const cota = Object.fromEntries(Object.entries(cats).map(([k, [, , q]]) => [k, Math.ceil((q * limite) / 100)]));
  const conta = (k) => livros.filter((l) => l.catKey === k).length;

  /* 0) nada a fazer? (evita execuções e commits desnecessários) */
  const pular = (k, chave) => { const s = est.itens[chave]; return livros.some((l) => l.chave === chave) || s?.status === 'concluido' || conta(k) >= cota[k] || livros.length >= totalMax || (!refazer && s?.status === 'bloqueado') || (!refazer && s?.status === 'erro' && (s.tentativas || 0) >= 3) || (!refazer && s?.proxima_tentativa && Date.parse(s.proxima_tentativa) > agora()); };
  { const v0 = {}; let trabalho = false; for (const [k, , tit, aut] of lista) { const b0 = `${k}|${tit}|${aut}`; v0[b0] = (v0[b0] || 0) + 1; if (!pular(k, `${b0}|${v0[b0]}`)) { trabalho = true; break; } }
    if (!trabalho) { log('Nada a fazer: meta atingida ou todos os itens concluídos/bloqueados/aguardando nova tentativa.'); return { novos: 0, tentados: 0, parou_por: 'nada a fazer', fontes: {}, sem_trabalho: true, total: livros.length, resumo: est.resumo || { concluidos: livros.length, pendentes: 0, erros: 0, bloqueados: 0 }, estado: est }; } }

  /* 1) disponibilidade de cada fonte (independentes: uma fora do ar não para as outras) */
  const ativas = [];
  for (const f of fontes) {
    const e = est.fontes[f.id] ||= { nome: f.nome }; e.verificado_em = new Date(agora()).toISOString(); f.falhas = 0;
    try { const r = await f.disponibilidade(); Object.assign(e, { disponivel: true, ms: r.ms, detalhe: r.detalhe, erro: null, ultimo_ok: e.verificado_em }); ativas.push(f); log(`fonte ${f.id}: DISPONÍVEL`); }
    catch (err) { Object.assign(e, { disponivel: false, erro: err.message, detalhe: 'indisponível nesta execução; será testada de novo na próxima' }); log(`fonte ${f.id}: INDISPONÍVEL (${err.message})`); }
  }

  /* 2) itens, em lotes, com retomada */
  const resumo = { novos: 0, tentados: 0, parou_por: 'fim da lista' }; const vezes = {};
  const marcar = (it, chave, base) => { est.itens[chave] = { ...(est.itens[chave] || {}), ...base, pedido: `${it.tit || 'obra de'} (${it.aut})`, categoria: cats[it.k][0], atualizado_em: new Date(agora()).toISOString() }; };
  const salvar = async () => {
    livros.sort((a, b) => a.categoria.localeCompare(b.categoria) || a.titulo.localeCompare(b.titulo, 'pt', { sensitivity: 'base' }));
    await gravarJson(catPath, { colecao: titulo, licenca: 'Cada livro registra fonte, licença e autorização de redistribuição. Somente obras com direitos comprovados (domínio público no Brasil: autor e tradutor falecidos até 1955; ou licença Creative Commons/CC0 explícita).', livros });
    est.atualizado_em = new Date(agora()).toISOString(); await gravarJson(estPath, est);
  };

  for (const it of lista) {
    const [k, idioma, tit, aut] = it; const item = { k, idioma, tit, aut };
    const base = `${k}|${tit}|${aut}`; vezes[base] = (vezes[base] || 0) + 1; const chave = `${base}|${vezes[base]}`;
    const s = est.itens[chave];
    if (pular(k, chave)) continue;
    if (resumo.tentados >= lote) { resumo.parou_por = `lote de ${lote} itens`; break; }
    if (agora() - inicio > orcamentoMin * 60000) { resumo.parou_por = `orçamento de tempo (${orcamentoMin} min)`; break; }
    resumo.tentados++;
    const tent = (s?.tentativas || 0) + 1; const motivos = []; let rede = false, achou = false, feito = false, errouBaixar = false;
    const usaveis = ativas.filter((f) => f.falhas < 3);
    if (!usaveis.length) { marcar(item, chave, { status: 'pendente', tentativas: s?.tentativas || 0, motivo: 'nenhuma fonte disponível agora; retomará automaticamente' }); continue; }
    for (const f of fontes) {
      if (!usaveis.includes(f) || f.falhas >= 3) { if (!ativas.includes(f) || f.falhas >= 3) rede = true; continue; }
      let cands;
      try { cands = await f.buscar(item); f.falhas = 0; }
      catch (e) { if (e instanceof ErroRede) { f.falhas++; rede = true; motivos.push(`${f.id}: ${e.message}`); if (f.falhas >= 3) { est.fontes[f.id].disponivel = false; est.fontes[f.id].erro = 'caiu durante a execução'; log(`fonte ${f.id}: caiu, usando as demais`); } } else motivos.push(`${f.id}: busca falhou (${e.message})`); continue; }
      if (!cands.length) { motivos.push(`${f.id}: não encontrado`); continue; }
      for (const c of cands.slice(0, 6)) {
        const gid = `${f.id}:${c.id}`; achou = true;
        if (ids.has(gid)) { motivos.push(`${gid}: já importado`); continue; }
        if (!refazer && est.rejeitados[gid]) { motivos.push(`${gid}: ${est.rejeitados[gid]} (decisão anterior)`); continue; } // não baixa nem consulta de novo
        const rejeitar = (m) => { est.rejeitados[gid] = m; motivos.push(`${gid}: ${m}`); };
        let v;
        try { v = await f.direitos(c, item); } catch (e) { if (e instanceof ErroRede) { rede = true; f.falhas++; } motivos.push(`${gid}: direitos não verificados (${e.message})`); continue; }
        if (!v.ok) { rejeitar(v.motivo); continue; }
        const tn = plain(v.titulo);
        if (tn.length > 5 && [...outros, ...titulos].some((o) => o && (tn.includes(o) || o.includes(tn)) && Math.min(o.length, tn.length) > 5)) { rejeitar(`já existe na biblioteca (${v.titulo})`); continue; }
        let dl;
        try { dl = await f.baixar(c); } catch (e) { if (e instanceof ErroRede) { rede = true; f.falhas++; } errouBaixar = true; motivos.push(`${gid}: download falhou (${e.message})`); continue; }
        if (dl.buf.length > MAX_BYTES) { rejeitar(`EPUB de ${mb(dl.buf.length)} MB excede o limite de ${mb(MAX_BYTES)} MB`); continue; }
        const slug = slugOf(`${v.titulo}-${f.id === 'gutenberg' ? c.id : f.id.slice(0, 3) + c.id}`); const pasta = `${dir}/${cats[k][1]}`; const arq = `${pasta}/${slug}.epub`;
        if (dl.md5 && createHash('md5').update(dl.buf).digest('hex') !== dl.md5) { errouBaixar = true; motivos.push(`${gid}: MD5 não confere (download incompleto)`); continue; }
        const hash = sha256(dl.buf);
        if (hashes.has(hash)) { rejeitar('arquivo idêntico já existe (hash)'); continue; }
        await mkdir(pasta, { recursive: true }); await writeFile(arq, dl.buf);
        let capa; try { validarEpub(arq, dl.buf); capa = inspectEpub(arq); } catch (e) { await unlink(arq).catch(() => {}); errouBaixar = true; motivos.push(`${gid}: EPUB inválido — ${e.message}`); continue; }
        const capaPath = capa ? `${dir}/capas/${slug}.jpg` : null; if (capa) { await mkdir(`${dir}/capas`, { recursive: true }); await writeFile(capaPath, reduzirCapa(capa)); }
        livros.push({ id: `acervo-${slug}`, chave, catKey: k, ids: [gid], titulo: v.titulo.replace(/\s+/g, ' '), autor: v.autor, categoria: cats[k][0], idioma, genero: cats[k][0], capa: capaPath, capa_ok: !!capa, epub: arq,
          fonte_id: f.id, fonte: v.fonte, origem_download: dl.url, credito: v.credito, licenca: v.licenca, autorizacao_redistribuicao: true, traducao_verificada: !!v.traducao_verificada,  baixado: true, tamanho: dl.buf.length, sha256: hash, importado_em: new Date(agora()).toISOString() });
        ids.add(gid); hashes.add(hash); titulos.push(tn); feito = true; resumo.novos++;
        marcar(item, chave, { status: 'concluido', fonte: f.id, tentativas: tent, motivo: null, proxima_tentativa: null });
        log(`OK [${f.id}] ${cats[k][0]}: ${v.titulo}`);
        break;
      }
      if (feito) break;
    }
    if (!feito) {
      if (rede && !errouBaixar) marcar(item, chave, { status: 'pendente', tentativas: tent, motivo: `fonte indisponível: ${motivos.join(' | ')}`.slice(0, 600), proxima_tentativa: proxima(tent, agora()) });
      else if (errouBaixar) marcar(item, chave, { status: 'erro', tentativas: tent, motivo: motivos.join(' | ').slice(0, 600), proxima_tentativa: proxima(tent, agora()) });
      else marcar(item, chave, { status: 'bloqueado', tentativas: tent, motivo: (achou ? 'direitos não comprovados ou duplicata: ' : '') + (motivos.join(' | ') || 'não encontrado em nenhuma fonte').slice(0, 600), proxima_tentativa: null });
      log(`PULADO ${base}: ${est.itens[chave].status}`);
    }
    await salvar(); // grava a cada item: se a execução cair, nada se perde
  }
  const todos = Object.values(est.itens);
  const exec = { inicio: new Date(inicio).toISOString(), fim: new Date(agora()).toISOString(), ...resumo, fontes: Object.fromEntries(fontes.map((f) => [f.id, est.fontes[f.id].disponivel])), total: livros.length };
  est.ultima_execucao = exec; est.execucoes = [exec, ...est.execucoes].slice(0, 15);
  est.resumo = { meta: limite, concluidos: livros.length, pendentes: todos.filter((x) => x.status === 'pendente').length, erros: todos.filter((x) => x.status === 'erro').length, bloqueados: todos.filter((x) => x.status === 'bloqueado').length, por_fonte: livros.reduce((a, l) => ((a[l.fonte_id] = (a[l.fonte_id] || 0) + 1), a), {}), por_categoria: Object.fromEntries(Object.entries(cats).map(([k, [n]]) => [n, `${conta(k)}/${cota[k]}`])) };
  await salvar();
  const lin = (l) => `| ${l.categoria} | ${l.titulo.replace(/\|/g, '/')} | ${l.autor.replace(/\|/g, '/')} | ${l.idioma} | ${l.fonte_id} | [fonte](${l.fonte}) | ${l.licenca.replace(/\|/g, '/')} | ${l.traducao_verificada ? 'sim' : 'NÃO — revisar'} |`;
  await writeFile(`${dir}/RELATORIO.md`, `# Relatório: ${titulo}\n\nÚltima execução: ${exec.fim} — parou por: ${exec.parou_por}\n\nConcluídos **${est.resumo.concluidos}** | pendentes ${est.resumo.pendentes} | com erro ${est.resumo.erros} | bloqueados (sem direitos/não encontrados) ${est.resumo.bloqueados}\n\nFontes: ${fontes.map((f) => `${f.nome}: ${est.fontes[f.id].disponivel ? 'disponível' : 'indisponível'}`).join(' · ')}\n\n| Categoria | Título | Autor | Idioma | Fonte | Link | Direitos | Tradução verificada |\n|---|---|---|---|---|---|---|---|\n${livros.map(lin).join('\n')}\n\n## Não incluídos / pendentes\n\n${Object.values(est.itens).filter((x) => x.status !== 'concluido').map((x) => `- **${x.pedido}** (${x.categoria}) — ${x.status}: ${x.motivo || ''}`).join('\n') || 'Nenhum.'}\n`);
  return { ...exec, resumo: est.resumo, estado: est };
}

export async function main() {
  const COL = process.env.COLECAO === 'literatura-internacional' ? 'literatura-internacional' : 'acervo';
  const lit = COL === 'literatura-internacional';
  const DIR = process.env.ACERVO_DIR || `public/books/${COL}`;
  const lista = JSON.parse(await readFile(process.env.ACERVO_LISTA || (lit ? 'tools/literatura-internacional.json' : 'tools/acervo-lista.json'), 'utf8')).itens;
  const autores = await lerJson(process.env.AUTORES || 'tools/autores-dominio-publico.json', {});
  const ordem = (process.env.FONTES || 'gutenberg,internet-archive,wikisource,adamastor').split(',').map((x) => x.trim()).filter((x) => FONTES[x]);
  const fontes = ordem.map((id) => (id === 'adamastor' ? FONTES[id](autores) : FONTES[id]()));
  const r = await executar({ dir: DIR, lista, fontes, cats: lit ? CATS_LIT : CATS, titulo: lit ? 'Literatura internacional' : 'Acervo', totalMax: lit ? Math.max(1, Number(process.env.LIMITE) || 50) : Infinity, limite: lit ? Math.max(1, Number(process.env.LIMITE) || 50) : Math.max(1, Math.min(100, Number(process.env.LIMITE) || 100)), lote: Number(process.env.LOTE) || 30, orcamentoMin: Number(process.env.ORCAMENTO_MIN) || 40, refazer: process.env.REFAZER === '1', outrosDirs: ['adamastor', 'estante', 'acervo', 'literatura-internacional'].filter((d) => d !== COL).map((d) => `${path.dirname(DIR)}/${d}`) });
  if (r.sem_trabalho) return;
  console.log(`${lit ? 'Literatura internacional' : 'Acervo'}: ${r.resumo.concluidos} livro(s); +${r.novos} nesta execução; pendentes ${r.resumo.pendentes}, erros ${r.resumo.erros}, bloqueados ${r.resumo.bloqueados}. Parou por: ${r.parou_por}.`);
  if (!Object.values(r.fontes).some(Boolean)) console.log('::warning::Nenhuma fonte respondeu nesta execução. Os itens ficam pendentes e serão retomados automaticamente.');
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
