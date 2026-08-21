import type { Database } from "./connection.ts";

/** Limite de 24 horas para o tempo informado em uma única tentativa. */
export const MAX_ATTEMPT_DURATION_MS = 24 * 60 * 60 * 1_000;

export interface RecordAttemptInput {
  questionOccurrenceId: number;
  selectedLabel: string;
  durationMs?: number;
}

export interface AttemptFeedback {
  attemptId: number;
  occurrenceId: number;
  questionId: number;
  selectedLabel: string;
  correctLabel: string;
  isCorrect: boolean;
  answeredAt: string;
  durationMs: number | null;
}

export interface AttemptHistoryItem {
  attemptId: number;
  selectedLabel: string;
  correctLabel: string;
  isCorrect: boolean;
  answeredAt: string;
  durationMs: number | null;
}

export class AttemptValidationError extends Error {
  constructor(readonly field: string, message: string) {
    super(`Tentativa inválida: ${field} ${message}.`);
    this.name = "AttemptValidationError";
  }
}

export class QuestionOccurrenceNotFoundError extends Error {
  constructor(readonly occurrenceId: number) {
    super(`A ocorrência de questão ${occurrenceId} não existe.`);
    this.name = "QuestionOccurrenceNotFoundError";
  }
}

export class InvalidAlternativeError extends Error {
  constructor(
    readonly occurrenceId: number,
    readonly selectedLabel: string,
  ) {
    super(
      `A alternativa ${selectedLabel} não pertence à questão da ocorrência ${occurrenceId}.`,
    );
    this.name = "InvalidAlternativeError";
  }
}

export class AttemptTransactionError extends Error {
  constructor(cause: unknown) {
    super(
      `Falha transacional ao registrar a tentativa: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = "AttemptTransactionError";
  }
}

interface ValidatedAttemptInput {
  questionOccurrenceId: number;
  selectedLabel: string;
  durationMs: number | null;
}

interface OccurrenceAnswerRow {
  question_id: number;
  answer_label: string;
}

interface AttemptHistoryRow {
  id: number;
  selected_label: string;
  correct_label_snapshot: string;
  is_correct: number;
  answered_at: string;
  duration_ms: number | null;
}

type Clock = () => Date;

const systemClock: Clock = () => new Date();

const normalizeLabel = (value: string) =>
  value.normalize("NFC").trim().toUpperCase();

/** Valida e normaliza somente os três campos aceitos pela operação pública. */
export function validateRecordAttemptInput(
  input: RecordAttemptInput,
): ValidatedAttemptInput {
  if (
    !Number.isInteger(input.questionOccurrenceId) ||
    input.questionOccurrenceId <= 0
  ) {
    throw new AttemptValidationError(
      "questionOccurrenceId",
      "deve ser um inteiro positivo",
    );
  }
  if (typeof input.selectedLabel !== "string") {
    throw new AttemptValidationError(
      "selectedLabel",
      "deve ser uma string não vazia",
    );
  }
  const selectedLabel = normalizeLabel(input.selectedLabel);
  if (selectedLabel === "") {
    throw new AttemptValidationError(
      "selectedLabel",
      "deve ser uma string não vazia",
    );
  }
  if (input.durationMs !== undefined) {
    if (!Number.isInteger(input.durationMs) || input.durationMs < 0) {
      throw new AttemptValidationError(
        "durationMs",
        "deve ser um inteiro maior ou igual a zero",
      );
    }
    if (input.durationMs > MAX_ATTEMPT_DURATION_MS) {
      throw new AttemptValidationError(
        "durationMs",
        `não pode exceder ${MAX_ATTEMPT_DURATION_MS}`,
      );
    }
  }
  return {
    questionOccurrenceId: input.questionOccurrenceId,
    selectedLabel,
    durationMs: input.durationMs ?? null,
  };
}

function rollback(database: Database): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // Preserva o erro que causou o rollback.
  }
}

function recordAttemptWithClock(
  database: Database,
  input: RecordAttemptInput,
  clock: Clock,
): AttemptFeedback {
  const validated = validateRecordAttemptInput(input);
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const occurrence = database.prepare(`
      SELECT qo.question_id, q.answer_label
      FROM question_occurrences AS qo
      JOIN questions AS q ON q.id = qo.question_id
      WHERE qo.id = ?
    `).get(validated.questionOccurrenceId) as
      | OccurrenceAnswerRow
      | undefined;
    if (!occurrence) {
      throw new QuestionOccurrenceNotFoundError(
        validated.questionOccurrenceId,
      );
    }
    const alternative = database.prepare(`
      SELECT 1 AS valid
      FROM alternatives
      WHERE question_id = ? AND label = ?
    `).get(occurrence.question_id, validated.selectedLabel);
    if (!alternative) {
      throw new InvalidAlternativeError(
        validated.questionOccurrenceId,
        validated.selectedLabel,
      );
    }

    const answeredAt = clock().toISOString();
    const correctLabel = occurrence.answer_label;
    const isCorrect = validated.selectedLabel === correctLabel;
    const inserted = database.prepare(`
      INSERT INTO attempts
        (question_occurrence_id, selected_label, correct_label_snapshot,
         is_correct, answered_at, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      validated.questionOccurrenceId,
      validated.selectedLabel,
      correctLabel,
      isCorrect ? 1 : 0,
      answeredAt,
      validated.durationMs,
    );
    database.exec("COMMIT");
    return {
      attemptId: Number(inserted.lastInsertRowid),
      occurrenceId: validated.questionOccurrenceId,
      questionId: Number(occurrence.question_id),
      selectedLabel: validated.selectedLabel,
      correctLabel,
      isCorrect,
      answeredAt,
      durationMs: validated.durationMs,
    };
  } catch (error) {
    if (transactionStarted) rollback(database);
    if (
      error instanceof QuestionOccurrenceNotFoundError ||
      error instanceof InvalidAlternativeError
    ) {
      throw error;
    }
    throw new AttemptTransactionError(error);
  }
}

/** Registra uma nova tentativa; respostas repetidas nunca sobrescrevem o histórico. */
export function recordAttempt(
  database: Database,
  input: RecordAttemptInput,
): AttemptFeedback {
  return recordAttemptWithClock(database, input, systemClock);
}

/**
 * Ponto interno para testes determinísticos. Não integra a API da CLI e não
 * permite que consumidores definam o horário pela operação de produção.
 * @internal
 */
export const _attemptTesting = Object.freeze({
  recordAttemptWithClock,
});

/**
 * Retorna null se a ocorrência não existir e [] se ela ainda não tiver
 * tentativas. A ordem é answeredAt DESC, com desempate por attemptId DESC.
 */
export function getAttemptHistory(
  database: Database,
  questionOccurrenceId: number,
): AttemptHistoryItem[] | null {
  if (!Number.isInteger(questionOccurrenceId) || questionOccurrenceId <= 0) {
    throw new AttemptValidationError(
      "questionOccurrenceId",
      "deve ser um inteiro positivo",
    );
  }
  const occurrence = database.prepare(
    "SELECT 1 AS present FROM question_occurrences WHERE id = ?",
  ).get(questionOccurrenceId);
  if (!occurrence) return null;

  const rows = database.prepare(`
    SELECT id, selected_label, correct_label_snapshot, is_correct,
           answered_at, duration_ms
    FROM attempts
    WHERE question_occurrence_id = ?
    ORDER BY answered_at DESC, id DESC
  `).all(questionOccurrenceId) as unknown as AttemptHistoryRow[];
  return rows.map((row) => ({
    attemptId: Number(row.id),
    selectedLabel: row.selected_label,
    correctLabel: row.correct_label_snapshot,
    isCorrect: Number(row.is_correct) === 1,
    answeredAt: row.answered_at,
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
  }));
}
