# Importação de livros do Boto Azul

Somente **EPUB**. Nada de PDF. Só entra obra com **autorização de redistribuição comprovada**.

## Fontes (independentes, com fallback na ordem abaixo)
| Fonte | Como é usada | Direitos exigidos |
|---|---|---|
| Project Gutenberg | busca (Gutendex → OPDS) + cadastro RDF + EPUB | "Public domain" no cadastro **e** autor/tradutor falecidos até 1955 (regra Brasil: vida + 70 anos). Tradutor sem data = recusado |
| Internet Archive | APIs `advancedsearch`, `metadata`, `download` (checa MD5) | Licença explícita: CC0, Domínio Público (PDM), CC BY ou CC BY-SA, ou declaração textual de domínio público. Itens de empréstimo (`inlibrary`) e CC NC/ND = recusados |
| Projecto Adamastor | busca do site + link de download da página da obra | Autor na tabela `tools/autores-dominio-publico.json` (morte ≤ 1955, obra original em português). Edição sob Creative Commons (variante não especificada pelo site): manter crédito, não alterar |
| Acervo próprio | catálogos já existentes (Clássicos, Estante, Acervo) | Nunca é apagado; serve para evitar duplicatas (título e hash) |

Se uma fonte estiver fora do ar, as outras continuam. Quando ela volta, os itens que ficaram **pendentes** são retomados sozinhos.

## Arquivos gravados (public/books/acervo/)
- `catalogo.json` livros importados (fonte, licença, autorização, hash, origem do download)
- `estado.json` progresso: cada item = concluido | pendente | erro | bloqueado, tentativas, motivo, próxima tentativa; estado das fontes; última execução
- `RELATORIO.md` relatório legível · `brasileiros/ internacionais/ filosofia/ terror-suspense/` os EPUBs · `capas/`

## Como executar
GitHub → **Actions → Importar livros → Run workflow** (meta 10 para teste; depois 100). Também roda sozinho a cada 6 h e se encerra em segundos quando não há nada a fazer.
Variáveis (opcionais): `LIMITE` meta total, `LOTE` itens por execução (30), `ORCAMENTO_MIN` minutos (40), `FONTES` (ex.: `gutenberg,internet-archive`), `REFAZER=1` reanalisa bloqueados.
Local: `LIMITE=10 node tools/importar-acervo.mjs` (Node 18+ e o comando `unzip`).

## Painel
No app: **Ajustes → Importação automática de livros → Abrir painel** (`#importacao`).

## Limites conhecidos
- As buscas do Internet Archive e do Adamastor, e a coleta de links do Adamastor, seguem a estrutura pública dos sites e **ainda não foram exercitadas contra os servidores reais** (o ambiente de desenvolvimento não alcança esses sites). Os testes usam respostas simuladas.
- O Gutenberg pode bloquear IPs de nuvem; nesse caso o painel mostra a fonte como indisponível e as outras seguem.
- A verificação de direitos do Adamastor depende da tabela de autores (manutenção manual).
