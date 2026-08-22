import {
  classifyExamSubjects,
  isGenericOccurrenceSubject,
} from "../database/classify_subjects.ts";
import { runClassifyCli } from "../database/classify_cli.ts";
import type { Database } from "../database/connection.ts";
import { openDatabase } from "../database/connection.ts";
import { getFilterOptions } from "../database/filter_options.ts";
import { runMigrations } from "../database/migrations.ts";
import { listQuestionOccurrences } from "../database/questions.ts";
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

function seedClassificationExam(
  database: Database,
  externalId = "classificacao-2026",
): void {
  database.prepare(`
    INSERT INTO exams (external_id, organizer, year, role, subject)
    VALUES (?, 'Banca Local', 2026, 'Procurador', 'Conhecimentos Gerais')
  `).run(externalId);
  const exam = database.prepare(
    "SELECT id FROM exams WHERE external_id = ?",
  ).get(externalId) as { id: number };
  const questions = [
    ["a", "A licitação antecede o contrato administrativo.", null],
    [
      "b",
      "O controle de constitucionalidade cabe ao Supremo Tribunal Federal.",
      "Conhecimentos Gerais",
    ],
    [
      "c",
      "O Código Penal disciplina a tipicidade do crime.",
      "Direito Tributário",
    ],
    ["d", "Enunciado inteiramente neutro para esta taxonomia.", null],
  ] as const;
  const insertQuestion = database.prepare(`
    INSERT INTO questions (content_hash, statement, kind, answer_label)
    VALUES (?, ?, 'multiple-choice', 'A')
  `);
  const insertAlternative = database.prepare(`
    INSERT INTO alternatives (question_id, label, position, text)
    VALUES (?, 'A', 0, 'Alternativa neutra'),
           (?, 'B', 1, 'Outra alternativa neutra')
  `);
  const insertOccurrence = database.prepare(`
    INSERT INTO question_occurrences (question_id, exam_id, number, subject)
    VALUES (?, ?, ?, ?)
  `);
  questions.forEach(([hash, statement, subject], index) => {
    const question = insertQuestion.run(hash.repeat(64), statement);
    const questionId = Number(question.lastInsertRowid);
    insertAlternative.run(questionId, questionId);
    insertOccurrence.run(questionId, exam.id, index + 1, subject);
  });
}

async function withDatabase(
  operation: (database: Database) => void | Promise<void>,
): Promise<void> {
  const directory = await Deno.makeTempDir({ prefix: "classification-" });
  const database = openDatabase(join(directory, "study.sqlite3"));
  try {
    runMigrations(database);
    seedClassificationExam(database);
    await operation(database);
  } finally {
    database.close();
    await Deno.remove(directory, { recursive: true });
  }
}

Deno.test("detecção de assunto genérico preserva classificações finais", () => {
  assertEquals(isGenericOccurrenceSubject(null, "Geral"), true);
  assertEquals(
    isGenericOccurrenceSubject("Conhecimentos Gerais", "Conhecimentos Gerais"),
    true,
  );
  assertEquals(isGenericOccurrenceSubject("Direito", null), true);
  assertEquals(
    isGenericOccurrenceSubject("Direito Administrativo", "Direito"),
    false,
  );
  assertEquals(isGenericOccurrenceSubject("Sem classificação", null), false);
});

Deno.test("classifica, persiste, integra filtros e é idempotente", async () => {
  await withDatabase((database) => {
    const first = classifyExamSubjects(database, {
      examId: "classificacao-2026",
    });
    assertEquals(
      {
        total: first.totalOccurrences,
        evaluated: first.evaluated,
        updated: first.updated,
        skipped: first.skipped,
        unclassified: first.unclassified,
      },
      { total: 4, evaluated: 3, updated: 3, skipped: 1, unclassified: 1 },
    );
    assertEquals(first.bySubject, [
      { subject: "Direito Administrativo", count: 1 },
      { subject: "Direito Constitucional", count: 1 },
      { subject: "Direito Tributário", count: 1 },
      { subject: "Sem classificação", count: 1 },
    ]);
    assertEquals(
      listQuestionOccurrences(database, {
        examId: "classificacao-2026",
        subject: "Direito Administrativo",
      }).total,
      1,
    );
    assertEquals(getFilterOptions(database).subjects, [
      "Direito Administrativo",
      "Direito Constitucional",
      "Direito Tributário",
      "Sem classificação",
    ]);

    const second = classifyExamSubjects(database, {
      examId: "classificacao-2026",
    });
    assertEquals(
      [second.evaluated, second.updated, second.skipped],
      [0, 0, 4],
    );

    const forced = classifyExamSubjects(database, {
      examId: "classificacao-2026",
      force: true,
    });
    assertEquals(
      [forced.evaluated, forced.updated, forced.skipped],
      [4, 1, 0],
    );
    assertEquals(
      listQuestionOccurrences(database, {
        examId: "classificacao-2026",
        subject: "Direito Penal",
      }).total,
      1,
    );
  });
});

Deno.test("CLI classifica banco indicado e imprime resumo JSON", async () => {
  const directory = await Deno.makeTempDir({ prefix: "classification-cli-" });
  const path = join(directory, "study.sqlite3");
  const database = openDatabase(path);
  try {
    runMigrations(database);
    seedClassificationExam(database, "cli-2026");
  } finally {
    database.close();
  }
  try {
    const output = await new Deno.Command("deno", {
      args: [
        "task",
        "db:classify",
        "--",
        "--exam-id",
        "cli-2026",
        "--database",
        path,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);
    if (!output.success) {
      throw new Error(`db:classify falhou (${output.code}): ${stderr}`);
    }
    const result = JSON.parse(stdout);
    assertEquals(result.exam.externalId, "cli-2026");
    assertEquals(result.updated, 3);
    assertEquals(result.unclassified, 1);

    const verify = openDatabase(path);
    try {
      assertEquals(
        listQuestionOccurrences(verify, {
          examId: "cli-2026",
          subject: "Direito Administrativo",
        }).total,
        1,
      );
    } finally {
      verify.close();
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("CLI valida argumentos antes de abrir o banco", () => {
  let opened = 0;
  for (
    const args of [
      [] as string[],
      ["--exam-id", ""],
      ["--exam-id", "x", "--unknown"],
      ["--", "--", "--exam-id", "x"],
    ]
  ) {
    try {
      runClassifyCli(args, {
        openDatabase: () => {
          opened++;
          throw new Error("Não deveria abrir o banco.");
        },
      });
      throw new Error("A validação deveria falhar.");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (error.message === "A validação deveria falhar.") throw error;
    }
  }
  assertEquals(opened, 0);
});
