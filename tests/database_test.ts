import type { Database } from "../database/connection.ts";
import { openDatabase } from "../database/connection.ts";
import {
  type Migration,
  MigrationError,
  MIGRATIONS,
  runMigrations,
} from "../database/migrations.ts";
import { join } from "node:path";

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

function assertThrows(operation: () => unknown, expected: RegExp): Error {
  try {
    operation();
    throw new Error("A operação deveria falhar.");
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (error.message === "A operação deveria falhar.") throw error;
    assertMatch(error.message, expected);
    return error;
  }
}

async function withTemporaryDatabase(
  operation: (database: Database) => void | Promise<void>,
): Promise<void> {
  const directory = await Deno.makeTempDir({ prefix: "concursos-db-test-" });
  const database = openDatabase(join(directory, "test.sqlite3"));
  try {
    await operation(database);
  } finally {
    database.close();
    await Deno.remove(directory, { recursive: true });
  }
}

function createExam(database: Database, externalId: string): number {
  const result = database.prepare(`
    INSERT INTO exams (external_id, organizer, year, role, subject)
    VALUES (?, 'Banca Sintética', 2026, 'Analista', 'Geral')
  `).run(externalId);
  return Number(result.lastInsertRowid);
}

function createQuestion(database: Database, hashCharacter: string): number {
  const result = database.prepare(`
    INSERT INTO questions
      (content_hash, statement, kind, answer_label)
    VALUES (?, 'Enunciado sintético', 'multiple-choice', 'A')
  `).run(hashCharacter.repeat(64));
  const questionId = Number(result.lastInsertRowid);
  database.prepare(`
    INSERT INTO alternatives (question_id, label, position, text)
    VALUES (?, 'A', 0, 'Alternativa A'), (?, 'B', 1, 'Alternativa B')
  `).run(questionId, questionId);
  return questionId;
}

function createOccurrence(
  database: Database,
  questionId: number,
  examId: number,
  number: number,
): number {
  const result = database.prepare(`
    INSERT INTO question_occurrences (question_id, exam_id, number, subject)
    VALUES (?, ?, ?, 'Geral')
  `).run(questionId, examId, number);
  return Number(result.lastInsertRowid);
}

Deno.test("aplica a migração inicial em banco temporário", async () => {
  await withTemporaryDatabase((database) => {
    assertEquals(runMigrations(database), { applied: [1], skipped: [] });
    const tables = database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map((row) => (row as { name: string }).name);
    assertEquals(tables, [
      "alternatives",
      "attempts",
      "exams",
      "import_batches",
      "import_occurrences",
      "question_occurrences",
      "questions",
      "schema_migrations",
    ]);
    assertEquals(
      (database.prepare("PRAGMA foreign_keys").get() as {
        foreign_keys: number;
      })
        .foreign_keys,
      1,
    );
    const examId = createExam(database, "data-utc");
    const createdAt = database.prepare(
      "SELECT created_at FROM exams WHERE id = ?",
    ).get(examId) as { created_at: string };
    assertMatch(createdAt.created_at, /^\d{4}-\d{2}-\d{2}T.*\.\d{3}Z$/);
  });
});

Deno.test("segunda execução das migrações é idempotente", async () => {
  await withTemporaryDatabase((database) => {
    assertEquals(runMigrations(database), { applied: [1], skipped: [] });
    assertEquals(runMigrations(database), { applied: [], skipped: [1] });
    const count = database.prepare(
      "SELECT count(*) AS count FROM schema_migrations",
    ).get() as { count: number };
    assertEquals(count.count, 1);
  });
});

Deno.test("foreign keys rejeitam referências inexistentes", async () => {
  await withTemporaryDatabase((database) => {
    runMigrations(database);
    assertThrows(
      () =>
        database.exec(`
          INSERT INTO question_occurrences (question_id, exam_id, number)
          VALUES (999, 999, 1)
        `),
      /FOREIGN KEY constraint failed/i,
    );
  });
});

Deno.test("content_hash identifica unicamente a questão canônica", async () => {
  await withTemporaryDatabase((database) => {
    runMigrations(database);
    createQuestion(database, "a");
    assertThrows(
      () =>
        database.prepare(`
          INSERT INTO questions
            (content_hash, statement, kind, answer_label)
          VALUES (?, 'Outro enunciado', 'multiple-choice', 'B')
        `).run("a".repeat(64)),
      /UNIQUE constraint failed: questions\.content_hash/i,
    );
  });
});

Deno.test("mesma questão pode ocorrer em provas diferentes", async () => {
  await withTemporaryDatabase((database) => {
    runMigrations(database);
    const questionId = createQuestion(database, "b");
    const firstExam = createExam(database, "prova-1");
    const secondExam = createExam(database, "prova-2");
    createOccurrence(database, questionId, firstExam, 10);
    createOccurrence(database, questionId, secondExam, 10);
    const count = database.prepare(`
      SELECT count(*) AS count FROM question_occurrences
      WHERE question_id = ?
    `).get(questionId) as { count: number };
    assertEquals(count.count, 2);
  });
});

Deno.test("número é único por prova e pode repetir em outra prova", async () => {
  await withTemporaryDatabase((database) => {
    runMigrations(database);
    const firstQuestion = createQuestion(database, "c");
    const secondQuestion = createQuestion(database, "d");
    const firstExam = createExam(database, "prova-a");
    const secondExam = createExam(database, "prova-b");
    createOccurrence(database, firstQuestion, firstExam, 7);
    assertThrows(
      () => createOccurrence(database, secondQuestion, firstExam, 7),
      /UNIQUE constraint failed: question_occurrences\.exam_id, question_occurrences\.number/i,
    );
    createOccurrence(database, secondQuestion, secondExam, 7);
  });
});

Deno.test("tentativas referenciam ocorrência e não questão canônica", async () => {
  await withTemporaryDatabase((database) => {
    runMigrations(database);
    const questionId = createQuestion(database, "e");
    const examId = createExam(database, "prova-tentativa");
    const occurrenceId = createOccurrence(database, questionId, examId, 3);
    database.prepare(`
      INSERT INTO attempts
        (question_occurrence_id, selected_label, correct_label_snapshot,
         is_correct, duration_ms)
      VALUES (?, 'A', 'A', 1, 1200)
    `).run(occurrenceId);

    const columns = database.prepare("PRAGMA table_info(attempts)").all().map(
      (row) => (row as { name: string }).name,
    );
    assertEquals(columns.includes("question_occurrence_id"), true);
    assertEquals(columns.includes("question_id"), false);
    const foreignKey = database.prepare(
      "PRAGMA foreign_key_list(attempts)",
    ).get() as { table: string; from: string };
    assertEquals(foreignKey.table, "question_occurrences");
    assertEquals(foreignKey.from, "question_occurrence_id");
    assertThrows(
      () =>
        database.exec(`
          INSERT INTO attempts
            (question_occurrence_id, selected_label, correct_label_snapshot,
             is_correct)
          VALUES (999, 'A', 'A', 1)
        `),
      /FOREIGN KEY constraint failed/i,
    );
  });
});

Deno.test("erro em migração reverte DDL, dados e registro da versão", async () => {
  await withTemporaryDatabase((database) => {
    runMigrations(database);
    const brokenMigration: Migration = {
      version: 2,
      name: "broken_for_rollback_test",
      sql: `
        CREATE TABLE partial_state (id INTEGER PRIMARY KEY) STRICT;
        INSERT INTO partial_state (id) VALUES (1);
        INSERT INTO table_that_does_not_exist (id) VALUES (1);
      `,
    };
    const error = assertThrows(
      () => runMigrations(database, [...MIGRATIONS, brokenMigration]),
      /Falha na migração 2.*no such table: table_that_does_not_exist/i,
    );
    assertEquals(error instanceof MigrationError, true);
    assertEquals(
      database.prepare(`
        SELECT name FROM sqlite_schema WHERE name = 'partial_state'
      `).get(),
      undefined,
    );
    assertEquals(
      database.prepare(`
        SELECT version FROM schema_migrations WHERE version = 2
      `).get(),
      undefined,
    );
    const originalMigration = database.prepare(`
      SELECT version FROM schema_migrations WHERE version = 1
    `).get() as { version: number };
    assertEquals(originalMigration.version, 1);
  });
});
