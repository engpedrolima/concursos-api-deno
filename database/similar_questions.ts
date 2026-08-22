import type { Database } from "./connection.ts";
import type {
  QuestionAlternativeView,
  QuestionOccurrenceView,
} from "./questions.ts";
import type { QuestionKind } from "./question_filters.ts";

export const DEFAULT_SIMILAR_LIMIT = 10;
export const MAX_SIMILAR_LIMIT = 20;
const MAX_QUERY_TERMS = 12;

const STOP_WORDS = new Set([
  "aos",
  "com",
  "como",
  "das",
  "dos",
  "ela",
  "ele",
  "entre",
  "essa",
  "esse",
  "esta",
  "este",
  "isto",
  "nas",
  "nos",
  "para",
  "pela",
  "pelo",
  "por",
  "que",
  "sem",
  "ser",
  "sua",
  "suas",
  "seu",
  "seus",
  "uma",
]);

export class SimilarQuestionValidationError extends Error {
  constructor(readonly field: string, message: string) {
    super(`Busca de semelhantes inválida: ${field} ${message}.`);
    this.name = "SimilarQuestionValidationError";
  }
}

interface SourceRow {
  question_id: number;
  statement: string;
  kind: QuestionKind;
  effective_subject: string | null;
}

interface SimilarRow {
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
}

interface AlternativeRow {
  question_id: number;
  label: string;
  position: number;
  text: string;
}

export function buildSafeFtsQuery(statement: string): string | null {
  const normalized = statement.normalize("NFD").replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("pt-BR");
  const tokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.length < 3 || STOP_WORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    unique.push(token);
    if (unique.length === MAX_QUERY_TERMS) break;
  }
  return unique.length === 0
    ? null
    : unique.map((token) => `"${token}"`).join(" OR ");
}

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new SimilarQuestionValidationError(
      "limit",
      "deve ser um inteiro positivo",
    );
  }
  if (limit > MAX_SIMILAR_LIMIT) {
    throw new SimilarQuestionValidationError(
      "limit",
      `não pode exceder ${MAX_SIMILAR_LIMIT}`,
    );
  }
}

function loadAlternatives(
  database: Database,
  questionIds: number[],
): Map<number, QuestionAlternativeView[]> {
  const result = new Map<number, QuestionAlternativeView[]>();
  if (questionIds.length === 0) return result;
  const placeholders = questionIds.map(() => "?").join(", ");
  const rows = database.prepare(`
    SELECT question_id, label, position, text
    FROM alternatives
    WHERE question_id IN (${placeholders})
    ORDER BY question_id ASC, position ASC, label COLLATE BINARY ASC
  `).all(...questionIds) as unknown as AlternativeRow[];
  for (const row of rows) {
    const questionId = Number(row.question_id);
    const alternatives = result.get(questionId) ?? [];
    alternatives.push({
      label: row.label,
      position: Number(row.position),
      text: row.text,
    });
    result.set(questionId, alternatives);
  }
  return result;
}

export function findSimilarQuestionOccurrences(
  database: Database,
  occurrenceId: number,
  limit = DEFAULT_SIMILAR_LIMIT,
): QuestionOccurrenceView[] | null {
  if (!Number.isInteger(occurrenceId) || occurrenceId <= 0) {
    throw new SimilarQuestionValidationError(
      "occurrenceId",
      "deve ser um inteiro positivo",
    );
  }
  validateLimit(limit);

  const source = database.prepare(`
    SELECT
      q.id AS question_id,
      q.statement,
      q.kind,
      COALESCE(qo.subject, e.subject) AS effective_subject
    FROM question_occurrences AS qo
    JOIN questions AS q ON q.id = qo.question_id
    JOIN exams AS e ON e.id = qo.exam_id
    WHERE qo.id = ?
  `).get(occurrenceId) as unknown as SourceRow | undefined;
  if (!source) return null;

  const ftsQuery = buildSafeFtsQuery(source.statement);
  if (ftsQuery === null) return [];

  const rows = database.prepare(`
    WITH lexical_candidates AS (
      SELECT
        q.id AS question_id,
        q.statement,
        q.kind,
        bm25(question_fts) AS lexical_rank
      FROM question_fts
      JOIN questions AS q ON q.id = question_fts.rowid
      WHERE question_fts MATCH ? AND q.id <> ?
    ),
    occurrence_candidates AS (
      SELECT
        qo.id AS occurrence_id,
        candidate.question_id,
        qo.number,
        COALESCE(qo.subject, e.subject) AS subject,
        e.external_id,
        e.organizer,
        e.year,
        e.role,
        candidate.statement,
        candidate.kind,
        candidate.lexical_rank,
        CASE WHEN COALESCE(qo.subject, e.subject) IS ? THEN 0 ELSE 1 END
          AS subject_priority,
        CASE WHEN candidate.kind = ? THEN 0 ELSE 1 END AS kind_priority
      FROM lexical_candidates AS candidate
      JOIN question_occurrences AS qo
        ON qo.question_id = candidate.question_id
      JOIN exams AS e ON e.id = qo.exam_id
    ),
    prioritized AS (
      SELECT *, subject_priority + kind_priority AS context_priority
      FROM occurrence_candidates
    ),
    ranked AS (
      SELECT *, row_number() OVER (
        PARTITION BY question_id
        ORDER BY context_priority ASC, subject_priority ASC,
                 kind_priority ASC, lexical_rank ASC, year ASC,
                 external_id COLLATE BINARY ASC, number ASC,
                 occurrence_id ASC
      ) AS representative_rank
      FROM prioritized
    )
    SELECT * FROM ranked
    WHERE representative_rank = 1
    ORDER BY context_priority ASC, subject_priority ASC, kind_priority ASC,
             lexical_rank ASC, year ASC, external_id COLLATE BINARY ASC,
             number ASC, occurrence_id ASC
    LIMIT ?
  `).all(
    ftsQuery,
    source.question_id,
    source.effective_subject,
    source.kind,
    limit,
  ) as unknown as SimilarRow[];
  const alternatives = loadAlternatives(
    database,
    rows.map((row) => Number(row.question_id)),
  );
  return rows.map((row) => ({
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
  }));
}
