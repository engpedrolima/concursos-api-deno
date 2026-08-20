import { buildQuestions, type ParseDiagnostics } from "./parser.ts";
import type {
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
) {
  const booklet = documents.find((doc) => doc.kind === "question-booklet");
  const answerKey = documents.find((doc) => doc.kind === "final-answer-key");
  if (!booklet || !answerKey) {
    throw new Error("São obrigatórios caderno de prova e gabarito definitivo.");
  }
  if (booklet.identity.id !== answerKey.identity.id) {
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
  return {
    questions,
    rejected: parsed.rejected,
    diagnostics: parsed.diagnostics,
    documents: [{ url: booklet.url, sha256: bookletHash }, {
      url: answerKey.url,
      sha256: keyHash,
    }],
  };
}
