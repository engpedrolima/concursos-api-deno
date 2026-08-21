import {
  type AttemptFeedback,
  recordAttempt,
  type RecordAttemptInput,
  validateRecordAttemptInput,
} from "./attempts.ts";
import {
  type Database,
  DEFAULT_DATABASE_PATH,
  openDatabase,
} from "./connection.ts";
import { runMigrations } from "./migrations.ts";

export interface AnswerCliDependencies {
  openDatabase(path: string): Database;
  migrate(database: Database): unknown;
  record(database: Database, input: RecordAttemptInput): AttemptFeedback;
  log(message: string): void;
}

const defaultDependencies: AnswerCliDependencies = {
  openDatabase,
  migrate: runMigrations,
  record: recordAttempt,
  log: (message) => console.log(message),
};

interface ParsedArguments {
  databasePath: string;
  input: RecordAttemptInput;
}

const KNOWN_OPTIONS = new Set([
  "--occurrence-id",
  "--selected-label",
  "--duration-ms",
  "--database",
]);

function parseOptions(args: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!KNOWN_OPTIONS.has(name)) {
      throw new Error(`Argumento desconhecido: ${name}.`);
    }
    if (options.has(name)) throw new Error(`Argumento duplicado: ${name}.`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Informe ${name}.`);
    }
    options.set(name, value);
  }
  return options;
}

function required(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (value === undefined) throw new Error(`Informe ${name}.`);
  return value;
}

function numericOption(value: string, name: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${name} deve ser um inteiro não negativo.`);
  }
  return Number(value);
}

/** Analisa e valida todos os argumentos antes que o banco seja aberto. */
export function parseAnswerArguments(args: string[]): ParsedArguments {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  const options = parseOptions(normalizedArgs);
  const input: RecordAttemptInput = {
    questionOccurrenceId: numericOption(
      required(options, "--occurrence-id"),
      "--occurrence-id",
    ),
    selectedLabel: required(options, "--selected-label"),
  };
  const duration = options.get("--duration-ms");
  if (duration !== undefined) {
    input.durationMs = numericOption(duration, "--duration-ms");
  }
  validateRecordAttemptInput(input);

  const databasePath = options.get("--database") ?? DEFAULT_DATABASE_PATH;
  if (databasePath.trim() === "") {
    throw new Error("--database não pode ser vazio.");
  }
  return { databasePath, input };
}

export function runAnswerCli(
  args: string[],
  overrides: Partial<AnswerCliDependencies> = {},
): AttemptFeedback | undefined {
  const dependencies = { ...defaultDependencies, ...overrides };
  if (args.includes("--help")) {
    dependencies.log(
      "deno task db:answer -- --occurrence-id 1 --selected-label A " +
        "[--duration-ms 12000] [--database caminho.sqlite3]",
    );
    return undefined;
  }
  const parsed = parseAnswerArguments(args);
  const database = dependencies.openDatabase(parsed.databasePath);
  try {
    dependencies.migrate(database);
    const result = dependencies.record(database, parsed.input);
    dependencies.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    database.close();
  }
}

if (import.meta.main) {
  try {
    runAnswerCli(Deno.args);
  } catch (error) {
    console.error(
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error),
    );
    Deno.exit(1);
  }
}
