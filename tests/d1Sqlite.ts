// Test-only D1Database adapter over node:sqlite, so query helpers are tested
// against real SQL semantics (unique indexes, conditional updates, upsert
// conflict clauses) instead of hand-rolled mocks.
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Loaded via require so the test bundler (vite 5) does not try to resolve
// node:sqlite, which is missing from its builtin-module list.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      get(...params: never[]): unknown;
      all(...params: never[]): unknown[];
      run(...params: never[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    };
  };
};

type BoundStatement = {
  bind(...values: unknown[]): BoundStatement;
  first<T = unknown>(column?: string): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[]; success: boolean; meta: Record<string, unknown> }>;
  run(): Promise<{ success: boolean; meta: { changes: number; last_row_id: number } }>;
  raw<T = unknown>(): Promise<T[]>;
};

function normalizeValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

export function createSqliteD1(): D1Database {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");

  function prepare(sql: string): BoundStatement {
    let bound: unknown[] = [];
    const statement: BoundStatement = {
      bind(...values: unknown[]) {
        bound = values.map(normalizeValue);
        return statement;
      },
      async first<T>(column?: string) {
        const row = database.prepare(sql).get(...(bound as never[])) as Record<string, unknown> | undefined;
        if (!row) return null;
        if (column) return (row[column] ?? null) as T | null;
        return row as T;
      },
      async all<T>() {
        const rows = database.prepare(sql).all(...(bound as never[])) as T[];
        return { results: rows, success: true, meta: {} };
      },
      async run() {
        const result = database.prepare(sql).run(...(bound as never[]));
        return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      },
      async raw<T>() {
        const rows = database.prepare(sql).all(...(bound as never[])) as Record<string, unknown>[];
        return rows.map((row) => Object.values(row)) as T[];
      }
    };
    return statement;
  }

  const d1 = {
    prepare,
    async batch(statements: BoundStatement[]) {
      // D1 batches are transactional; mirror that so partial-failure tests
      // behave like production.
      database.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    async exec(sql: string) {
      database.exec(sql);
      return { count: 1, duration: 0 };
    },
    dump() {
      throw new Error("not supported in tests");
    },
    withSession() {
      return d1;
    }
  };
  return d1 as unknown as D1Database;
}

/** Fresh in-memory database with every migration in /migrations applied. */
export function createMigratedD1(): D1Database {
  const db = createSqliteD1();
  const migrationsDir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "migrations");
  const files = readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    void (db as unknown as { exec(sql: string): Promise<unknown> }).exec(sql);
  }
  return db;
}
