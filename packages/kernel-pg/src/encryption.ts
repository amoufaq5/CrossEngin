import type { PgConnection } from "./connection.js";

export const DATA_CLASS_KEY = "crossengin.data_class";
export const ENCRYPT_KEY = "crossengin.encrypt";
export const ENCRYPT_AT_REST_VALUE = "at_rest";

export interface ColumnDirectives {
  readonly dataClass: string | null;
  readonly encryptAtRest: boolean;
}

/**
 * Parses the directive string the kernel DDL emitter writes into a column
 * comment, e.g. `'crossengin.data_class=phi; crossengin.encrypt=at_rest'`.
 */
export function parseColumnDirectives(comment: string | null | undefined): ColumnDirectives {
  if (comment === null || comment === undefined || comment.length === 0) {
    return { dataClass: null, encryptAtRest: false };
  }
  let dataClass: string | null = null;
  let encryptAtRest = false;
  for (const rawPart of comment.split(";")) {
    const part = rawPart.trim();
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === DATA_CLASS_KEY) dataClass = value;
    else if (key === ENCRYPT_KEY && value === ENCRYPT_AT_REST_VALUE) encryptAtRest = true;
  }
  return { dataClass, encryptAtRest };
}

export const ENCRYPTED_COLUMN_QUERY = `
  SELECT n.nspname AS schema,
         c.relname AS table_name,
         a.attname AS column_name,
         pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
         col_description(a.attrelid, a.attnum) AS comment
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE a.attnum > 0
     AND NOT a.attisdropped
     AND c.relkind = 'r'
     AND n.nspname = $1
     AND col_description(a.attrelid, a.attnum) LIKE '%crossengin.encrypt=at_rest%'
   ORDER BY c.relname, a.attnum
`;

export interface EncryptedColumnRow {
  readonly schema: string;
  readonly table_name: string;
  readonly column_name: string;
  readonly data_type: string;
  readonly comment: string | null;
}

export interface EncryptedColumn {
  readonly schema: string;
  readonly table: string;
  readonly column: string;
  readonly dataType: string;
  readonly dataClass: string | null;
  readonly encryptedStorage: boolean;
}

function isCiphertextStorage(dataType: string): boolean {
  return dataType.trim().toLowerCase() === "bytea";
}

export async function introspectEncryptedColumns(
  conn: PgConnection,
  schema: string,
): Promise<readonly EncryptedColumn[]> {
  const result = await conn.query<EncryptedColumnRow>(ENCRYPTED_COLUMN_QUERY, [schema]);
  const out: EncryptedColumn[] = [];
  for (const row of result.rows) {
    const directives = parseColumnDirectives(row.comment);
    if (!directives.encryptAtRest) continue;
    out.push({
      schema: row.schema,
      table: row.table_name,
      column: row.column_name,
      dataType: row.data_type,
      dataClass: directives.dataClass,
      encryptedStorage: isCiphertextStorage(row.data_type),
    });
  }
  return out;
}

export const PGCRYPTO_EXTENSION = "pgcrypto";

export async function pgcryptoInstalled(conn: PgConnection): Promise<boolean> {
  const result = await conn.query<{ installed: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = $1) AS installed`,
    [PGCRYPTO_EXTENSION],
  );
  return result.rows[0]?.installed === true;
}

export async function ensurePgcryptoExtension(conn: PgConnection): Promise<void> {
  await conn.query(`CREATE EXTENSION IF NOT EXISTS ${PGCRYPTO_EXTENSION}`);
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Builds the pgcrypto symmetric-encryption expression for a value. `keyRef`
 * is a SQL expression yielding the key (e.g. a bind param or
 * `current_setting('app.column_encryption_key')`), never the raw key text.
 */
export function pgpSymEncryptExpr(valueExpr: string, keyRef: string): string {
  return `pgp_sym_encrypt(${valueExpr}, ${keyRef})`;
}

export function pgpSymDecryptExpr(columnExpr: string, keyRef: string): string {
  return `pgp_sym_decrypt(${columnExpr}, ${keyRef})`;
}

export function pgpSymEncryptLiteral(plaintext: string, keyRef: string): string {
  return pgpSymEncryptExpr(quoteLiteral(plaintext), keyRef);
}

export const ENCRYPTION_DRIFT_KINDS = [
  "plaintext_at_rest",
  "pgcrypto_missing",
] as const;
export type EncryptionDriftKind = (typeof ENCRYPTION_DRIFT_KINDS)[number];

export interface EncryptionDriftIssue {
  readonly kind: EncryptionDriftKind;
  readonly schema: string;
  readonly table: string | null;
  readonly column: string | null;
  readonly detail: string;
}

export interface EncryptionCoverageReport {
  readonly schema: string;
  readonly pgcryptoInstalled: boolean;
  readonly total: number;
  readonly ciphertextStored: number;
  readonly plaintext: number;
  readonly columns: readonly EncryptedColumn[];
  readonly issues: readonly EncryptionDriftIssue[];
}

export function summarizeEncryptionCoverage(
  schema: string,
  columns: readonly EncryptedColumn[],
  pgcryptoIsInstalled: boolean,
): EncryptionCoverageReport {
  const issues: EncryptionDriftIssue[] = [];
  let ciphertextStored = 0;
  for (const col of columns) {
    if (col.encryptedStorage) {
      ciphertextStored += 1;
    } else {
      issues.push({
        kind: "plaintext_at_rest",
        schema: col.schema,
        table: col.table,
        column: col.column,
        detail: `${col.table}.${col.column} is hinted encrypt=at_rest (${col.dataClass ?? "?"}) but stored as ${col.dataType}, not bytea ciphertext`,
      });
    }
  }
  if (!pgcryptoIsInstalled && columns.length > 0) {
    issues.push({
      kind: "pgcrypto_missing",
      schema,
      table: null,
      column: null,
      detail: `${columns.length.toString()} column(s) require at-rest encryption but the pgcrypto extension is not installed`,
    });
  }
  return {
    schema,
    pgcryptoInstalled: pgcryptoIsInstalled,
    total: columns.length,
    ciphertextStored,
    plaintext: columns.length - ciphertextStored,
    columns,
    issues,
  };
}

export class EncryptionApplier {
  private readonly conn: PgConnection;

  constructor(conn: PgConnection) {
    this.conn = conn;
  }

  async ensureProvisioned(): Promise<void> {
    await ensurePgcryptoExtension(this.conn);
  }

  async coverage(schema: string): Promise<EncryptionCoverageReport> {
    const [columns, installed] = await Promise.all([
      introspectEncryptedColumns(this.conn, schema),
      pgcryptoInstalled(this.conn),
    ]);
    return summarizeEncryptionCoverage(schema, columns, installed);
  }

  async verify(schema: string): Promise<readonly EncryptionDriftIssue[]> {
    return (await this.coverage(schema)).issues;
  }
}
