export type QuestionKind = "multiple-choice" | "certo-errado";
export type StudyProgress =
  | "unanswered"
  | "answered"
  | "latest-correct"
  | "latest-incorrect";

export interface StudyOccurrenceFilters {
  organizer?: string;
  year?: number;
  role?: string;
  subject?: string;
  kind?: QuestionKind;
  examId?: string;
  progress?: StudyProgress;
}

export type QueryParameter = string | number;

export interface OccurrenceFilterSql {
  where: string;
  parameters: QueryParameter[];
}

export type FilterValidationErrorFactory = (
  field: string,
  message: string,
) => Error;

const QUESTION_KINDS = new Set<string>([
  "multiple-choice",
  "certo-errado",
]);
const STUDY_PROGRESS = new Set<string>([
  "unanswered",
  "answered",
  "latest-correct",
  "latest-incorrect",
]);

function nonEmptyFilter(
  value: unknown,
  field: string,
  invalid: FilterValidationErrorFactory,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalid(field, "deve ser uma string não vazia");
  }
  return value;
}

/**
 * Constrói os filtros exatos compartilhados pelas consultas de ocorrências.
 * Os aliases fixos são e (exam), qo (occurrence) e q (question); somente os
 * valores do consumidor são enviados como parâmetros SQLite.
 */
export function buildOccurrenceFilterSql(
  filters: StudyOccurrenceFilters,
  invalid: FilterValidationErrorFactory,
): OccurrenceFilterSql {
  const clauses: string[] = [];
  const parameters: QueryParameter[] = [];
  if (filters.organizer !== undefined) {
    clauses.push("e.organizer = ?");
    parameters.push(nonEmptyFilter(filters.organizer, "organizer", invalid));
  }
  if (filters.year !== undefined) {
    if (!Number.isInteger(filters.year) || filters.year < 1900) {
      throw invalid("year", "deve ser um inteiro maior ou igual a 1900");
    }
    clauses.push("e.year = ?");
    parameters.push(filters.year);
  }
  if (filters.role !== undefined) {
    clauses.push("e.role = ?");
    parameters.push(nonEmptyFilter(filters.role, "role", invalid));
  }
  if (filters.subject !== undefined) {
    clauses.push("COALESCE(qo.subject, e.subject) = ?");
    parameters.push(nonEmptyFilter(filters.subject, "subject", invalid));
  }
  if (filters.kind !== undefined) {
    if (!QUESTION_KINDS.has(filters.kind)) {
      throw invalid("kind", "deve ser multiple-choice ou certo-errado");
    }
    clauses.push("q.kind = ?");
    parameters.push(filters.kind);
  }
  if (filters.examId !== undefined) {
    clauses.push("e.external_id = ?");
    parameters.push(nonEmptyFilter(filters.examId, "examId", invalid));
  }
  if (filters.progress !== undefined) {
    if (!STUDY_PROGRESS.has(filters.progress)) {
      throw invalid(
        "progress",
        "deve ser unanswered, answered, latest-correct ou latest-incorrect",
      );
    }
    if (filters.progress === "unanswered") {
      clauses.push(`NOT EXISTS (
        SELECT 1 FROM attempts AS progress_attempt
        WHERE progress_attempt.question_occurrence_id = qo.id
      )`);
    } else if (filters.progress === "answered") {
      clauses.push(`EXISTS (
        SELECT 1 FROM attempts AS progress_attempt
        WHERE progress_attempt.question_occurrence_id = qo.id
      )`);
    } else {
      clauses.push(`(
        SELECT progress_attempt.is_correct
        FROM attempts AS progress_attempt
        WHERE progress_attempt.question_occurrence_id = qo.id
        ORDER BY progress_attempt.answered_at DESC, progress_attempt.id DESC
        LIMIT 1
      ) = ?`);
      parameters.push(filters.progress === "latest-correct" ? 1 : 0);
    }
  }
  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    parameters,
  };
}
