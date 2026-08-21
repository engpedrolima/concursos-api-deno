import type { Database } from "./connection.ts";
import {
  buildOccurrenceFilterSql,
  type StudyOccurrenceFilters,
} from "./question_filters.ts";

export const MISSING_SUBJECT_LABEL = "(sem assunto)";
export const PERCENTAGE_DECIMAL_PLACES = 2;

export type StudyStatisticsFilters = StudyOccurrenceFilters;

export interface AttemptStatistics {
  total: number;
  correct: number;
  incorrect: number;
  accuracyPercent: number;
}

export interface OccurrenceStatistics {
  total: number;
  answered: number;
  unanswered: number;
  latestCorrect: number;
  latestIncorrect: number;
  latestAccuracyPercent: number;
}

export interface SubjectStatistics {
  subject: string;
  attempts: AttemptStatistics;
  occurrences: OccurrenceStatistics;
}

export interface StudyStatistics {
  attempts: AttemptStatistics;
  occurrences: OccurrenceStatistics;
  bySubject: SubjectStatistics[];
}

export class StatisticsValidationError extends Error {
  constructor(readonly field: string, message: string) {
    super(`Consulta de estatísticas inválida: ${field} ${message}.`);
    this.name = "StatisticsValidationError";
  }
}

interface OccurrenceStatisticsRow {
  occurrence_id: number;
  effective_subject: string | null;
  attempt_total: number;
  attempt_correct: number;
  latest_is_correct: number | null;
}

interface MutableStatistics {
  attemptTotal: number;
  attemptCorrect: number;
  occurrenceTotal: number;
  occurrenceAnswered: number;
  occurrenceLatestCorrect: number;
}

const emptyMutableStatistics = (): MutableStatistics => ({
  attemptTotal: 0,
  attemptCorrect: 0,
  occurrenceTotal: 0,
  occurrenceAnswered: 0,
  occurrenceLatestCorrect: 0,
});

/**
 * Calcula (numerador / denominador) * 100, arredondado para duas casas
 * decimais. Um denominador zero sempre produz 0.
 */
export function percentage(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  const scale = 10 ** PERCENTAGE_DECIMAL_PLACES;
  return Math.round((numerator * 100 * scale) / denominator) / scale;
}

function addOccurrence(
  accumulator: MutableStatistics,
  row: OccurrenceStatisticsRow,
): void {
  accumulator.occurrenceTotal++;
  accumulator.attemptTotal += Number(row.attempt_total);
  accumulator.attemptCorrect += Number(row.attempt_correct);
  if (row.latest_is_correct !== null) {
    accumulator.occurrenceAnswered++;
    if (Number(row.latest_is_correct) === 1) {
      accumulator.occurrenceLatestCorrect++;
    }
  }
}

function finalize(accumulator: MutableStatistics): {
  attempts: AttemptStatistics;
  occurrences: OccurrenceStatistics;
} {
  const attemptIncorrect = accumulator.attemptTotal -
    accumulator.attemptCorrect;
  const occurrenceLatestIncorrect = accumulator.occurrenceAnswered -
    accumulator.occurrenceLatestCorrect;
  return {
    attempts: {
      total: accumulator.attemptTotal,
      correct: accumulator.attemptCorrect,
      incorrect: attemptIncorrect,
      accuracyPercent: percentage(
        accumulator.attemptCorrect,
        accumulator.attemptTotal,
      ),
    },
    occurrences: {
      total: accumulator.occurrenceTotal,
      answered: accumulator.occurrenceAnswered,
      unanswered: accumulator.occurrenceTotal - accumulator.occurrenceAnswered,
      latestCorrect: accumulator.occurrenceLatestCorrect,
      latestIncorrect: occurrenceLatestIncorrect,
      latestAccuracyPercent: percentage(
        accumulator.occurrenceLatestCorrect,
        accumulator.occurrenceAnswered,
      ),
    },
  };
}

function filterSql(filters: StudyStatisticsFilters) {
  return buildOccurrenceFilterSql(
    filters,
    (field, message) => new StatisticsValidationError(field, message),
  );
}

/** Valida filtros sem abrir nem consultar o banco. */
export function validateStudyStatisticsFilters(
  filters: StudyStatisticsFilters,
): void {
  filterSql(filters);
}

const compareBinary = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * Calcula estatísticas sobre ocorrências filtradas. Cada tentativa conta no
 * bloco attempts; o bloco occurrences usa somente a tentativa mais recente,
 * ordenada por answered_at DESC e, em empate, attempts.id DESC.
 */
export function getStudyStatistics(
  database: Database,
  filters: StudyStatisticsFilters = {},
): StudyStatistics {
  const query = filterSql(filters);
  const rows = database.prepare(`
    WITH eligible_occurrences AS (
      SELECT
        qo.id AS occurrence_id,
        COALESCE(qo.subject, e.subject) AS effective_subject
      FROM question_occurrences AS qo
      JOIN questions AS q ON q.id = qo.question_id
      JOIN exams AS e ON e.id = qo.exam_id
      ${query.where}
    ),
    ranked_attempts AS (
      SELECT
        a.id,
        a.question_occurrence_id,
        a.is_correct,
        row_number() OVER (
          PARTITION BY a.question_occurrence_id
          ORDER BY a.answered_at DESC, a.id DESC
        ) AS attempt_rank
      FROM attempts AS a
      JOIN eligible_occurrences AS eligible
        ON eligible.occurrence_id = a.question_occurrence_id
    )
    SELECT
      eligible.occurrence_id,
      eligible.effective_subject,
      count(ranked.id) AS attempt_total,
      coalesce(sum(ranked.is_correct), 0) AS attempt_correct,
      max(
        CASE WHEN ranked.attempt_rank = 1 THEN ranked.is_correct END
      ) AS latest_is_correct
    FROM eligible_occurrences AS eligible
    LEFT JOIN ranked_attempts AS ranked
      ON ranked.question_occurrence_id = eligible.occurrence_id
    GROUP BY eligible.occurrence_id, eligible.effective_subject
    ORDER BY eligible.occurrence_id ASC
  `).all(...query.parameters) as unknown as OccurrenceStatisticsRow[];

  const total = emptyMutableStatistics();
  const subjects = new Map<string, MutableStatistics>();
  for (const row of rows) {
    addOccurrence(total, row);
    const subject = row.effective_subject ?? MISSING_SUBJECT_LABEL;
    const group = subjects.get(subject) ?? emptyMutableStatistics();
    addOccurrence(group, row);
    subjects.set(subject, group);
  }
  const finalized = finalize(total);
  const bySubject = [...subjects.entries()]
    .sort(([left], [right]) => compareBinary(left, right))
    .map(([subject, metrics]) => ({ subject, ...finalize(metrics) }));
  return { ...finalized, bySubject };
}
