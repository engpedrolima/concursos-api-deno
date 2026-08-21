import {
  type ImportArtifact,
  ImportArtifactValidationError,
  validateImportArtifact,
} from "../importer/artifact.ts";
import {
  type Database,
  DEFAULT_DATABASE_PATH,
  openDatabase,
} from "./connection.ts";
import {
  persistImportArtifact,
  type PersistImportResult,
} from "./import_artifact.ts";
import { runMigrations } from "./migrations.ts";

export interface DatabaseImportCliDependencies {
  readTextFile(path: string): Promise<string>;
  openDatabase(path: string): Database;
  migrate(database: Database): unknown;
  persist(database: Database, artifact: ImportArtifact): PersistImportResult;
  log(message: string): void;
}

const defaultDependencies: DatabaseImportCliDependencies = {
  readTextFile: (path) => Deno.readTextFile(path),
  openDatabase,
  migrate: runMigrations,
  persist: persistImportArtifact,
  log: (message) => console.log(message),
};

function option(
  args: string[],
  name: string,
  required = false,
): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (index >= 0 && (!value || value.startsWith("--"))) {
    throw new Error(`Informe ${name}.`);
  }
  if (required && !value) throw new Error(`Informe ${name}.`);
  return value;
}

/** Lê e valida o artefato antes que qualquer conexão de banco seja aberta. */
async function readArtifact(
  path: string,
  readTextFile: DatabaseImportCliDependencies["readTextFile"],
): Promise<ImportArtifact> {
  const json = await readTextFile(path);
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
  return validateImportArtifact(value);
}

export async function runDatabaseImportCli(
  args: string[],
  overrides: Partial<DatabaseImportCliDependencies> = {},
): Promise<PersistImportResult | undefined> {
  const dependencies = { ...defaultDependencies, ...overrides };
  if (args.includes("--help")) {
    dependencies.log(
      "deno task db:import -- --artifact caminho.json [--database caminho.sqlite3]",
    );
    return undefined;
  }
  const artifactPath = option(args, "--artifact", true)!;
  const databasePath = option(args, "--database") ?? DEFAULT_DATABASE_PATH;
  const artifact = await readArtifact(artifactPath, dependencies.readTextFile);

  const database = dependencies.openDatabase(databasePath);
  try {
    dependencies.migrate(database);
    const result = dependencies.persist(database, artifact);
    dependencies.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    database.close();
  }
}

if (import.meta.main) {
  try {
    await runDatabaseImportCli(Deno.args);
  } catch (error) {
    console.error(
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error),
    );
    Deno.exit(1);
  }
}
