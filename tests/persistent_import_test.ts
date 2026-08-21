import {
  type ImportArtifact,
  ImportArtifactValidationError,
  parseImportArtifact,
} from "../importer/artifact.ts";
import type { Database } from "../database/connection.ts";
import { openDatabase } from "../database/connection.ts";
import { runDatabaseImportCli } from "../database/import_cli.ts";
import {
  ExamMetadataConflictError,
  ImportTransactionError,
  OccurrenceConflictError,
  persistImportArtifact,
} from "../database/import_artifact.ts";
import { runMigrations } from "../database/migrations.ts";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureUrl = new URL(
  "./fixtures/import-artifact-v1.json",
  import.meta.url,
);

const fixture = async (): Promise<ImportArtifact> =>
  parseImportArtifact(await Deno.readTextFile(fixtureUrl));

const assertEquals = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
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

function assertThrows<T extends Error>(
  operation: () => unknown,
  errorType: new (...args: never[]) => T,
  expectedMessage?: RegExp,
): T {
  try {
    operation();
    throw new Error("A operação deveria falhar.");
  } catch (error) {
    if (!(error instanceof errorType)) throw error;
    if (expectedMessage) assertMatch(error.message, expectedMessage);
    return error;
  }
}

async function withTemporaryDatabase(
  operation: (database: Database) => void | Promise<void>,
): Promise<void> {
  const directory = await Deno.makeTempDir({ prefix: "persistent-import-" });
  const database = openDatabase(join(directory, "test.sqlite3"));
  try {
    runMigrations(database);
    await operation(database);
  } finally {
    database.close();
    await Deno.remove(directory, { recursive: true });
  }
}

function count(database: Database, table: string): number {
  const allowed = new Set([
    "exams",
    "questions",
    "alternatives",
    "question_occurrences",
    "import_batches",
    "import_occurrences",
  ]);
  if (!allowed.has(table)) throw new Error(`Tabela não permitida: ${table}`);
  return (database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as {
    count: number;
  }).count;
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

Deno.test("primeira importação cria todas as entidades e a proveniência", async () => {
  await withTemporaryDatabase(async (database) => {
    const artifact = await fixture();
    const result = persistImportArtifact(database, artifact);
    assertEquals(result.alreadyImported, false);
    assertEquals(result.batch.status, "created");
    assertEquals(result.exam.status, "created");
    assertEquals(result.canonicalQuestions, { created: 1, reused: 0 });
    assertEquals(result.occurrences, { created: 1, reused: 0 });
    assertEquals(result.rejected, 1);
    assertEquals(count(database, "exams"), 1);
    assertEquals(count(database, "import_batches"), 1);
    assertEquals(count(database, "questions"), 1);
    assertEquals(count(database, "alternatives"), 2);
    assertEquals(count(database, "question_occurrences"), 1);
    assertEquals(count(database, "import_occurrences"), 1);

    const batch = database.prepare(`
      SELECT schema_version, importer_version, documents_json,
             diagnostics_json, rejected_json
      FROM import_batches
    `).get() as Record<string, string | number>;
    assertEquals(batch.schema_version, 1);
    assertEquals(batch.importer_version, "1.0.0");
    assertEquals(JSON.parse(String(batch.documents_json)), artifact.documents);
    assertEquals(
      JSON.parse(String(batch.diagnostics_json)),
      artifact.diagnostics,
    );
    assertEquals(JSON.parse(String(batch.rejected_json)), artifact.rejected);
  });
});

Deno.test("reimportação do mesmo lote é no-op explícito", async () => {
  await withTemporaryDatabase(async (database) => {
    const artifact = await fixture();
    const first = persistImportArtifact(database, artifact);
    const second = persistImportArtifact(database, structuredClone(artifact));
    assertEquals(second.alreadyImported, true);
    assertEquals(second.batch, { id: first.batch.id, status: "reused" });
    assertEquals(second.canonicalQuestions, { created: 0, reused: 1 });
    assertEquals(second.occurrences, { created: 0, reused: 1 });
    for (
      const table of [
        "exams",
        "import_batches",
        "questions",
        "question_occurrences",
        "import_occurrences",
      ]
    ) {
      assertEquals(count(database, table), 1);
    }
  });
});

Deno.test("mesmo conteúdo normalizado em duas provas reutiliza questão canônica", async () => {
  await withTemporaryDatabase(async (database) => {
    const firstArtifact = await fixture();
    persistImportArtifact(database, firstArtifact);
    const secondArtifact = retargetExam(firstArtifact, {
      id: "outra-prova-2027",
      organizer: "Outra Banca",
      year: 2027,
      role: "Auditor",
      subject: "Outro assunto",
    });
    secondArtifact.questions[0].statement = `  ${
      secondArtifact.questions[0].statement.replaceAll(" ", "  ")
    }  `;
    secondArtifact.questions[0].alternatives.A = " Primeira   opção ";
    secondArtifact.questions[0].number = 99;
    const result = persistImportArtifact(database, secondArtifact);
    assertEquals(result.canonicalQuestions, { created: 0, reused: 1 });
    assertEquals(result.occurrences, { created: 1, reused: 0 });
    assertEquals(count(database, "exams"), 2);
    assertEquals(count(database, "questions"), 1);
    assertEquals(count(database, "question_occurrences"), 2);
  });
});

Deno.test("mesmo número com conteúdos diferentes é permitido em provas diferentes", async () => {
  await withTemporaryDatabase(async (database) => {
    const firstArtifact = await fixture();
    persistImportArtifact(database, firstArtifact);
    const secondArtifact = retargetExam(firstArtifact, {
      ...firstArtifact.exam,
      id: "prova-independente-2026",
    });
    secondArtifact.questions[0].statement = "Outro enunciado sintético.";
    const result = persistImportArtifact(database, secondArtifact);
    assertEquals(result.canonicalQuestions, { created: 1, reused: 0 });
    assertEquals(result.occurrences, { created: 1, reused: 0 });
    assertEquals(count(database, "questions"), 2);
    assertEquals(count(database, "question_occurrences"), 2);
  });
});

Deno.test("colisão na mesma ocorrência reverte lote e questão parciais", async () => {
  await withTemporaryDatabase(async (database) => {
    const artifact = await fixture();
    persistImportArtifact(database, artifact);
    const conflicting = structuredClone(artifact);
    conflicting.documents.answerKey.collectedAt = "2026-08-21T12:00:01.000Z";
    conflicting.questions[0].statement =
      "Conteúdo conflitante para o número 1.";
    const error = assertThrows(
      () => persistImportArtifact(database, conflicting),
      OccurrenceConflictError,
      /já aponta para outra questão canônica/,
    );
    assertEquals(error.reason, "different-question");
    assertEquals(count(database, "import_batches"), 1);
    assertEquals(count(database, "questions"), 1);
    assertEquals(count(database, "alternatives"), 2);
    assertEquals(count(database, "question_occurrences"), 1);
    assertEquals(count(database, "import_occurrences"), 1);
  });
});

Deno.test("novo lote idêntico cria apenas vínculo de proveniência ausente", async () => {
  await withTemporaryDatabase(async (database) => {
    const artifact = await fixture();
    persistImportArtifact(database, artifact);
    const newBatch = structuredClone(artifact);
    newBatch.documents.answerKey.collectedAt = "2026-08-22T12:00:01.000Z";
    const result = persistImportArtifact(database, newBatch);
    assertEquals(result.alreadyImported, false);
    assertEquals(result.batch.status, "created");
    assertEquals(result.exam.status, "reused");
    assertEquals(result.canonicalQuestions, { created: 0, reused: 1 });
    assertEquals(result.occurrences, { created: 0, reused: 1 });
    assertEquals(count(database, "import_batches"), 2);
    assertEquals(count(database, "questions"), 1);
    assertEquals(count(database, "question_occurrences"), 1);
    assertEquals(count(database, "import_occurrences"), 2);
  });
});

Deno.test("metadados divergentes da mesma prova falham sem sobrescrita", async () => {
  await withTemporaryDatabase(async (database) => {
    const artifact = await fixture();
    persistImportArtifact(database, artifact);
    const divergent = retargetExam(artifact, {
      ...artifact.exam,
      organizer: "Banca Divergente",
    });
    const error = assertThrows(
      () => persistImportArtifact(database, divergent),
      ExamMetadataConflictError,
      /metadados divergentes: organizer/,
    );
    assertEquals(error.differences, ["organizer"]);
    assertEquals(count(database, "exams"), 1);
    assertEquals(count(database, "import_batches"), 1);
  });
});

Deno.test("falha inesperada de banco produz erro transacional tipado", async () => {
  const directory = await Deno.makeTempDir({ prefix: "transaction-error-" });
  const database = openDatabase(join(directory, "empty.sqlite3"));
  try {
    const artifact = await fixture();
    assertThrows(
      () => persistImportArtifact(database, artifact),
      ImportTransactionError,
      /no such table: import_batches/,
    );
  } finally {
    database.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("artefato inválido falha antes de abrir o banco", async () => {
  const invalidJson = await Deno.readTextFile(
    new URL("./fixtures/import-artifact-incomplete.json", import.meta.url),
  );
  let opened = 0;
  try {
    await runDatabaseImportCli(["--artifact", "invalido.json"], {
      readTextFile: () => Promise.resolve(invalidJson),
      openDatabase: () => {
        opened++;
        throw new Error("O banco não deveria ser aberto.");
      },
      log: () => undefined,
    });
    throw new Error("A validação deveria falhar.");
  } catch (error) {
    if (!(error instanceof ImportArtifactValidationError)) throw error;
    assertMatch(error.message, /documents\.answerKey/);
  }
  assertEquals(opened, 0);
});

Deno.test("CLI usa o banco indicado e imprime resumo JSON verificável", async () => {
  const directory = await Deno.makeTempDir({ prefix: "db-import-cli-" });
  const databasePath = join(directory, "indicado.sqlite3");
  const logs: string[] = [];
  try {
    const result = await runDatabaseImportCli([
      "--artifact",
      fileURLToPath(fixtureUrl),
      "--database",
      databasePath,
    ], { log: (message) => logs.push(message) });
    if (!result) throw new Error("O CLI deveria retornar um resumo.");
    assertEquals(result.alreadyImported, false);
    assertEquals(JSON.parse(logs.at(-1) ?? "{}"), result);
    const database = openDatabase(databasePath);
    try {
      assertEquals(count(database, "import_batches"), 1);
      assertEquals(count(database, "question_occurrences"), 1);
    } finally {
      database.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
