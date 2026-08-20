/** Dados mínimos que identificam inequivocamente uma prova oficial. */
export interface ExamIdentity {
  id: string;
  organizer: string;
  year: number;
  role?: string;
  subject?: string;
}

export interface Provenance {
  sourceUrl: string;
  collectedAt: string;
  pdfSha256: string;
  exam: ExamIdentity;
}

export interface ImportedQuestion {
  number: number;
  statement: string;
  alternatives: Record<string, string>;
  answer: string;
  organizer: string;
  year: number;
  role?: string;
  subject?: string;
  provenance: Provenance;
}

export interface SourceDocument {
  bytes: Uint8Array;
  url: string;
  collectedAt: string;
  identity: ExamIdentity;
  kind: "question-booklet" | "final-answer-key";
}

export interface OfficialSource {
  readonly name: string;
  fetch(identity: ExamIdentity): Promise<SourceDocument[]>;
}

export interface PdfTextExtractor {
  extract(pdf: Uint8Array): Promise<string>;
}
