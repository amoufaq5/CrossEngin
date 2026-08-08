import type { PgConnection } from "./connection.js";
import {
  introspectEncryptedColumns,
  pgpSymDecryptExpr,
  pgpSymEncryptExpr,
  type EncryptedColumn,
} from "./encryption.js";

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function qualify(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

export interface ReencryptColumnInput {
  readonly schema: string;
  readonly table: string;
  /** A BYTEA column already encrypted under `oldKeyRef`. */
  readonly column: string;
  readonly oldKeyRef: string;
  readonly newKeyRef: string;
}

/**
 * Emits the in-place re-encryption of a pgcrypto BYTEA column from one key to
 * another: decrypt with the old key, re-encrypt with the new key. NULLs are left
 * untouched (the `WHERE ... IS NOT NULL` guard skips them). Keys are always SQL
 * references, never inlined.
 */
export function reencryptColumnSql(input: ReencryptColumnInput): string {
  const table = qualify(input.schema, input.table);
  const col = quoteIdent(input.column);
  const decrypted = pgpSymDecryptExpr(col, input.oldKeyRef);
  const reencrypted = pgpSymEncryptExpr(decrypted, input.newKeyRef);
  return `UPDATE ${table} SET ${col} = ${reencrypted} WHERE ${col} IS NOT NULL;`;
}

export interface KeyRotationPlan {
  readonly schema: string;
  readonly table: string;
  readonly column: string;
  readonly dataClass: string | null;
  readonly statement: string;
}

export function planColumnKeyRotation(
  column: EncryptedColumn,
  oldKeyRef: string,
  newKeyRef: string,
): KeyRotationPlan {
  return {
    schema: column.schema,
    table: column.table,
    column: column.column,
    dataClass: column.dataClass,
    statement: reencryptColumnSql({
      schema: column.schema,
      table: column.table,
      column: column.column,
      oldKeyRef,
      newKeyRef,
    }),
  };
}

export function formatKeyRotationPlan(plans: readonly KeyRotationPlan[]): string {
  if (plans.length === 0) {
    return "No encrypted-at-rest columns found — nothing to rotate.";
  }
  const lines: string[] = [
    `Key rotation plan: ${plans.length.toString()} column(s) to re-encrypt`,
  ];
  for (const plan of plans) {
    lines.push(`-- ${plan.table}.${plan.column} (${plan.dataClass ?? "?"})`);
    lines.push(plan.statement);
  }
  return lines.join("\n");
}

export interface EncryptingViewTriggersInput {
  readonly schema: string;
  readonly table: string;
  readonly viewName: string;
  /** All base-table columns, in write order. */
  readonly columns: readonly string[];
  /** The subset of `columns` stored as encrypted BYTEA. */
  readonly encryptedColumns: readonly string[];
  /** Columns identifying a row for UPDATE / DELETE (e.g. ["tenant_id", "id"]). */
  readonly keyColumns: readonly string[];
  readonly keyRef: string;
  /** SQL cast applied to plaintext before encryption (default `::text`). */
  readonly plaintextCast?: string;
}

function triggerFunctionName(viewName: string): string {
  return `${viewName}_encrypt_tg`;
}

function writeExpr(
  column: string,
  encrypted: ReadonlySet<string>,
  keyRef: string,
  cast: string,
): string {
  const ref = `NEW.${quoteIdent(column)}`;
  if (!encrypted.has(column)) return ref;
  const encryptExpr = pgpSymEncryptExpr(`${ref}${cast}`, keyRef);
  return `CASE WHEN ${ref} IS NULL THEN NULL ELSE ${encryptExpr} END`;
}

/**
 * Emits an INSTEAD OF INSERT/UPDATE/DELETE trigger (and its plpgsql function)
 * on a decrypting view so writes are transparently encrypted: an INSERT/UPDATE
 * through the view lands in the base table with each encrypted column stored as
 * `pgp_sym_encrypt(NEW.col::text, key)`, plaintext columns pass through, and a
 * DELETE removes the matching base row. Paired with `emitDecryptingViewSql`, the
 * view becomes a fully transparent read+write facade over an encrypted table.
 * The key is a SQL reference, never inlined; NULLs stay NULL.
 */
export function emitEncryptingViewTriggersSql(input: EncryptingViewTriggersInput): string[] {
  if (input.keyColumns.length === 0) {
    throw new Error("emitEncryptingViewTriggersSql: keyColumns must not be empty");
  }
  const encrypted = new Set(input.encryptedColumns);
  const cast = input.plaintextCast ?? "::text";
  const baseTable = qualify(input.schema, input.table);
  const view = qualify(input.schema, input.viewName);
  const fn = qualify(input.schema, triggerFunctionName(input.viewName));
  const triggerName = quoteIdent(`${input.viewName}_encrypt`);

  const insertCols = input.columns.map((c) => quoteIdent(c)).join(", ");
  const insertVals = input.columns
    .map((c) => writeExpr(c, encrypted, input.keyRef, cast))
    .join(", ");
  const updateAssignments = input.columns
    .map((c) => `${quoteIdent(c)} = ${writeExpr(c, encrypted, input.keyRef, cast)}`)
    .join(",\n      ");
  const whereClause = input.keyColumns
    .map((c) => `${quoteIdent(c)} = OLD.${quoteIdent(c)}`)
    .join(" AND ");

  const functionSql = [
    `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $crossengin_enc$`,
    `BEGIN`,
    `  IF (TG_OP = 'INSERT') THEN`,
    `    INSERT INTO ${baseTable} (${insertCols}) VALUES (${insertVals});`,
    `    RETURN NEW;`,
    `  ELSIF (TG_OP = 'UPDATE') THEN`,
    `    UPDATE ${baseTable} SET`,
    `      ${updateAssignments}`,
    `    WHERE ${whereClause};`,
    `    RETURN NEW;`,
    `  ELSIF (TG_OP = 'DELETE') THEN`,
    `    DELETE FROM ${baseTable} WHERE ${whereClause};`,
    `    RETURN OLD;`,
    `  END IF;`,
    `  RETURN NULL;`,
    `END;`,
    `$crossengin_enc$;`,
  ].join("\n");

  return [
    `DROP TRIGGER IF EXISTS ${triggerName} ON ${view};`,
    functionSql,
    `CREATE TRIGGER ${triggerName} INSTEAD OF INSERT OR UPDATE OR DELETE ON ${view} FOR EACH ROW EXECUTE FUNCTION ${fn}();`,
  ];
}

export class KeyRotationMigrator {
  private readonly conn: PgConnection;

  constructor(conn: PgConnection) {
    this.conn = conn;
  }

  /** Plans a re-encryption for every ciphertext (bytea) hinted column in the schema. */
  async planSchema(
    schema: string,
    oldKeyRef: string,
    newKeyRef: string,
  ): Promise<readonly KeyRotationPlan[]> {
    const columns = await introspectEncryptedColumns(this.conn, schema);
    return columns
      .filter((c) => c.encryptedStorage)
      .map((c) => planColumnKeyRotation(c, oldKeyRef, newKeyRef));
  }

  /** Plans + executes the rotation. Each column re-encrypts in its own transaction. */
  async rotateSchema(
    schema: string,
    oldKeyRef: string,
    newKeyRef: string,
  ): Promise<readonly KeyRotationPlan[]> {
    const plans = await this.planSchema(schema, oldKeyRef, newKeyRef);
    for (const plan of plans) {
      await this.conn.transaction(async (tx) => {
        await tx.query(plan.statement);
      });
    }
    return plans;
  }
}
