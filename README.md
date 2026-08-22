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

## Classificação local por assunto

Depois de importar uma prova, classifique ocorrências ainda sem assunto
específico com regras locais e determinísticas:

```bash
deno task db:classify -- --exam-id prova-2026-procurador
deno task db:classify -- --exam-id prova-2026-procurador \
  --database caminho/estudo.sqlite3 --force
```

Sem `--force`, o comando preserva assuntos específicos e atualiza somente
valores ausentes ou genéricos. O resumo JSON informa a versão das regras,
contagens por assunto e quantas ocorrências ficaram como `Sem classificação`.
A classificação usa apenas o enunciado e as alternativas armazenados no banco;
não acessa rede, serviços de IA ou os PDFs originais.

## Camada de leitura

`database/questions.ts` lista e obtém ocorrências para estudo sem expor o
gabarito por padrão. A listagem aceita filtros exatos por banca, ano, cargo,
assunto, formato, progresso e `externalId` da prova, além de paginação e
deduplicação. O progresso permite selecionar não respondidas, respondidas e
ocorrências cuja tentativa mais recente foi correta ou incorreta.
O assunto específico da ocorrência prevalece sobre o assunto geral da prova.

A ordem é ano, `externalId`, número na prova e ID da ocorrência. Com
`deduplicate: true`, a primeira ocorrência filtrada nessa ordem representa cada
questão canônica. O detalhe só inclui o gabarito quando a chamada interna usa
explicitamente `includeAnswer: true`.

## Tentativas por ocorrência

Registre uma resposta no banco local com:

```bash
deno task db:answer -- --occurrence-id 1 --selected-label A \
  --duration-ms 12000 --database caminho/estudo.sqlite3
```

`--database` é opcional e usa o caminho-padrão acima. Cada resposta cria uma
nova tentativa vinculada à ocorrência, preservando o gabarito daquele momento
para o histórico e imprimindo a correção em JSON. A duração é opcional, em
milissegundos, e aceita valores de zero até 24 horas (`86400000`).

## Estatísticas de estudo

Consulte as métricas gerais e por assunto com:

```bash
deno task db:stats -- --database caminho/estudo.sqlite3 \
  --organizer "Banca Exemplo" --year 2020 --subject Direito
```

As métricas de `attempts` contam todas as respostas registradas. As métricas de
`occurrences` contam as questões elegíveis e, para cada questão respondida,
consideram somente sua tentativa mais recente. Os percentuais são arredondados
para duas casas decimais. O agrupamento usa o assunto da ocorrência, recorre ao
assunto da prova e identifica a ausência de ambos como `(sem assunto)`.

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

Inicie a API local em `http://127.0.0.1:8000` com `deno task start`. Ela usa o
banco-padrão `data/concursos.sqlite3`; para outro arquivo, execute
`deno task start -- --database caminho/estudo.sqlite3`.

Endpoints JSON disponíveis:

- `GET /` — saúde do serviço;
- `GET /api/questions` e `GET /api/questions/:occurrenceId` — listagem e
  detalhe sem gabarito;
- `GET /api/filter-options` — valores disponíveis para os filtros;
- `GET /api/questions/:occurrenceId/similar` — ocorrências textualmente
  semelhantes, sem gabarito;
- `POST /api/questions/:occurrenceId/attempts` — registra e corrige uma
  resposta;
- `GET /api/questions/:occurrenceId/attempts` — histórico da ocorrência;
- `GET /api/statistics` — métricas gerais e por assunto.

## Interface local

Fluxo resumido para estudar no navegador:

1. gere e revise o artefato com `deno task import -- ... --output importacao.json`;
2. importe-o com `deno task db:import -- --artifact importacao.json`;
3. inicie o serviço com `deno task start`;
4. abra `http://localhost:8000/app/` no navegador.

A interface e a API usam a mesma origem local. Nenhum dado é enviado a CDN ou
serviço externo. O filtro de progresso usa a tentativa mais recente de cada
ocorrência. O botão **Questões semelhantes** usa somente similaridade textual
local via SQLite FTS5/BM25; esta primeira versão não é busca semântica nem IA.
