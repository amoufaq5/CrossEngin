import { assertScopeTenantId, type PgConnection } from "./connection.js";
import {
  introspectEncryptedColumns,
  introspectPartitionedEncryptedTables,
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

/** The column every tenant-scoped entity table carries; the DDL emitter adds it as a system column. */
export const TENANT_SCOPE_COLUMN = "tenant_id";

/**
 * Which rows a re-encryption rewrites. A discriminated union and **required** rather than an
 * optional predicate, because an optional one can be forgotten with the type still valid and the
 * thing forgotten here is the difference between rotating one tenant and rotating every tenant
 * under one tenant's key.
 *
 * That is not a hypothetical: under a boot manifest every tenant's encrypted columns live in the
 * deployment's **shared** schema with a `tenant_id` column, while the envelope's data key is **per
 * tenant** — so a scopeless rotation for tenant A re-encrypts B's ciphertext under A's key pair,
 * and in envelope mode it cannot even get that far, because `pgp_sym_decrypt` raises `Wrong key or
 * corrupt data` on the first foreign row.
 */
export type ReencryptScope =
  | { readonly kind: "tenant"; readonly column: string; readonly tenantId: string }
  /** `because` carries the reason the unsafe branch was chosen, the way an unreachable-store
   *  declaration does. A blank one throws. */
  | { readonly kind: "every_row"; readonly because: string };

export interface ReencryptStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

export interface ReencryptColumnInput {
  readonly schema: string;
  readonly table: string;
  /** A BYTEA column already encrypted under `oldKeyRef`. */
  readonly column: string;
  readonly oldKeyRef: string;
  readonly newKeyRef: string;
  readonly scope: ReencryptScope;
}

/**
 * The `WHERE` every statement in this module shares, so a rotation, its row count and its
 * confirm-readability pass cannot disagree about which rows they are talking about.
 *
 * Three statements built from one clause rather than three clauses: the confirm pass exists to prove
 * that what the `UPDATE` rewrote reads back under the new key, and a predicate that differed by one
 * conjunct would make the two counts incomparable — which is the one comparison
 * `rotateTenantWithin` refuses to commit without.
 */
function scopeWhere(column: string, scope: ReencryptScope): ReencryptStatement {
  const col = quoteIdent(column);
  if (scope.kind === "every_row") {
    if (scope.because.trim().length === 0) {
      throw new Error(
        "reencrypt scope every_row requires a non-empty `because`: rewriting every row in a table " +
          "under one key pair is correct only for a key that is not per tenant, and that reason is " +
          "written down rather than assumed, the way an unreachable-store declaration is.",
      );
    }
    return { sql: `${col} IS NOT NULL`, params: [] };
  }
  // Bound, never interpolated — and asserted, because a tenant id that matches no row makes every
  // statement here answer 0, which is byte-identical to "this tenant holds no ciphertext" and is
  // the one wrong answer a rekey cannot come back from.
  assertScopeTenantId(scope.tenantId);
  return {
    sql: `${col} IS NOT NULL AND ${quoteIdent(scope.column)} = $1`,
    params: [scope.tenantId],
  };
}

/**
 * Emits the in-place re-encryption of a pgcrypto BYTEA column from one key to
 * another: decrypt with the old key, re-encrypt with the new key. NULLs are left
 * untouched (the `WHERE ... IS NOT NULL` guard skips them). Keys are always SQL
 * references, never inlined, and the scope's tenant id is always a bound parameter.
 */
export function reencryptColumnSql(input: ReencryptColumnInput): ReencryptStatement {
  const table = qualify(input.schema, input.table);
  const col = quoteIdent(input.column);
  const decrypted = pgpSymDecryptExpr(col, input.oldKeyRef);
  const reencrypted = pgpSymEncryptExpr(decrypted, input.newKeyRef);
  const where = scopeWhere(input.column, input.scope);
  return {
    sql: `UPDATE ${table} SET ${col} = ${reencrypted} WHERE ${where.sql};`,
    params: where.params,
  };
}

/**
 * The confirm-readability pass: decrypt every row the rotation touched under the **new** key and
 * count. pgcrypto raises `Wrong key or corrupt data` on a wrong key, so this either returns the
 * count or aborts the transaction — ADR-0316's confirm-absence-before-committing, inverted to
 * confirm-readability.
 */
export function confirmColumnKeySql(input: {
  readonly schema: string;
  readonly table: string;
  readonly column: string;
  readonly keyRef: string;
  readonly scope: ReencryptScope;
}): ReencryptStatement {
  const table = qualify(input.schema, input.table);
  const col = quoteIdent(input.column);
  const where = scopeWhere(input.column, input.scope);
  // `count(<expr>)` counts the non-NULL results, so this is a count of rows that *decrypted*,
  // not of rows considered — which is what makes comparing it to the UPDATE's row count mean
  // something.
  return {
    sql: `SELECT count(${pgpSymDecryptExpr(col, input.keyRef)}) AS readable FROM ${table} WHERE ${where.sql};`,
    params: where.params,
  };
}

/** The rows a plan would rewrite, without needing either key — so a survey can run with none set. */
function countReencryptRowsSql(input: {
  readonly schema: string;
  readonly table: string;
  readonly column: string;
  readonly scope: ReencryptScope;
}): ReencryptStatement {
  const where = scopeWhere(input.column, input.scope);
  return {
    sql: `SELECT count(*) AS rows_to_rewrite FROM ${qualify(input.schema, input.table)} WHERE ${where.sql};`,
    params: where.params,
  };
}

/**
 * `count()` is BIGINT, which node-postgres hands back as a **string** (ADR-0331's measured class), so
 * a `typeof === "number"` reader would be answering for a row shape this code never sees live and
 * every offline fake produces. Both forms are read, and anything else is a finding rather than a
 * zero: substituting 0 here would let `rotateTenantWithin`'s confirm comparison pass vacuously.
 */
function readCount(value: unknown, what: string): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  throw new Error(`${what}: count came back as ${JSON.stringify(value)}, which is not a row count`);
}

export interface KeyRotationPlan {
  readonly schema: string;
  readonly table: string;
  readonly column: string;
  readonly dataClass: string | null;
  readonly statement: ReencryptStatement;
  readonly confirm: ReencryptStatement;
  /**
   * Rows this plan would rewrite, or `null` when nobody counted. `planColumnKeyRotation` is pure and
   * answers `null`; `surveyTenant` counts and fills it. `null` is "not counted", never 0 — the
   * distinction matters because 0 is also what a confined session sees.
   *
   * Advisory, not an invariant: under READ COMMITTED a row committed between the count and the
   * `UPDATE` is visible to the latter, so the two figures may legitimately differ. The figure that
   * is checked is the `UPDATE`'s own against the confirm pass's.
   */
  readonly rowsToRewrite: number | null;
}

export function planColumnKeyRotation(
  column: EncryptedColumn,
  oldKeyRef: string,
  newKeyRef: string,
  scope: ReencryptScope,
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
      scope,
    }),
    confirm: confirmColumnKeySql({
      schema: column.schema,
      table: column.table,
      column: column.column,
      keyRef: newKeyRef,
      scope,
    }),
    rowsToRewrite: null,
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
    const counted =
      plan.rowsToRewrite === null ? "" : ` — ${plan.rowsToRewrite.toString()} row(s)`;
    lines.push(`-- ${plan.table}.${plan.column} (${plan.dataClass ?? "?"})${counted}`);
    lines.push(plan.statement.sql);
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
 * The ways a rotation is wrong *as a rotation*, and so refuses.
 *
 * `plaintext_at_rest` is deliberately **not** here. A hinted column stored as TEXT was protected by
 * neither key, so retiring the old one cannot make it unreadable — it is a finding about the
 * *encryption* migration, which `crossengin-pg encrypt --verify` is the surface for, and blocking a
 * correct rotation on it would couple two independent migrations into one refusal an operator would
 * route around. It is reported on the survey and in the formatted plan instead.
 *
 * The two later members share one shape: each names a way the rotation would **report itself
 * complete having skipped ciphertext**, which is the one outcome that is worse than a failure,
 * because the operator's next act is to destroy the key the skipped rows are still under.
 */
export const KEY_ROTATION_REFUSAL_REASONS = [
  "rls_would_confine_this_session",
  "keys_are_the_same",
  "table_missing",
  /**
   * A table holding a hinted encrypted column has no `tenant_id` column at all, so a tenant-scoped
   * rotation cannot be expressed over it. Refused and **not** downgraded to a whole-table rotation:
   * the downgrade is the defect — it would rewrite every tenant's ciphertext under this tenant's key
   * pair.
   */
  "tenant_column_missing",
  /**
   * A partitioned table in this schema carries an at-rest-encrypted column, so
   * `introspectEncryptedColumns` (which filters `relkind = 'r'`) cannot see it and a rotation that
   * reported success would have skipped it. See `introspectPartitionedEncryptedTables` for why
   * widening the filter is not the fix.
   */
  "partitioned_table_unreachable",
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

/** What `rotateTenantWithin` rewrote and what it proved readable, before the caller's commit. */
export interface TenantRotationOutcome {
  readonly columns: readonly KeyRotationOutcome[];
  readonly rowsReencrypted: number;
  readonly rowsConfirmed: number;
}

interface RotationVisibilityRow {
  readonly role: unknown;
  readonly bypasses_rls: unknown;
  readonly is_owner: unknown;
  readonly rls_enabled: unknown;
  readonly rls_forced: unknown;
  readonly has_scope_column: unknown;
}

/**
 * `rotateSchema`'s scope, stated once rather than at its two call sites.
 *
 * A whole-schema rotation is correct exactly when the key is **not** per tenant — a KEK rotation,
 * where one key pair covers every row in the schema by construction. It is wrong for the per-tenant
 * data key, which is why `rotateTenantWithin` exists beside it rather than replacing it.
 */
const WHOLE_SCHEMA_SCOPE: ReencryptScope = {
  kind: "every_row",
  because:
    "rotateSchema rewrites every row in the schema under one key pair, which is correct only for a " +
    "key that is not per tenant (a KEK rotation). A per-tenant data key takes rotateTenantWithin.",
};

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
      .map((c) => planColumnKeyRotation(c, oldKeyRef, newKeyRef, WHOLE_SCHEMA_SCOPE));
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
      .map((c) => planColumnKeyRotation(c, oldKeyRef, newKeyRef, WHOLE_SCHEMA_SCOPE));
    const plaintextAtRest = columns.filter((c) => !c.encryptedStorage);
    const refusals = await this.commonRefusals(
      this.conn,
      schema,
      plans,
      oldKeyRef,
      newKeyRef,
      WHOLE_SCHEMA_SCOPE,
    );
    return { plans, plaintextAtRest, refusals };
  }

  /**
   * Surveys a **tenant-scoped** rotation on an explicit connection, counting the rows each column
   * would rewrite so an operator sees the lock window before approving it.
   *
   * ## Why `rls_would_confine_this_session` is kept for a scoped rotation
   *
   * It is tempting to argue that for a tenant-scoped rotation the session's confinement *is* the
   * scope, so this refusal is spurious — set `app.current_tenant_id` and RLS and the predicate
   * agree. That is true of the **rows** and false of the **count**: a confined session that can see
   * none of them reports `0 rows re-encrypted`, which is byte-identical to "this tenant holds no
   * ciphertext", and the rekey's very next act is to delete the generation those rows are under.
   * `probeJobQueueVisibility`'s ambiguity, in the one place where resolving it wrongly is permanent.
   * And for an **owner** the tenant context is inert, because the owner bypasses RLS. So the tenant
   * predicate is not a second belt beside RLS — **it is the only confinement**, which is exactly why
   * it must be required and bound.
   *
   * The explicit connection is the seam `rotateTenantWithin` surveys through, so what is rotated is
   * what was surveyed; `kernel-pg` had no `*Within` seam before this one, and it follows
   * `appendWithin` / `writeWithin` / `eraseTenantSchemaWithin`'s idiom of putting the connection
   * first.
   */
  async surveyTenant(
    on: PgConnection,
    schema: string,
    tenantId: string,
    oldKeyRef: string,
    newKeyRef: string,
  ): Promise<KeyRotationSurvey> {
    const scope: ReencryptScope = {
      kind: "tenant",
      column: TENANT_SCOPE_COLUMN,
      tenantId,
    };
    const columns = await introspectEncryptedColumns(on, schema);
    const planned = columns
      .filter((c) => c.encryptedStorage)
      .map((c) => planColumnKeyRotation(c, oldKeyRef, newKeyRef, scope));
    const plaintextAtRest = columns.filter((c) => !c.encryptedStorage);
    const refusals = await this.commonRefusals(on, schema, planned, oldKeyRef, newKeyRef, scope);

    // Counted only when nothing refuses, and that is one rule rather than a judgement per reason.
    // Three of the five refusals make the figure a lie or a raise: a confined session counts 0, a
    // table with no `tenant_id` column makes the count itself raise `42703`, and a missing table
    // likewise. A survey that refuses is not going to be executed, so a count nobody can act on is
    // work spent to print a number whose meaning this function cannot vouch for.
    if (refusals.length > 0) {
      return { plans: planned, plaintextAtRest, refusals };
    }
    const plans: KeyRotationPlan[] = [];
    for (const plan of planned) {
      const count = countReencryptRowsSql({
        schema: plan.schema,
        table: plan.table,
        column: plan.column,
        scope,
      });
      const result = await on.query<{ readonly rows_to_rewrite: unknown }>(
        count.sql,
        count.params,
      );
      plans.push({
        ...plan,
        rowsToRewrite: readCount(
          result.rows[0]?.rows_to_rewrite,
          `${plan.table}.${plan.column} rows_to_rewrite`,
        ),
      });
    }
    return { plans, plaintextAtRest, refusals };
  }

  /**
   * Surveys inside the caller's transaction, refuses, rotates every column, then confirms each one
   * reads back under the new key — all before the caller's commit.
   *
   * One transaction for every column, where `rotateSchema` takes one per column, and the difference
   * is not stylistic. `ColumnEncryptionKeySource` resolves exactly **one** key per tenant per
   * operation and nothing on any row records which key wrote it, so a tenant left with columns 1–3
   * under the new key and 4–7 under the old is unserveable by either key: the per-column split turns
   * a recoverable failure (nothing committed, retry) into an unrecoverable one. Per-tenant scoping
   * is what makes a single transaction plausible where per-schema did not, and none of this is DDL,
   * so the key row the caller writes afterwards commits with the ciphertext.
   */
  async rotateTenantWithin(
    tx: PgConnection,
    schema: string,
    tenantId: string,
    oldKeyRef: string,
    newKeyRef: string,
  ): Promise<TenantRotationOutcome> {
    // First, because the `UPDATE` and the confirm are the only statements here that read a key GUC
    // and neither may run before the keys are claimed: both refs are the raising form, so one
    // issued ahead of these aborts the transaction with `unrecognized configuration parameter`
    // rather than silently encrypting NULL. The **survey** reads no key at all — introspection, a
    // catalog probe and a `count(*)` over the scope predicate — which is also why it is safe to run
    // on its own connection with no key set, and why ordering it after these settings costs
    // nothing rather than being required.
    await this.applySessionSettings(tx);

    // Inside the transaction, so what is rotated is what was surveyed and every refusal rolls back.
    const survey = await this.surveyTenant(tx, schema, tenantId, oldKeyRef, newKeyRef);
    if (survey.refusals.length > 0) throw new KeyRotationRefused(schema, survey.refusals);

    const columns: KeyRotationOutcome[] = [];
    let rowsReencrypted = 0;
    for (const plan of survey.plans) {
      const result = await tx.query(plan.statement.sql, plan.statement.params);
      columns.push({ ...plan, rowsReencrypted: result.rowCount });
      rowsReencrypted += result.rowCount;
    }

    let rowsConfirmed = 0;
    for (const outcome of columns) {
      const result = await tx.query<{ readonly readable: unknown }>(
        outcome.confirm.sql,
        outcome.confirm.params,
      );
      const readable = readCount(
        result.rows[0]?.readable,
        `${outcome.table}.${outcome.column} confirm`,
      );
      // A disagreement means some row did not come back under the new key, and the transaction must
      // not commit. No cause is claimed for it, deliberately: a row committed under the *previous*
      // key between the UPDATE and the confirm — the stale-key writer, which is the obvious guess —
      // makes `pgp_sym_decrypt` **raise** rather than count low, so it never reaches this
      // comparison. This is the backstop for a count that disagrees for some reason pgcrypto does
      // not raise on, and rolling back is the right answer whether or not we can name it.
      if (readable !== outcome.rowsReencrypted) {
        throw new Error(
          `key rotation confirm failed for ${schema}.${outcome.table}.${outcome.column}: ` +
            `${outcome.rowsReencrypted.toString()} row(s) were re-encrypted but ` +
            `${readable.toString()} read back under the new key, so the rotation must not commit`,
        );
      }
      rowsConfirmed += readable;
    }

    return { columns, rowsReencrypted, rowsConfirmed };
  }

  /**
   * Surveys, refuses, then executes. Each column re-encrypts in its own transaction.
   *
   * Returns the **rows actually rewritten** per column, not merely the statements issued. What is
   * deliberately *not* here is a resume ledger, and the reason is not that one is unbuilt: for a
   * **per-tenant** key no ledger is wanted at all, because the atomic unit is the tenant and
   * `rotateTenantWithin` makes it one transaction — a half-rotated tenant is unserveable either way,
   * so a ledger would only make an unrecoverable state resumable in principle and still unreadable
   * in fact. These per-column transactions are the right shape only for a rotation whose key is
   * **not** per tenant, i.e. a KEK rotation, where every row in the schema is under one key pair and
   * a failure at column 4 of 7 leaves 1–3 correct and re-runnable once their already-rotated state
   * is known. For *that* rotation the outcome list is the only record and the caller must keep it.
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
        await this.applySessionSettings(tx);
        const result = await tx.query(plan.statement.sql, plan.statement.params);
        return result.rowCount;
      });
      outcomes.push({ ...plan, rowsReencrypted: rows });
    }
    return outcomes;
  }

  private async applySessionSettings(on: PgConnection): Promise<void> {
    for (const [name, value] of this.sessionSettings) {
      await on.query(`SELECT set_config($1, $2, true)`, [name, value]);
    }
  }

  /** The refusals both surveys share, so neither can acquire one the other lacks. */
  private async commonRefusals(
    conn: PgConnection,
    schema: string,
    plans: readonly KeyRotationPlan[],
    oldKeyRef: string,
    newKeyRef: string,
    scope: ReencryptScope,
  ): Promise<readonly KeyRotationRefusal[]> {
    const refusals: KeyRotationRefusal[] = [];

    // Before the probes, because it needs no database round trip. It is **not** the refusal that is
    // always right: it compares the two *references* as text, so two different GUC names holding
    // identical bytes pass it, which is exactly the shape a rekey has. This module compares
    // references because key *values* must not enter it at all — they reach Postgres only as bound
    // parameters of `set_config` — so the value-equality check belongs to whatever orchestrator
    // holds both values, and `crypto-pg`'s rekey is where it lives.
    if (oldKeyRef.trim() === newKeyRef.trim()) {
      refusals.push({
        reason: "keys_are_the_same",
        detail: `oldKeyRef and newKeyRef are the same expression (${oldKeyRef.trim()})`,
      });
    }

    // Asked before the per-table probes, because its finding is about tables the plan does not
    // contain: a partitioned parent is absent from `plans` by construction, so no amount of probing
    // what *is* planned can reach it.
    for (const table of await introspectPartitionedEncryptedTables(conn, schema)) {
      refusals.push({
        reason: "partitioned_table_unreachable",
        detail:
          `${schema}.${table} is a partitioned table carrying an at-rest-encrypted column; ` +
          "introspection only sees ordinary tables, so this rotation would report itself complete " +
          "having skipped it",
      });
    }

    for (const table of [...new Set(plans.map((p) => p.table))]) {
      refusals.push(...(await this.probeTable(conn, schema, table, scope)));
    }
    return refusals;
  }

  private async probeTable(
    conn: PgConnection,
    schema: string,
    table: string,
    scope: ReencryptScope,
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
    // One statement for both scopes: the scope column is bound either way and `has_scope_column` is
    // simply not read for `every_row`, which keeps the two paths asking the catalog one question.
    const scopeColumn = scope.kind === "tenant" ? scope.column : TENANT_SCOPE_COLUMN;
    const result = await conn.query<RotationVisibilityRow>(
      `SELECT current_user AS role,
              COALESCE((SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user), false) AS bypasses_rls,
              pg_catalog.pg_get_userbyid(c.relowner) = current_user AS is_owner,
              c.relrowsecurity AS rls_enabled,
              c.relforcerowsecurity AS rls_forced,
              EXISTS (SELECT 1 FROM pg_attribute a
                       WHERE a.attrelid = c.oid
                         AND a.attnum > 0
                         AND NOT a.attisdropped
                         AND a.attname = $3) AS has_scope_column
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2`,
      [schema, table, scopeColumn],
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

    const refusals: KeyRotationRefusal[] = [];
    if (scope.kind === "tenant" && row.has_scope_column !== true) {
      refusals.push({
        reason: "tenant_column_missing",
        detail:
          `${schema}.${table} holds an encrypted column but has no "${scopeColumn}" column, so a ` +
          "tenant-scoped rotation cannot be expressed over it; rotating it unscoped would rewrite " +
          "every tenant's ciphertext under this tenant's key pair",
      });
    }
    // Kept for a **tenant-scoped** rotation too, which is the non-obvious half. The tempting
    // argument is that for a scoped rotation the session's confinement *is* the scope, so this is
    // spurious — set `app.current_tenant_id` and RLS and the predicate agree. That is true of the
    // rows and false of the count: a confined session reports `0 rows re-encrypted`, which is
    // byte-identical to "this tenant holds no ciphertext", and the rekey's very next act is to
    // delete the generation those rows are under. And for an **owner** the tenant context is inert,
    // because the owner bypasses RLS — so the bound predicate is not a second belt beside RLS, it is
    // the only confinement there is.
    //
    // `relforcerowsecurity` is read because **it confines the owner too**, which is the one input
    // the ownership arm would otherwise answer wrongly in the permissive direction. Nothing in this
    // repo sets `FORCE ROW LEVEL SECURITY` today, so this is latent — but the whole point of this
    // probe is that a confined session's zero is indistinguishable from an empty tenant, and
    // reading ownership while ignoring the one flag that overrides ownership would let exactly that
    // session through.
    const bypassesPolicies =
      row.rls_forced === true
        ? row.bypasses_rls === true
        : row.is_owner === true || row.bypasses_rls === true;
    if (row.rls_enabled === true && !bypassesPolicies) {
      refusals.push({
        reason: "rls_would_confine_this_session",
        detail:
          `row-level security confines '${String(row.role)}' on ${schema}.${table}` +
          (row.rls_forced === true ? " (FORCE ROW LEVEL SECURITY, which confines the owner too)" : "") +
          "; a session with no tenant context, or another tenant's, counts 0 rows — which is " +
          "byte-identical to \"this tenant holds no ciphertext\" — and a session confined to " +
          "exactly this tenant would rotate correctly but cannot be told apart from the first one " +
          "from here, so the refusal is up front rather than after the count",
      });
    }
    return refusals;
  }
}
