import { qualifyTable, quoteIdent, toTableName } from "@crossengin/kernel/ddl";
import type { OnDelete } from "@crossengin/types/meta-schema";

import type { ColumnMapping, EntityTablePlan, JoinTablePlan } from "./column-plan.js";
import { searchFoldExpr, searchFoldRef } from "./search-fold.js";

const TENANT_ISOLATION = "tenant_id = current_setting('app.current_tenant_id', true)::UUID";

const MAX_IDENTIFIER_LEN = 63;

/**
 * Whether a column's SQL type can carry a trigram index at all.
 *
 * BYTEA (encrypted-at-rest) and non-text types (numeric/uuid/date/bool/json/…)
 * are excluded. `CHAR(n)` is excluded too, even though it holds text:
 * `gin_trgm_ops` accepts `text` and `varchar` (binary-coercible to text) but
 * **not** `bpchar`, so indexing one fails with `operator class "gin_trgm_ops"
 * does not accept data type character`. A `country_code` field emits `CHAR(2)`,
 * which is why `pack-erp-core` could not boot on this store at all.
 */
function isTextColumn(col: { sqlType: string; encryptAtRest: boolean }): boolean {
  if (col.encryptAtRest) return false;
  const t = col.sqlType.toUpperCase();
  return t === "TEXT" || t.startsWith("VARCHAR");
}

/**
 * Whether a column gets a trigram index: a text column whose *declared field
 * kind* holds free text.
 *
 * The second half is the narrowing. `enum` and `reference` both emit `TEXT`, so
 * a type-only test indexed them — measured on a composed pack, 67 of 291
 * trigram indexes were over enums and 82 over reference ids, 51% of them, and a
 * trigram index over a five-value enum measured larger than the table's own
 * primary key. Nothing substring-searches a closed token set or an opaque id:
 * both are matched by equality, which the tenant index and the primary key
 * already serve. `textSearchable` comes from the kernel's
 * `TEXT_SEARCHABLE_FIELD_KINDS` — the same fact that decides which fields `?q`
 * reaches, so the index set and the search surface cannot drift apart.
 */
function isTrigramIndexable(col: ColumnMapping): boolean {
  return isTextColumn(col) && col.textSearchable;
}

/**
 * The index name this emitter used before the fold (ADR-0285), kept only so the
 * now-provably-unusable index can be dropped by name. It indexed the bare
 * column, which no folded predicate can match.
 */
function legacyTrigramIndexName(table: string, column: string): string {
  return capIdentifier(`${table}_${column}_trgm`);
}

/** Deterministic fold-index name, capped at Postgres's 63-char identifier limit. */
function foldIndexName(table: string, column: string): string {
  return capIdentifier(`${table}_${column}_fold_trgm`);
}

function capIdentifier(name: string): string {
  return name.length <= MAX_IDENTIFIER_LEN ? name : name.slice(0, MAX_IDENTIFIER_LEN);
}

/**
 * Emits an additive `ADD COLUMN IF NOT EXISTS` per planned column, so a table created by an
 * earlier version of the manifest gains the fields a later one added. Without it
 * `CREATE TABLE IF NOT EXISTS` silently no-ops on the existing table and every read and
 * write of the new field fails against a column that was never created.
 *
 * **`NOT NULL` is dropped unless the column has a default.** Adding a NOT NULL column to a
 * table that already has rows is rejected by Postgres when there is nothing to backfill
 * with, so a newly required field arrives nullable rather than failing the migration: the
 * manifest's requirement is still enforced on write by the serving layer, and narrowing the
 * existing rows is a data decision this emitter cannot make. A column created fresh by the
 * `CREATE TABLE` above still carries its full `NOT NULL`.
 */
export function emitAddColumnDdl(plan: EntityTablePlan): string[] {
  const qualified = qualifyTable(plan.schema, plan.table);
  return plan.columns.map((c) => {
    const backfillable = { ...c, notNull: c.notNull && c.defaultSql !== null };
    return `ALTER TABLE ${qualified} ADD COLUMN IF NOT EXISTS ${quoteIdent(c.column)} ${columnType(backfillable)};`;
  });
}

/**
 * The housekeeping timestamps every entity table carries. An `auditable` entity declares
 * these as trait fields, so they arrive in the plan as ordinary domain columns; for every
 * other entity the emitter supplies them here. Either way the table has exactly one of each
 * — the plan wins, since a planned column is also readable, filterable and sortable.
 */
const SYSTEM_TIMESTAMPS: readonly { readonly name: string; readonly sql: string }[] = [
  { name: "created_at", sql: "TIMESTAMPTZ NOT NULL DEFAULT now()" },
  { name: "updated_at", sql: "TIMESTAMPTZ NOT NULL DEFAULT now()" },
];

/**
 * The system timestamps this table carries that the plan does not: `created_at`
 * and `updated_at` unless the entity declares them (the `auditable` trait does,
 * and then they are ordinary planned columns). One definition, read by the DDL
 * that creates them and by the store that selects them — a read that omitted
 * them published no version for a conditional write to echo.
 */
export function unplannedSystemTimestamps(plan: EntityTablePlan): readonly string[] {
  const planned = new Set(plan.columns.map((c) => c.column));
  return SYSTEM_TIMESTAMPS.filter((t) => !planned.has(t.name)).map((t) => t.name);
}

/** `<type>[ NOT NULL][ DEFAULT <sql>]` for one planned column. */
function columnType(c: ColumnMapping): string {
  const base = c.encryptAtRest ? "BYTEA" : c.sqlType;
  const notNull = c.notNull ? " NOT NULL" : "";
  const dflt = c.defaultSql !== null ? ` DEFAULT ${c.defaultSql}` : "";
  return `${base}${notNull}${dflt}`;
}

/**
 * Emits idempotent DDL for one entity's per-tenant table: a `CREATE TABLE IF
 * NOT EXISTS` with the system columns (`tenant_id`, TEXT `id`, timestamps) plus
 * each typed domain column, an additive `ADD COLUMN IF NOT EXISTS` per planned
 * column so a table created by an earlier manifest gains what the current one
 * added, the `(tenant_id, id)` primary key, a tenant index, RLS enabled with the
 * standard tenant-isolation policy (`DROP POLICY IF EXISTS` → `CREATE POLICY`,
 * so re-runs are safe), and a
 * `crossengin.data_class=…[; crossengin.encrypt=at_rest]` comment per classified
 * column (the same convention the kernel-pg encryption applier reads). A column
 * flagged `encryptAtRest` is stored as `BYTEA` (pgcrypto ciphertext), not its
 * plaintext type.
 */
export function emitEntityTableDdl(plan: EntityTablePlan): string[] {
  const qualified = qualifyTable(plan.schema, plan.table);
  const planned = new Set(plan.columns.map((c) => c.column));
  const columnLines: string[] = [
    `${quoteIdent("tenant_id")} UUID NOT NULL`,
    `${quoteIdent("id")} TEXT NOT NULL`,
    ...plan.columns.map((c) => `${quoteIdent(c.column)} ${columnType(c)}`),
    ...SYSTEM_TIMESTAMPS.filter((t) => !planned.has(t.name)).map(
      (t) => `${quoteIdent(t.name)} ${t.sql}`,
    ),
    `PRIMARY KEY (${quoteIdent("tenant_id")}, ${quoteIdent("id")})`,
  ];

  const policyName = `${plan.table}_tenant_isolation`;
  const indexNm = `idx_${plan.table}_tenant`;

  const stmts: string[] = [
    `CREATE TABLE IF NOT EXISTS ${qualified} (\n  ${columnLines.join(",\n  ")}\n);`,
    // Immediately after the CREATE and before anything that references a column: the
    // CREATE is a no-op on a table that already exists, so without this a manifest that
    // gained a field would leave the column missing and the very next statement (its
    // trigram index) would fail.
    ...emitAddColumnDdl(plan),
    `CREATE INDEX IF NOT EXISTS ${quoteIdent(indexNm)} ON ${qualified} (${quoteIdent("tenant_id")});`,
    `ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS ${quoteIdent(policyName)} ON ${qualified};`,
    `CREATE POLICY ${quoteIdent(policyName)} ON ${qualified} USING (${TENANT_ISOLATION});`,
  ];

  for (const col of plan.columns) {
    if (col.classification === null) continue;
    const directives = [`crossengin.data_class=${col.classification}`];
    if (col.encryptAtRest) directives.push("crossengin.encrypt=at_rest");
    stmts.push(`COMMENT ON COLUMN ${qualified}.${quoteIdent(col.column)} IS '${directives.join("; ")}';`);
  }

  // Drop the pre-fold plain-column trigram index wherever one could have been
  // emitted — including on columns that get no index at all now. It is emitted
  // by NAME rather than skipped, because `CREATE INDEX IF NOT EXISTS` on an
  // existing name keeps the OLD definition and creates nothing (verified: the
  // notice reads "relation already exists, skipping"), so reusing the name would
  // have left every deployment with the unusable index it already had. Dropping
  // an index is not the kind of data decision ADR-0283 holds migrations back
  // from: no row changes, and the index provably cannot serve any predicate this
  // store emits.
  const foldRef = searchFoldRef(plan.schema);
  for (const col of plan.columns) {
    if (!isTextColumn(col)) continue;
    stmts.push(
      `DROP INDEX IF EXISTS ${qualifyTable(plan.schema, legacyTrigramIndexName(plan.table, col.column))};`,
    );
  }

  // Trigram GIN index per free-text column, over the SAME folded expression the
  // `contains` filter and `?q` search compare through — a functional index, which
  // is the only kind a function-call predicate can match. Requires pg_trgm and
  // the fold function (both provisioned by the store's ensureSchema).
  for (const col of plan.columns) {
    if (!isTrigramIndexable(col)) continue;
    stmts.push(
      `CREATE INDEX IF NOT EXISTS ${quoteIdent(foldIndexName(plan.table, col.column))} ON ${qualified} `
      + `USING gin (${searchFoldExpr(foldRef, quoteIdent(col.column))} gin_trgm_ops);`,
    );
  }

  return stmts;
}

/**
 * Builds the `ON DELETE` clause for a reference's composite FK. `restrict` and
 * `cascade` are version-agnostic; `set_null` uses the **column-list** form so
 * only the `<ref>_id` column is nulled — never `tenant_id` (a plain `SET NULL`
 * would null every FK column, including the tenant). The column-list form
 * requires Postgres ≥ 15.
 */
export function onDeleteClause(policy: OnDelete, refColumn: string): string {
  switch (policy) {
    case "cascade":
      return "ON DELETE CASCADE";
    case "set_null":
      return `ON DELETE SET NULL (${quoteIdent(refColumn)})`;
    case "restrict":
      return "ON DELETE RESTRICT";
  }
}

/**
 * Emits idempotent foreign-key DDL for a plan's reference columns. Each
 * reference is a **composite** FK `(tenant_id, <ref>_id) → target (tenant_id,
 * id)`, so a reference can only point to a row in the *same tenant* (the PK is
 * `(tenant_id, id)`). A target not in `knownEntities` is skipped (no table to
 * reference). The `ON DELETE` behavior is per-relation via `onDeleteFor(field)`
 * (defaulting to RESTRICT). `DROP CONSTRAINT IF EXISTS` → `ADD CONSTRAINT` keeps
 * it re-runnable; applied in a second pass after all tables exist (so reference
 * cycles are safe).
 */
/** Emits the idempotent DROP/ADD pair for one composite tenant-scoped FK. */
function compositeFkStmts(
  qualified: string,
  constraint: string,
  refColumn: string,
  targetTable: string,
  onDelete: string,
): string[] {
  return [
    `ALTER TABLE ${qualified} DROP CONSTRAINT IF EXISTS ${quoteIdent(constraint)};`,
    `ALTER TABLE ${qualified} ADD CONSTRAINT ${quoteIdent(constraint)} ` +
      `FOREIGN KEY (${quoteIdent("tenant_id")}, ${quoteIdent(refColumn)}) ` +
      `REFERENCES ${targetTable} (${quoteIdent("tenant_id")}, ${quoteIdent("id")}) ${onDelete};`,
  ];
}

export function emitForeignKeyDdl(
  plan: EntityTablePlan,
  knownEntities: ReadonlySet<string>,
  onDeleteFor?: (field: string) => OnDelete | undefined,
): string[] {
  const qualified = qualifyTable(plan.schema, plan.table);
  const stmts: string[] = [];
  for (const col of plan.columns) {
    if (col.referenceTarget === null || !knownEntities.has(col.referenceTarget)) continue;
    const targetTable = qualifyTable(plan.schema, toTableName(col.referenceTarget));
    const policy = onDeleteFor?.(col.field) ?? "restrict";
    stmts.push(
      ...compositeFkStmts(qualified, `fk_${plan.table}_${col.column}`, col.column, targetTable, onDeleteClause(policy, col.column)),
    );
  }
  return stmts;
}

/**
 * Emits idempotent DDL for a `many_to_many` join table: a tenant-scoped link
 * table with `(tenant_id, <left>_id, <right>_id)` PK + RLS and a **composite**
 * FK from each side to its entity's `(tenant_id, id)` — `ON DELETE CASCADE`, so
 * deleting either linked row removes the association (no dangling links). Both
 * FK targets are required to exist (created in the entity-table phase); a side
 * not in `knownEntities` is skipped.
 */
export function emitJoinTableDdl(plan: JoinTablePlan, knownEntities: ReadonlySet<string>): string[] {
  const qualified = qualifyTable(plan.schema, plan.table);
  const policyName = `${plan.table}_tenant_isolation`;
  const columnLines = [
    `${quoteIdent("tenant_id")} UUID NOT NULL`,
    `${quoteIdent(plan.leftColumn)} TEXT NOT NULL`,
    `${quoteIdent(plan.rightColumn)} TEXT NOT NULL`,
    `${quoteIdent("created_at")} TIMESTAMPTZ NOT NULL DEFAULT now()`,
    `PRIMARY KEY (${quoteIdent("tenant_id")}, ${quoteIdent(plan.leftColumn)}, ${quoteIdent(plan.rightColumn)})`,
  ];
  const stmts: string[] = [
    `CREATE TABLE IF NOT EXISTS ${qualified} (\n  ${columnLines.join(",\n  ")}\n);`,
    `ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS ${quoteIdent(policyName)} ON ${qualified};`,
    `CREATE POLICY ${quoteIdent(policyName)} ON ${qualified} USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID);`,
  ];
  if (knownEntities.has(plan.leftEntity)) {
    stmts.push(
      ...compositeFkStmts(
        qualified,
        `fk_${plan.table}_${plan.leftColumn}`,
        plan.leftColumn,
        qualifyTable(plan.schema, toTableName(plan.leftEntity)),
        "ON DELETE CASCADE",
      ),
    );
  }
  if (knownEntities.has(plan.rightEntity)) {
    stmts.push(
      ...compositeFkStmts(
        qualified,
        `fk_${plan.table}_${plan.rightColumn}`,
        plan.rightColumn,
        qualifyTable(plan.schema, toTableName(plan.rightEntity)),
        "ON DELETE CASCADE",
      ),
    );
  }
  return stmts;
}
