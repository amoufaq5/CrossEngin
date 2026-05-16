import type { PgConnection } from "./connection.js";
import { excerptStatement, hashStatement, isStatementHash } from "./statement-hash.js";

export const META_MIGRATIONS_TABLE = "_meta_migrations";

export interface MigrationLogEntry {
  readonly statementHash: string;
  readonly statementSqlExcerpt: string;
  readonly executedAt: Date;
  readonly durationMs: number;
  readonly succeeded: boolean;
  readonly errorMessage: string | null;
}

export function migrationLogDdl(schema: string): readonly string[] {
  const fq = `${quoteIdent(schema)}.${quoteIdent(META_MIGRATIONS_TABLE)}`;
  return [
    `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)};`,
    `CREATE TABLE IF NOT EXISTS ${fq} (
  statement_hash CHAR(64) PRIMARY KEY CHECK (statement_hash ~ '^[0-9a-f]{64}$'),
  statement_sql_excerpt TEXT NOT NULL,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  succeeded BOOLEAN NOT NULL,
  error_message TEXT NULL
);`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdent(META_MIGRATIONS_TABLE + "_executed_at_idx")} ON ${fq} (executed_at);`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdent(META_MIGRATIONS_TABLE + "_succeeded_idx")} ON ${fq} (succeeded);`,
  ];
}

function quoteIdent(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`unsafe identifier: ${value}`);
  }
  return `"${value}"`;
}

export async function ensureMigrationLog(conn: PgConnection, schema: string): Promise<void> {
  for (const stmt of migrationLogDdl(schema)) {
    await conn.query(stmt);
  }
}

export async function isStatementApplied(
  conn: PgConnection,
  schema: string,
  statementHash: string,
): Promise<boolean> {
  if (!isStatementHash(statementHash)) {
    throw new Error(`not a valid statement hash: ${statementHash}`);
  }
  const fq = `${quoteIdent(schema)}.${quoteIdent(META_MIGRATIONS_TABLE)}`;
  const result = await conn.query<{ succeeded: boolean }>(
    `SELECT succeeded FROM ${fq} WHERE statement_hash = $1`,
    [statementHash],
  );
  const row = result.rows[0];
  return row !== undefined && row.succeeded === true;
}

export async function recordStatement(
  conn: PgConnection,
  schema: string,
  sql: string,
  durationMs: number,
  succeeded: boolean,
  errorMessage: string | null = null,
): Promise<MigrationLogEntry> {
  const statementHash = hashStatement(sql);
  const fq = `${quoteIdent(schema)}.${quoteIdent(META_MIGRATIONS_TABLE)}`;
  await conn.query(
    `INSERT INTO ${fq} (statement_hash, statement_sql_excerpt, duration_ms, succeeded, error_message)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (statement_hash) DO UPDATE
       SET statement_sql_excerpt = EXCLUDED.statement_sql_excerpt,
           duration_ms = EXCLUDED.duration_ms,
           succeeded = EXCLUDED.succeeded,
           error_message = EXCLUDED.error_message,
           executed_at = now()`,
    [statementHash, excerptStatement(sql), durationMs, succeeded, errorMessage],
  );
  return {
    statementHash,
    statementSqlExcerpt: excerptStatement(sql),
    executedAt: new Date(),
    durationMs,
    succeeded,
    errorMessage,
  };
}

export async function listAppliedHashes(
  conn: PgConnection,
  schema: string,
): Promise<readonly string[]> {
  const fq = `${quoteIdent(schema)}.${quoteIdent(META_MIGRATIONS_TABLE)}`;
  const result = await conn.query<{ statement_hash: string }>(
    `SELECT statement_hash FROM ${fq} WHERE succeeded = true`,
  );
  return result.rows.map((row) => row.statement_hash);
}
