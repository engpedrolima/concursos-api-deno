import {
  _attemptTesting,
  AttemptValidationError,
  getAttemptHistory,
  InvalidAlternativeError,
  MAX_ATTEMPT_DURATION_MS,
  QuestionOccurrenceNotFoundError,
  recordAttempt,
} from "../database/attempts.ts";
import { parseAnswerArguments, runAnswerCli } from "../database/answer_cli.ts";
import type { Database } from "../database/connection.ts";
import { openDatabase } from "../database/connection.ts";
import { persistImportArtifact } from "../database/import_artifact.ts";
import { runMigrations } from "../database/migrations.ts";
import { parseImportArtifact } from "../importer/artifact.ts";
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

interface SeededOccurrences {
  multipleChoice: number;
  certoErrado: number;
  multipleChoiceQuestion: number;
}

async function seedAttemptsDatabase(
  database: Database,
): Promise<SeededOccurrences> {
  const artifact = parseImportArtifact(await Deno.readTextFile(fixtureUrl));
  artifact.rejected = [];
  const certoErrado = structuredClone(artifact.questions[0]);
  certoErrado.number = 2;
  certoErrado.statement = "O cenário sintético está correto.";
  certoErrado.alternatives = { C: "Certo", E: "Errado" };
  certoErrado.answer = "C";
  certoErrado.subject = "Direito";
  artifact.questions.push(certoErrado);
  artifact.diagnostics.questionHeaders = 2;
  artifact.diagnostics.multipleChoiceCandidates = 1;
  artifact.diagnostics.certoErradoCandidates = 1;
  persistImportArtifact(database, artifact);

  const rows = database.prepare(`
    SELECT id, question_id, number
    FROM question_occurrences
    ORDER BY number
  `).all() as unknown as Array<{
    id: number;
    question_id: number;
    number: number;
  }>;
  return {
    multipleChoice: Number(rows[0].id),
    certoErrado: Number(rows[1].id),
    multipleChoiceQuestion: Number(rows[0].question_id),
  };
}

async function withAttemptsDatabase(
  operation: (
    database: Database,
    occurrences: SeededOccurrences,
    path: string,
  ) => void | Promise<void>,
): Promise<void> {
  const directory = await Deno.makeTempDir({ prefix: "attempts-" });
  const path = join(directory, "study.sqlite3");
  const database = openDatabase(path);
  try {
    runMigrations(database);
    const occurrences = await seedAttemptsDatabase(database);
    await operation(database, occurrences, path);
  } finally {
    database.close();
    await Deno.remove(directory, { recursive: true });
  }
}

const attemptsCount = (database: Database): number => {
  const row = database.prepare("SELECT count(*) AS total FROM attempts")
    .get() as {
      total: number;
    };
  return Number(row.total);
};

Deno.test("tentativas correta e incorreta usam o gabarito interno como snapshot", async () => {
  await withAttemptsDatabase((database, occurrences) => {
    const correct = recordAttempt(database, {
      questionOccurrenceId: occurrences.multipleChoice,
      selectedLabel: " b ",
      durationMs: 12_000,
    });
    const incorrect = recordAttempt(database, {
      questionOccurrenceId: occurrences.multipleChoice,
      selectedLabel: "A",
    });
    assertEquals(
      {
        occurrenceId: correct.occurrenceId,
        questionId: correct.questionId,
        selectedLabel: correct.selectedLabel,
        correctLabel: correct.correctLabel,
        isCorrect: correct.isCorrect,
        durationMs: correct.durationMs,
      },
      {
        occurrenceId: occurrences.multipleChoice,
        questionId: occurrences.multipleChoiceQuestion,
        selectedLabel: "B",
        correctLabel: "B",
        isCorrect: true,
        durationMs: 12_000,
      },
    );
    assertEquals(incorrect.selectedLabel, "A");
    assertEquals(incorrect.correctLabel, "B");
    assertEquals(incorrect.isCorrect, false);
    assertEquals(incorrect.durationMs, null);
    assertEquals(Number.isNaN(Date.parse(correct.answeredAt)), false);
    assertEquals(attemptsCount(database), 2);
  });
});

Deno.test("alternativas C e E são aceitas para questão certo-errado", async () => {
  await withAttemptsDatabase((database, occurrences) => {
    const certo = recordAttempt(database, {
      questionOccurrenceId: occurrences.certoErrado,
      selectedLabel: "C",
    });
    const errado = recordAttempt(database, {
      questionOccurrenceId: occurrences.certoErrado,
      selectedLabel: "E",
    });
    assertEquals([certo.correctLabel, certo.isCorrect], ["C", true]);
    assertEquals([errado.correctLabel, errado.isCorrect], ["C", false]);
  });
});

Deno.test("alternativa inválida falha e não cria tentativa", async () => {
  await withAttemptsDatabase((database, occurrences) => {
    const error = assertInstanceOf(
      () =>
        recordAttempt(database, {
          questionOccurrenceId: occurrences.multipleChoice,
          selectedLabel: "Z",
        }),
      InvalidAlternativeError,
    );
    assertEquals(error.occurrenceId, occurrences.multipleChoice);
    assertEquals(attemptsCount(database), 0);
  });
});

Deno.test("ocorrência inexistente falha e não cria tentativa", async () => {
  await withAttemptsDatabase((database) => {
    assertInstanceOf(
      () =>
        recordAttempt(database, {
          questionOccurrenceId: 999_999,
          selectedLabel: "A",
        }),
      QuestionOccurrenceNotFoundError,
    );
    assertEquals(attemptsCount(database), 0);
  });
});

Deno.test("durationMs inválido falha antes de acessar o banco", () => {
  let accesses = 0;
  const database = {
    exec: () => {
      accesses++;
      throw new Error("Não deveria acessar o banco.");
    },
    prepare: () => {
      accesses++;
      throw new Error("Não deveria acessar o banco.");
    },
  } as unknown as Database;
  for (
    const durationMs of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      MAX_ATTEMPT_DURATION_MS + 1,
    ]
  ) {
    assertInstanceOf(
      () =>
        recordAttempt(database, {
          questionOccurrenceId: 1,
          selectedLabel: "A",
          durationMs,
        }),
      AttemptValidationError,
    );
  }
  assertEquals(accesses, 0);

  let opened = 0;
  assertInstanceOf(
    () =>
      runAnswerCli(
        [
          "--occurrence-id",
          "1",
          "--selected-label",
          "A",
          "--duration-ms",
          String(MAX_ATTEMPT_DURATION_MS + 1),
        ],
        {
          openDatabase: () => {
            opened++;
            throw new Error("Não deveria abrir o banco.");
          },
        },
      ),
    AttemptValidationError,
  );
  assertEquals(opened, 0);
});

Deno.test("duas respostas para a mesma ocorrência preservam duas tentativas", async () => {
  await withAttemptsDatabase((database, occurrences) => {
    const first = recordAttempt(database, {
      questionOccurrenceId: occurrences.multipleChoice,
      selectedLabel: "A",
    });
    const second = recordAttempt(database, {
      questionOccurrenceId: occurrences.multipleChoice,
      selectedLabel: "B",
    });
    assertEquals(first.attemptId === second.attemptId, false);
    assertEquals(attemptsCount(database), 2);
  });
});

Deno.test("histórico ordena por data e ID sem misturar ocorrências", async () => {
  await withAttemptsDatabase((database, occurrences) => {
    const first = _attemptTesting.recordAttemptWithClock(
      database,
      {
        questionOccurrenceId: occurrences.multipleChoice,
        selectedLabel: "A",
      },
      () => new Date("2026-08-20T10:00:00.000Z"),
    );
    const other = _attemptTesting.recordAttemptWithClock(
      database,
      {
        questionOccurrenceId: occurrences.certoErrado,
        selectedLabel: "C",
      },
      () => new Date("2026-08-20T11:00:00.000Z"),
    );
    const second = _attemptTesting.recordAttemptWithClock(
      database,
      {
        questionOccurrenceId: occurrences.multipleChoice,
        selectedLabel: "B",
      },
      () => new Date("2026-08-20T12:00:00.000Z"),
    );
    const tied = _attemptTesting.recordAttemptWithClock(
      database,
      {
        questionOccurrenceId: occurrences.multipleChoice,
        selectedLabel: "A",
      },
      () => new Date("2026-08-20T12:00:00.000Z"),
    );
    const history = getAttemptHistory(database, occurrences.multipleChoice);
    if (!history) throw new Error("O histórico deveria existir.");
    assertEquals(
      history.map((attempt) => attempt.attemptId),
      [tied.attemptId, second.attemptId, first.attemptId],
    );
    assertEquals(
      history.some((attempt) => attempt.attemptId === other.attemptId),
      false,
    );
    assertEquals(
      getAttemptHistory(database, occurrences.certoErrado)?.length,
      1,
    );
  });
});

Deno.test("histórico conserva snapshot após alteração controlada do gabarito", async () => {
  await withAttemptsDatabase((database, occurrences) => {
    const attempt = _attemptTesting.recordAttemptWithClock(
      database,
      {
        questionOccurrenceId: occurrences.multipleChoice,
        selectedLabel: "B",
      },
      () => new Date("2026-08-20T12:00:00.000Z"),
    );
    database.prepare("UPDATE questions SET answer_label = 'A' WHERE id = ?")
      .run(occurrences.multipleChoiceQuestion);
    const history = getAttemptHistory(database, occurrences.multipleChoice);
    if (!history) throw new Error("O histórico deveria existir.");
    assertEquals(history[0].attemptId, attempt.attemptId);
    assertEquals(history[0].correctLabel, "B");
    assertEquals(history[0].isCorrect, true);
  });
});

Deno.test("histórico diferencia ocorrência inexistente de histórico vazio", async () => {
  await withAttemptsDatabase((database, occurrences) => {
    assertEquals(getAttemptHistory(database, 999_999), null);
    assertEquals(getAttemptHistory(database, occurrences.multipleChoice), []);
  });
});

Deno.test("CLI usa banco indicado, grava e imprime correção JSON", async () => {
  const directory = await Deno.makeTempDir({ prefix: "answer-cli-" });
  const path = join(directory, "cli.sqlite3");
  let occurrences: SeededOccurrences;
  const seedDatabase = openDatabase(path);
  try {
    runMigrations(seedDatabase);
    occurrences = await seedAttemptsDatabase(seedDatabase);
  } finally {
    seedDatabase.close();
  }
  try {
    const messages: string[] = [];
    const result = runAnswerCli(
      [
        "--occurrence-id",
        String(occurrences.multipleChoice),
        "--selected-label",
        "B",
        "--duration-ms",
        "12000",
        "--database",
        path,
      ],
      { log: (message) => messages.push(message) },
    );
    if (!result) throw new Error("A CLI deveria retornar uma correção.");
    const output = JSON.parse(messages[0]);
    assertEquals(output, result);
    assertEquals(output.isCorrect, true);
    assertEquals(output.correctLabel, "B");
    assertEquals(output.durationMs, 12_000);

    const checkDatabase = openDatabase(path);
    try {
      const history = getAttemptHistory(
        checkDatabase,
        occurrences.multipleChoice,
      );
      assertEquals(history?.length, 1);
      assertEquals(history?.[0].attemptId, result.attemptId);
    } finally {
      checkDatabase.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("task db:answer aceita separador inicial e emite correção JSON", async () => {
  const directory = await Deno.makeTempDir({ prefix: "answer-task-" });
  const path = join(directory, "task.sqlite3");
  let occurrences: SeededOccurrences;
  const seedDatabase = openDatabase(path);
  try {
    runMigrations(seedDatabase);
    occurrences = await seedAttemptsDatabase(seedDatabase);
  } finally {
    seedDatabase.close();
  }
  try {
    const command = new Deno.Command("deno", {
      args: [
        "task",
        "db:answer",
        "--",
        "--occurrence-id",
        String(occurrences.multipleChoice),
        "--selected-label",
        "A",
        "--duration-ms",
        "12000",
        "--database",
        path,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await command.output();
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);
    if (!output.success) {
      throw new Error(`db:answer falhou (${output.code}): ${stderr}`);
    }
    const feedback = JSON.parse(stdout);
    assertEquals(feedback.occurrenceId, occurrences.multipleChoice);
    assertEquals(feedback.selectedLabel, "A");
    assertEquals(feedback.correctLabel, "B");
    assertEquals(feedback.isCorrect, false);
    assertEquals(feedback.durationMs, 12_000);

    const checkDatabase = openDatabase(path);
    try {
      const history = getAttemptHistory(
        checkDatabase,
        occurrences.multipleChoice,
      );
      assertEquals(history?.length, 1);
      assertEquals(history?.[0].attemptId, feedback.attemptId);
    } finally {
      checkDatabase.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CLI descarta exclusivamente um separador inicial", () => {
  const parsed = parseAnswerArguments([
    "--",
    "--occurrence-id",
    "1",
    "--selected-label",
    "A",
  ]);
  assertEquals(parsed.input.questionOccurrenceId, 1);
  const duplicate = assertInstanceOf(
    () =>
      parseAnswerArguments([
        "--",
        "--",
        "--occurrence-id",
        "1",
        "--selected-label",
        "A",
      ]),
    Error,
  );
  assertEquals(duplicate.message, "Argumento desconhecido: --.");
  const misplaced = assertInstanceOf(
    () =>
      parseAnswerArguments([
        "--occurrence-id",
        "1",
        "--selected-label",
        "A",
        "--",
      ]),
    Error,
  );
  assertEquals(misplaced.message, "Argumento desconhecido: --.");
});

Deno.test("consulta de histórico é somente leitura no banco fornecido", async () => {
  await withAttemptsDatabase((database, occurrences) => {
    recordAttempt(database, {
      questionOccurrenceId: occurrences.multipleChoice,
      selectedLabel: "B",
    });
    const before = database.prepare("SELECT total_changes() AS value")
      .get() as {
        value: number;
      };
    getAttemptHistory(database, occurrences.multipleChoice);
    const after = database.prepare("SELECT total_changes() AS value").get() as {
      value: number;
    };
    assertEquals(after.value, before.value);
  });
});
