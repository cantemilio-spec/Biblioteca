// Mensagem de boas-vindas mostrada ao abrir o aplicativo. "Não mostrar de novo" fica guardado só neste aparelho.
import { h, bimg } from './ui.js';

const KEY = 'bd-welcome-off';
const get = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
const set = (v) => { try { v ? localStorage.setItem(KEY, '1') : localStorage.removeItem(KEY); } catch { /* sem armazenamento: apenas mostra de novo */ } };

export function showWelcome() {
  if (get()) return;
  const prev = document.activeElement;
  const check = h('input', { type: 'checkbox', id: 'wl-off' });
  const close = () => { if (check.checked) set(true); document.removeEventListener('keydown', onKey, true); back.remove(); prev?.focus?.({ preventScroll: true }); };
  const ok = h('button', { class: 'btn', type: 'button', onclick: close }, 'Começar a ler');
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Tab') { const f = [check, ok]; const i = f.indexOf(document.activeElement); e.preventDefault(); f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus(); }
  };
  const back = h('div', { class: 'wl-back' },
    h('div', { class: 'wl', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'wl-t' },
      bimg(),
      h('h2', { id: 'wl-t' }, 'Boto Azul — Conhecimento livre para todos'),
      h('p', {}, 'O Boto Azul é uma plataforma de leitura digital sem fins lucrativos, criada com o propósito de democratizar o acesso à leitura e ao conhecimento.'),
      h('p', {}, 'Acreditamos que o conhecimento deve ser livre, acessível e compartilhado. Por isso, o Boto Azul é um projeto de código aberto (Open Source), permitindo que qualquer pessoa tenha acesso ao seu código, estude, contribua e ajude a melhorar a plataforma.'),
      h('p', {}, 'Nosso objetivo é construir um espaço onde a leitura não seja um privilégio, mas uma oportunidade para todos.'),
      h('p', { class: 'wl-strong' }, 'Sem fins lucrativos. Sem barreiras para o conhecimento. Feito para compartilhar.'),
      h('p', { class: 'wl-end' }, '📖 Boto Azul — O conhecimento pertence a todos.'),
      h('label', { class: 'wl-off', for: 'wl-off' }, check, h('span', {}, 'Não mostrar de novo')),
      ok));
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(back); ok.focus({ preventScroll: true });
}
