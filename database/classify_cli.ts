import {
  classifyExamSubjects,
  type ClassifyExamSubjectsResult,
} from "./classify_subjects.ts";
import {
  type Database,
  DEFAULT_DATABASE_PATH,
  openDatabase,
} from "./connection.ts";
import { runMigrations } from "./migrations.ts";

export interface ClassifyCliDependencies {
  openDatabase(path: string): Database;
  migrate(database: Database): unknown;
  classify(
    database: Database,
    options: { examId: string; force: boolean },
  ): ClassifyExamSubjectsResult;
  log(message: string): void;
}

const defaultDependencies: ClassifyCliDependencies = {
  openDatabase,
  migrate: runMigrations,
  classify: classifyExamSubjects,
  log: (message) => console.log(message),
};

export interface ParsedClassifyArguments {
  databasePath: string;
  examId: string;
  force: boolean;
}

export function parseClassifyArguments(
  args: string[],
): ParsedClassifyArguments {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  let examId: string | undefined;
  let databasePath = DEFAULT_DATABASE_PATH;
  let force = false;
  let databaseSeen = false;
  for (let index = 0; index < normalized.length; index++) {
    const name = normalized[index];
    if (name === "--force") {
      if (force) throw new Error("Argumento duplicado: --force.");
      force = true;
      continue;
    }
    if (name !== "--exam-id" && name !== "--database") {
      throw new Error(`Argumento desconhecido: ${name}.`);
    }
    if (name === "--exam-id" && examId !== undefined) {
      throw new Error("Argumento duplicado: --exam-id.");
    }
    if (name === "--database" && databaseSeen) {
      throw new Error("Argumento duplicado: --database.");
    }
    const value = normalized[++index];
    if (value === undefined || value.startsWith("--") || value.trim() === "") {
      throw new Error(`Informe ${name}.`);
    }
    if (name === "--exam-id") examId = value;
    else {
      databasePath = value;
      databaseSeen = true;
    }
  }
  if (examId === undefined) {
    throw new Error(
      "Uso: deno task db:classify -- --exam-id ID " +
        "[--database caminho.sqlite3] [--force]",
    );
  }
  return { databasePath, examId, force };
}

export function runClassifyCli(
  args: string[],
  overrides: Partial<ClassifyCliDependencies> = {},
): ClassifyExamSubjectsResult {
  const dependencies = { ...defaultDependencies, ...overrides };
  const parsed = parseClassifyArguments(args);
  const database = dependencies.openDatabase(parsed.databasePath);
  try {
    dependencies.migrate(database);
    const result = dependencies.classify(database, {
      examId: parsed.examId,
      force: parsed.force,
    });
    dependencies.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    database.close();
  }
}

if (import.meta.main) {
  try {
    runClassifyCli(Deno.args);
  } catch (error) {
    console.error(
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error),
    );
    Deno.exit(1);
  }
}
