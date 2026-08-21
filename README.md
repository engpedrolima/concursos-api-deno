# Importador rastreável de questões de concursos

Este projeto importa questões apenas a partir de um **caderno de prova** e de um
**gabarito definitivo**, ambos em PDF público e hospedados no site oficial da
banca ou do órgão. Não usa login, CAPTCHA, scraping de bancos de questões de
terceiros, nem contorna bloqueios.

## Garantias de segurança e qualidade

- A origem é uma URL HTTPS cujo domínio precisa ser informado explicitamente
  como oficial (`--official-host`).
- O download tem timeout de 20 s, no máximo duas tentativas, até três
  redirecionamentos validados e intervalo mínimo de 1 s entre requisições. Cada
  PDF é limitado a 25 MiB. Não há cookies, autenticação ou bypass.
- A importação exige os dois documentos para a mesma prova e valida o tipo PDF.
- Cada questão retém URL do caderno, data de coleta, SHA-256 do PDF e
  identificação da prova. O SHA-256 do gabarito também integra o relatório.
- Questões anuladas, sem enunciado/alternativas suficientes, sem gabarito ou com
  gabarito conflitante são rejeitadas.
- `--dry-run` é o fluxo recomendado: apenas mostra o JSON e não grava nada. Não
  há integração com base de dados.

## Executar

Requer Deno e o utilitário local `pdftotext` (Poppler) para extrair texto sem
enviar o PDF a terceiros.

```bash
deno task test
deno task import -- --dry-run \
  --official-host banca.exemplo.gov.br \
  --booklet https://banca.exemplo.gov.br/arquivos/caderno.pdf \
  --answer-key https://banca.exemplo.gov.br/arquivos/gabarito-definitivo.pdf \
  --exam-id orgao-2025-analista-tipo-1 \
  --organizer "Banca Exemplo" --year 2025 --role "Analista"
```

Para produzir um artefato local revisável, acrescente `--output importacao.json`
e remova `--dry-run`. O arquivo só é gravado depois da validação integral do
contrato. Revise o relatório e faça a persistência em sua base por um processo
separado e auditado.

## Artefato de importação

O JSON produzido usa um envelope versionado com `schemaVersion: 1`, a versão do
parser/importador, a identidade completa da prova e os documentos rotulados como
`booklet` e `answerKey`. Cada documento preserva URL, SHA-256 e data de coleta.
O envelope também contém `questions`, `rejected` e `diagnostics`.

`schemaVersion` define a compatibilidade estrutural; versões desconhecidas ou
artefatos incompletos são rejeitados com a indicação do campo inválido. A versão
do importador registra qual parser produziu o conteúdo, sem substituir a versão
do schema. O fluxo `--dry-run` valida e exibe exatamente esse envelope, sem abrir
banco de dados nem gravar arquivo.

## Banco local

Inicialize ou atualize o schema com `deno task db:init`. Por padrão, o SQLite
fica em `data/concursos.sqlite3`, caminho ignorado pelo Git. Para escolher outro
arquivo, use `deno task db:init -- --database caminho/estudo.sqlite3`.

Todas as conexões ativam chaves estrangeiras e todas as datas persistidas usam
UTC no formato ISO 8601 `YYYY-MM-DDTHH:mm:ss.sssZ`. As migrações e constraints
podem ser verificadas com `deno task test`; os testes criam apenas bancos
temporários.

O fluxo persistente permanece separado da coleta: primeiro produza e revise o
JSON com `deno task import -- ... --output importacao.json`; depois valide e
grave esse artefato com:

```bash
deno task db:import -- --artifact importacao.json
# banco alternativo:
deno task db:import -- --artifact importacao.json --database caminho/estudo.sqlite3
```

Antes de abrir o banco, `db:import` valida integralmente o contrato v1. A chave
idempotente é o SHA-256 de `schemaVersion`, `importerVersion`, identidade completa
da prova e URL, SHA-256 e data de coleta de `booklet` e `answerKey`.

## Adicionar uma banca ou órgão

Não há descoberta automática de URLs: ela tende a trazer fontes não autorizadas.
Para adicionar uma fonte recorrente, implemente `OfficialSource` em
`importer/sources.ts` (ou novo arquivo):

1. aceite somente URLs publicadas pela banca/órgão e valide uma lista explícita
   de hosts oficiais;
2. devolva exatamente um `question-booklet` e um `final-answer-key` com a mesma
   `ExamIdentity`;
3. reutilize `PoliteHttpClient`, sem credenciais e sem mecanismos de contorno;
4. registre a fonte no comando de importação e cubra-a com fixtures locais em
   `tests/fixtures/`.

O parser atual trata o formato textual mais comum (`QUESTÃO n`, alternativas A–E
e linhas `n - letra`). Ajustes específicos de uma banca devem permanecer
conservadores: se não for possível determinar uma questão ou resposta de modo
unívoco, rejeite-a.

## API

`deno task start` expõe apenas um endpoint de saúde. A antiga coleta de um
agregador de concursos foi removida para não contrariar a política de fontes
oficiais.
