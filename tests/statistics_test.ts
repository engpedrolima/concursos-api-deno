import { recordAttempt } from "../database/attempts.ts";
import type { Database } from "../database/connection.ts";
import { openDatabase } from "../database/connection.ts";
import { persistImportArtifact } from "../database/import_artifact.ts";
import { runMigrations } from "../database/migrations.ts";
import {
  getStudyStatistics,
  MISSING_SUBJECT_LABEL,
  StatisticsValidationError,
} from "../database/statistics.ts";
import { runStatisticsCli } from "../database/statistics_cli.ts";
import {
  type ImportArtifact,
  parseImportArtifact,
} from "../importer/artifact.ts";
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

function assertInstanceOf<T extends Error>(
  operation: () => unknown,
  errorType: new (...args: never[]) => T,
): T {
  try {
    operation();
  } catch (error) {
    if (error instanceof errorType) return error;
    throw error;
  }
  throw new Error(`Era esperado um erro ${errorType.name}.`);
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

interface StatisticsOccurrences {
  alphaShared: number;
  alphaCertoErrado: number;
  alphaUnanswered: number;
  betaShared: number;
  betaTechnology: number;
}

async function seedStatisticsDatabase(
  database: Database,
  withAttempts = true,
): Promise<StatisticsOccurrences> {
  const base = parseImportArtifact(await Deno.readTextFile(fixtureUrl));
  const alpha = retargetExam(base, {
    id: "alpha-2020",
    organizer: "Banca Alpha",
    year: 2020,
    role: "Analista",
    subject: "Geral",
  });
  alpha.rejected = [];
  alpha.questions[0].subject = undefined;
  const certoErrado = structuredClone(alpha.questions[0]);
  certoErrado.number = 2;
  certoErrado.statement = "O cenário estatístico sintético está correto.";
  certoErrado.alternatives = { C: "Certo", E: "Errado" };
  certoErrado.answer = "C";
  certoErrado.subject = "Direito";
  const unanswered = structuredClone(alpha.questions[0]);
  unanswered.number = 3;
  unanswered.statement = "Questão sintética ainda não respondida.";
  unanswered.subject = "Sem respostas";
  alpha.questions.push(certoErrado, unanswered);
  alpha.diagnostics.questionHeaders = 3;
  alpha.diagnostics.multipleChoiceCandidates = 2;
  alpha.diagnostics.certoErradoCandidates = 1;

  const beta = retargetExam(base, {
    id: "beta-2021",
    organizer: "Banca Beta",
    year: 2021,
    role: "Auditor",
  });
  beta.rejected = [];
  beta.questions[0].number = 5;
  beta.questions[0].subject = undefined;
  const technology = structuredClone(beta.questions[0]);
  technology.number = 6;
  technology.statement = "Qual alternativa mede a precisão sintética?";
  technology.alternatives = { A: "Correta", B: "Incorreta" };
  technology.answer = "A";
  technology.subject = "Tecnologia";
  beta.questions.push(technology);
  beta.diagnostics.questionHeaders = 2;
  beta.diagnostics.multipleChoiceCandidates = 2;
  beta.diagnostics.certoErradoCandidates = 0;

  persistImportArtifact(database, alpha);
  persistImportArtifact(database, beta);
  const rows = database.prepare(`
    SELECT qo.id, e.external_id, qo.number
    FROM question_occurrences AS qo
    JOIN exams AS e ON e.id = qo.exam_id
  `).all() as unknown as Array<{
    id: number;
    external_id: string;
    number: number;
  }>;
  const id = (externalId: string, number: number): number => {
    const row = rows.find((candidate) =>
      candidate.external_id === externalId &&
      Number(candidate.number) === number
    );
    if (!row) throw new Error(`Ocorrência ${externalId}#${number} ausente.`);
    return Number(row.id);
  };
  const occurrences = {
    alphaShared: id("alpha-2020", 1),
    alphaCertoErrado: id("alpha-2020", 2),
    alphaUnanswered: id("alpha-2020", 3),
    betaShared: id("beta-2021", 5),
    betaTechnology: id("beta-2021", 6),
  };
  if (withAttempts) {
    recordAttempt(database, {
      questionOccurrenceId: occurrences.alphaShared,
      selectedLabel: "A",
    });
    recordAttempt(database, {
      questionOccurrenceId: occurrences.alphaShared,
      selectedLabel: "B",
    });
    recordAttempt(database, {
      questionOccurrenceId: occurrences.alphaCertoErrado,
      selectedLabel: "E",
    });
    recordAttempt(database, {
      questionOccurrenceId: occurrences.betaShared,
      selectedLabel: "B",
    });
    recordAttempt(database, {
      questionOccurrenceId: occurrences.betaTechnology,
      selectedLabel: "A",
    });
    recordAttempt(database, {
      questionOccurrenceId: occurrences.betaTechnology,
      selectedLabel: "A",
    });
    recordAttempt(database, {
      questionOccurrenceId: occurrences.betaTechnology,
      selectedLabel: "B",
    });
  }
  return occurrences;
}

async function withStatisticsDatabase(
  operation: (
    database: Database,
    occurrences: StatisticsOccurrences,
  ) => void | Promise<void>,
  withAttempts = true,
): Promise<void> {
  const directory = await Deno.makeTempDir({ prefix: "statistics-" });
  const database = openDatabase(join(directory, "study.sqlite3"));
  try {
    runMigrations(database);
    const occurrences = await seedStatisticsDatabase(database, withAttempts);
    await operation(database, occurrences);
  } finally {
    database.close();
    await Deno.remove(directory, { recursive: true });
  }
}

Deno.test("banco sem ocorrências ou tentativas retorna métricas zeradas", async () => {
  const directory = await Deno.makeTempDir({ prefix: "statistics-empty-" });
  const database = openDatabase(join(directory, "empty.sqlite3"));
  try {
    runMigrations(database);
    assertEquals(getStudyStatistics(database), {
      attempts: { total: 0, correct: 0, incorrect: 0, accuracyPercent: 0 },
      occurrences: {
        total: 0,
        answered: 0,
        unanswered: 0,
        latestCorrect: 0,
        latestIncorrect: 0,
        latestAccuracyPercent: 0,
      },
      bySubject: [],
    });
  } finally {
    database.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("tentativas contam todas as respostas e ocorrências usam a última", async () => {
  await withStatisticsDatabase((database) => {
    const statistics = getStudyStatistics(database);
    assertEquals(statistics.attempts, {
      total: 7,
      correct: 4,
      incorrect: 3,
      accuracyPercent: 57.14,
    });
    assertEquals(statistics.occurrences, {
      total: 5,
      answered: 4,
      unanswered: 1,
      latestCorrect: 2,
      latestIncorrect: 2,
      latestAccuracyPercent: 50,
    });
  });
});

Deno.test("ocorrência sem resposta integra total e percentuais permanecem zero", async () => {
  await withStatisticsDatabase((database) => {
    const statistics = getStudyStatistics(database, {
      subject: "Sem respostas",
    });
    assertEquals(statistics.attempts, {
      total: 0,
      correct: 0,
      incorrect: 0,
      accuracyPercent: 0,
    });
    assertEquals(statistics.occurrences, {
      total: 1,
      answered: 0,
      unanswered: 1,
      latestCorrect: 0,
      latestIncorrect: 0,
      latestAccuracyPercent: 0,
    });
  });
});

Deno.test("questão canônica repetida em provas conta por ocorrência", async () => {
  await withStatisticsDatabase((database) => {
    const repeated = database.prepare(`
      SELECT question_id, count(*) AS total
      FROM question_occurrences
      GROUP BY question_id
      HAVING count(*) > 1
    `).get() as { question_id: number; total: number };
    assertEquals(Number(repeated.total), 2);
    const multipleChoice = getStudyStatistics(database, {
      kind: "multiple-choice",
    });
    assertEquals(multipleChoice.occurrences.total, 4);
    assertEquals(multipleChoice.attempts.total, 6);
    assertEquals(multipleChoice.attempts.accuracyPercent, 66.67);
  });
});

Deno.test("filtros individuais restringem tentativas e ocorrências", async () => {
  await withStatisticsDatabase((database) => {
    const cases = [
      [{ organizer: "Banca Alpha" }, 3, 3, 1],
      [{ year: 2021 }, 2, 4, 3],
      [{ role: "Auditor" }, 2, 4, 3],
      [{ subject: "Direito" }, 1, 1, 0],
      [{ kind: "certo-errado" as const }, 1, 1, 0],
      [{ examId: "beta-2021" }, 2, 4, 3],
    ] as const;
    for (const [filters, occurrenceTotal, attemptTotal, correct] of cases) {
      const statistics = getStudyStatistics(database, filters);
      assertEquals(statistics.occurrences.total, occurrenceTotal);
      assertEquals(statistics.attempts.total, attemptTotal);
      assertEquals(statistics.attempts.correct, correct);
    }
    assertEquals(
      getStudyStatistics(database, { organizer: "' OR 1=1 --" }).occurrences
        .total,
      0,
    );
  });
});

Deno.test("combinação de filtros é aplicada antes das métricas", async () => {
  await withStatisticsDatabase((database) => {
    const statistics = getStudyStatistics(database, {
      organizer: "Banca Alpha",
      year: 2020,
      role: "Analista",
      subject: "Direito",
      kind: "certo-errado",
      examId: "alpha-2020",
    });
    assertEquals(statistics.occurrences, {
      total: 1,
      answered: 1,
      unanswered: 0,
      latestCorrect: 0,
      latestIncorrect: 1,
      latestAccuracyPercent: 0,
    });
    assertEquals(statistics.attempts, {
      total: 1,
      correct: 0,
      incorrect: 1,
      accuracyPercent: 0,
    });
  });
});

Deno.test("filtro de progresso restringe listagem estatística elegível", async () => {
  await withStatisticsDatabase((database) => {
    const unanswered = getStudyStatistics(database, { progress: "unanswered" });
    assertEquals(unanswered.occurrences.total, 1);
    assertEquals(unanswered.attempts.total, 0);

    const answered = getStudyStatistics(database, { progress: "answered" });
    assertEquals(answered.occurrences.total, 4);
    assertEquals(answered.attempts.total, 7);

    const latestCorrect = getStudyStatistics(database, {
      progress: "latest-correct",
    });
    assertEquals(latestCorrect.occurrences.total, 2);
    assertEquals(latestCorrect.occurrences.latestCorrect, 2);

    const latestIncorrect = getStudyStatistics(database, {
      progress: "latest-incorrect",
      organizer: "Banca Alpha",
    });
    assertEquals(latestIncorrect.occurrences.total, 1);
    assertEquals(latestIncorrect.occurrences.latestIncorrect, 1);
  });
});

Deno.test("quebra por assunto usa fallback, label ausente e ordem estável", async () => {
  await withStatisticsDatabase((database) => {
    const groups = getStudyStatistics(database).bySubject;
    assertEquals(
      groups.map((group) => group.subject),
      [
        MISSING_SUBJECT_LABEL,
        "Direito",
        "Geral",
        "Sem respostas",
        "Tecnologia",
      ],
    );
    const missing = groups[0];
    assertEquals(missing.attempts, {
      total: 1,
      correct: 1,
      incorrect: 0,
      accuracyPercent: 100,
    });
    assertEquals(missing.occurrences.latestCorrect, 1);
    const fallback = groups.find((group) => group.subject === "Geral");
    assertEquals(fallback?.occurrences.total, 1);
    assertEquals(fallback?.attempts.accuracyPercent, 50);
    const technology = groups.find((group) => group.subject === "Tecnologia");
    assertEquals(technology?.attempts.accuracyPercent, 66.67);
    assertEquals(technology?.occurrences.latestAccuracyPercent, 0);
  });
});

Deno.test("CLI com separador inicial imprime JSON e respeita filtros", async () => {
  const directory = await Deno.makeTempDir({ prefix: "statistics-cli-" });
  const path = join(directory, "stats.sqlite3");
  const seedDatabase = openDatabase(path);
  try {
    runMigrations(seedDatabase);
    await seedStatisticsDatabase(seedDatabase);
  } finally {
    seedDatabase.close();
  }
  try {
    const command = new Deno.Command("deno", {
      args: [
        "task",
        "db:stats",
        "--",
        "--database",
        path,
        "--organizer",
        "Banca Beta",
        "--year",
        "2021",
        "--role",
        "Auditor",
        "--kind",
        "multiple-choice",
        "--exam-id",
        "beta-2021",
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await command.output();
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);
    if (!output.success) {
      throw new Error(`db:stats falhou (${output.code}): ${stderr}`);
    }
    const statistics = JSON.parse(stdout);
    assertEquals(statistics.occurrences.total, 2);
    assertEquals(statistics.attempts.total, 4);
    assertEquals(statistics.attempts.correct, 3);
    assertEquals(statistics.bySubject.length, 2);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("argumentos inválidos da CLI falham antes de abrir banco", () => {
  let opened = 0;
  const invalidArguments = [
    ["--unknown", "value"],
    ["--", "--", "--year", "2020"],
    ["--year", "abc"],
    ["--year", "1899"],
    ["--kind", "dissertativa"],
    ["--organizer", ""],
  ];
  for (const args of invalidArguments) {
    assertInstanceOf(
      () =>
        runStatisticsCli(args, {
          openDatabase: () => {
            opened++;
            throw new Error("Não deveria abrir o banco.");
          },
        }),
      Error,
    );
  }
  assertEquals(opened, 0);

  let queries = 0;
  const fakeDatabase = {
    prepare: () => {
      queries++;
      throw new Error("Não deveria consultar.");
    },
  } as unknown as Database;
  assertInstanceOf(
    () =>
      getStudyStatistics(fakeDatabase, {
        kind: "dissertativa" as "multiple-choice",
      }),
    StatisticsValidationError,
  );
  assertEquals(queries, 0);
});

Deno.test("consulta de estatísticas não altera o banco", async () => {
  await withStatisticsDatabase((database) => {
    const before = database.prepare("SELECT total_changes() AS value")
      .get() as {
        value: number;
      };
    getStudyStatistics(database);
    getStudyStatistics(database, { examId: "alpha-2020" });
    const after = database.prepare("SELECT total_changes() AS value").get() as {
      value: number;
    };
    assertEquals(after.value, before.value);
  });
});
