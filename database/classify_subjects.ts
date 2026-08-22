import type { Database } from "./connection.ts";
import {
  CLASSIFICATION_RULESET_VERSION,
  classifyQuestionSubject,
  normalizeClassificationText,
  SUBJECT_TAXONOMY,
} from "./subject_classifier.ts";

export interface ClassifyExamSubjectsOptions {
  examId: string;
  force?: boolean;
}

export interface SubjectSummary {
  subject: string;
  count: number;
}

export interface ClassifyExamSubjectsResult {
  exam: { id: number; externalId: string };
  rulesetVersion: string;
  force: boolean;
  totalOccurrences: number;
  evaluated: number;
  updated: number;
  skipped: number;
  unclassified: number;
  bySubject: SubjectSummary[];
}

export class SubjectClassificationValidationError extends Error {
  constructor(readonly field: string, message: string) {
    super(`Classificação inválida: ${field} ${message}.`);
    this.name = "SubjectClassificationValidationError";
  }
}

export class ClassificationExamNotFoundError extends Error {
  constructor(readonly externalId: string) {
    super(`Prova não encontrada: ${externalId}.`);
    this.name = "ClassificationExamNotFoundError";
  }
}

export class SubjectClassificationTransactionError extends Error {
  constructor(cause: unknown) {
    super(
      `Falha transacional ao classificar assuntos: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = "SubjectClassificationTransactionError";
  }
}

interface ExamRow {
  id: number;
  external_id: string;
  subject: string | null;
}

interface ClassificationRow {
  occurrence_id: number;
  occurrence_subject: string | null;
  statement: string;
  label: string | null;
  alternative_text: string | null;
}

const GENERIC_SUBJECTS = new Set([
  "geral",
  "conhecimentos basicos",
  "conhecimentos especificos",
  "conhecimentos gerais",
  "conhecimentos juridicos",
  "direito",
  "materias juridicas",
  "sem assunto",
]);

const SPECIFIC_SUBJECTS = new Set(
  SUBJECT_TAXONOMY.filter((subject) => subject !== "Sem classificação")
    .map(normalizeClassificationText),
);

export function isGenericOccurrenceSubject(
  occurrenceSubject: string | null,
  examSubject: string | null,
): boolean {
  if (occurrenceSubject === null) return true;
  const normalized = normalizeClassificationText(occurrenceSubject);
  if (GENERIC_SUBJECTS.has(normalized)) return true;
  if (examSubject === null) return false;
  const normalizedExam = normalizeClassificationText(examSubject);
  return normalized === normalizedExam &&
    !SPECIFIC_SUBJECTS.has(normalizedExam);
}

export function validateClassifyExamSubjectsOptions(
  options: ClassifyExamSubjectsOptions,
): void {
  if (typeof options.examId !== "string" || options.examId.trim() === "") {
    throw new SubjectClassificationValidationError(
      "examId",
      "deve ser uma string não vazia",
    );
  }
  if (options.force !== undefined && typeof options.force !== "boolean") {
    throw new SubjectClassificationValidationError(
      "force",
      "deve ser booleano",
    );
  }
}

const rollback = (database: Database): void => {
  try {
    database.exec("ROLLBACK");
  } catch {
    // Preserva o erro original.
  }
};

export function classifyExamSubjects(
  database: Database,
  options: ClassifyExamSubjectsOptions,
): ClassifyExamSubjectsResult {
  validateClassifyExamSubjectsOptions(options);
  const force = options.force ?? false;
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const exam = database.prepare(`
      SELECT id, external_id, subject
      FROM exams WHERE external_id = ?
    `).get(options.examId) as unknown as ExamRow | undefined;
    if (!exam) throw new ClassificationExamNotFoundError(options.examId);

    const rows = database.prepare(`
      SELECT
        qo.id AS occurrence_id,
        qo.subject AS occurrence_subject,
        q.statement,
        a.label,
        a.text AS alternative_text
      FROM question_occurrences AS qo
      JOIN questions AS q ON q.id = qo.question_id
      LEFT JOIN alternatives AS a ON a.question_id = q.id
      WHERE qo.exam_id = ?
      ORDER BY qo.id ASC, a.position ASC, a.label COLLATE BINARY ASC
    `).all(exam.id) as unknown as ClassificationRow[];
    const grouped = new Map<number, {
      subject: string | null;
      statement: string;
      alternatives: Array<{ label: string; text: string }>;
    }>();
    for (const row of rows) {
      const occurrenceId = Number(row.occurrence_id);
      const occurrence = grouped.get(occurrenceId) ?? {
        subject: row.occurrence_subject,
        statement: row.statement,
        alternatives: [],
      };
      if (row.label !== null && row.alternative_text !== null) {
        occurrence.alternatives.push({
          label: row.label,
          text: row.alternative_text,
        });
      }
      grouped.set(occurrenceId, occurrence);
    }

    const update = database.prepare(`
      UPDATE question_occurrences SET subject = ? WHERE id = ?
    `);
    let evaluated = 0;
    let updated = 0;
    for (const [occurrenceId, occurrence] of grouped) {
      if (
        !force &&
        !isGenericOccurrenceSubject(occurrence.subject, exam.subject)
      ) {
        continue;
      }
      evaluated++;
      const classification = classifyQuestionSubject(occurrence);
      if (occurrence.subject !== classification.subject) {
        update.run(classification.subject, occurrenceId);
        updated++;
      }
    }

    const bySubject = database.prepare(`
      SELECT
        COALESCE(qo.subject, e.subject, 'Sem classificação') AS subject,
        count(*) AS count
      FROM question_occurrences AS qo
      JOIN exams AS e ON e.id = qo.exam_id
      WHERE qo.exam_id = ?
      GROUP BY COALESCE(qo.subject, e.subject, 'Sem classificação')
      ORDER BY subject COLLATE BINARY ASC
    `).all(exam.id).map((row) => ({
      subject: String(row.subject),
      count: Number(row.count),
    }));
    const unclassified = bySubject.find((item) =>
      item.subject === "Sem classificação"
    )?.count ?? 0;
    database.exec("COMMIT");
    transactionStarted = false;
    return {
      exam: { id: Number(exam.id), externalId: exam.external_id },
      rulesetVersion: CLASSIFICATION_RULESET_VERSION,
      force,
      totalOccurrences: grouped.size,
      evaluated,
      updated,
      skipped: grouped.size - evaluated,
      unclassified,
      bySubject,
    };
  } catch (error) {
    if (transactionStarted) rollback(database);
    if (
      error instanceof ClassificationExamNotFoundError ||
      error instanceof SubjectClassificationValidationError
    ) {
      throw error;
    }
    throw new SubjectClassificationTransactionError(error);
  }
}
