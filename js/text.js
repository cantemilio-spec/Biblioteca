// HTML -> texto puro. DOMParser não executa scripts; script/style/template são descartados com o conteúdo.
export function plainText(s, max = 2000) {
  if (!s) return '';
  const doc = new DOMParser().parseFromString(String(s), 'text/html');
  doc.querySelectorAll('script,style,template,noscript').forEach((n) => n.remove());
  return doc.body.textContent.replace(/\s+/g, ' ').trim().slice(0, max);
}
