import type { Database } from "../database/connection.ts";
import { DEFAULT_DATABASE_PATH, openDatabase } from "../database/connection.ts";
import { persistImportArtifact } from "../database/import_artifact.ts";
import { runMigrations } from "../database/migrations.ts";
import type { ImportArtifact } from "../importer/artifact.ts";
import { parseImportArtifact } from "../importer/artifact.ts";
import {
  type ApiHandler,
  createHandler,
  handler as defaultHandler,
  MAX_JSON_REQUEST_BODY_BYTES,
} from "../main.ts";
import { join } from "node:path";

const fixtureUrl = new URL(
  "./fixtures/import-artifact-v1.json",
  import.meta.url,
);

const assertEquals = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Esperado ${JSON.stringify(expected)}, recebido ${
        JSON.stringify(actual)
      }`,
    );
  }
};

async function responseJson(response: Response): Promise<unknown> {
  assertEquals(
    response.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  return await response.json();
}

function retargetExam(
  source: ImportArtifact,
  exam: ImportArtifact["exam"],
): ImportArtifact {
  const artifact = structuredClone(source);
  artifact.exam = exam;
  for (const question of artifact.questions) {
    question.organizer = exam.organizer;
    question.year = exam.year;
    question.role = exam.role;
    question.subject = exam.subject;
    question.provenance.exam = structuredClone(exam);
  }
  return artifact;
}

interface ApiOccurrences {
  alphaMultipleChoice: number;
  alphaCertoErrado: number;
  betaMultipleChoice: number;
}

async function seedApiDatabase(database: Database): Promise<ApiOccurrences> {
  const base = parseImportArtifact(await Deno.readTextFile(fixtureUrl));
  const alpha = retargetExam(base, {
    id: "api-alpha-2026",
    organizer: "Banca Alpha",
    year: 2026,
    role: "Analista",
    subject: "Conhecimentos Gerais",
  });
  alpha.rejected = [];
  alpha.questions[0].subject = "Tecnologia";
  const certoErrado = structuredClone(alpha.questions[0]);
  certoErrado.number = 2;
  certoErrado.statement = "A API sintética está saudável.";
  certoErrado.alternatives = { C: "Certo", E: "Errado" };
  certoErrado.answer = "C";
  certoErrado.subject = "Direito";
  alpha.questions.push(certoErrado);
  alpha.diagnostics.questionHeaders = 2;
  alpha.diagnostics.multipleChoiceCandidates = 1;
  alpha.diagnostics.certoErradoCandidates = 1;

  const beta = retargetExam(base, {
    id: "api-beta-2027",
    organizer: "Banca Beta",
    year: 2027,
    role: "Auditor",
    subject: "Conhecimentos Gerais",
  });
  beta.rejected = [];
  beta.questions[0].number = 5;
  beta.questions[0].subject = "Tecnologia";

  persistImportArtifact(database, alpha);
  persistImportArtifact(database, beta);
  const rows = database.prepare(`
    SELECT qo.id, qo.number, e.external_id
    FROM question_occurrences AS qo
    JOIN exams AS e ON e.id = qo.exam_id
  `).all() as unknown as Array<{
    id: number;
    number: number;
    external_id: string;
  }>;
  const id = (externalId: string, number: number): number => {
    const row = rows.find((candidate) =>
      candidate.external_id === externalId &&
      Number(candidate.number) === number
    );
    if (!row) throw new Error(`Ocorrência ${externalId}#${number} ausente.`);
    return Number(row.id);
  };
  return {
    alphaMultipleChoice: id("api-alpha-2026", 1),
    alphaCertoErrado: id("api-alpha-2026", 2),
    betaMultipleChoice: id("api-beta-2027", 5),
  };
}

async function withApiDatabase(
  operation: (
    handler: ApiHandler,
    occurrences: ApiOccurrences,
    path: string,
  ) => void | Promise<void>,
): Promise<void> {
  const directory = await Deno.makeTempDir({ prefix: "api-http-" });
  const path = join(directory, "api.sqlite3");
  const database = openDatabase(path);
  let occurrences: ApiOccurrences;
  try {
    runMigrations(database);
    occurrences = await seedApiDatabase(database);
  } finally {
    database.close();
  }
  try {
    await operation(createHandler({ databasePath: path }), occurrences, path);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

const requestJson = (
  handler: ApiHandler,
  path: string,
  body: unknown,
): Promise<Response> =>
  handler(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    }),
  );

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

Deno.test("health check permanece JSON e não cria banco padrão", async () => {
  const existedBefore = await pathExists(DEFAULT_DATABASE_PATH);
  const response = await defaultHandler(new Request("http://localhost/"));
  assertEquals(response.status, 200);
  const body = await responseJson(response) as Record<string, unknown>;
  assertEquals(body.service, "concursos-api-deno");
  assertEquals(body.status, "ok");
  assertEquals(await pathExists(DEFAULT_DATABASE_PATH), existedBefore);
});

Deno.test("listagem HTTP aplica filtros e nunca expõe gabarito", async () => {
  await withApiDatabase(async (handler) => {
    const allResponse = await handler(
      new Request("http://localhost/api/questions"),
    );
    assertEquals(allResponse.status, 200);
    const all = await responseJson(allResponse) as {
      items: Array<Record<string, unknown>>;
      total: number;
      limit: number;
      offset: number;
    };
    assertEquals([all.total, all.limit, all.offset], [3, 25, 0]);
    assertEquals(all.items.length, 3);
    assertEquals(JSON.stringify(all).includes("answerLabel"), false);
    assertEquals(JSON.stringify(all).includes("answer_label"), false);

    const filteredResponse = await handler(
      new Request(
        "http://localhost/api/questions?organizer=Banca%20Alpha&year=2026" +
          "&role=Analista&subject=Direito&kind=certo-errado" +
          "&examId=api-alpha-2026&limit=1&offset=0",
      ),
    );
    const filtered = await responseJson(filteredResponse) as {
      items: Array<{ kind: string; subject: string }>;
      total: number;
    };
    assertEquals(filtered.total, 1);
    assertEquals(filtered.items[0].kind, "certo-errado");
    assertEquals(filtered.items[0].subject, "Direito");

    const deduplicated = await responseJson(
      await handler(
        new Request("http://localhost/api/questions?deduplicate=true"),
      ),
    ) as { total: number };
    assertEquals(deduplicated.total, 2);
  });
});

Deno.test("detalhe HTTP retorna ocorrência sem gabarito e 404", async () => {
  await withApiDatabase(async (handler, occurrences) => {
    const response = await handler(
      new Request(
        `http://localhost/api/questions/${occurrences.alphaMultipleChoice}`,
      ),
    );
    assertEquals(response.status, 200);
    const detail = await responseJson(response) as Record<string, unknown>;
    assertEquals(detail.occurrenceId, occurrences.alphaMultipleChoice);
    assertEquals(Object.hasOwn(detail, "answerLabel"), false);
    assertEquals(Object.hasOwn(detail, "answer_label"), false);

    const missing = await handler(
      new Request("http://localhost/api/questions/999999"),
    );
    assertEquals(missing.status, 404);
    await responseJson(missing);
  });
});

Deno.test("POST registra respostas correta e incorreta com feedback", async () => {
  await withApiDatabase(async (handler, occurrences, path) => {
    const correct = await requestJson(
      handler,
      `/api/questions/${occurrences.alphaMultipleChoice}/attempts`,
      { selectedLabel: "B", durationMs: 12_000 },
    );
    assertEquals(correct.status, 201);
    const correctBody = await responseJson(correct) as Record<string, unknown>;
    assertEquals(correctBody.selectedLabel, "B");
    assertEquals(correctBody.correctLabel, "B");
    assertEquals(correctBody.isCorrect, true);
    assertEquals(correctBody.durationMs, 12_000);
    assertEquals(
      Number.isNaN(Date.parse(String(correctBody.answeredAt))),
      false,
    );

    const incorrect = await requestJson(
      handler,
      `/api/questions/${occurrences.alphaMultipleChoice}/attempts`,
      { selectedLabel: "A" },
    );
    assertEquals(incorrect.status, 201);
    const incorrectBody = await responseJson(incorrect) as Record<
      string,
      unknown
    >;
    assertEquals(incorrectBody.correctLabel, "B");
    assertEquals(incorrectBody.isCorrect, false);

    const database = openDatabase(path);
    try {
      const count = database.prepare("SELECT count(*) AS total FROM attempts")
        .get() as { total: number };
      assertEquals(Number(count.total), 2);
    } finally {
      database.close();
    }
  });
});

Deno.test("POST rejeita JSON, payload, label, duração e ocorrência inválidos", async () => {
  await withApiDatabase(async (handler, occurrences, path) => {
    const endpoint =
      `/api/questions/${occurrences.alphaMultipleChoice}/attempts`;
    const malformed = await handler(
      new Request(`http://localhost${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    );
    assertEquals(malformed.status, 400);
    await responseJson(malformed);

    for (
      const payload of [
        [],
        {},
        { selectedLabel: 1 },
        { selectedLabel: "A", correctLabel: "A" },
        { selectedLabel: "A", isCorrect: true },
      ]
    ) {
      const response = await requestJson(handler, endpoint, payload);
      assertEquals(response.status, 400);
      await responseJson(response);
    }

    const invalidLabel = await requestJson(handler, endpoint, {
      selectedLabel: "Z",
    });
    assertEquals(invalidLabel.status, 400);
    await responseJson(invalidLabel);

    for (const durationMs of [-1, 1.5, 86_400_001]) {
      const response = await requestJson(handler, endpoint, {
        selectedLabel: "A",
        durationMs,
      });
      assertEquals(response.status, 400);
      await responseJson(response);
    }

    const invalidId = await requestJson(
      handler,
      "/api/questions/abc/attempts",
      { selectedLabel: "A" },
    );
    assertEquals(invalidId.status, 400);
    await responseJson(invalidId);

    const missing = await requestJson(
      handler,
      "/api/questions/999999/attempts",
      { selectedLabel: "A" },
    );
    assertEquals(missing.status, 404);
    await responseJson(missing);

    const oversized = await requestJson(handler, endpoint, {
      selectedLabel: "A".repeat(MAX_JSON_REQUEST_BODY_BYTES),
    });
    assertEquals(oversized.status, 413);
    await responseJson(oversized);

    const database = openDatabase(path);
    try {
      const count = database.prepare("SELECT count(*) AS total FROM attempts")
        .get() as { total: number };
      assertEquals(Number(count.total), 0);
    } finally {
      database.close();
    }
  });
});

Deno.test("ID, query e duração inválidos falham antes de abrir banco", async () => {
  let opened = 0;
  const handler = createHandler({
    databasePath: "ignored.sqlite3",
    dependencies: {
      openDatabase: () => {
        opened++;
        throw new Error("Não deveria abrir o banco.");
      },
    },
  });
  const requests = [
    new Request("http://localhost/api/questions/abc"),
    new Request("http://localhost/api/questions?limit=101"),
    new Request("http://localhost/api/questions?year=abc"),
    new Request("http://localhost/api/statistics?kind=dissertativa"),
  ];
  for (const request of requests) {
    const response = await handler(request);
    assertEquals(response.status, 400);
    await responseJson(response);
  }
  const invalidDuration = await requestJson(
    handler,
    "/api/questions/1/attempts",
    { selectedLabel: "A", durationMs: -1 },
  );
  assertEquals(invalidDuration.status, 400);
  assertEquals(opened, 0);
});

Deno.test("histórico HTTP ordena respostas e isola ocorrências", async () => {
  await withApiDatabase(async (handler, occurrences) => {
    const alphaEndpoint =
      `/api/questions/${occurrences.alphaMultipleChoice}/attempts`;
    const ceEndpoint =
      `/api/questions/${occurrences.alphaCertoErrado}/attempts`;
    await requestJson(handler, alphaEndpoint, { selectedLabel: "A" });
    await requestJson(handler, ceEndpoint, { selectedLabel: "E" });
    await requestJson(handler, alphaEndpoint, { selectedLabel: "B" });

    const alphaResponse = await handler(
      new Request(`http://localhost${alphaEndpoint}`),
    );
    const alphaHistory = await responseJson(alphaResponse) as Array<{
      selectedLabel: string;
    }>;
    assertEquals(
      alphaHistory.map((attempt) => attempt.selectedLabel),
      ["B", "A"],
    );
    const ceHistory = await responseJson(
      await handler(new Request(`http://localhost${ceEndpoint}`)),
    ) as Array<{ selectedLabel: string }>;
    assertEquals(ceHistory.map((attempt) => attempt.selectedLabel), ["E"]);

    const missing = await handler(
      new Request("http://localhost/api/questions/999999/attempts"),
    );
    assertEquals(missing.status, 404);
    await responseJson(missing);
  });
});

Deno.test("estatísticas HTTP refletem tentativa e respeitam filtros", async () => {
  await withApiDatabase(async (handler, occurrences) => {
    await requestJson(
      handler,
      `/api/questions/${occurrences.alphaMultipleChoice}/attempts`,
      { selectedLabel: "B" },
    );
    const response = await handler(
      new Request("http://localhost/api/statistics"),
    );
    const statistics = await responseJson(response) as {
      attempts: { total: number; correct: number };
      occurrences: { total: number; answered: number; latestCorrect: number };
    };
    assertEquals(statistics.attempts.total, 1);
    assertEquals(statistics.attempts.correct, 1);
    assertEquals(statistics.occurrences.total, 3);
    assertEquals(statistics.occurrences.answered, 1);
    assertEquals(statistics.occurrences.latestCorrect, 1);

    const beta = await responseJson(
      await handler(
        new Request(
          "http://localhost/api/statistics?organizer=Banca%20Beta&year=2027" +
            "&role=Auditor&subject=Tecnologia&kind=multiple-choice" +
            "&examId=api-beta-2027",
        ),
      ),
    ) as {
      attempts: { total: number };
      occurrences: { total: number };
    };
    assertEquals(beta.attempts.total, 0);
    assertEquals(beta.occurrences.total, 1);
  });
});

Deno.test("API retorna 404, 405 com Allow e 500 genérico", async () => {
  const notFound = await defaultHandler(
    new Request("http://localhost/api/inexistente"),
  );
  assertEquals(notFound.status, 404);
  await responseJson(notFound);

  const method = await defaultHandler(
    new Request("http://localhost/api/questions", { method: "POST" }),
  );
  assertEquals(method.status, 405);
  assertEquals(method.headers.get("allow"), "GET");
  await responseJson(method);

  const attemptsMethod = await defaultHandler(
    new Request("http://localhost/api/questions/1/attempts", {
      method: "DELETE",
    }),
  );
  assertEquals(attemptsMethod.status, 405);
  assertEquals(attemptsMethod.headers.get("allow"), "GET, POST");
  await responseJson(attemptsMethod);

  const failingHandler = createHandler({
    databasePath: "C:/segredo/banco.sqlite3",
    dependencies: {
      openDatabase: () => {
        throw new Error("SQL secreto em C:/segredo/banco.sqlite3");
      },
    },
  });
  const failure = await failingHandler(
    new Request("http://localhost/api/questions"),
  );
  assertEquals(failure.status, 500);
  const body = await responseJson(failure) as { error: string };
  assertEquals(body.error, "Erro interno do servidor.");
  assertEquals(JSON.stringify(body).includes("SQL"), false);
  assertEquals(JSON.stringify(body).includes("segredo"), false);
});
