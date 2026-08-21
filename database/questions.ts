import type { Database } from "./connection.ts";

export const DEFAULT_QUESTION_LIMIT = 25;
export const MAX_QUESTION_LIMIT = 100;

export type QuestionKind = "multiple-choice" | "certo-errado";

export interface QuestionAlternativeView {
  label: string;
  position: number;
  text: string;
}

export interface QuestionExamView {
  externalId: string;
  organizer: string;
  year: number;
  role: string | null;
}

export interface QuestionOccurrenceView {
  occurrenceId: number;
  questionId: number;
  number: number;
  subject: string | null;
  exam: QuestionExamView;
  statement: string;
  kind: QuestionKind;
  alternatives: QuestionAlternativeView[];
}

export interface QuestionOccurrenceWithAnswer extends QuestionOccurrenceView {
  answerLabel: string;
}

export interface QuestionOccurrenceFilters {
  organizer?: string;
  year?: number;
  role?: string;
  subject?: string;
  kind?: QuestionKind;
  examId?: string;
  deduplicate?: boolean;
  limit?: number;
  offset?: number;
}

export interface QuestionOccurrencePage {
  items: QuestionOccurrenceView[];
  total: number;
  limit: number;
  offset: number;
}

export class QuestionQueryValidationError extends Error {
  constructor(readonly field: string, message: string) {
    super(`Consulta de questões inválida: ${field} ${message}.`);
    this.name = "QuestionQueryValidationError";
  }
}

interface Pagination {
  limit: number;
  offset: number;
}

interface OccurrenceRow {
  occurrence_id: number;
  question_id: number;
  number: number;
  subject: string | null;
  external_id: string;
  organizer: string;
  year: number;
  role: string | null;
  statement: string;
  kind: QuestionKind;
  answer_label?: string;
}

interface AlternativeRow {
  question_id: number;
  label: string;
  position: number;
  text: string;
}

type QueryParameter = string | number;

const ORDER_BY =
  "year ASC, external_id COLLATE BINARY ASC, number ASC, occurrence_id ASC";
const QUESTION_KINDS = new Set<string>([
  "multiple-choice",
  "certo-errado",
]);

function validatePagination(filters: QuestionOccurrenceFilters): Pagination {
  const limit = filters.limit ?? DEFAULT_QUESTION_LIMIT;
  const offset = filters.offset ?? 0;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new QuestionQueryValidationError(
      "limit",
      "deve ser um inteiro positivo",
    );
  }
  if (limit > MAX_QUESTION_LIMIT) {
    throw new QuestionQueryValidationError(
      "limit",
      `não pode exceder ${MAX_QUESTION_LIMIT}`,
    );
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new QuestionQueryValidationError(
      "offset",
      "deve ser um inteiro maior ou igual a zero",
    );
  }
  return { limit, offset };
}

function nonEmptyFilter(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new QuestionQueryValidationError(
      field,
      "deve ser uma string não vazia",
    );
  }
  return value;
}

function filtersSql(filters: QuestionOccurrenceFilters): {
  where: string;
  parameters: QueryParameter[];
} {
  const clauses: string[] = [];
  const parameters: QueryParameter[] = [];
  if (filters.organizer !== undefined) {
    clauses.push("e.organizer = ?");
    parameters.push(nonEmptyFilter(filters.organizer, "organizer"));
  }
  if (filters.year !== undefined) {
    if (!Number.isInteger(filters.year) || filters.year < 1900) {
      throw new QuestionQueryValidationError(
        "year",
        "deve ser um inteiro maior ou igual a 1900",
      );
    }
    clauses.push("e.year = ?");
    parameters.push(filters.year);
  }
  if (filters.role !== undefined) {
    clauses.push("e.role = ?");
    parameters.push(nonEmptyFilter(filters.role, "role"));
  }
  if (filters.subject !== undefined) {
    clauses.push("COALESCE(qo.subject, e.subject) = ?");
    parameters.push(nonEmptyFilter(filters.subject, "subject"));
  }
  if (filters.kind !== undefined) {
    if (!QUESTION_KINDS.has(filters.kind)) {
      throw new QuestionQueryValidationError(
        "kind",
        "deve ser multiple-choice ou certo-errado",
      );
    }
    clauses.push("q.kind = ?");
    parameters.push(filters.kind);
  }
  if (filters.examId !== undefined) {
    clauses.push("e.external_id = ?");
    parameters.push(nonEmptyFilter(filters.examId, "examId"));
  }
  if (
    filters.deduplicate !== undefined &&
    typeof filters.deduplicate !== "boolean"
  ) {
    throw new QuestionQueryValidationError("deduplicate", "deve ser booleano");
  }
  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    parameters,
  };
}

const filteredCte = (where: string) => `
  filtered AS (
    SELECT
      qo.id AS occurrence_id,
      qo.question_id,
      qo.number,
      COALESCE(qo.subject, e.subject) AS subject,
      e.external_id,
      e.organizer,
      e.year,
      e.role,
      q.statement,
      q.kind
    FROM question_occurrences AS qo
    JOIN questions AS q ON q.id = qo.question_id
    JOIN exams AS e ON e.id = qo.exam_id
    ${where}
  )
`;

function loadAlternatives(
  database: Database,
  questionIds: number[],
): Map<number, QuestionAlternativeView[]> {
  const alternatives = new Map<number, QuestionAlternativeView[]>();
  if (questionIds.length === 0) return alternatives;
  const placeholders = questionIds.map(() => "?").join(", ");
  const rows = database.prepare(`
    SELECT question_id, label, position, text
    FROM alternatives
    WHERE question_id IN (${placeholders})
    ORDER BY question_id ASC, position ASC, label COLLATE BINARY ASC
  `).all(...questionIds) as unknown as AlternativeRow[];
  for (const row of rows) {
    const questionId = Number(row.question_id);
    const current = alternatives.get(questionId) ?? [];
    current.push({
      label: row.label,
      position: Number(row.position),
      text: row.text,
    });
    alternatives.set(questionId, current);
  }
  return alternatives;
}

function mapOccurrence(
  row: OccurrenceRow,
  alternatives: ReadonlyMap<number, QuestionAlternativeView[]>,
): QuestionOccurrenceView {
  return {
    occurrenceId: Number(row.occurrence_id),
    questionId: Number(row.question_id),
    number: Number(row.number),
    subject: row.subject,
    exam: {
      externalId: row.external_id,
      organizer: row.organizer,
      year: Number(row.year),
      role: row.role,
    },
    statement: row.statement,
    kind: row.kind,
    alternatives: alternatives.get(Number(row.question_id)) ?? [],
  };
}

/**
 * Lista ocorrências por prova. Quando deduplicate=true, escolhe para cada
 * questionId a ocorrência filtrada de menor ano, externalId, número e id.
 */
export function listQuestionOccurrences(
  database: Database,
  filters: QuestionOccurrenceFilters = {},
): QuestionOccurrencePage {
  const pagination = validatePagination(filters);
  const query = filtersSql(filters);
  const selectedCtes = filters.deduplicate
    ? `,
      ranked AS (
        SELECT *, row_number() OVER (
          PARTITION BY question_id ORDER BY ${ORDER_BY}
        ) AS representative_rank
        FROM filtered
      ),
      selected AS (
        SELECT * FROM ranked WHERE representative_rank = 1
      )
    `
    : ", selected AS (SELECT * FROM filtered)";
  const withSql = `WITH ${filteredCte(query.where)} ${selectedCtes}`;
  const totalRow = database.prepare(`
    ${withSql}
    SELECT count(*) AS total FROM selected
  `).get(...query.parameters) as { total: number };
  const rows = database.prepare(`
    ${withSql}
    SELECT selected.*
    FROM selected
    ORDER BY ${ORDER_BY}
    LIMIT ? OFFSET ?
  `).all(
    ...query.parameters,
    pagination.limit,
    pagination.offset,
  ) as unknown as OccurrenceRow[];
  const alternatives = loadAlternatives(
    database,
    [...new Set(rows.map((row) => Number(row.question_id)))],
  );
  return {
    items: rows.map((row) => mapOccurrence(row, alternatives)),
    total: Number(totalRow.total),
    ...pagination,
  };
}

export function getQuestionOccurrence(
  database: Database,
  occurrenceId: number,
): QuestionOccurrenceView | null;
export function getQuestionOccurrence(
  database: Database,
  occurrenceId: number,
  options: { includeAnswer: true },
): QuestionOccurrenceWithAnswer | null;
export function getQuestionOccurrence(
  database: Database,
  occurrenceId: number,
  options?: { includeAnswer?: boolean },
): QuestionOccurrenceView | QuestionOccurrenceWithAnswer | null;
/** Busca uma ocorrência; o gabarito só é selecionado por opção explícita. */
export function getQuestionOccurrence(
  database: Database,
  occurrenceId: number,
  options: { includeAnswer?: boolean } = {},
): QuestionOccurrenceView | QuestionOccurrenceWithAnswer | null {
  if (!Number.isInteger(occurrenceId) || occurrenceId <= 0) {
    throw new QuestionQueryValidationError(
      "occurrenceId",
      "deve ser um inteiro positivo",
    );
  }
  if (
    options.includeAnswer !== undefined &&
    typeof options.includeAnswer !== "boolean"
  ) {
    throw new QuestionQueryValidationError(
      "includeAnswer",
      "deve ser booleano",
    );
  }
  const answerColumn = options.includeAnswer ? ", q.answer_label" : "";
  const row = database.prepare(`
    SELECT
      qo.id AS occurrence_id,
      qo.question_id,
      qo.number,
      COALESCE(qo.subject, e.subject) AS subject,
      e.external_id,
      e.organizer,
      e.year,
      e.role,
      q.statement,
      q.kind
      ${answerColumn}
    FROM question_occurrences AS qo
    JOIN questions AS q ON q.id = qo.question_id
    JOIN exams AS e ON e.id = qo.exam_id
    WHERE qo.id = ?
  `).get(occurrenceId) as unknown as OccurrenceRow | undefined;
  if (!row) return null;
  const alternatives = loadAlternatives(database, [Number(row.question_id)]);
  const occurrence = mapOccurrence(row, alternatives);
  return options.includeAnswer
    ? { ...occurrence, answerLabel: String(row.answer_label) }
    : occurrence;
}
