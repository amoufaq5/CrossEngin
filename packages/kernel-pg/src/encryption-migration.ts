import type { PgConnection } from "./connection.js";
import {
  DATA_CLASS_KEY,
  ENCRYPT_AT_REST_VALUE,
  ENCRYPT_KEY,
  introspectEncryptedColumns,
  pgpSymEncryptExpr,
  type EncryptedColumn,
} from "./encryption.js";

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function qualify(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

export interface EncryptColumnInput {
  readonly schema: string;
  readonly table: string;
  readonly column: string;
  readonly keyRef: string;
  readonly dataClass?: string | null;
  /** SQL cast applied to the existing plaintext before encryption (default `::text`). */
  readonly plaintextCast?: string;
}

const ENC_SUFFIX = "__enc";

function directiveComment(dataClass: string | null | undefined): string {
  const directives: string[] = [];
  if (dataClass !== null && dataClass !== undefined && dataClass.length > 0) {
    directives.push(`${DATA_CLASS_KEY}=${dataClass}`);
  }
  directives.push(`${ENCRYPT_KEY}=${ENCRYPT_AT_REST_VALUE}`);
  return directives.join("; ");
}

/**
 * Emits the ordered DDL that converts a plaintext column to a pgcrypto-encrypted
 * BYTEA column in place: add a ciphertext column, encrypt the existing values,
 * drop the plaintext column, rename the ciphertext into its place, and re-apply
 * the classification + encrypt directive comment. NULLs stay NULL.
 */
export function emitEncryptColumnSql(input: EncryptColumnInput): string[] {
  const table = qualify(input.schema, input.table);
  const col = quoteIdent(input.column);
  const encCol = quoteIdent(`${input.column}${ENC_SUFFIX}`);
  const cast = input.plaintextCast ?? "::text";
  const encryptExpr = pgpSymEncryptExpr(`${col}${cast}`, input.keyRef);
  return [
    `ALTER TABLE ${table} ADD COLUMN ${encCol} BYTEA;`,
    `UPDATE ${table} SET ${encCol} = CASE WHEN ${col} IS NULL THEN NULL ELSE ${encryptExpr} END;`,
    `ALTER TABLE ${table} DROP COLUMN ${col};`,
    `ALTER TABLE ${table} RENAME COLUMN ${encCol} TO ${col};`,
    `COMMENT ON COLUMN ${table}.${col} IS '${directiveComment(input.dataClass)}';`,
  ];
}

export interface DecryptingViewInput {
  readonly schema: string;
  readonly table: string;
  readonly viewName: string;
  readonly columns: readonly string[];
  readonly encryptedColumns: readonly string[];
  readonly keyRef: string;
}

/**
 * Emits a view that exposes an encrypted table transparently for reads: every
 * column is selected as-is except the encrypted ones, which are surfaced via
 * `pgp_sym_decrypt(col, key)`.
 */
export function emitDecryptingViewSql(input: DecryptingViewInput): string {
  const encrypted = new Set(input.encryptedColumns);
  const selectList = input.columns
    .map((c) => {
      const col = quoteIdent(c);
      if (!encrypted.has(c)) return col;
      return `pgp_sym_decrypt(${col}, ${input.keyRef}) AS ${col}`;
    })
    .join(", ");
  return `CREATE OR REPLACE VIEW ${qualify(input.schema, input.viewName)} AS SELECT ${selectList} FROM ${qualify(input.schema, input.table)};`;
}

export interface ColumnMigrationPlan {
  readonly schema: string;
  readonly table: string;
  readonly column: string;
  readonly dataClass: string | null;
  readonly statements: readonly string[];
}

export function planColumnEncryption(
  column: EncryptedColumn,
  keyRef: string,
): ColumnMigrationPlan {
  return {
    schema: column.schema,
    table: column.table,
    column: column.column,
    dataClass: column.dataClass,
    statements: emitEncryptColumnSql({
      schema: column.schema,
      table: column.table,
      column: column.column,
      keyRef,
      dataClass: column.dataClass,
    }),
  };
}

export function formatEncryptionPlan(plans: readonly ColumnMigrationPlan[]): string {
  if (plans.length === 0) {
    return "All hinted columns are already encrypted at rest — nothing to migrate.";
  }
  const lines: string[] = [
    `Encryption migration plan: ${plans.length.toString()} column(s) to encrypt in place`,
  ];
  for (const plan of plans) {
    lines.push(`-- ${plan.table}.${plan.column} (${plan.dataClass ?? "?"})`);
    for (const statement of plan.statements) lines.push(statement);
  }
  return lines.join("\n");
}

export class EncryptionMigrator {
  private readonly conn: PgConnection;

  constructor(conn: PgConnection) {
    this.conn = conn;
  }

  /** Plans encrypt-in-place migrations for every plaintext (non-bytea) hinted column. */
  async planSchema(schema: string, keyRef: string): Promise<readonly ColumnMigrationPlan[]> {
    const columns = await introspectEncryptedColumns(this.conn, schema);
    return columns
      .filter((c) => !c.encryptedStorage)
      .map((c) => planColumnEncryption(c, keyRef));
  }

  /** Plans + executes the migration. Each plan runs in its own transaction. */
  async migrateSchema(schema: string, keyRef: string): Promise<readonly ColumnMigrationPlan[]> {
    const plans = await this.planSchema(schema, keyRef);
    for (const plan of plans) {
      await this.conn.transaction(async (tx) => {
        for (const statement of plan.statements) {
          await tx.query(statement);
        }
      });
    }
    return plans;
  }
}
