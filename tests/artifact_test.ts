import { outputImportArtifact } from "../import.ts";
import {
  IMPORT_ARTIFACT_SCHEMA_VERSION,
  ImportArtifactValidationError,
  parseImportArtifact,
} from "../importer/artifact.ts";

const fixture = async (name: string) =>
  await Deno.readTextFile(new URL(`./fixtures/${name}`, import.meta.url));

const assertEquals = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Esperado ${JSON.stringify(expected)}, recebido ${
        JSON.stringify(actual)
      }`,
    );
  }
};

const assertMatch = (actual: string, expected: RegExp) => {
  if (!expected.test(actual)) {
    throw new Error(`Valor não corresponde a ${expected}: ${actual}`);
  }
};

async function validationMessage(
  operation: () => unknown | Promise<unknown>,
): Promise<string> {
  try {
    await operation();
    throw new Error("A validação deveria falhar.");
  } catch (error) {
    if (!(error instanceof ImportArtifactValidationError)) throw error;
    return error.message;
  }
}

Deno.test("aceita envelope sintético completo e versionado", async () => {
  const artifact = parseImportArtifact(
    await fixture("import-artifact-v1.json"),
  );
  assertEquals(artifact.schemaVersion, IMPORT_ARTIFACT_SCHEMA_VERSION);
  assertEquals(artifact.importerVersion, "1.0.0");
  assertEquals(artifact.exam.id, "prova-sintetica-2026");
  assertEquals(artifact.questions.length, 1);
  assertEquals(artifact.rejected.length, 1);
});

Deno.test("documentos do envelope são rotulados como booklet e answerKey", async () => {
  const artifact = parseImportArtifact(
    await fixture("import-artifact-v1.json"),
  );
  assertEquals(Object.keys(artifact.documents).sort(), [
    "answerKey",
    "booklet",
  ]);
  assertMatch(artifact.documents.booklet.url, /caderno-sintetico\.pdf$/);
  assertMatch(artifact.documents.answerKey.url, /gabarito-sintetico\.pdf$/);
  assertMatch(artifact.documents.booklet.sha256, /^[a-f0-9]{64}$/);
  assertMatch(artifact.documents.answerKey.sha256, /^[a-f0-9]{64}$/);
});

Deno.test("rejeita versão de schema incompatível com erro claro", async () => {
  const message = await validationMessage(async () =>
    parseImportArtifact(
      await fixture("import-artifact-unsupported-version.json"),
    )
  );
  assertMatch(
    message,
    /schemaVersion: versão incompatível; esperado 1, recebido 99/,
  );
});

Deno.test("rejeita envelope incompleto com caminho do campo ausente", async () => {
  const message = await validationMessage(async () =>
    parseImportArtifact(await fixture("import-artifact-incomplete.json"))
  );
  assertMatch(message, /documents\.answerKey: deve ser um objeto/);
});

Deno.test("dry-run prevalece sobre output e não chama escrita", async () => {
  const artifact = parseImportArtifact(
    await fixture("import-artifact-v1.json"),
  );
  const logs: string[] = [];
  let writes = 0;
  const result = await outputImportArtifact(
    artifact,
    ["--dry-run", "--output", "nao-deve-existir.json"],
    {
      log: (message) => logs.push(message),
      writeTextFile: () => {
        writes++;
        return Promise.resolve();
      },
    },
  );
  assertEquals(result.written, false);
  assertEquals(writes, 0);
  assertMatch(logs.at(-1) ?? "", /Nenhum arquivo foi gravado/);
});

Deno.test("output recebe somente JSON válido e versionado", async () => {
  const artifact = parseImportArtifact(
    await fixture("import-artifact-v1.json"),
  );
  let writtenPath = "";
  let writtenData = "";
  const result = await outputImportArtifact(
    artifact,
    ["--output", "artefato.json"],
    {
      log: () => undefined,
      writeTextFile: (path, data) => {
        writtenPath = path;
        writtenData = data;
        return Promise.resolve();
      },
    },
  );
  assertEquals(result, { written: true, output: "artefato.json" });
  assertEquals(writtenPath, "artefato.json");
  assertEquals(
    parseImportArtifact(writtenData).schemaVersion,
    IMPORT_ARTIFACT_SCHEMA_VERSION,
  );
});

Deno.test("output rejeita artefato inválido antes de escrever", async () => {
  const incomplete = JSON.parse(
    await fixture("import-artifact-incomplete.json"),
  );
  let writes = 0;
  try {
    await outputImportArtifact(incomplete, ["--output", "artefato.json"], {
      log: () => undefined,
      writeTextFile: () => {
        writes++;
        return Promise.resolve();
      },
    });
    throw new Error("A saída deveria rejeitar o artefato.");
  } catch (error) {
    if (!(error instanceof ImportArtifactValidationError)) throw error;
    assertMatch(error.message, /documents\.answerKey/);
  }
  assertEquals(writes, 0);
});
