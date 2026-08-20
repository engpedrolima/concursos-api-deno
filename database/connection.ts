import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";

/** Caminho local padrão, relativo ao diretório em que o processo é iniciado. */
export const DEFAULT_DATABASE_PATH = "data/concursos.sqlite3";

export type Database = DatabaseSync;

/**
 * Abre e configura uma conexão SQLite.
 *
 * Toda conexão ativa chaves estrangeiras. Bancos em arquivo usam WAL e esperam
 * até cinco segundos por um lock concorrente antes de falhar.
 */
export function openDatabase(
  path: string = DEFAULT_DATABASE_PATH,
): DatabaseSync {
  if (path.trim() === "") {
    throw new Error("O caminho do banco não pode ser vazio.");
  }
  const inMemory = path === ":memory:";
  if (!inMemory) Deno.mkdirSync(dirname(resolve(path)), { recursive: true });

  const database = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
  });
  try {
    database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (!inMemory) database.exec("PRAGMA journal_mode = WAL;");
    const result = database.prepare("PRAGMA foreign_keys").get() as
      | { foreign_keys: number }
      | undefined;
    if (result?.foreign_keys !== 1) {
      throw new Error(
        "Não foi possível ativar PRAGMA foreign_keys nesta conexão.",
      );
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
