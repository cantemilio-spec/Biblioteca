// Tela de estatísticas e metas. Dados reais vindos da loja "sessions" (tempo de leitura ativo) e dos livros.
import { h, icon, toast, bimg } from './ui.js';
import * as db from './db.js';
import { getSetting, setSetting } from './settings.js';
import { DEFAULT_GOALS, byDay, byBook, streaks, lastDays, sumMonth, booksFinishedIn, fmtDuration, loadSessions, dayKey, monthKey, parseDay } from './stats.js';

const SVG = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  kids.forEach((c) => el.append(c));
  return el;
};
const fmtDay = (k) => parseDay(k).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });

/** Anel de progresso da meta diária. */
function ring(frac, label, sub) {
  const R = 52, C = 2 * Math.PI * R, f = Math.min(1, Math.max(0, frac));
  const svg = s('svg', { viewBox: '0 0 130 130', class: 'ring', role: 'img', 'aria-label': `${label}. ${sub}` },
    s('circle', { cx: 65, cy: 65, r: R, class: 'ring-bg' }),
    f > 0 ? s('circle', { cx: 65, cy: 65, r: R, class: 'ring-fg', 'stroke-dasharray': `${C * f} ${C}`, transform: 'rotate(-90 65 65)' }) : s('g'),
    s('text', { x: 65, y: 63, 'text-anchor': 'middle', class: 'ring-t' }, label),
    s('text', { x: 65, y: 82, 'text-anchor': 'middle', class: 'ring-s' }, sub));
  return svg;
}

/** Gráfico de barras dos últimos dias, com linha da meta. */
function barChart(days, goalSec) {
  const W = 640, H = 200, pl = 34, pb = 24, pt = 10, n = days.length;
  const max = Math.max(goalSec, ...days.map((d) => d.seconds), 60);
  const niceMin = Math.ceil(max / 60 / 10) * 10, top = niceMin * 60; // eixo em minutos, arredondado
  const bw = (W - pl) / n, y = (sec) => pt + (H - pt - pb) * (1 - sec / top);
  const g = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'bars', role: 'img', 'aria-label': `Minutos lidos nos últimos ${n} dias` });
  for (const t of [0, 0.5, 1]) {
    const v = top * t;
    g.append(s('line', { x1: pl, x2: W, y1: y(v), y2: y(v), class: 'grid' }), s('text', { x: pl - 6, y: y(v) + 4, 'text-anchor': 'end', class: 'axis' }, `${Math.round(v / 60)}`));
  }
  days.forEach((d, i) => {
    const x = pl + i * bw, bh = Math.max(d.seconds ? 2 : 0, (H - pt - pb) * (d.seconds / top));
    g.append(s('rect', { x: x + bw * 0.18, y: H - pb - bh, width: bw * 0.64, height: bh, rx: 3, class: `bar${d.seconds >= goalSec ? ' hit' : ''}` }, s('title', {}, `${fmtDay(d.day)}: ${fmtDuration(d.seconds)}`)));
    if (n <= 14 || i % 5 === n % 5 || i === n - 1) g.append(s('text', { x: x + bw / 2, y: H - 6, 'text-anchor': i === n - 1 ? 'end' : 'middle', class: 'axis' }, fmtDay(d.day).replace('.', '')));
  });
  g.append(s('line', { x1: pl, x2: W, y1: y(goalSec), y2: y(goalSec), class: 'goal' }));
  return g;
}

export async function mountStats(root) {
  const [sessions, books] = await Promise.all([loadSessions(), db.getAll('books')]);
  const goals = { ...DEFAULT_GOALS, ...(getSetting('goals') || {}) };
  const days = byDay(sessions), today = dayKey(), mk = monthKey();
  const todaySec = days.get(today) || 0, total = [...days.values()].reduce((a, b) => a + b, 0);
  const st = streaks(days, today), monthSec = sumMonth(days, mk);
  const finishedMonth = booksFinishedIn(books, mk), finishedAll = books.filter((b) => b.finishedAt).length;
  const goalSec = goals.dailyMin * 60;
  const titles = new Map(books.map((b) => [b.id, b]));

  let range = 30;
  const chartBox = h('div', { class: 'chart-box' });
  const drawChart = () => chartBox.replaceChildren(barChart(lastDays(days, range, today), goalSec));
  const rangeSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Período do gráfico' }, [[7, '7 dias'], [30, '30 dias']].map(([v, l]) => h('button', {
    type: 'button', class: v === range ? 'on' : '', 'aria-pressed': String(v === range),
    onclick: () => { range = v; rangeSeg.querySelectorAll('button').forEach((b, i) => { const on = [7, 30][i] === v; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }); drawChart(); },
  }, l)));
  drawChart();

  const goalInput = (label, key, min, max, unit) => {
    const input = h('input', { type: 'number', min, max, step: 1, value: goals[key], 'aria-label': label });
    input.addEventListener('change', async () => {
      const v = Math.min(max, Math.max(min, Math.round(Number(input.value) || DEFAULT_GOALS[key])));
      input.value = v; goals[key] = v;
      try { await setSetting('goals', { ...goals }); toast('Meta atualizada.'); mountStats(root); } catch { toast('Não foi possível salvar a meta.', 'error'); }
    });
    return h('label', { class: 'field inline' }, h('span', {}, `${label} (${unit})`), input);
  };

  const card = (value, label) => h('div', { class: 'stat' }, h('strong', {}, value), h('span', {}, label));
  const rank = [...byBook(sessions)].filter(([id]) => titles.has(id)).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const topSec = rank[0]?.[1] || 1;
  const monthBar = (v, goal) => h('div', { class: 'meter', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': goal, 'aria-valuenow': Math.min(v, goal) }, h('i', { style: `width:${Math.min(100, (v / goal) * 100)}%` }));

  root.replaceChildren(
    h('div', { class: 'view-head head-brand' }, bimg(), h('div', {}, h('h1', {}, 'Estatísticas'), h('p', { class: 'hint' }, 'O tempo conta só enquanto você lê com o app aberto e ativo. Tudo fica apenas neste dispositivo.'))),
    h('section', { class: 'panel' }, h('h2', {}, 'Metas'),
      h('div', { class: 'goals' },
        ring(todaySec / goalSec, `${Math.floor(todaySec / 60)} min`, `meta ${goals.dailyMin} min`),
        h('div', { class: 'goal-side' },
          h('p', {}, todaySec >= goalSec ? 'Meta de hoje cumprida. 🎉' : `Faltam ${Math.ceil((goalSec - todaySec) / 60)} min para a meta de hoje.`),
          h('p', { class: 'hint' }, `Livros concluídos em ${new Date().toLocaleDateString('pt-BR', { month: 'long' })}: ${finishedMonth} de ${goals.monthlyBooks}`),
          monthBar(finishedMonth, goals.monthlyBooks))),
      goalInput('Meta diária', 'dailyMin', 1, 600, 'minutos'),
      goalInput('Meta mensal', 'monthlyBooks', 1, 100, 'livros')),
    h('section', { class: 'stat-grid' },
      card(`${st.current} ${st.current === 1 ? 'dia' : 'dias'}`, 'Sequência atual'),
      card(`${st.best} ${st.best === 1 ? 'dia' : 'dias'}`, 'Melhor sequência'),
      card(fmtDuration(monthSec), 'Lido neste mês'),
      card(fmtDuration(total), 'Tempo total'),
      card(String(finishedAll), 'Livros concluídos'),
      card(days.size ? fmtDuration(total / days.size) : '0 min', 'Média por dia de leitura')),
    h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, 'Minutos por dia'), rangeSeg), chartBox,
      h('p', { class: 'hint' }, 'A linha tracejada marca a meta diária; barras mais escuras atingiram a meta.')),
    h('section', { class: 'panel' }, h('h2', {}, 'Tempo por livro'),
      rank.length ? h('ol', { class: 'rank' }, rank.map(([id, sec]) => h('li', {}, h('span', { class: 'rk-t' }, titles.get(id).title), h('span', { class: 'rk-v' }, fmtDuration(sec)), h('div', { class: 'meter' }, h('i', { style: `width:${(sec / topSec) * 100}%` }))))) :
        h('div', { class: 'empty small' }, icon('chart', 36), h('p', {}, 'Ainda não há leituras registradas. Abra um livro e leia por alguns segundos para começar.'))),
  );
}
