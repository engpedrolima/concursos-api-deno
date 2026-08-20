import { createHash } from "node:crypto";
import type { Database } from "./connection.ts";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const initialSchema = Deno.readTextFileSync(
  new URL("./migrations/001_initial_schema.sql", import.meta.url),
);

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "initial_schema", sql: initialSchema },
];

export interface MigrationResult {
  applied: number[];
  skipped: number[];
}

export class MigrationError extends Error {
  constructor(
    readonly version: number,
    readonly migrationName: string,
    cause: unknown,
  ) {
    super(
      `Falha na migração ${version} (${migrationName}): ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = "MigrationError";
  }
}

const normalizedSql = (sql: string) => sql.replaceAll("\r\n", "\n");

export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(normalizedSql(sql), "utf8").digest("hex");
}

function ensureMigrationTable(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE CHECK (trim(name) <> ''),
      checksum TEXT NOT NULL CHECK (
        length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*'
      ),
      applied_at TEXT NOT NULL CHECK (
        applied_at GLOB '????-??-??T??:??:??.???Z'
      )
    ) STRICT;
  `);
}

function validatedMigrations(
  migrations: readonly Migration[],
): Array<Migration & { checksum: string; normalizedSql: string }> {
  const versions = new Set<number>();
  const names = new Set<string>();
  const validated = migrations.map((migration) => {
    if (!Number.isInteger(migration.version) || migration.version < 1) {
      throw new Error("Toda migração deve ter versão inteira positiva.");
    }
    if (migration.name.trim() === "") {
      throw new Error(`A migração ${migration.version} deve ter nome.`);
    }
    if (versions.has(migration.version)) {
      throw new Error(`Versão de migração duplicada: ${migration.version}.`);
    }
    if (names.has(migration.name)) {
      throw new Error(`Nome de migração duplicado: ${migration.name}.`);
    }
    versions.add(migration.version);
    names.add(migration.name);
    const sql = normalizedSql(migration.sql);
    return {
      ...migration,
      normalizedSql: sql,
      checksum: migrationChecksum(sql),
    };
  });
  return validated.sort((left, right) => left.version - right.version);
}

/** Aplica cada migração pendente em sua própria transação. */
export function runMigrations(
  database: Database,
  migrations: readonly Migration[] = MIGRATIONS,
): MigrationResult {
  ensureMigrationTable(database);
  const available = validatedMigrations(migrations);
  const byVersion = new Map(available.map((migration) => [
    migration.version,
    migration,
  ]));
  const appliedRows = database.prepare(
    "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
  ).all() as Array<{ version: number; name: string; checksum: string }>;

  for (const row of appliedRows) {
    const expected = byVersion.get(row.version);
    if (!expected) {
      throw new Error(
        `O banco contém a migração desconhecida ${row.version} (${row.name}).`,
      );
    }
    if (row.name !== expected.name || row.checksum !== expected.checksum) {
      throw new Error(
        `A migração aplicada ${row.version} não corresponde ao código atual.`,
      );
    }
  }

  const alreadyApplied = new Set(appliedRows.map((row) => row.version));
  const result: MigrationResult = { applied: [], skipped: [] };
  const insertMigration = database.prepare(`
    INSERT INTO schema_migrations (version, name, checksum, applied_at)
    VALUES (?, ?, ?, ?)
  `);

  for (const migration of available) {
    if (alreadyApplied.has(migration.version)) {
      result.skipped.push(migration.version);
      continue;
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.normalizedSql);
      insertMigration.run(
        migration.version,
        migration.name,
        migration.checksum,
        new Date().toISOString(),
      );
      database.exec("COMMIT");
      result.applied.push(migration.version);
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // O erro original da migração é mais informativo.
      }
      throw new MigrationError(migration.version, migration.name, error);
    }
  }
  return result;
}
