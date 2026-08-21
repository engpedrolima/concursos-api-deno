import type { ImportArtifact } from "../importer/artifact.ts";
import { parseImportArtifact } from "../importer/artifact.ts";
import type { Database } from "../database/connection.ts";
import { openDatabase } from "../database/connection.ts";
import { persistImportArtifact } from "../database/import_artifact.ts";
import { runMigrations } from "../database/migrations.ts";
import {
  getQuestionOccurrence,
  listQuestionOccurrences,
  MAX_QUESTION_LIMIT,
  QuestionQueryValidationError,
} from "../database/questions.ts";
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

async function seedStudyDatabase(database: Database): Promise<void> {
  const base = parseImportArtifact(await Deno.readTextFile(fixtureUrl));
  const alpha = retargetExam(base, {
    id: "alpha-2026",
    organizer: "Banca Sintética",
    year: 2026,
    role: "Analista",
    subject: "Conhecimentos Gerais",
  });
  alpha.rejected = [];
  const certoErrado = structuredClone(alpha.questions[0]);
  certoErrado.number = 2;
  certoErrado.statement = "O conteúdo sintético está correto.";
  certoErrado.alternatives = { C: "Certo", E: "Errado" };
  certoErrado.answer = "C";
  certoErrado.subject = "Direito";
  alpha.questions.push(certoErrado);
  alpha.diagnostics.questionHeaders = 2;
  alpha.diagnostics.multipleChoiceCandidates = 1;
  alpha.diagnostics.certoErradoCandidates = 1;

  const beta = retargetExam(base, {
    id: "beta-2027",
    organizer: "Outra Banca",
    year: 2027,
    role: "Auditor",
    subject: "Tecnologia",
  });
  beta.rejected = [];
  beta.questions[0].number = 5;

  const gamma = retargetExam(base, {
    id: "gamma-2027",
    organizer: "Banca Sintética",
    year: 2027,
    role: "Analista",
    subject: "Direito",
  });
  gamma.rejected = [];
  gamma.questions[0].number = 3;
  gamma.questions[0].statement = "Qual é a ordem persistida das alternativas?";
  gamma.questions[0].alternatives = {
    B: "Segunda na ordem persistida",
    A: "Primeira por label",
    C: "Terceira na ordem persistida",
  };
  gamma.questions[0].answer = "A";

  persistImportArtifact(database, alpha);
  persistImportArtifact(database, beta);
  persistImportArtifact(database, gamma);
}

async function withStudyDatabase(
  operation: (database: Database) => void | Promise<void>,
): Promise<void> {
  const directory = await Deno.makeTempDir({ prefix: "questions-query-" });
  const database = openDatabase(join(directory, "study.sqlite3"));
  try {
    runMigrations(database);
    await seedStudyDatabase(database);
    await operation(database);
  } finally {
    database.close();
    await Deno.remove(directory, { recursive: true });
  }
}

Deno.test("listagem sem filtros retorna ocorrências e preserva duplicata canônica", async () => {
  await withStudyDatabase((database) => {
    const page = listQuestionOccurrences(database);
    assertEquals(page.total, 4);
    assertEquals(page.limit, 25);
    assertEquals(page.offset, 0);
    assertEquals(page.items.length, 4);
    assertEquals(
      page.items.map((item) => [item.exam.externalId, item.number]),
      [
        ["alpha-2026", 1],
        ["alpha-2026", 2],
        ["beta-2027", 5],
        ["gamma-2027", 3],
      ],
    );
    assertEquals(page.items[0].questionId, page.items[2].questionId);
    assertEquals(
      page.items[0].occurrenceId === page.items[2].occurrenceId,
      false,
    );
  });
});

Deno.test("filtros individuais usam metadados da prova e ocorrência", async () => {
  await withStudyDatabase((database) => {
    assertEquals(
      listQuestionOccurrences(database, { organizer: "Banca Sintética" }).total,
      3,
    );
    assertEquals(listQuestionOccurrences(database, { year: 2027 }).total, 2);
    assertEquals(
      listQuestionOccurrences(database, { role: "Auditor" }).total,
      1,
    );
    assertEquals(
      listQuestionOccurrences(database, { subject: "Direito" }).total,
      2,
    );
    assertEquals(
      listQuestionOccurrences(database, { kind: "certo-errado" }).total,
      1,
    );
    assertEquals(
      listQuestionOccurrences(database, { examId: "beta-2027" }).total,
      1,
    );
    assertEquals(
      listQuestionOccurrences(database, { organizer: "' OR 1=1 --" }).total,
      0,
    );
  });
});

Deno.test("combinação de filtros restringe deterministicamente", async () => {
  await withStudyDatabase((database) => {
    const page = listQuestionOccurrences(database, {
      organizer: "Banca Sintética",
      year: 2027,
      role: "Analista",
      subject: "Direito",
      kind: "multiple-choice",
      examId: "gamma-2027",
    });
    assertEquals(page.total, 1);
    assertEquals(page.items[0].exam.externalId, "gamma-2027");
    assertEquals(page.items[0].number, 3);
  });
});

Deno.test("paginação preserva total completo e ordem estável", async () => {
  await withStudyDatabase((database) => {
    const page = listQuestionOccurrences(database, { limit: 2, offset: 1 });
    assertEquals(page.total, 4);
    assertEquals(page.limit, 2);
    assertEquals(page.offset, 1);
    assertEquals(
      page.items.map((item) => [item.exam.externalId, item.number]),
      [["alpha-2026", 2], ["beta-2027", 5]],
    );
  });
});

Deno.test("deduplicate escolhe a ocorrência mais antiga na ordem documentada", async () => {
  await withStudyDatabase((database) => {
    const page = listQuestionOccurrences(database, { deduplicate: true });
    assertEquals(page.total, 3);
    assertEquals(new Set(page.items.map((item) => item.questionId)).size, 3);
    assertEquals(
      page.items.map((item) => [item.exam.externalId, item.number]),
      [
        ["alpha-2026", 1],
        ["alpha-2026", 2],
        ["gamma-2027", 3],
      ],
    );
  });
});

Deno.test("alternativas são carregadas uma vez e ordenadas por posição", async () => {
  await withStudyDatabase((database) => {
    const item = listQuestionOccurrences(database, { examId: "gamma-2027" })
      .items[0];
    assertEquals(
      item.alternatives.map((alternative) => [
        alternative.label,
        alternative.position,
      ]),
      [["B", 0], ["A", 1], ["C", 2]],
    );
  });
});

Deno.test("listagem e detalhe padrão não expõem gabarito", async () => {
  await withStudyDatabase((database) => {
    const listed = listQuestionOccurrences(database).items[0];
    const detailed = getQuestionOccurrence(database, listed.occurrenceId);
    if (!detailed) throw new Error("A ocorrência deveria existir.");
    for (const item of [listed, detailed]) {
      assertEquals(Object.hasOwn(item, "answerLabel"), false);
      assertEquals(Object.hasOwn(item, "answer_label"), false);
      assertEquals(JSON.stringify(item).includes("answer_label"), false);
    }
  });
});

Deno.test("detalhe inclui gabarito somente por opção explícita", async () => {
  await withStudyDatabase((database) => {
    const occurrence = listQuestionOccurrences(database, {
      examId: "gamma-2027",
    }).items[0];
    const detail = getQuestionOccurrence(database, occurrence.occurrenceId, {
      includeAnswer: true,
    });
    if (!detail) throw new Error("A ocorrência deveria existir.");
    assertEquals(detail.answerLabel, "A");
    assertEquals(detail.alternatives.length, 3);
  });
});

Deno.test("detalhe inexistente retorna null", async () => {
  await withStudyDatabase((database) => {
    assertEquals(getQuestionOccurrence(database, 999_999), null);
  });
});

Deno.test("paginação inválida falha antes de consultar o banco", () => {
  let queries = 0;
  const database = {
    prepare: () => {
      queries++;
      throw new Error("Não deveria consultar.");
    },
  } as unknown as Database;
  const invalidFilters = [
    { limit: 0 },
    { limit: -1 },
    { limit: 1.5 },
    { limit: Number.NaN },
    { limit: MAX_QUESTION_LIMIT + 1 },
    { offset: -1 },
    { offset: 1.5 },
    { offset: Number.NaN },
    { offset: Number.POSITIVE_INFINITY },
  ];
  for (const filters of invalidFilters) {
    try {
      listQuestionOccurrences(database, filters);
      throw new Error("A paginação deveria falhar.");
    } catch (error) {
      if (!(error instanceof QuestionQueryValidationError)) throw error;
    }
  }
  assertEquals(queries, 0);
});

Deno.test("consultas de questões não alteram o banco", async () => {
  await withStudyDatabase((database) => {
    const before = database.prepare("SELECT total_changes() AS value")
      .get() as {
        value: number;
      };
    const page = listQuestionOccurrences(database, { deduplicate: true });
    getQuestionOccurrence(database, page.items[0].occurrenceId, {
      includeAnswer: true,
    });
    const after = database.prepare("SELECT total_changes() AS value").get() as {
      value: number;
    };
    assertEquals(after.value, before.value);
  });
});
