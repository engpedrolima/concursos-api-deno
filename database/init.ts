import { DEFAULT_DATABASE_PATH, openDatabase } from "./connection.ts";
import { runMigrations } from "./migrations.ts";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Informe ${name}.`);
  return value;
}

export function initializeDatabase(args: string[] = Deno.args): void {
  const path = option(args, "--database") ?? DEFAULT_DATABASE_PATH;
  const database = openDatabase(path);
  try {
    const result = runMigrations(database);
    console.log(
      `Banco pronto em ${path}. Migrações aplicadas: ${
        result.applied.join(", ") || "nenhuma"
      }; já existentes: ${result.skipped.join(", ") || "nenhuma"}.`,
    );
  } finally {
    database.close();
  }
}

if (import.meta.main) initializeDatabase();
