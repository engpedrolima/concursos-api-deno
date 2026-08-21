import { createHash } from "node:crypto";
import {
  type ImportArtifact,
  validateImportArtifact,
} from "../importer/artifact.ts";
import type { ImportedQuestion } from "../importer/types.ts";
import type { Database } from "./connection.ts";

export interface PersistImportResult {
  alreadyImported: boolean;
  idempotencyKey: string;
  batch: { id: number; status: "created" | "reused" };
  exam: { id: number; externalId: string; status: "created" | "reused" };
  canonicalQuestions: { created: number; reused: number };
  occurrences: { created: number; reused: number };
  rejected: number;
}

export class ExamMetadataConflictError extends Error {
  constructor(readonly externalId: string, readonly differences: string[]) {
    super(
      `A prova ${externalId} já existe com metadados divergentes: ${
        differences.join(", ")
      }.`,
    );
    this.name = "ExamMetadataConflictError";
  }
}

export class OccurrenceConflictError extends Error {
  constructor(
    readonly examExternalId: string,
    readonly number: number,
    readonly reason: "different-question" | "different-subject",
  ) {
    super(
      reason === "different-question"
        ? `A ocorrência ${examExternalId}#${number} já aponta para outra questão canônica.`
        : `A ocorrência ${examExternalId}#${number} já existe com assunto divergente.`,
    );
    this.name = "OccurrenceConflictError";
  }
}

export class CanonicalQuestionConflictError extends Error {
  constructor(readonly contentHash: string) {
    super(
      `O hash canônico ${contentHash} já existe com conteúdo estrutural diferente.`,
    );
    this.name = "CanonicalQuestionConflictError";
  }
}

export class ImportTransactionError extends Error {
  constructor(cause: unknown) {
    super(
      `Falha transacional ao persistir o artefato: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = "ImportTransactionError";
  }
}

interface CanonicalAlternative {
  label: string;
  position: number;
  text: string;
}

interface CanonicalQuestion {
  contentHash: string;
  statement: string;
  kind: "certo-errado" | "multiple-choice";
  answerLabel: string;
  alternatives: CanonicalAlternative[];
}

const normalizeText = (value: string) =>
  value.normalize("NFC").replace(/\s+/gu, " ").trim();

const normalizeLabel = (value: string) => normalizeText(value).toUpperCase();

const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

const stableExam = (artifact: ImportArtifact) => ({
  externalId: artifact.exam.id,
  organizer: artifact.exam.organizer,
  year: artifact.exam.year,
  role: artifact.exam.role ?? null,
  subject: artifact.exam.subject ?? null,
});

/**
 * SHA-256 de schema/importer, prova completa e documentos completos.
 * Questões não integram esta chave: os hashes oficiais identificam seu lote.
 */
export function computeImportIdempotencyKey(artifact: ImportArtifact): string {
  const identity = {
    schemaVersion: artifact.schemaVersion,
    importerVersion: artifact.importerVersion,
    exam: stableExam(artifact),
    documents: {
      booklet: {
        url: artifact.documents.booklet.url,
        sha256: artifact.documents.booklet.sha256,
        collectedAt: artifact.documents.booklet.collectedAt,
      },
      answerKey: {
        url: artifact.documents.answerKey.url,
        sha256: artifact.documents.answerKey.sha256,
        collectedAt: artifact.documents.answerKey.collectedAt,
      },
    },
  };
  return sha256(JSON.stringify(identity));
}

export function canonicalizeQuestion(
  question: ImportedQuestion,
): CanonicalQuestion {
  const alternatives = Object.entries(question.alternatives).map(
    ([label, text], position) => ({
      label: normalizeLabel(label),
      position,
      text: normalizeText(text),
    }),
  );
  const labels = alternatives.map((alternative) => alternative.label);
  if (new Set(labels).size !== labels.length) {
    throw new Error(
      `A questão ${question.number} possui labels duplicados após normalização.`,
    );
  }
  const answerLabel = normalizeLabel(question.answer);
  const kind = labels.length === 2 && labels[0] === "C" && labels[1] === "E"
    ? "certo-errado" as const
    : "multiple-choice" as const;
  const canonicalContent = {
    statement: normalizeText(question.statement),
    kind,
    alternatives,
    answerLabel,
  };
  return {
    ...canonicalContent,
    contentHash: sha256(JSON.stringify(canonicalContent)),
  };
}

function getOrCreateExam(
  database: Database,
  artifact: ImportArtifact,
): { id: number; status: "created" | "reused" } {
  const expected = stableExam(artifact);
  const existing = database.prepare(`
    SELECT id, organizer, year, role, subject
    FROM exams WHERE external_id = ?
  `).get(expected.externalId) as
    | {
      id: number;
      organizer: string;
      year: number;
      role: string | null;
      subject: string | null;
    }
    | undefined;
  if (existing) {
    const differences = [
      existing.organizer === expected.organizer ? undefined : "organizer",
      existing.year === expected.year ? undefined : "year",
      existing.role === expected.role ? undefined : "role",
      existing.subject === expected.subject ? undefined : "subject",
    ].filter((field): field is string => field !== undefined);
    if (differences.length > 0) {
      throw new ExamMetadataConflictError(expected.externalId, differences);
    }
    return { id: existing.id, status: "reused" };
  }
  const result = database.prepare(`
    INSERT INTO exams (external_id, organizer, year, role, subject)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    expected.externalId,
    expected.organizer,
    expected.year,
    expected.role,
    expected.subject,
  );
  return { id: Number(result.lastInsertRowid), status: "created" };
}

function sameCanonicalQuestion(
  database: Database,
  questionId: number,
  canonical: CanonicalQuestion,
): boolean {
  const stored = database.prepare(`
    SELECT statement, kind, answer_label
    FROM questions WHERE id = ?
  `).get(questionId) as
    | { statement: string; kind: string; answer_label: string }
    | undefined;
  if (
    !stored || stored.statement !== canonical.statement ||
    stored.kind !== canonical.kind ||
    stored.answer_label !== canonical.answerLabel
  ) {
    return false;
  }
  const alternativeRows = database.prepare(`
    SELECT label, position, text FROM alternatives
    WHERE question_id = ? ORDER BY position
  `).all(questionId);
  const alternatives: CanonicalAlternative[] = alternativeRows.map((row) => ({
    label: String(row.label),
    position: Number(row.position),
    text: String(row.text),
  }));
  return JSON.stringify(alternatives) ===
    JSON.stringify(canonical.alternatives);
}

function getOrCreateQuestion(
  database: Database,
  canonical: CanonicalQuestion,
): { id: number; status: "created" | "reused" } {
  const existing = database.prepare(
    "SELECT id FROM questions WHERE content_hash = ?",
  ).get(canonical.contentHash) as { id: number } | undefined;
  if (existing) {
    if (!sameCanonicalQuestion(database, existing.id, canonical)) {
      throw new CanonicalQuestionConflictError(canonical.contentHash);
    }
    return { id: existing.id, status: "reused" };
  }
  const result = database.prepare(`
    INSERT INTO questions (content_hash, statement, kind, answer_label)
    VALUES (?, ?, ?, ?)
  `).run(
    canonical.contentHash,
    canonical.statement,
    canonical.kind,
    canonical.answerLabel,
  );
  const questionId = Number(result.lastInsertRowid);
  const insertAlternative = database.prepare(`
    INSERT INTO alternatives (question_id, label, position, text)
    VALUES (?, ?, ?, ?)
  `);
  for (const alternative of canonical.alternatives) {
    insertAlternative.run(
      questionId,
      alternative.label,
      alternative.position,
      alternative.text,
    );
  }
  return { id: questionId, status: "created" };
}

function getOrCreateOccurrence(
  database: Database,
  examExternalId: string,
  examId: number,
  questionId: number,
  question: ImportedQuestion,
): { id: number; status: "created" | "reused" } {
  const subject = question.subject ?? null;
  const existing = database.prepare(`
    SELECT id, question_id, subject FROM question_occurrences
    WHERE exam_id = ? AND number = ?
  `).get(examId, question.number) as
    | { id: number; question_id: number; subject: string | null }
    | undefined;
  if (existing) {
    if (existing.question_id !== questionId) {
      throw new OccurrenceConflictError(
        examExternalId,
        question.number,
        "different-question",
      );
    }
    if (existing.subject !== subject) {
      throw new OccurrenceConflictError(
        examExternalId,
        question.number,
        "different-subject",
      );
    }
    return { id: existing.id, status: "reused" };
  }
  const result = database.prepare(`
    INSERT INTO question_occurrences (question_id, exam_id, number, subject)
    VALUES (?, ?, ?, ?)
  `).run(questionId, examId, question.number, subject);
  return { id: Number(result.lastInsertRowid), status: "created" };
}

const rollback = (database: Database) => {
  try {
    database.exec("ROLLBACK");
  } catch {
    // Preserva o erro que causou o rollback.
  }
};

/** Persiste um artefato v1 validado em uma única transação. */
export function persistImportArtifact(
  database: Database,
  value: unknown,
): PersistImportResult {
  const artifact = validateImportArtifact(value);
  const idempotencyKey = computeImportIdempotencyKey(artifact);
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const existingBatch = database.prepare(`
      SELECT import_batches.id, import_batches.exam_id, exams.external_id
      FROM import_batches
      JOIN exams ON exams.id = import_batches.exam_id
      WHERE import_batches.idempotency_key = ?
    `).get(idempotencyKey) as
      | { id: number; exam_id: number; external_id: string }
      | undefined;
    if (existingBatch) {
      database.exec("COMMIT");
      return {
        alreadyImported: true,
        idempotencyKey,
        batch: { id: existingBatch.id, status: "reused" },
        exam: {
          id: existingBatch.exam_id,
          externalId: existingBatch.external_id,
          status: "reused",
        },
        canonicalQuestions: { created: 0, reused: artifact.questions.length },
        occurrences: { created: 0, reused: artifact.questions.length },
        rejected: artifact.rejected.length,
      };
    }

    const exam = getOrCreateExam(database, artifact);
    const batchResult = database.prepare(`
      INSERT INTO import_batches
        (exam_id, idempotency_key, schema_version, importer_version,
         documents_json, diagnostics_json, rejected_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      exam.id,
      idempotencyKey,
      artifact.schemaVersion,
      artifact.importerVersion,
      JSON.stringify(artifact.documents),
      JSON.stringify(artifact.diagnostics),
      JSON.stringify(artifact.rejected),
    );
    const batchId = Number(batchResult.lastInsertRowid);
    const result: PersistImportResult = {
      alreadyImported: false,
      idempotencyKey,
      batch: { id: batchId, status: "created" },
      exam: { id: exam.id, externalId: artifact.exam.id, status: exam.status },
      canonicalQuestions: { created: 0, reused: 0 },
      occurrences: { created: 0, reused: 0 },
      rejected: artifact.rejected.length,
    };
    const linkOccurrence = database.prepare(`
      INSERT OR IGNORE INTO import_occurrences
        (import_batch_id, question_occurrence_id)
      VALUES (?, ?)
    `);

    for (const question of artifact.questions) {
      const canonical = canonicalizeQuestion(question);
      const storedQuestion = getOrCreateQuestion(database, canonical);
      result.canonicalQuestions[storedQuestion.status]++;
      const occurrence = getOrCreateOccurrence(
        database,
        artifact.exam.id,
        exam.id,
        storedQuestion.id,
        question,
      );
      result.occurrences[occurrence.status]++;
      linkOccurrence.run(batchId, occurrence.id);
    }
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (transactionStarted) rollback(database);
    if (
      error instanceof ExamMetadataConflictError ||
      error instanceof OccurrenceConflictError ||
      error instanceof CanonicalQuestionConflictError
    ) {
      throw error;
    }
    throw new ImportTransactionError(error);
  }
}
