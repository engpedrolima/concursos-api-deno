import {
  AttemptValidationError,
  getAttemptHistory,
  InvalidAlternativeError,
  QuestionOccurrenceNotFoundError,
  recordAttempt,
  type RecordAttemptInput,
  validateRecordAttemptInput,
} from "./database/attempts.ts";
import {
  type Database,
  DEFAULT_DATABASE_PATH,
  openDatabase,
} from "./database/connection.ts";
import { runMigrations } from "./database/migrations.ts";
import {
  getQuestionOccurrence,
  listQuestionOccurrences,
  type QuestionOccurrenceFilters,
  QuestionQueryValidationError,
  validateQuestionOccurrenceFilters,
} from "./database/questions.ts";
import type { QuestionKind } from "./database/question_filters.ts";
import {
  getStudyStatistics,
  StatisticsValidationError,
  type StudyStatisticsFilters,
  validateStudyStatisticsFilters,
} from "./database/statistics.ts";

export const API_HOSTNAME = "127.0.0.1";
export const API_PORT = 8000;
export const MAX_JSON_REQUEST_BODY_BYTES = 16 * 1024;

type HandlerResult = Response | Promise<Response>;
export type ApiHandler = (request: Request) => Promise<Response>;

export interface ApiDependencies {
  openDatabase(path: string): Database;
  migrate(database: Database): unknown;
  listQuestions: typeof listQuestionOccurrences;
  getQuestion: typeof getQuestionOccurrence;
  recordAttempt: typeof recordAttempt;
  getAttemptHistory: typeof getAttemptHistory;
  getStatistics: typeof getStudyStatistics;
}

export interface CreateHandlerOptions {
  databasePath?: string;
  dependencies?: Partial<ApiDependencies>;
}

const defaultDependencies: ApiDependencies = {
  openDatabase,
  migrate: runMigrations,
  listQuestions: listQuestionOccurrences,
  getQuestion: getQuestionOccurrence,
  recordAttempt,
  getAttemptHistory,
  getStatistics: getStudyStatistics,
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: HeadersInit = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const jsonResponse = (
  body: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response => {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders,
  });
};

const errorResponse = (
  message: string,
  status: number,
  headers: HeadersInit = {},
) => jsonResponse({ error: message }, status, headers);

function methodNotAllowed(allow: string): Response {
  return errorResponse("Método não permitido.", 405, { allow });
}

function mapError(error: unknown): Response {
  if (error instanceof HttpError) {
    return errorResponse(error.message, error.status, error.headers);
  }
  if (
    error instanceof QuestionQueryValidationError ||
    error instanceof StatisticsValidationError ||
    error instanceof AttemptValidationError ||
    error instanceof InvalidAlternativeError
  ) {
    return errorResponse(error.message, 400);
  }
  if (error instanceof QuestionOccurrenceNotFoundError) {
    return errorResponse(error.message, 404);
  }
  return errorResponse("Erro interno do servidor.", 500);
}

function positiveInteger(value: string, field: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new HttpError(400, `${field} deve ser um inteiro positivo.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new HttpError(400, `${field} deve ser um inteiro positivo.`);
  }
  return parsed;
}

function nonNegativeInteger(value: string, field: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new HttpError(
      400,
      `${field} deve ser um inteiro maior ou igual a zero.`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new HttpError(
      400,
      `${field} deve ser um inteiro maior ou igual a zero.`,
    );
  }
  return parsed;
}

function singleParameter(
  parameters: URLSearchParams,
  name: string,
): string | undefined {
  const values = parameters.getAll(name);
  if (values.length > 1) {
    throw new HttpError(400, `O parâmetro ${name} não pode ser repetido.`);
  }
  return values[0];
}

const COMMON_FILTERS = new Set([
  "organizer",
  "year",
  "role",
  "subject",
  "kind",
  "examId",
]);

function rejectUnknownParameters(
  parameters: URLSearchParams,
  allowed: ReadonlySet<string>,
): void {
  for (const name of parameters.keys()) {
    if (!allowed.has(name)) {
      throw new HttpError(400, `Parâmetro desconhecido: ${name}.`);
    }
  }
}

function commonFilters(parameters: URLSearchParams): StudyStatisticsFilters {
  const filters: StudyStatisticsFilters = {};
  const organizer = singleParameter(parameters, "organizer");
  const year = singleParameter(parameters, "year");
  const role = singleParameter(parameters, "role");
  const subject = singleParameter(parameters, "subject");
  const kind = singleParameter(parameters, "kind");
  const examId = singleParameter(parameters, "examId");
  if (organizer !== undefined) filters.organizer = organizer;
  if (year !== undefined) filters.year = positiveInteger(year, "year");
  if (role !== undefined) filters.role = role;
  if (subject !== undefined) filters.subject = subject;
  if (kind !== undefined) filters.kind = kind as QuestionKind;
  if (examId !== undefined) filters.examId = examId;
  return filters;
}

function questionFilters(
  parameters: URLSearchParams,
): QuestionOccurrenceFilters {
  const allowed = new Set([
    ...COMMON_FILTERS,
    "deduplicate",
    "limit",
    "offset",
  ]);
  rejectUnknownParameters(parameters, allowed);
  const filters: QuestionOccurrenceFilters = commonFilters(parameters);
  const deduplicate = singleParameter(parameters, "deduplicate");
  const limit = singleParameter(parameters, "limit");
  const offset = singleParameter(parameters, "offset");
  if (deduplicate !== undefined) {
    if (deduplicate !== "true" && deduplicate !== "false") {
      throw new HttpError(400, "deduplicate deve ser true ou false.");
    }
    filters.deduplicate = deduplicate === "true";
  }
  if (limit !== undefined) filters.limit = positiveInteger(limit, "limit");
  if (offset !== undefined) {
    filters.offset = nonNegativeInteger(offset, "offset");
  }
  validateQuestionOccurrenceFilters(filters);
  return filters;
}

function statisticsFilters(
  parameters: URLSearchParams,
): StudyStatisticsFilters {
  rejectUnknownParameters(parameters, COMMON_FILTERS);
  const filters = commonFilters(parameters);
  validateStudyStatisticsFilters(filters);
  return filters;
}

async function readJsonBody(request: Request): Promise<unknown> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]
    .trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new HttpError(
      400,
      "O corpo deve usar Content-Type application/json.",
    );
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const length = nonNegativeInteger(contentLength, "Content-Length");
    if (length > MAX_JSON_REQUEST_BODY_BYTES) {
      throw new HttpError(413, "O corpo JSON excede o limite de 16 KiB.");
    }
  }
  if (!request.body) throw new HttpError(400, "Informe um corpo JSON.");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_JSON_REQUEST_BODY_BYTES) {
        await reader.cancel();
        throw new HttpError(413, "O corpo JSON excede o limite de 16 KiB.");
      }
      chunks.push(chunk.value);
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
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(400, "O corpo deve conter JSON UTF-8 válido.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "O corpo deve conter JSON válido.");
  }
}

function attemptInput(
  value: unknown,
  occurrenceId: number,
): RecordAttemptInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "O corpo da tentativa deve ser um objeto JSON.");
  }
  const payload = value as Record<string, unknown>;
  const allowed = new Set(["selectedLabel", "durationMs"]);
  for (const field of Object.keys(payload)) {
    if (!allowed.has(field)) {
      throw new HttpError(400, `Campo desconhecido: ${field}.`);
    }
  }
  if (!Object.hasOwn(payload, "selectedLabel")) {
    throw new HttpError(400, "Informe selectedLabel.");
  }
  const input: RecordAttemptInput = {
    questionOccurrenceId: occurrenceId,
    selectedLabel: payload.selectedLabel as string,
  };
  if (Object.hasOwn(payload, "durationMs")) {
    input.durationMs = payload.durationMs as number;
  }
  validateRecordAttemptInput(input);
  return input;
}

/** Cria um handler sem abrir porta e sem tocar no banco até uma rota de dados. */
export function createHandler(
  options: CreateHandlerOptions = {},
): ApiHandler {
  const databasePath = options.databasePath ?? DEFAULT_DATABASE_PATH;
  if (databasePath.trim() === "") {
    throw new Error("O caminho do banco não pode ser vazio.");
  }
  const dependencies = { ...defaultDependencies, ...options.dependencies };

  const withDatabase = <T>(operation: (database: Database) => T): T => {
    const database = dependencies.openDatabase(databasePath);
    try {
      dependencies.migrate(database);
      return operation(database);
    } finally {
      database.close();
    }
  };

  const dispatch = (request: Request): HandlerResult => {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return jsonResponse({
        service: "concursos-api-deno",
        status: "ok",
        imports:
          "Use `deno task import -- --help`. Apenas PDFs públicos de cadernos e gabaritos definitivos em domínios oficiais são aceitos.",
      });
    }
    if (url.pathname === "/api/questions") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      const filters = questionFilters(url.searchParams);
      return jsonResponse(
        withDatabase((database) =>
          dependencies.listQuestions(database, filters)
        ),
      );
    }
    if (url.pathname === "/api/statistics") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      const filters = statisticsFilters(url.searchParams);
      return jsonResponse(
        withDatabase((database) =>
          dependencies.getStatistics(database, filters)
        ),
      );
    }

    const attemptsMatch = url.pathname.match(
      /^\/api\/questions\/([^/]+)\/attempts$/u,
    );
    if (attemptsMatch) {
      if (request.method !== "GET" && request.method !== "POST") {
        return methodNotAllowed("GET, POST");
      }
      const occurrenceId = positiveInteger(
        attemptsMatch[1],
        "occurrenceId",
      );
      if (request.method === "GET") {
        const history = withDatabase((database) =>
          dependencies.getAttemptHistory(database, occurrenceId)
        );
        return history === null
          ? errorResponse("Ocorrência de questão não encontrada.", 404)
          : jsonResponse(history);
      }
      return readJsonBody(request).then((body) => {
        const input = attemptInput(body, occurrenceId);
        const feedback = withDatabase((database) =>
          dependencies.recordAttempt(database, input)
        );
        return jsonResponse(feedback, 201);
      });
    }

    const detailMatch = url.pathname.match(/^\/api\/questions\/([^/]+)$/u);
    if (detailMatch) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      const occurrenceId = positiveInteger(detailMatch[1], "occurrenceId");
      const question = withDatabase((database) =>
        dependencies.getQuestion(database, occurrenceId)
      );
      return question === null
        ? errorResponse("Ocorrência de questão não encontrada.", 404)
        : jsonResponse(question);
    }
    return errorResponse("Rota não encontrada.", 404);
  };

  return async (request) => {
    try {
      return await dispatch(request);
    } catch (error) {
      return mapError(error);
    }
  };
}

interface ServerArguments {
  databasePath: string;
}

export function parseServerArguments(args: string[]): ServerArguments {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  if (normalized.length === 0) return { databasePath: DEFAULT_DATABASE_PATH };
  if (
    normalized.length !== 2 || normalized[0] !== "--database" ||
    normalized[1].trim() === "" || normalized[1].startsWith("--")
  ) {
    throw new Error(
      "Uso: deno task start -- --database caminho/estudo.sqlite3",
    );
  }
  return { databasePath: normalized[1] };
}

/** Handler compatível para health check e uso local com o caminho-padrão. */
export const handler = createHandler();

if (import.meta.main) {
  const { databasePath } = parseServerArguments(Deno.args);
  const database = openDatabase(databasePath);
  try {
    runMigrations(database);
  } finally {
    database.close();
  }
  console.log(
    `concursos-api-deno em http://${API_HOSTNAME}:${API_PORT} (SQLite local configurado)`,
  );
  Deno.serve(
    { hostname: API_HOSTNAME, port: API_PORT },
    createHandler({ databasePath }),
  );
}
