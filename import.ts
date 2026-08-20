import { PoliteHttpClient } from "./importer/http.ts";
import {
  importOfficialQuestions,
  NoQuestionsRecognizedError,
} from "./importer/importer.ts";
import { LocalPdftotextExtractor } from "./importer/pdf.ts";
import { DuplicateQuestionNumberError } from "./importer/parser.ts";
import { PublicPdfSource } from "./importer/sources.ts";
import type { ExamIdentity } from "./importer/types.ts";

function option(name: string, required = true): string | undefined {
  const index = Deno.args.indexOf(name);
  const value = index >= 0 ? Deno.args[index + 1] : undefined;
  if (required && !value) throw new Error(`Informe ${name}.`);
  return value;
}

if (Deno.args.includes("--help")) {
  console.log(
    "deno task import -- --booklet URL --answer-key URL --official-host dominio --exam-id ID --organizer BANCA --year ANO [--role CARGO] [--subject ASSUNTO] [--dry-run] [--output arquivo.json]",
  );
  Deno.exit(0);
}

const identity: ExamIdentity = {
  id: option("--exam-id")!,
  organizer: option("--organizer")!,
  year: Number(option("--year")!),
  role: option("--role", false),
  subject: option("--subject", false),
};
if (!Number.isInteger(identity.year) || identity.year < 1900) {
  throw new Error("--year inválido.");
}
const source = new PublicPdfSource(
  {
    questionBookletUrl: option("--booklet")!,
    finalAnswerKeyUrl: option("--answer-key")!,
    allowedHosts: [option("--official-host")!],
  },
  new PoliteHttpClient({
    timeoutMs: 20_000,
    retries: 2,
    minIntervalMs: 1_000,
    maxRedirects: 3,
    userAgent: "concursos-api-deno/1.0 (importador de PDFs públicos)",
  }),
);

let result;
try {
  result = await importOfficialQuestions(
    source,
    identity,
    new LocalPdftotextExtractor(),
  );
} catch (error) {
  if (error instanceof NoQuestionsRecognizedError) {
    console.error(JSON.stringify(
      {
        error: error.name,
        message: error.message,
        diagnostics: error.diagnostics,
      },
      null,
      2,
    ));
    Deno.exit(1);
  }
  if (error instanceof DuplicateQuestionNumberError) {
    console.error(JSON.stringify(
      {
        error: error.name,
        message: error.message,
        diagnostics: { duplicateNumbers: error.duplicateNumbers },
      },
      null,
      2,
    ));
    Deno.exit(1);
  }
  throw error;
}

const payload = JSON.stringify(result, null, 2);
if (Deno.args.includes("--dry-run") || !option("--output", false)) {
  console.log(payload);
  console.log(
    `Dry-run: ${result.questions.length} questões válidas; ${result.rejected.length} rejeitadas. Nenhum arquivo foi gravado.`,
  );
} else {
  const output = option("--output", false)!;
  await Deno.writeTextFile(output, payload);
  console.log(
    `Arquivo de importação criado: ${output} (${result.questions.length} questões).`,
  );
}
