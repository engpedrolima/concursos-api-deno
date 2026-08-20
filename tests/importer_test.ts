import {
  importDocuments,
  NoQuestionsRecognizedError,
} from "../importer/importer.ts";
import {
  buildQuestions,
  DuplicateQuestionNumberError,
  parseFinalAnswerKey,
  parseQuestionBooklet,
} from "../importer/parser.ts";
import { PoliteHttpClient } from "../importer/http.ts";
import { PublicPdfSource } from "../importer/sources.ts";

const fixture = async (name: string) =>
  await Deno.readTextFile(new URL(`./fixtures/${name}`, import.meta.url));
const identity = {
  id: "prefeitura-2025-analista",
  organizer: "Banca Oficial",
  year: 2025,
  role: "Analista",
};
const assertEquals = (actual: unknown, expected: unknown) => {
  if (actual !== expected) {
    throw new Error(
      `Esperado ${JSON.stringify(expected)}, recebido ${
        JSON.stringify(actual)
      }`,
    );
  }
};
const assertMatch = (actual: string, expected: RegExp) => {
  if (!expected.test(actual)) {
    throw new Error(`Valor não corresponde a ${expected}: ${actual}`);
  }
};

Deno.test("interpreta fixtures locais e rejeita anulada e gabarito ambíguo", async () => {
  const booklet = await fixture("caderno-exemplo.txt");
  const key = await fixture("gabarito-definitivo-exemplo.txt");
  assertEquals(parseQuestionBooklet(booklet).length, 3);
  assertEquals(parseFinalAnswerKey(key).get(3), "AMBIGUA");
  const result = await importDocuments([
    {
      bytes: new TextEncoder().encode(booklet),
      url: "https://banca.gov.br/caderno.pdf",
      collectedAt: "2025-01-02T03:04:05.000Z",
      identity,
      kind: "question-booklet",
    },
    {
      bytes: new TextEncoder().encode(key),
      url: "https://banca.gov.br/gabarito.pdf",
      collectedAt: "2025-01-02T03:04:05.000Z",
      identity,
      kind: "final-answer-key",
    },
  ], { extract: async (bytes) => new TextDecoder().decode(bytes) });
  assertEquals(result.questions.length, 1);
  assertEquals(result.questions[0].answer, "B");
  assertEquals(result.questions[0].provenance.exam.id, identity.id);
  assertMatch(result.questions[0].provenance.pdfSha256, /^[a-f0-9]{64}$/);
  assertEquals(result.rejected.length, 2);
  assertEquals(result.schemaVersion, 1);
  assertEquals(result.importerVersion, "1.0.0");
  assertEquals(result.exam.id, identity.id);
  assertEquals(
    result.documents.booklet.url,
    "https://banca.gov.br/caderno.pdf",
  );
  assertEquals(
    result.documents.answerKey.url,
    "https://banca.gov.br/gabarito.pdf",
  );
});

Deno.test("recusa URL não oficial antes da requisição", async () => {
  const client = new PoliteHttpClient({
    timeoutMs: 10,
    retries: 0,
    minIntervalMs: 0,
    maxRedirects: 0,
    userAgent: "test",
  });
  const source = new PublicPdfSource({
    questionBookletUrl: "https://terceiro.example/a.pdf",
    finalAnswerKeyUrl: "https://terceiro.example/g.pdf",
    allowedHosts: ["banca.gov.br"],
  }, client);
  const outcome = await source.fetch(identity).then(
    () => "ok",
    (error) => error.message,
  );
  assertEquals(
    outcome,
    "O domínio terceiro.example não está na lista oficial permitida.",
  );
});

const httpWith = (fetcher: typeof fetch) =>
  new PoliteHttpClient({
    timeoutMs: 100,
    retries: 0,
    minIntervalMs: 0,
    maxRedirects: 3,
    userAgent: "test",
  }, fetcher);

const redirectSource = (client: PoliteHttpClient, maxPdfBytes?: number) =>
  new PublicPdfSource({
    questionBookletUrl: "https://banca.gov.br/caderno.pdf",
    finalAnswerKeyUrl: "https://banca.gov.br/gabarito.pdf",
    allowedHosts: ["banca.gov.br"],
    maxPdfBytes,
  }, client);

Deno.test("recusa redirect para host não permitido antes de requisitar o destino", async () => {
  const calls: string[] = [];
  const source = redirectSource(httpWith((input) => {
    calls.push(String(input));
    return Promise.resolve(
      new Response(null, {
        status: 302,
        headers: { location: "https://terceiro.example/documento.pdf" },
      }),
    );
  }) as never);
  const outcome = await source.fetch(identity).then(
    () => "ok",
    (error) => error.message,
  );
  assertEquals(
    outcome,
    "O domínio terceiro.example não está na lista oficial permitida.",
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0], "https://banca.gov.br/caderno.pdf");
});

Deno.test("recusa redirect para HTTP antes de requisitar o destino", async () => {
  const calls: string[] = [];
  const source = redirectSource(httpWith((input) => {
    calls.push(String(input));
    return Promise.resolve(
      new Response(null, {
        status: 301,
        headers: { location: "http://banca.gov.br/documento.pdf" },
      }),
    );
  }) as never);
  const outcome = await source.fetch(identity).then(
    () => "ok",
    (error) => error.message,
  );
  assertEquals(outcome, "A fonte deve usar HTTPS.");
  assertEquals(calls.length, 1);
});

Deno.test("rejeita Content-Length acima do limite do PDF", async () => {
  const source = redirectSource(
    httpWith(() =>
      Promise.resolve(
        new Response("%PDF-", {
          headers: { "content-type": "application/pdf", "content-length": "6" },
        }),
      ) as never
    ),
    5,
  );
  const outcome = await source.fetch(identity).then(
    () => "ok",
    (error) => error.message,
  );
  assertEquals(outcome, "PDF excede o limite de 5 bytes.");
});

Deno.test("interrompe stream de PDF que excede o limite sem Content-Length", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("%PDF-mais-que-cinco"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const source = redirectSource(
    httpWith(() =>
      Promise.resolve(
        new Response(stream, {
          headers: { "content-type": "application/pdf" },
        }),
      ) as never
    ),
    5,
  );
  const outcome = await source.fetch(identity).then(
    () => "ok",
    (error) => error.message,
  );
  assertEquals(outcome, "PDF excede o limite de 5 bytes.");
  assertEquals(cancelled, true);
});

Deno.test("importa item Certo/Errado da Quadrix e rejeita item anulado", async () => {
  const booklet = await fixture("caderno-quadrix-ce.txt");
  const key = await fixture("gabarito-quadrix-ce.txt");
  const result = await importDocuments([
    {
      bytes: new TextEncoder().encode(booklet),
      url: "https://quadrix.org.br/caderno.pdf",
      collectedAt: "2025-01-02T03:04:05.000Z",
      identity,
      kind: "question-booklet",
    },
    {
      bytes: new TextEncoder().encode(key),
      url: "https://quadrix.org.br/gabarito.pdf",
      collectedAt: "2025-01-02T03:04:05.000Z",
      identity,
      kind: "final-answer-key",
    },
  ], { extract: async (bytes) => new TextDecoder().decode(bytes) });
  assertEquals(result.questions.length, 1);
  assertEquals(result.questions[0].answer, "C");
  assertEquals(result.questions[0].alternatives.C, "Certo");
  assertEquals(result.questions[0].alternatives.E, "Errado");
  assertEquals(result.rejected.length, 1);
  assertEquals(result.diagnostics.certoErradoCandidates, 2);
});

Deno.test("reconhece itens numéricos Quadrix apenas presentes no gabarito e preserva UTF-8", async () => {
  const booklet = await fixture("caderno-quadrix-numerico-utf8.txt");
  const key = await fixture("gabarito-quadrix-numerico-utf8.txt");
  const quadrixIdentity = { ...identity, role: "Técnico Administrativo" };
  assertEquals(parseFinalAnswerKey(key, quadrixIdentity).get(61), "C");
  assertEquals(parseFinalAnswerKey(key, quadrixIdentity).get(62), "ANULADA");
  const result = await importDocuments([
    {
      bytes: new TextEncoder().encode(booklet),
      url: "https://quadrix.org.br/caderno.pdf",
      collectedAt: "2025-01-02T03:04:05.000Z",
      identity: quadrixIdentity,
      kind: "question-booklet",
    },
    {
      bytes: new TextEncoder().encode(key),
      url: "https://quadrix.org.br/gabarito.pdf",
      collectedAt: "2025-01-02T03:04:05.000Z",
      identity: quadrixIdentity,
      kind: "final-answer-key",
    },
  ], { extract: async (bytes) => new TextDecoder("utf-8").decode(bytes) });
  assertEquals(result.questions.length, 1);
  assertEquals(result.questions[0].number, 61);
  assertMatch(result.questions[0].statement, /proteção à dignidade/);
  assertMatch(result.questions[0].statement, /99 Referência interna/);
  assertEquals(result.questions[0].alternatives.C, "Certo");
  assertEquals(result.rejected.length, 1);
});

Deno.test("encerra a objetiva antes da prova discursiva e mantém 120 números únicos", async () => {
  const tail = await fixture("caderno-quadrix-discursiva.txt");
  const objective = Array.from(
    { length: 119 },
    (_, index) => `${index + 1} Item objetivo ${index + 1}.`,
  ).join("\n");
  const booklet = `${objective}\n${tail}`;
  const answerKey = Array.from(
    { length: 120 },
    (_, index) => `${index + 1} - C`,
  ).join("\n");
  const result = buildQuestions(booklet, answerKey, identity);
  assertEquals(result.questions.length, 120);
  assertEquals(
    new Set(result.questions.map((question) => question.number)).size,
    120,
  );
  const item120 = result.questions.find((question) => question.number === 120)!;
  assertEquals(item120.statement.includes("PROVA DISCURSIVA"), false);
  assertEquals(item120.statement.includes("Redija um texto"), false);
});

Deno.test("falha com diagnóstico estruturado para número objetivo repetido", () => {
  const booklet = "1 Primeiro item.\n1 Segundo item repetido.";
  const answers = parseFinalAnswerKey("1 - C");
  try {
    parseQuestionBooklet(booklet, answers);
    throw new Error("A duplicidade deveria falhar.");
  } catch (error) {
    if (!(error instanceof DuplicateQuestionNumberError)) throw error;
    assertEquals(error.duplicateNumbers.length, 1);
    assertEquals(error.duplicateNumbers[0], 1);
  }
});

Deno.test("falha com diagnóstico quando nenhum candidato é reconhecido", async () => {
  const unknown = new TextEncoder().encode(
    "Texto extraído sem itens reconhecíveis.",
  );
  try {
    await importDocuments([
      {
        bytes: unknown,
        url: "https://banca.gov.br/caderno.pdf",
        collectedAt: "2025-01-02T03:04:05.000Z",
        identity,
        kind: "question-booklet",
      },
      {
        bytes: unknown,
        url: "https://banca.gov.br/gabarito.pdf",
        collectedAt: "2025-01-02T03:04:05.000Z",
        identity,
        kind: "final-answer-key",
      },
    ], { extract: async (bytes) => new TextDecoder().decode(bytes) });
    throw new Error("A importação deveria falhar.");
  } catch (error) {
    if (!(error instanceof NoQuestionsRecognizedError)) throw error;
    assertEquals(error.diagnostics.questionHeaders, 0);
    assertEquals(error.diagnostics.bookletCharacters > 0, true);
  }
});
