import { PoliteHttpClient } from "./http.ts";
import type { ExamIdentity, OfficialSource, SourceDocument } from "./types.ts";

/** Tamanho máximo de cada PDF aceito: 25 MiB. */
export const MAX_PDF_BYTES = 25 * 1024 * 1024;

export interface PublicPdfSourceOptions {
  questionBookletUrl: string;
  finalAnswerKeyUrl: string;
  allowedHosts: string[];
  maxPdfBytes?: number;
}

function ensureOfficialPdfUrl(raw: string | URL, allowedHosts: string[]): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("A fonte deve usar HTTPS.");
  if (
    !allowedHosts.some((host) =>
      url.hostname === host || url.hostname.endsWith(`.${host}`)
    )
  ) {
    throw new Error(
      `O domínio ${url.hostname} não está na lista oficial permitida.`,
    );
  }
  return url;
}

async function readPdfBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    await response.body?.cancel();
    throw new Error(`PDF excede o limite de ${maxBytes} bytes.`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("PDF excede o limite permitido.");
        throw new Error(`PDF excede o limite de ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class PublicPdfSource implements OfficialSource {
  readonly name = "public-pdf";
  constructor(
    private readonly options: PublicPdfSourceOptions,
    private readonly http: PoliteHttpClient,
  ) {}

  async fetch(identity: ExamIdentity): Promise<SourceDocument[]> {
    const specs = [
      ["question-booklet", this.options.questionBookletUrl],
      ["final-answer-key", this.options.finalAnswerKeyUrl],
    ] as const;
    const collectedAt = new Date().toISOString();
    const documents: SourceDocument[] = [];
    const maxPdfBytes = this.options.maxPdfBytes ?? MAX_PDF_BYTES;
    for (const [kind, rawUrl] of specs) {
      const url = ensureOfficialPdfUrl(rawUrl, this.options.allowedHosts);
      const response = await this.http.get(
        url.href,
        (redirectUrl) =>
          ensureOfficialPdfUrl(redirectUrl, this.options.allowedHosts),
      );
      const bytes = await readPdfBytes(response, maxPdfBytes);
      const isPdf =
        response.headers.get("content-type")?.toLowerCase().includes("pdf") ||
        new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-";
      if (!isPdf) throw new Error(`${url.href} não retornou um PDF.`);
      documents.push({ bytes, url: response.url, collectedAt, identity, kind });
    }
    return documents;
  }
}
