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

/**
 * Partitioned **parents** carrying a column comment that hints at-rest encryption.
 *
 * Deliberately a separate query rather than a widening of `ENCRYPTED_COLUMN_QUERY`'s
 * `c.relkind = 'r'`, and it reads `pg_description` directly rather than through `col_description`
 * so the two statements cannot be mistaken for one another by a reader or a test double.
 */
export const PARTITIONED_ENCRYPTED_TABLE_QUERY = `
  SELECT c.relname AS table_name,
         d.description AS comment
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_description d ON d.objoid = c.oid AND d.objsubid > 0
   WHERE c.relkind = 'p'
     AND n.nspname = $1
     AND d.description LIKE '%crossengin.encrypt=at_rest%'
   ORDER BY c.relname, d.objsubid
`;

interface PartitionedEncryptedTableRow {
  readonly table_name: string;
  readonly comment: string | null;
}

/**
 * Partitioned tables (`relkind = 'p'`) carrying an at-rest-encrypted column in this schema.
 *
 * This exists so a rotation can **refuse** rather than silently skip. `introspectEncryptedColumns`
 * filters `relkind = 'r'`, so a partitioned parent is invisible to it and a rotation over that
 * schema would rewrite nothing for it **and report itself complete** — after which an operator
 * retires the old key and that data is permanently undecryptable.
 *
 * Widening the filter to include `'p'` is not the fix, because an `UPDATE` on a partitioned parent
 * rewrites every leaf row. Whether a leaf also carries the hint depends on how it was created
 * (`CREATE TABLE … PARTITION OF` does not copy column comments; `ATTACH PARTITION` of an
 * emitter-built table does), so the widened filter would **double-encrypt** every leaf that carries
 * it while the narrow filter skips the data entirely. Both answers are wrong, so the honest move is
 * to say so and stop. Nothing in this repo partitions today; this refusal is what keeps that true
 * rather than silent.
 */
export async function introspectPartitionedEncryptedTables(
  conn: PgConnection,
  schema: string,
): Promise<readonly string[]> {
  const result = await conn.query<PartitionedEncryptedTableRow>(
    PARTITIONED_ENCRYPTED_TABLE_QUERY,
    [schema],
  );
  // The `LIKE` is a substring test; the directive parser is what decides, so a comment merely
  // mentioning the directive name does not refuse a rotation. Same two-step as its sibling.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of result.rows) {
    if (!parseColumnDirectives(row.comment).encryptAtRest) continue;
    if (seen.has(row.table_name)) continue;
    seen.add(row.table_name);
    out.push(row.table_name);
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
 * The GUC every builder in this stack reads the at-rest column key out of.
 *
 * It was spelled independently in three places — `crossengin-pg.ts`'s private `DEFAULT_KEY_REF`,
 * `operate-runtime-pg`'s `DEFAULT_ENCRYPTION_KEY_REF` and `encryption-writepath.test.ts` — and
 * exported from none of them, so the one string the whole subsystem agrees on was agreed by
 * coincidence. This is that string, and `DEFAULT_COLUMN_KEY_REF` is the one expression derived
 * from it.
 */
export const COLUMN_ENCRYPTION_KEY_GUC = "app.column_encryption_key";

/**
 * The environment variable holding the key **value**.
 *
 * Environment and never argv: argv is readable by any process that can run `ps`, which is ADR-0301's
 * established rule in this repo for exactly this class of secret. The value reaches Postgres as a
 * *bound parameter* of `set_config($1, $2, true)`, so it is in no SQL text, no
 * `pg_stat_statements` entry and no server log line.
 */
export const COLUMN_ENCRYPTION_KEY_ENV = "COLUMN_ENCRYPTION_KEY";

/**
 * A GUC name: two dot-separated lowercase identifiers (`app.column_encryption_key`).
 *
 * Validated here because `keyRef` is interpolated into SQL text **unescaped** by every builder in
 * this stack (`pgpSymEncryptExpr`, `emitEncryptColumnSql`, `emitDecryptingViewSql`,
 * `emitEncryptingViewTriggersSql`), and deliberately so — the whole point of a key *reference* is
 * that it is an expression rather than a value. `columnKeyRefFor` is therefore the single place a
 * name becomes that expression, and the single place it can be checked.
 */
const COLUMN_KEY_GUC_RE = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;

export function columnKeyRefFor(guc: string): string {
  if (!COLUMN_KEY_GUC_RE.test(guc)) {
    throw new Error(
      `columnKeyRefFor: ${JSON.stringify(guc)} is not a GUC name; expected two dot-separated ` +
        "lowercase identifiers (e.g. app.column_encryption_key). The name is interpolated into " +
        "SQL text unescaped, so it is validated here and nowhere else.",
    );
  }
  // One argument, never two. See `isRaisingKeyRef`.
  return `current_setting('${guc}')`;
}

/**
 * The *raising* form, and the only one this stack emits.
 *
 * Measured on PG 16:
 *
 * - `current_setting('app.foo')` with the GUC unset **raises** `unrecognized configuration
 *   parameter`.
 * - `current_setting('app.foo', true)` with it unset returns **NULL** — and `''` once the setting
 *   has been used and reset on that connection, i.e. on every pooled connection in production.
 * - `pgp_sym_encrypt(x, NULL)` returns **NULL, silently**.
 * - `pgp_sym_encrypt(x, '')` **raises** `Illegal argument to function`.
 *
 * So the house idiom for a GUC in this repo — the two-argument form, as
 * `NULLIF(current_setting('app.current_tenant_id', true), '')` uses for tenant isolation — is
 * exactly wrong here: composed with `pgp_sym_encrypt` it turns a *missing key* into a PHI column
 * storing NULL, reported as a successful write. A loud failure on every row is the only acceptable
 * behaviour, so the second argument is forbidden and `isRaisingKeyRef` is what says whether a
 * caller-supplied ref has it.
 */
export const DEFAULT_COLUMN_KEY_REF = columnKeyRefFor(COLUMN_ENCRYPTION_KEY_GUC);

/**
 * The GUC holding the key a rekey reads **from**, where `COLUMN_ENCRYPTION_KEY_GUC` holds the one it
 * writes **to**.
 *
 * Two GUCs rather than one because a re-encryption decrypts under one key and encrypts under the
 * other **in a single statement** — `pgp_sym_encrypt(pgp_sym_decrypt(col, old), new)` — so both
 * values have to be readable from inside that one expression. A sequential "set the key, rotate, set
 * the other key" cannot express it: there is no intermediate state in which the column is plaintext.
 *
 * Both are `columnKeyRefFor`'s one-argument raising form, and the reason is `isRaisingKeyRef`'s
 * measurement applied twice. On the **new**-key side a two-argument ref resolving to NULL makes
 * `pgp_sym_encrypt(x, NULL)` return NULL silently, so a rekey with the new key unset would write NULL
 * over every PHI value in the column and report the row count as a success. On the **old**-key side
 * it is the same loss one function in: `pgp_sym_decrypt(col, NULL)` is NULL, which is then encrypted
 * under the new key, so the column ends up holding ciphertext of nothing. A rekey is the one
 * operation after which the previous key is destroyed, so neither failure is recoverable.
 *
 * The name `app.column_encryption_key_old` already existed in this package's
 * `encryption-writepath.test.ts` and in **no `src` file**: the two-key capability was built, tested
 * and reachable only from its own test (ADR-0336's class), which is why the old-key side of every
 * rotation in this repo has been a string a test typed in rather than a declaration anything shared.
 */
export const COLUMN_ENCRYPTION_KEY_OLD_GUC = "app.column_encryption_key_old";

export const OLD_COLUMN_KEY_REF = columnKeyRefFor(COLUMN_ENCRYPTION_KEY_OLD_GUC);

const RAISING_KEY_REF_RE = /^\s*current_setting\(\s*'[^']*'\s*\)\s*$/i;

/**
 * Whether `ref` is guaranteed to **raise** rather than yield NULL when the key is absent.
 *
 * True only for the single-argument `current_setting('…')` form. False for the two-argument form,
 * and false for a bind parameter or any other expression — not because those are malformed, but
 * because this function answers one question and the honest answer for them is "cannot be shown to
 * raise": `$1` bound to null is the silent-NULL path again, one layer out.
 */
export function isRaisingKeyRef(ref: string): boolean {
  return RAISING_KEY_REF_RE.test(ref);
}

export const COLUMN_KEY_REFUSAL_REASONS = ["key_value_absent", "key_ref_can_yield_null"] as const;
export type ColumnKeyRefusalReason = (typeof COLUMN_KEY_REFUSAL_REASONS)[number];

export interface ColumnKeyRefusal {
  readonly reason: ColumnKeyRefusalReason;
  readonly message: string;
}

export interface ColumnKeyResolution {
  readonly keyRef: string;
  /**
   * Transaction-local `set_config` pairs to claim before the migration's statements —
   * `EncryptionMigratorOptions.sessionSettings`' shape. Empty when the key ref is not the default
   * one, because then the deployment arranged the key some other way and this CLI has no idea
   * which setting, if any, to claim.
   */
  readonly sessionSettings: ReadonlyMap<string, string>;
  /** Non-null when a migration must refuse **before** its first statement runs. */
  readonly refusal: ColumnKeyRefusal | null;
}

/**
 * Resolves the key a column-encryption migration will run under, from the key ref and the process
 * environment, without touching the database.
 *
 * Up front rather than at the first statement, because the alternative is Postgres's
 * `unrecognized configuration parameter "app.column_encryption_key"` on statement 1 of N with some
 * columns already converted: the migration is per column in its own transaction, so a failure
 * halfway leaves a schema half encrypted and nothing recording which half. A refusal naming the
 * missing variable costs nothing and happens before any DDL.
 *
 * An **empty** value refuses for the same reason a missing one does, and the reason is measured
 * rather than stylistic: `pgp_sym_encrypt(x, '')` raises `Illegal argument to function`, so an
 * empty variable is a failure at statement 1 either way.
 */
export function resolveColumnEncryptionKey(
  keyRef: string,
  env: Readonly<Record<string, string | undefined>>,
): ColumnKeyResolution {
  if (keyRef !== DEFAULT_COLUMN_KEY_REF) {
    if (!isRaisingKeyRef(keyRef)) {
      return {
        keyRef,
        sessionSettings: new Map(),
        refusal: {
          reason: "key_ref_can_yield_null",
          message:
            `--key-ref=${keyRef} is not the raising form. current_setting('…', true) returns NULL ` +
            "when the setting is unset (and '' once it has been used and reset on a pooled " +
            "connection), and pgp_sym_encrypt(x, NULL) returns NULL silently — so a missing key " +
            "would store NULL over every PHI value and report success. Use " +
            `current_setting('<guc>') with one argument.`,
        },
      };
    }
    // A raising ref the deployment named itself: it is arranging the key some other way (a
    // connection-level `options` parameter, a server-side `ALTER ROLE ... SET`), so the key value
    // is deliberately not this process's business and the variable is not required.
    return { keyRef, sessionSettings: new Map(), refusal: null };
  }

  const value = env[COLUMN_ENCRYPTION_KEY_ENV];
  if (value === undefined || value.length === 0) {
    return {
      keyRef,
      sessionSettings: new Map(),
      refusal: {
        reason: "key_value_absent",
        message:
          `${COLUMN_ENCRYPTION_KEY_ENV} is not set, so ${keyRef} would raise ` +
          `'unrecognized configuration parameter "${COLUMN_ENCRYPTION_KEY_GUC}"' on the first ` +
          `statement. Set ${COLUMN_ENCRYPTION_KEY_ENV}=<key> in the environment (not on the ` +
          "command line — argv is readable via ps), or pass --key-ref=<sql> if this deployment " +
          `sets ${COLUMN_ENCRYPTION_KEY_GUC} another way.`,
      },
    };
  }
  return {
    keyRef,
    sessionSettings: new Map([[COLUMN_ENCRYPTION_KEY_GUC, value]]),
    refusal: null,
  };
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

export function formatEncryptionCoverage(report: EncryptionCoverageReport): string {
  const lines: string[] = [];
  lines.push(
    `Encryption coverage for schema "${report.schema}": ${report.total.toString()} column(s) hinted encrypt=at_rest`,
  );
  lines.push(`  pgcrypto installed: ${report.pgcryptoInstalled ? "yes" : "no"}`);
  if (report.total === 0) {
    lines.push("  no columns hinted for at-rest encryption.");
    return lines.join("\n");
  }
  lines.push(
    `  ciphertext: ${report.ciphertextStored.toString()}   plaintext: ${report.plaintext.toString()}`,
  );
  if (report.issues.length === 0) {
    lines.push("  OK — every hinted column is encrypted at rest.");
  } else {
    for (const issue of report.issues) {
      lines.push(`  [${issue.kind}] ${issue.detail}`);
    }
  }
  return lines.join("\n");
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
