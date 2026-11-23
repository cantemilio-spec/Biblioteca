// Painel de acompanhamento da importação de livros (somente leitura): lê public/books/acervo/estado.json, gravado pelo workflow.
import { h, icon, bimg } from './ui.js';

const STATUS = { concluido: ['Importado', 'ok'], pendente: ['Pendente', 'pend'], erro: ['Com erro', 'err'], bloqueado: ['Bloqueado', 'blk'] };
const quando = (iso) => { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }); };

export async function mountPainel(root) {
  root.replaceChildren(h('div', { class: 'view-head head-brand' }, bimg(), h('div', {}, h('h1', {}, 'Importação de livros'), h('p', { class: 'hint' }, 'Acompanhe o que o importador já trouxe, o que está pendente e como estão as fontes.'))), h('p', { class: 'hint', role: 'status' }, 'Carregando…'));
  let est, lit = null;
  try {
    const r = await fetch('public/books/acervo/estado.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(String(r.status));
    est = await r.json();
  } catch {
    root.lastChild.replaceWith(h('div', { class: 'empty small' }, icon('book', 40), h('h2', {}, 'Nenhuma importação registrada'), h('p', {}, 'No GitHub, abra Actions e rode o workflow “Importar livros”. Quando terminar, o andamento aparece aqui.'), h('button', { class: 'btn', type: 'button', onclick: () => mountPainel(root) }, 'Atualizar')));
    return;
  }
  try { const r2 = await fetch('public/books/literatura-internacional/estado.json', { cache: 'no-cache' }); if (r2.ok) lit = await r2.json(); } catch { /* coleção ainda não importada */ }
  const rs = est.resumo || {}, itens = [...Object.values(est.itens || {}), ...Object.values(lit?.itens || {})], meta = rs.meta || 0, feitos = rs.concluidos ?? itens.filter((x) => x.status === 'concluido').length;
  const pct = meta ? Math.min(100, Math.round((feitos / meta) * 100)) : 0;
  const card = (n, l, cls) => h('div', { class: `imp-card ${cls || ''}` }, h('strong', {}, String(n)), h('span', {}, l));
  const ex = est.ultima_execucao;
  const fontes = Object.entries(est.fontes || {}).map(([id, f]) => h('li', { class: 'imp-src' },
    h('span', { class: `imp-dot ${f.disponivel ? 'ok' : 'off'}`, role: 'img', 'aria-label': f.disponivel ? 'disponível' : 'indisponível' }),
    h('div', {}, h('div', { class: 'imp-name' }, f.nome || id, ' — ', f.disponivel ? 'disponível' : 'indisponível', rs.por_fonte?.[id] ? ` · ${rs.por_fonte[id]} livro(s)` : ''),
      h('div', { class: 'hint' }, f.disponivel ? `${f.detalhe || ''}${f.ms ? ` (${f.ms} ms)` : ''}` : (f.erro || 'sem resposta'), ` · verificado ${quando(f.verificado_em)}${f.ultimo_ok ? ` · último acesso OK ${quando(f.ultimo_ok)}` : ''}`))));
  let filtro = '';
  const lista = h('ul', { class: 'imp-list' });
  const draw = () => lista.replaceChildren(...itens.filter((x) => !filtro || x.status === filtro).sort((a, b) => String(a.categoria).localeCompare(b.categoria) || String(a.pedido).localeCompare(b.pedido)).map((x) => {
    const [lb, cls] = STATUS[x.status] || [x.status, '']; return h('li', { class: 'imp-item' }, h('div', { class: 'imp-row' }, h('span', { class: 'imp-title' }, x.pedido), h('span', { class: `imp-tag ${cls}` }, lb)),
      h('div', { class: 'hint' }, `${x.categoria}${x.fonte ? ` · ${x.fonte}` : ''}${x.tentativas ? ` · ${x.tentativas} tentativa(s)` : ''}`), x.motivo ? h('div', { class: 'imp-why' }, x.motivo) : null);
  }));
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Filtrar itens' }, [['', 'Todos'], ['concluido', 'Importados'], ['pendente', 'Pendentes'], ['erro', 'Com erro'], ['bloqueado', 'Bloqueados']].map(([v, l]) => h('button', { type: 'button', class: `chip${v === filtro ? ' on' : ''}`, 'aria-pressed': String(v === filtro), onclick: (e) => { filtro = v; chips.querySelectorAll('.chip').forEach((c) => { const on = c === e.currentTarget; c.classList.toggle('on', on); c.setAttribute('aria-pressed', String(on)); }); draw(); } }, l)));
  draw();
  root.lastChild.replaceWith(
    h('section', { class: 'panel' }, h('h2', {}, 'Progresso'), h('div', { class: 'progress imp-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct, 'aria-label': 'Progresso da importação' }, h('span', { style: `width:${pct}%` })),
      h('p', {}, `${feitos} de ${meta || '?'} livros (${pct}%)`),
      h('div', { class: 'imp-cards' }, card(feitos, 'Importados', 'ok'), card(rs.pendentes ?? 0, 'Pendentes', 'pend'), card(rs.erros ?? 0, 'Com erro', 'err'), card(rs.bloqueados ?? 0, 'Bloqueados', 'blk')),
      rs.por_categoria ? h('p', { class: 'hint' }, Object.entries(rs.por_categoria).map(([c, v]) => `${c}: ${v}`).join(' · ')) : null),
    lit ? h('section', { class: 'panel' }, h('h2', {}, 'Literatura internacional'), h('div', { class: 'progress imp-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': lit.resumo?.meta ? Math.min(100, Math.round((lit.resumo.concluidos / lit.resumo.meta) * 100)) : 0, 'aria-label': 'Progresso da literatura internacional' }, h('span', { style: `width:${lit.resumo?.meta ? Math.min(100, Math.round((lit.resumo.concluidos / lit.resumo.meta) * 100)) : 0}%` })),
      h('p', {}, `${lit.resumo?.concluidos ?? 0} de ${lit.resumo?.meta ?? '?'} livros · pendentes ${lit.resumo?.pendentes ?? 0} · erros ${lit.resumo?.erros ?? 0} · bloqueados ${lit.resumo?.bloqueados ?? 0}`), lit.resumo?.por_categoria ? h('p', { class: 'hint' }, Object.entries(lit.resumo.por_categoria).filter(([, v]) => !String(v).startsWith('0/')).map(([c, v]) => `${c}: ${v.split('/')[0]}`).join(' · ') || 'Nenhum livro ainda.') : null) : null,
    h('section', { class: 'panel' }, h('h2', {}, 'Fontes'), h('ul', { class: 'imp-srcs' }, fontes.length ? fontes : h('li', { class: 'hint' }, 'Sem dados de fontes ainda.'))),
    h('section', { class: 'panel' }, h('h2', {}, 'Última execução'), ex ? h('p', {}, `${quando(ex.inicio)} → ${quando(ex.fim)} · ${ex.novos} novo(s) · analisados ${ex.tentados} · parou por: ${ex.parou_por}`) : h('p', { class: 'hint' }, 'Sem registro.'), h('p', { class: 'hint' }, `Estado gravado em ${quando(est.atualizado_em)}.`)),
    h('section', { class: 'panel' }, h('h2', {}, 'Itens'), chips, lista),
    h('button', { class: 'btn', type: 'button', onclick: () => mountPainel(root) }, 'Atualizar'));
}
