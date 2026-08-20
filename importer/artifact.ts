import type { ParseDiagnostics } from "./parser.ts";
import type { ExamIdentity, ImportedQuestion } from "./types.ts";

/** Versão do contrato JSON. Mudanças incompatíveis exigem um novo número. */
export const IMPORT_ARTIFACT_SCHEMA_VERSION = 1 as const;

/** Versão estável do parser/importador que produziu o artefato. */
export const IMPORTER_VERSION = "1.0.0" as const;

export interface ImportArtifactDocument {
  url: string;
  sha256: string;
  collectedAt: string;
}

export interface ImportArtifact {
  schemaVersion: typeof IMPORT_ARTIFACT_SCHEMA_VERSION;
  importerVersion: string;
  exam: ExamIdentity;
  documents: {
    booklet: ImportArtifactDocument;
    answerKey: ImportArtifactDocument;
  };
  questions: ImportedQuestion[];
  rejected: string[];
  diagnostics: ParseDiagnostics;
}

export class ImportArtifactValidationError extends Error {
  constructor(message: string) {
    super(`Artefato de importação inválido: ${message}`);
    this.name = "ImportArtifactValidationError";
  }
}

type JsonRecord = Record<string, unknown>;

function invalid(path: string, message: string): never {
  throw new ImportArtifactValidationError(`${path}: ${message}`);
}

function record(value: unknown, path: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(path, "deve ser um objeto");
  }
  return value as JsonRecord;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    return invalid(path, "deve ser uma string não vazia");
  }
  return value;
}

function optionalText(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return text(value, path);
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    return invalid(path, `deve ser um inteiro maior ou igual a ${minimum}`);
  }
  return value as number;
}

function examIdentity(value: unknown, path: string): ExamIdentity {
  const candidate = record(value, path);
  return {
    id: text(candidate.id, `${path}.id`),
    organizer: text(candidate.organizer, `${path}.organizer`),
    year: integer(candidate.year, `${path}.year`, 1900),
    role: optionalText(candidate.role, `${path}.role`),
    subject: optionalText(candidate.subject, `${path}.subject`),
  };
}

function sameExam(left: ExamIdentity, right: ExamIdentity): boolean {
  return left.id === right.id && left.organizer === right.organizer &&
    left.year === right.year && left.role === right.role &&
    left.subject === right.subject;
}

function document(
  value: unknown,
  path: string,
): ImportArtifactDocument {
  const candidate = record(value, path);
  const url = text(candidate.url, `${path}.url`);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return invalid(`${path}.url`, "deve ser uma URL válida");
  }
  if (parsedUrl.protocol !== "https:") {
    return invalid(`${path}.url`, "deve usar HTTPS");
  }
  const sha256 = text(candidate.sha256, `${path}.sha256`);
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    return invalid(`${path}.sha256`, "deve conter 64 caracteres hexadecimais");
  }
  const collectedAt = text(candidate.collectedAt, `${path}.collectedAt`);
  try {
    if (new Date(collectedAt).toISOString() !== collectedAt) throw new Error();
  } catch {
    return invalid(
      `${path}.collectedAt`,
      "deve ser uma data ISO 8601 normalizada",
    );
  }
  return { url, sha256, collectedAt };
}

function diagnostics(value: unknown): void {
  const candidate = record(value, "diagnostics");
  for (
    const field of [
      "questionHeaders",
      "multipleChoiceCandidates",
      "certoErradoCandidates",
      "bookletCharacters",
      "answerKeyCharacters",
    ]
  ) {
    integer(candidate[field], `diagnostics.${field}`);
  }
}

function question(
  value: unknown,
  index: number,
  exam: ExamIdentity,
  booklet: ImportArtifactDocument,
): void {
  const path = `questions[${index}]`;
  const candidate = record(value, path);
  integer(candidate.number, `${path}.number`, 1);
  text(candidate.statement, `${path}.statement`);
  const alternatives = record(candidate.alternatives, `${path}.alternatives`);
  const labels = Object.keys(alternatives);
  if (labels.length < 2) {
    invalid(`${path}.alternatives`, "deve conter pelo menos duas alternativas");
  }
  for (const label of labels) {
    text(alternatives[label], `${path}.alternatives.${label}`);
  }
  const answer = text(candidate.answer, `${path}.answer`);
  if (!Object.hasOwn(alternatives, answer)) {
    invalid(`${path}.answer`, "deve identificar uma alternativa existente");
  }
  if (text(candidate.organizer, `${path}.organizer`) !== exam.organizer) {
    invalid(`${path}.organizer`, "deve corresponder à identidade da prova");
  }
  if (integer(candidate.year, `${path}.year`, 1900) !== exam.year) {
    invalid(`${path}.year`, "deve corresponder à identidade da prova");
  }
  if (optionalText(candidate.role, `${path}.role`) !== exam.role) {
    invalid(`${path}.role`, "deve corresponder à identidade da prova");
  }
  optionalText(candidate.subject, `${path}.subject`);

  const provenance = record(candidate.provenance, `${path}.provenance`);
  if (
    text(provenance.sourceUrl, `${path}.provenance.sourceUrl`) !== booklet.url
  ) {
    invalid(`${path}.provenance.sourceUrl`, "deve apontar para o caderno");
  }
  if (
    text(provenance.collectedAt, `${path}.provenance.collectedAt`) !==
      booklet.collectedAt
  ) {
    invalid(
      `${path}.provenance.collectedAt`,
      "deve corresponder à coleta do caderno",
    );
  }
  if (
    text(provenance.pdfSha256, `${path}.provenance.pdfSha256`) !==
      booklet.sha256
  ) {
    invalid(`${path}.provenance.pdfSha256`, "deve corresponder ao caderno");
  }
  const provenanceExam = examIdentity(
    provenance.exam,
    `${path}.provenance.exam`,
  );
  if (!sameExam(provenanceExam, exam)) {
    invalid(
      `${path}.provenance.exam`,
      "deve corresponder à identidade da prova",
    );
  }
}

/** Valida integralmente a fronteira aceita pela futura persistência. */
export function assertImportArtifact(
  value: unknown,
): asserts value is ImportArtifact {
  const artifact = record(value, "artifact");
  if (artifact.schemaVersion !== IMPORT_ARTIFACT_SCHEMA_VERSION) {
    invalid(
      "schemaVersion",
      `versão incompatível; esperado ${IMPORT_ARTIFACT_SCHEMA_VERSION}, recebido ${
        JSON.stringify(artifact.schemaVersion)
      }`,
    );
  }
  const importerVersion = text(artifact.importerVersion, "importerVersion");
  if (!/^\d+\.\d+\.\d+$/.test(importerVersion)) {
    invalid("importerVersion", "deve usar o formato semântico X.Y.Z");
  }
  const exam = examIdentity(artifact.exam, "exam");
  const documents = record(artifact.documents, "documents");
  const booklet = document(documents.booklet, "documents.booklet");
  document(documents.answerKey, "documents.answerKey");
  if (!Array.isArray(artifact.questions)) {
    invalid("questions", "deve ser uma lista");
  }
  artifact.questions.forEach((item, index) =>
    question(item, index, exam, booklet)
  );
  if (!Array.isArray(artifact.rejected)) {
    invalid("rejected", "deve ser uma lista");
  }
  artifact.rejected.forEach((item, index) => text(item, `rejected[${index}]`));
  diagnostics(artifact.diagnostics);
}

export function parseImportArtifact(json: string): ImportArtifact {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new ImportArtifactValidationError(
      `JSON malformado: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  assertImportArtifact(value);
  return value;
}
