import {
  assertImportArtifact,
  type ImportArtifact,
} from "./importer/artifact.ts";
import { PoliteHttpClient } from "./importer/http.ts";
import {
  importOfficialQuestions,
  NoQuestionsRecognizedError,
} from "./importer/importer.ts";
import { LocalPdftotextExtractor } from "./importer/pdf.ts";
import { DuplicateQuestionNumberError } from "./importer/parser.ts";
import { PublicPdfSource } from "./importer/sources.ts";
import type { ExamIdentity } from "./importer/types.ts";

function option(
  args: string[],
  name: string,
  required = true,
): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (required && !value) throw new Error(`Informe ${name}.`);
  return value;
}

export interface ImportCliIo {
  log(message: string): void;
  error(message: string): void;
  writeTextFile(path: string, data: string): Promise<void>;
}

const defaultIo: ImportCliIo = {
  log: (message) => console.log(message),
  error: (message) => console.error(message),
  writeTextFile: (path, data) => Deno.writeTextFile(path, data),
};

/** Emite o artefato validado; dry-run sempre prevalece sobre --output. */
export async function outputImportArtifact(
  artifact: unknown,
  args: string[],
  io: Pick<ImportCliIo, "log" | "writeTextFile"> = defaultIo,
): Promise<{ written: boolean; output?: string }> {
  assertImportArtifact(artifact);
  const payload = JSON.stringify(artifact, null, 2);
  const output = option(args, "--output", false);
  if (args.includes("--dry-run") || !output) {
    io.log(payload);
    io.log(
      `Dry-run: ${artifact.questions.length} questões válidas; ${artifact.rejected.length} rejeitadas. Nenhum arquivo foi gravado.`,
    );
    return { written: false };
  }
  await io.writeTextFile(output, payload);
  io.log(
    `Artefato de importação criado: ${output} (${artifact.questions.length} questões, schema v${artifact.schemaVersion}).`,
  );
  return { written: true, output };
}

export async function runImportCli(
  args: string[],
  io: ImportCliIo = defaultIo,
): Promise<number> {
  if (args.includes("--help")) {
    io.log(
      "deno task import -- --booklet URL --answer-key URL --official-host dominio --exam-id ID --organizer BANCA --year ANO [--role CARGO] [--subject ASSUNTO] [--dry-run] [--output arquivo.json]",
    );
    return 0;
  }

  const identity: ExamIdentity = {
    id: option(args, "--exam-id")!,
    organizer: option(args, "--organizer")!,
    year: Number(option(args, "--year")!),
    role: option(args, "--role", false),
    subject: option(args, "--subject", false),
  };
  if (!Number.isInteger(identity.year) || identity.year < 1900) {
    throw new Error("--year inválido.");
  }
  const source = new PublicPdfSource(
    {
      questionBookletUrl: option(args, "--booklet")!,
      finalAnswerKeyUrl: option(args, "--answer-key")!,
      allowedHosts: [option(args, "--official-host")!],
    },
    new PoliteHttpClient({
      timeoutMs: 20_000,
      retries: 2,
      minIntervalMs: 1_000,
      maxRedirects: 3,
      userAgent: "concursos-api-deno/1.0 (importador de PDFs públicos)",
    }),
  );

  let artifact: ImportArtifact;
  try {
    artifact = await importOfficialQuestions(
      source,
      identity,
      new LocalPdftotextExtractor(),
    );
  } catch (error) {
    if (error instanceof NoQuestionsRecognizedError) {
      io.error(JSON.stringify(
        {
          error: error.name,
          message: error.message,
          diagnostics: error.diagnostics,
        },
        null,
        2,
      ));
      return 1;
    }
    if (error instanceof DuplicateQuestionNumberError) {
      io.error(JSON.stringify(
        {
          error: error.name,
          message: error.message,
          diagnostics: { duplicateNumbers: error.duplicateNumbers },
        },
        null,
        2,
      ));
      return 1;
    }
    throw error;
  }

  await outputImportArtifact(artifact, args, io);
  return 0;
}

if (import.meta.main) {
  Deno.exit(await runImportCli(Deno.args));
}
