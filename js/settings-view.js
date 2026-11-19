import { h, toast } from './ui.js';
import * as db from './db.js';
import { getSetting, setSetting, applyTheme } from './settings.js';
import { formatBytes } from './books.js';

export async function mountSettings(root) {
  const themeOpts = [['auto', 'Automático'], ['light', 'Claro'], ['dark', 'Escuro']];
  const info = await db.storageInfo();
  const count = (await db.getAll('books')).length;

  const themeGroup = h('div', { class: 'seg wide', role: 'radiogroup', 'aria-label': 'Tema' },
    themeOpts.map(([v, l]) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(getSetting('theme') === v), class: getSetting('theme') === v ? 'on' : '',
      onclick: async (e) => {
        const btn = e.currentTarget; // capturar antes do await (currentTarget vira null depois)
        await setSetting('theme', v); applyTheme(v);
        themeGroup.querySelectorAll('button').forEach((b) => { b.classList.remove('on'); b.setAttribute('aria-checked', 'false'); });
        btn.classList.add('on'); btn.setAttribute('aria-checked', 'true');
      },
    }, l)));

  const mb = h('input', { type: 'number', min: 10, max: 2000, step: 10, value: getSetting('maxFileMB'), 'aria-label': 'Tamanho máximo por arquivo em MB' });
  mb.addEventListener('change', async () => {
    const v = Math.min(2000, Math.max(10, Math.round(Number(mb.value) || 200)));
    mb.value = v; await setSetting('maxFileMB', v); toast(`Limite de importação: ${v} MB.`);
  });

  const auto = h('input', { type: 'checkbox', checked: !!getSetting('autoIdentify'), 'aria-label': 'Buscar capas e informações online ao importar' });
  auto.addEventListener('change', async () => { await setSetting('autoIdentify', auto.checked); toast(auto.checked ? 'Busca online ativada.' : 'Busca online desativada.'); });

  root.replaceChildren(
    h('div', { class: 'view-head' }, h('h1', {}, 'Configurações')),
    h('section', { class: 'panel' }, h('h2', {}, 'Aparência'), h('p', { class: 'hint' }, 'O tema automático segue a configuração do seu dispositivo.'), themeGroup),
    h('section', { class: 'panel' }, h('h2', {}, 'Importação'),
      h('label', { class: 'field inline' }, h('span', {}, 'Tamanho máximo por arquivo (MB)'), mb),
      h('label', { class: 'field inline' }, h('span', {}, 'Buscar capas e informações online ao importar'), auto),
      h('p', { class: 'hint' }, 'Quando ativada, o título, o autor e o ISBN do livro são enviados ao Google Livros e ao Open Library. O arquivo do livro nunca é enviado.')),
    h('section', { class: 'panel' }, h('h2', {}, 'Armazenamento'),
      h('p', {}, `${count} livro(s) neste dispositivo.`),
      h('p', { class: 'hint' }, info.usage != null ? `Em uso: ${formatBytes(info.usage)} de ${formatBytes(info.quota)} disponíveis. Armazenamento persistente: ${info.persisted ? 'ativo' : 'ainda não concedido pelo navegador'}.` : 'Informações de armazenamento indisponíveis neste navegador.'),
      h('p', { class: 'hint' }, 'Os livros ficam apenas neste dispositivo. Limpar os dados do site no navegador apaga a biblioteca.')),
  );
}
