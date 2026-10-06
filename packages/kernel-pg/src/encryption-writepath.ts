import type { PgConnection } from "./connection.js";
import {
  introspectEncryptedColumns,
  pgpSymDecryptExpr,
  pgpSymEncryptExpr,
  type EncryptedColumn,
} from "./encryption.js";

const IDENT_RE = /^[a-z_][a-z0-9_]*$/i;

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
    // Not "no encrypted-at-rest columns found": `planSchema` drops the hinted-but-plaintext ones,
    // so that wording claimed an absence the function had not checked. `formatKeyRotationSurvey`
    // is where the dropped columns are reported.
    return "No ciphertext (BYTEA) columns to re-encrypt.";
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

/** The plan plus the two things a plan alone cannot say: what was skipped, and what refuses. */
export function formatKeyRotationSurvey(survey: KeyRotationSurvey): string {
  const lines = [formatKeyRotationPlan(survey.plans)];
  for (const col of survey.plaintextAtRest) {
    lines.push(
      `-- SKIPPED ${col.table}.${col.column}: hinted encrypt=at_rest but stored as ${col.dataType}`,
    );
  }
  for (const refusal of survey.refusals) {
    lines.push(`-- REFUSED ${refusal.reason}: ${refusal.detail}`);
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

/**
 * The three ways a rotation is wrong *as a rotation*, and so refuses.
 *
 * `plaintext_at_rest` is deliberately **not** here. A hinted column stored as TEXT was protected by
 * neither key, so retiring the old one cannot make it unreadable — it is a finding about the
 * *encryption* migration, which `crossengin-pg encrypt --verify` is the surface for, and blocking a
 * correct rotation on it would couple two independent migrations into one refusal an operator would
 * route around. It is reported on the survey and in the formatted plan instead.
 */
export const KEY_ROTATION_REFUSAL_REASONS = [
  "rls_would_confine_this_session",
  "keys_are_the_same",
  "table_missing",
] as const;
export type KeyRotationRefusalReason = (typeof KEY_ROTATION_REFUSAL_REASONS)[number];

export interface KeyRotationRefusal {
  readonly reason: KeyRotationRefusalReason;
  readonly detail: string;
}

export class KeyRotationRefused extends Error {
  readonly refusals: readonly KeyRotationRefusal[];

  constructor(schema: string, refusals: readonly KeyRotationRefusal[]) {
    super(
      `key rotation refused for schema ${schema}: ` +
        refusals.map((r) => `${r.reason} (${r.detail})`).join("; "),
    );
    this.name = "KeyRotationRefused";
    this.refusals = refusals;
  }
}

/** What a schema survey found, including the parts a plan deliberately leaves out. */
export interface KeyRotationSurvey {
  readonly plans: readonly KeyRotationPlan[];
  /**
   * Columns hinted `crossengin.encrypt=at_rest` whose storage is **not** BYTEA, i.e. plaintext at
   * rest. A rotation cannot re-encrypt what was never encrypted, and reporting them is the whole
   * point: filtering them out silently is how `formatKeyRotationPlan([])` came to say "no
   * encrypted-at-rest columns found" about a schema that has them and never encrypted them.
   */
  readonly plaintextAtRest: readonly EncryptedColumn[];
  readonly refusals: readonly KeyRotationRefusal[];
}

/** One executed re-encryption, and how many rows it actually rewrote. */
export interface KeyRotationOutcome extends KeyRotationPlan {
  readonly rowsReencrypted: number;
}

interface RotationVisibilityRow {
  readonly role: unknown;
  readonly bypasses_rls: unknown;
  readonly is_owner: unknown;
  readonly rls_enabled: unknown;
}

export interface KeyRotationMigratorOptions {
  /**
   * `set_config(name, value, true)` pairs claimed inside each rotation transaction.
   *
   * This exists because `oldKeyRef`/`newKeyRef` are SQL *expressions*, and the convention the rest
   * of the stack follows is `current_setting('app.column_encryption_key')` — a GUC. Nothing in the
   * workspace sets it, and a rotation that opens its own transaction had no way to, so the only
   * caller that could ever have worked was one inlining the key material into the SQL text, where
   * it lands in `pg_stat_statements` and in the server log on error. Transaction-local, following
   * `setPlatformWriteSql`: a session-wide `SET` would leave the key readable to the next caller of
   * a pooled connection.
   */
  readonly sessionSettings?: ReadonlyMap<string, string>;
}

export class KeyRotationMigrator {
  private readonly conn: PgConnection;
  private readonly sessionSettings: ReadonlyMap<string, string>;

  constructor(conn: PgConnection, options: KeyRotationMigratorOptions = {}) {
    this.conn = conn;
    this.sessionSettings = options.sessionSettings ?? new Map();
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

  /**
   * Plans, and asks the catalog whether this session could carry the plan out.
   *
   * The probe is per table and asks `relrowsecurity` / `rolbypassrls` / ownership rather than
   * counting rows, for `probeJobQueueVisibility`'s reason: zero rows rewritten and zero rows
   * present are the same observation. That ambiguity is load-bearing here in a way it is nowhere
   * else in this repo — a rotation that reports success having rewritten nothing is followed by an
   * operator retiring the old key, and at that moment every ciphertext in the schema becomes
   * permanently undecryptable. So the refusal is up front, before any `UPDATE` runs.
   */
  async surveySchema(
    schema: string,
    oldKeyRef: string,
    newKeyRef: string,
  ): Promise<KeyRotationSurvey> {
    const columns = await introspectEncryptedColumns(this.conn, schema);
    const plans = columns
      .filter((c) => c.encryptedStorage)
      .map((c) => planColumnKeyRotation(c, oldKeyRef, newKeyRef));
    const plaintextAtRest = columns.filter((c) => !c.encryptedStorage);
    const refusals: KeyRotationRefusal[] = [];

    // Before the probe, because it needs no database round trip and is the one refusal that is
    // *always* right: re-encrypting from a key to itself rewrites every row to the same plaintext
    // under the same key, which reports a successful rotation and rotates nothing.
    if (oldKeyRef.trim() === newKeyRef.trim()) {
      refusals.push({
        reason: "keys_are_the_same",
        detail: `oldKeyRef and newKeyRef are the same expression (${oldKeyRef.trim()})`,
      });
    }
    for (const table of [...new Set(plans.map((p) => p.table))]) {
      const visibility = await this.probeTable(schema, table);
      refusals.push(...visibility);
    }

    return { plans, plaintextAtRest, refusals };
  }

  /**
   * Surveys, refuses, then executes. Each column re-encrypts in its own transaction.
   *
   * Returns the **rows actually rewritten** per column, not merely the statements issued. What is
   * deliberately *not* here is a resume ledger: the transactions are per column, so a failure at
   * column 4 of 7 leaves 1–3 under the new key and 4–7 under the old, and a naive re-run then
   * decrypts already-rotated ciphertext with `oldKeyRef` and raises "Wrong key or corrupt data".
   * Recording which columns landed is a `_meta_migrations`-shaped subsystem, not a flag; until it
   * exists the outcome list is the only record and the caller must keep it.
   */
  async rotateSchema(
    schema: string,
    oldKeyRef: string,
    newKeyRef: string,
  ): Promise<readonly KeyRotationOutcome[]> {
    const survey = await this.surveySchema(schema, oldKeyRef, newKeyRef);
    if (survey.refusals.length > 0) throw new KeyRotationRefused(schema, survey.refusals);

    const outcomes: KeyRotationOutcome[] = [];
    for (const plan of survey.plans) {
      const rows = await this.conn.transaction(async (tx) => {
        for (const [name, value] of this.sessionSettings) {
          await tx.query(`SELECT set_config($1, $2, true)`, [name, value]);
        }
        const result = await tx.query(plan.statement);
        return result.rowCount;
      });
      outcomes.push({ ...plan, rowsReencrypted: rows });
    }
    return outcomes;
  }

  private async probeTable(
    schema: string,
    table: string,
  ): Promise<readonly KeyRotationRefusal[]> {
    // Identifiers, not parameters, reach `qualify()` elsewhere in this module; here they are bound,
    // but they came from `pg_attribute` and a malformed one means the introspection is wrong rather
    // than that a caller is hostile, so it fails fast instead of being quoted into a query.
    if (!IDENT_RE.test(schema) || !IDENT_RE.test(table)) {
      return [
        {
          reason: "table_missing",
          detail: `introspection returned an unusable identifier: ${schema}.${table}`,
        },
      ];
    }
    const result = await this.conn.query<RotationVisibilityRow>(
      `SELECT current_user AS role,
              COALESCE((SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user), false) AS bypasses_rls,
              pg_catalog.pg_get_userbyid(c.relowner) = current_user AS is_owner,
              c.relrowsecurity AS rls_enabled
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2`,
      [schema, table],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return [
        {
          reason: "table_missing",
          detail: `${schema}.${table} was introspected as holding an encrypted column but does not exist`,
        },
      ];
    }
    if (row.rls_enabled !== true || row.is_owner === true || row.bypasses_rls === true) return [];
    return [
      {
        reason: "rls_would_confine_this_session",
        detail:
          `row-level security confines '${String(row.role)}' on ${schema}.${table}; the UPDATE would ` +
          "match the rows this session can see and report only those, so a rotation would look " +
          "complete while ciphertext under the old key remained",
      },
    ];
  }
}
