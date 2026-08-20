import {
  assertImportArtifact,
  IMPORT_ARTIFACT_SCHEMA_VERSION,
  type ImportArtifact,
  IMPORTER_VERSION,
} from "./artifact.ts";
import { buildQuestions, type ParseDiagnostics } from "./parser.ts";
import type {
  ExamIdentity,
  ImportedQuestion,
  OfficialSource,
  PdfTextExtractor,
} from "./types.ts";

const sha256 = async (data: Uint8Array) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", data as unknown as BufferSource),
    ),
  ).map((value) => value.toString(16).padStart(2, "0")).join("");

const sameExam = (left: ExamIdentity, right: ExamIdentity) =>
  left.id === right.id && left.organizer === right.organizer &&
  left.year === right.year && left.role === right.role &&
  left.subject === right.subject;

/** Signals a parser mismatch without retaining or printing extracted PDF text. */
export class NoQuestionsRecognizedError extends Error {
  constructor(readonly diagnostics: ParseDiagnostics) {
    super(
      "Nenhuma questão foi reconhecida no caderno; revise o formato extraído ou adicione um parser conservador para a fonte.",
    );
    this.name = "NoQuestionsRecognizedError";
  }
}

export async function importOfficialQuestions(
  source: OfficialSource,
  identity: Parameters<OfficialSource["fetch"]>[0],
  extractor: PdfTextExtractor,
) {
  return await importDocuments(await source.fetch(identity), extractor);
}

/** Executes an import from two documents already authenticated by an official source. */
export async function importDocuments(
  documents: Awaited<ReturnType<OfficialSource["fetch"]>>,
  extractor: PdfTextExtractor,
): Promise<ImportArtifact> {
  const booklet = documents.find((doc) => doc.kind === "question-booklet");
  const answerKey = documents.find((doc) => doc.kind === "final-answer-key");
  if (!booklet || !answerKey) {
    throw new Error("São obrigatórios caderno de prova e gabarito definitivo.");
  }
  if (!sameExam(booklet.identity, answerKey.identity)) {
    throw new Error("Os documentos pertencem a provas diferentes.");
  }
  const [bookletText, answerKeyText, bookletHash, keyHash] = await Promise.all([
    extractor.extract(booklet.bytes),
    extractor.extract(answerKey.bytes),
    sha256(booklet.bytes),
    sha256(answerKey.bytes),
  ]);
  const parsed = buildQuestions(bookletText, answerKeyText, booklet.identity);
  if (parsed.questions.length === 0 && parsed.rejected.length === 0) {
    throw new NoQuestionsRecognizedError(parsed.diagnostics);
  }
  const questions: ImportedQuestion[] = parsed.questions.map((question) => ({
    ...question,
    provenance: {
      sourceUrl: booklet.url,
      collectedAt: booklet.collectedAt,
      pdfSha256: bookletHash,
      exam: booklet.identity,
    },
  }));
  const artifact: ImportArtifact = {
    schemaVersion: IMPORT_ARTIFACT_SCHEMA_VERSION,
    importerVersion: IMPORTER_VERSION,
    exam: booklet.identity,
    documents: {
      booklet: {
        url: booklet.url,
        sha256: bookletHash,
        collectedAt: booklet.collectedAt,
      },
      answerKey: {
        url: answerKey.url,
        sha256: keyHash,
        collectedAt: answerKey.collectedAt,
      },
    },
    questions,
    rejected: parsed.rejected,
    diagnostics: parsed.diagnostics,
  };
  assertImportArtifact(artifact);
  return artifact;
}
