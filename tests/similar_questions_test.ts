import type { Database } from "../database/connection.ts";
import { openDatabase } from "../database/connection.ts";
import { persistImportArtifact } from "../database/import_artifact.ts";
import { runMigrations } from "../database/migrations.ts";
import {
  buildSafeFtsQuery,
  findSimilarQuestionOccurrences,
} from "../database/similar_questions.ts";
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

async function withDatabase(
  operation: (database: Database) => void | Promise<void>,
): Promise<void> {
  const directory = await Deno.makeTempDir({ prefix: "similar-questions-" });
  const database = openDatabase(join(directory, "study.sqlite3"));
  try {
    runMigrations(database);
    await operation(database);
  } finally {
    database.close();
    await Deno.remove(directory, { recursive: true });
  }
}

function insertExam(
  database: Database,
  externalId: string,
  year: number,
  subject: string | null,
): number {
  return Number(
    database.prepare(`
    INSERT INTO exams (external_id, organizer, year, role, subject)
    VALUES (?, 'Banca Local', ?, 'Analista', ?)
  `).run(externalId, year, subject).lastInsertRowid,
  );
}

function insertQuestion(
  database: Database,
  hash: string,
  statement: string,
  kind: "multiple-choice" | "certo-errado" = "multiple-choice",
): number {
  const answer = kind === "certo-errado" ? "C" : "A";
  const id = Number(
    database.prepare(`
    INSERT INTO questions (content_hash, statement, kind, answer_label)
    VALUES (?, ?, ?, ?)
  `).run(hash.repeat(64), statement, kind, answer).lastInsertRowid,
  );
  const alternatives = kind === "certo-errado"
    ? [["C", 0, "Certo"], ["E", 1, "Errado"]]
    : [["A", 0, "Primeira"], ["B", 1, "Segunda"]];
  const insert = database.prepare(`
    INSERT INTO alternatives (question_id, label, position, text)
    VALUES (?, ?, ?, ?)
  `);
  for (const [label, position, text] of alternatives) {
    insert.run(id, label, position, text);
  }
  return id;
}

function insertOccurrence(
  database: Database,
  questionId: number,
  examId: number,
  number: number,
  subject: string | null,
): number {
  return Number(
    database.prepare(`
    INSERT INTO question_occurrences (question_id, exam_id, number, subject)
    VALUES (?, ?, ?, ?)
  `).run(questionId, examId, number, subject).lastInsertRowid,
  );
}

Deno.test("consulta FTS interna remove sintaxe e ignora termos curtos", () => {
  assertEquals(buildSafeFtsQuery("de e a"), null);
  assertEquals(
    buildSafeFtsQuery('Administração "pública" OR legalidade*'),
    '"administracao" OR "publica" OR "legalidade"',
  );
});

Deno.test("importação posterior à migração deixa questão pesquisável", async () => {
  await withDatabase(async (database) => {
    const sourceExam = insertExam(database, "origem-importacao", 2025, "Geral");
    const sourceQuestion = insertQuestion(
      database,
      "1",
      "Qual alternativa identifica conteúdo sintético adicional?",
    );
    const sourceOccurrence = insertOccurrence(
      database,
      sourceQuestion,
      sourceExam,
      1,
      "Geral",
    );

    const artifact = parseImportArtifact(await Deno.readTextFile(fixtureUrl));
    persistImportArtifact(database, artifact);
    const similar = findSimilarQuestionOccurrences(
      database,
      sourceOccurrence,
    );
    assertEquals(similar?.length, 1);
    assertEquals(similar?.[0].exam.externalId, "prova-sintetica-2026");
  });
});

Deno.test("semelhantes excluem origem, deduplicam e ordenam contexto e BM25", async () => {
  await withDatabase((database) => {
    const sourceExam = insertExam(database, "fonte-2024", 2024, "Direito");
    const secondExam = insertExam(database, "repetida-2025", 2025, "Direito");
    const otherExam = insertExam(database, "outra-2026", 2026, "Tecnologia");
    const sourceQuestion = insertQuestion(
      database,
      "2",
      "A administração pública observa legalidade moralidade e eficiência.",
    );
    const sameContext = insertQuestion(
      database,
      "3",
      "Legalidade e moralidade orientam a administração pública eficiente.",
    );
    const otherContext = insertQuestion(
      database,
      "4",
      "A administração de tecnologia busca eficiência.",
      "certo-errado",
    );
    const sourceOccurrence = insertOccurrence(
      database,
      sourceQuestion,
      sourceExam,
      1,
      "Direito",
    );
    const expectedFirst = insertOccurrence(
      database,
      sameContext,
      sourceExam,
      2,
      "Direito",
    );
    insertOccurrence(database, sameContext, secondExam, 7, "Direito");
    insertOccurrence(database, otherContext, otherExam, 3, "Tecnologia");

    const all = findSimilarQuestionOccurrences(database, sourceOccurrence, 20);
    if (all === null) throw new Error("A origem deveria existir.");
    assertEquals(all.length, 2);
    assertEquals(all[0].occurrenceId, expectedFirst);
    assertEquals(new Set(all.map((item) => item.questionId)).size, all.length);
    assertEquals(all.some((item) => item.questionId === sourceQuestion), false);
    assertEquals(JSON.stringify(all).includes("answer"), false);
    assertEquals(
      findSimilarQuestionOccurrences(database, sourceOccurrence, 1)?.length,
      1,
    );

    const shortQuestion = insertQuestion(database, "5", "de e a");
    const shortOccurrence = insertOccurrence(
      database,
      shortQuestion,
      sourceExam,
      9,
      "Direito",
    );
    assertEquals(
      findSimilarQuestionOccurrences(database, shortOccurrence),
      [],
    );
  });
});
