import {
  getStudyStatistics,
  type StudyStatistics,
  type StudyStatisticsFilters,
  validateStudyStatisticsFilters,
} from "./statistics.ts";
import {
  type Database,
  DEFAULT_DATABASE_PATH,
  openDatabase,
} from "./connection.ts";
import { runMigrations } from "./migrations.ts";

export interface StatisticsCliDependencies {
  openDatabase(path: string): Database;
  migrate(database: Database): unknown;
  read(
    database: Database,
    filters: StudyStatisticsFilters,
  ): StudyStatistics;
  log(message: string): void;
}

const defaultDependencies: StatisticsCliDependencies = {
  openDatabase,
  migrate: runMigrations,
  read: getStudyStatistics,
  log: (message) => console.log(message),
};

export interface ParsedStatisticsArguments {
  databasePath: string;
  filters: StudyStatisticsFilters;
}

const KNOWN_OPTIONS = new Set([
  "--database",
  "--organizer",
  "--year",
  "--role",
  "--subject",
  "--kind",
  "--exam-id",
]);

function parseOptions(args: string[]): Map<string, string> {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  const options = new Map<string, string>();
  for (let index = 0; index < normalizedArgs.length; index += 2) {
    const name = normalizedArgs[index];
    if (!KNOWN_OPTIONS.has(name)) {
      throw new Error(`Argumento desconhecido: ${name}.`);
    }
    if (options.has(name)) throw new Error(`Argumento duplicado: ${name}.`);
    const value = normalizedArgs[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Informe ${name}.`);
    }
    options.set(name, value);
  }
  return options;
}

function optionalInteger(
  options: Map<string, string>,
  name: string,
): number | undefined {
  const value = options.get(name);
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${name} deve ser um inteiro não negativo.`);
  }
  return Number(value);
}

/** Analisa e valida todos os argumentos antes que o banco seja aberto. */
export function parseStatisticsArguments(
  args: string[],
): ParsedStatisticsArguments {
  const options = parseOptions(args);
  const filters: StudyStatisticsFilters = {};
  const organizer = options.get("--organizer");
  const year = optionalInteger(options, "--year");
  const role = options.get("--role");
  const subject = options.get("--subject");
  const kind = options.get("--kind");
  const examId = options.get("--exam-id");
  if (organizer !== undefined) filters.organizer = organizer;
  if (year !== undefined) filters.year = year;
  if (role !== undefined) filters.role = role;
  if (subject !== undefined) filters.subject = subject;
  if (kind !== undefined) {
    filters.kind = kind as StudyStatisticsFilters["kind"];
  }
  if (examId !== undefined) filters.examId = examId;
  validateStudyStatisticsFilters(filters);

  const databasePath = options.get("--database") ?? DEFAULT_DATABASE_PATH;
  if (databasePath.trim() === "") {
    throw new Error("--database não pode ser vazio.");
  }
  return { databasePath, filters };
}

export function runStatisticsCli(
  args: string[],
  overrides: Partial<StatisticsCliDependencies> = {},
): StudyStatistics {
  const dependencies = { ...defaultDependencies, ...overrides };
  const parsed = parseStatisticsArguments(args);
  const database = dependencies.openDatabase(parsed.databasePath);
  try {
    dependencies.migrate(database);
    const result = dependencies.read(database, parsed.filters);
    dependencies.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    database.close();
  }
}

if (import.meta.main) {
  try {
    runStatisticsCli(Deno.args);
  } catch (error) {
    console.error(
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error),
    );
    Deno.exit(1);
  }
}
