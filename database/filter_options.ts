import type { Database } from "./connection.ts";
import type { QuestionKind } from "./question_filters.ts";

export interface ExamFilterOption {
  externalId: string;
  label: string;
}

export interface FilterOptions {
  organizers: string[];
  years: number[];
  roles: string[];
  subjects: string[];
  kinds: QuestionKind[];
  exams: ExamFilterOption[];
}

const textValues = (database: Database, sql: string): string[] =>
  database.prepare(sql).all().map((row) => String(row.value));

export function getFilterOptions(database: Database): FilterOptions {
  const organizers = textValues(
    database,
    `SELECT DISTINCT organizer AS value
     FROM exams
     ORDER BY value COLLATE BINARY ASC`,
  );
  const years = database.prepare(`
    SELECT DISTINCT year AS value
    FROM exams
    ORDER BY value ASC
  `).all().map((row) => Number(row.value));
  const roles = textValues(
    database,
    `SELECT DISTINCT role AS value
     FROM exams
     WHERE role IS NOT NULL
     ORDER BY value COLLATE BINARY ASC`,
  );
  const subjects = textValues(
    database,
    `SELECT DISTINCT COALESCE(qo.subject, e.subject) AS value
     FROM question_occurrences AS qo
     JOIN exams AS e ON e.id = qo.exam_id
     WHERE COALESCE(qo.subject, e.subject) IS NOT NULL
     ORDER BY value COLLATE BINARY ASC`,
  );
  const kinds = textValues(
    database,
    `SELECT DISTINCT q.kind AS value
     FROM question_occurrences AS qo
     JOIN questions AS q ON q.id = qo.question_id
     ORDER BY value COLLATE BINARY ASC`,
  ) as QuestionKind[];
  const exams = database.prepare(`
    SELECT external_id, organizer, year, role
    FROM exams
    ORDER BY year ASC, organizer COLLATE BINARY ASC,
             external_id COLLATE BINARY ASC
  `).all().map((row) => {
    const role = row.role === null ? "" : ` — ${String(row.role)}`;
    return {
      externalId: String(row.external_id),
      label: `${String(row.organizer)} ${Number(row.year)}${role} ` +
        `(${String(row.external_id)})`,
    };
  });
  return { organizers, years, roles, subjects, kinds, exams };
}
