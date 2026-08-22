import { openDatabase } from "../database/connection.ts";
import { getFilterOptions } from "../database/filter_options.ts";
import { runMigrations } from "../database/migrations.ts";

const assertEquals = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Esperado ${JSON.stringify(expected)}, recebido ${
        JSON.stringify(actual)
      }`,
    );
  }
};

Deno.test("filter-options ordena valores e usa fallback de assunto da prova", () => {
  const database = openDatabase(":memory:");
  try {
    runMigrations(database);
    database.exec(`
      INSERT INTO exams
        (id, external_id, organizer, year, role, subject)
      VALUES
        (1, 'z-2025', 'Banca Z', 2025, 'Técnico', 'Geral'),
        (2, 'a-2024', 'Banca A', 2024, 'Analista', 'Tecnologia');
      INSERT INTO questions
        (id, content_hash, statement, kind, answer_label)
      VALUES
        (1, '${"a".repeat(64)}', 'Questão de teste um',
         'multiple-choice', 'A'),
        (2, '${"b".repeat(64)}', 'Questão de teste dois',
         'certo-errado', 'C');
      INSERT INTO question_occurrences
        (question_id, exam_id, number, subject)
      VALUES (1, 1, 1, NULL), (2, 2, 1, 'Direito');
    `);
    const options = getFilterOptions(database);
    assertEquals(options.organizers, ["Banca A", "Banca Z"]);
    assertEquals(options.years, [2024, 2025]);
    assertEquals(options.roles, ["Analista", "Técnico"]);
    assertEquals(options.subjects, ["Direito", "Geral"]);
    assertEquals(options.kinds, ["certo-errado", "multiple-choice"]);
    assertEquals(
      options.exams.map((exam) => exam.externalId),
      ["a-2024", "z-2025"],
    );
  } finally {
    database.close();
  }
});
