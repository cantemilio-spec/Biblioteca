// Seletor manual: pesquisa nas duas fontes, mostra as edições encontradas e deixa escolher capa e/ou dados.
import { h, icon, toast, modal } from './ui.js';
import { searchBooks, fetchCover, fieldsFrom, MetadataUnavailable, SOURCE_LABEL } from './metadata.js';

/** onData(campos) preenche o formulário; onCover(blob, fonte) grava a capa. */
export function openMetadataPicker({ book, onData, onCover }) {
  const inp = (label, value, extra = {}) => h('label', { class: 'field' }, h('span', {}, label), h('input', { value, maxlength: 300, ...extra }));
  const fTitle = inp('Título', book.title), fAuthor = inp('Autor', book.author), fIsbn = inp('ISBN', book.isbn, { inputmode: 'numeric' });
  const val = (el) => el.querySelector('input').value.trim();
  const status = h('p', { class: 'hint', role: 'status' });
  const list = h('div', { class: 'cands', role: 'list' });
  let runId = 0;

  const candidate = (c) => {
    const coverBtn = h('button', { class: 'btn', type: 'button', disabled: !c.coverUrl }, icon('image', 16), c.coverUrl ? 'Usar capa' : 'Sem capa');
    coverBtn.addEventListener('click', async () => {
      coverBtn.disabled = true; coverBtn.lastChild.textContent = 'Baixando…';
      try { await onCover(await fetchCover(c.coverUrl), c.source); toast('Capa atualizada.'); coverBtn.lastChild.textContent = 'Capa aplicada'; return; }
      catch (e) { toast(`Não foi possível usar esta capa: ${e.message || 'erro desconhecido'}`, 'error'); }
      coverBtn.disabled = false; coverBtn.lastChild.textContent = 'Usar capa';
    });
    const dataBtn = h('button', { class: 'btn', type: 'button', onclick: () => { onData(fieldsFrom(c)); toast('Dados copiados para o formulário. Clique em Salvar para confirmar.'); } }, icon('check', 16), 'Usar dados');
    const thumb = c.coverUrl
      ? h('img', { class: 'cand-cover', src: c.coverUrl, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
      : h('div', { class: 'cand-cover empty' }, icon('book', 20));
    return h('div', { class: 'cand', role: 'listitem' }, thumb,
      h('div', { class: 'cand-info' },
        h('strong', {}, c.title),
        h('span', {}, c.authors.join(', ') || 'Autor desconhecido'),
        h('span', { class: 'hint' }, [c.publisher, c.year, c.isbns[0] && `ISBN ${c.isbns[0]}`, SOURCE_LABEL[c.source]].filter(Boolean).join(' · ')),
        h('div', { class: 'cand-actions' }, coverBtn, dataBtn)));
  };

  async function run() {
    const id = ++runId;
    list.replaceChildren(); status.textContent = 'Buscando…';
    try {
      const { candidates, partial } = await searchBooks({ title: val(fTitle), author: val(fAuthor), isbn: val(fIsbn) });
      if (id !== runId) return;
      if (!candidates.length) { status.textContent = 'Nenhuma edição encontrada. Ajuste o título, o autor ou o ISBN, ou envie uma capa do seu dispositivo.'; return; }
      status.textContent = `${candidates.length} resultado(s)${partial ? '. Uma das fontes não respondeu.' : '.'}`;
      list.append(...candidates.map(candidate));
    } catch (e) {
      if (id !== runId) return;
      status.textContent = e instanceof MetadataUnavailable
        ? 'Não foi possível consultar o Google Livros nem o Open Library agora. Verifique a conexão e tente de novo. Você ainda pode enviar uma capa do seu dispositivo.'
        : 'Erro inesperado na busca.';
    }
  }

  const form = h('form', { class: 'cand-search', onsubmit: (e) => { e.preventDefault(); run(); } },
    fTitle, fAuthor, fIsbn, h('button', { class: 'btn primary', type: 'submit' }, icon('search', 18), 'Buscar'));
  modal({
    title: 'Buscar informações online', wide: true,
    body: h('div', { class: 'cand-wrap' }, form,
      h('p', { class: 'hint' }, 'A busca envia o título, o autor ou o ISBN ao Google Livros e ao Open Library. Nada além disso sai do seu dispositivo.'),
      status, list),
    actions: [{ label: 'Fechar' }],
  });
  run();
}
