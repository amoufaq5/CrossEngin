import { qualifyTable, quoteIdent, toTableName } from "@crossengin/kernel/ddl";
import type { OnDelete } from "@crossengin/types/meta-schema";

import {
  topologicalEntityOrder,
  type ColumnMapping,
  type EntityTablePlan,
  type JoinTablePlan,
} from "./column-plan.js";

/**
 * The isolation predicate every served entity table carries.
 *
 * `NULLIF` is load-bearing: `current_setting(x, true)` answers NULL only until the setting has been
 * used once on a connection, after which its reset value is the empty string — and `''::UUID` raises
 * `invalid input syntax for type uuid: ""` rather than returning no rows. So on a pooled connection
 * that has already served one tenant, a query without a tenant context became an error instead of an
 * empty result. Both are fail-closed, but only one matches the platform rule that an unresolvable
 * identity yields an empty result set, and only one is debuggable.
 */
const TENANT_ISOLATION = "tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::UUID";

const MAX_IDENTIFIER_LEN = 63;

/**
 * A plaintext (non-encrypted) text or varchar column — the kind a `contains`
 * (substring) filter can search, and which a trigram GIN index accelerates.
 * BYTEA (encrypted-at-rest) and non-text types (numeric/uuid/date/bool/json/…)
 * are excluded.
 *
 * `CHAR(n)` is excluded too, even though it holds text: `gin_trgm_ops` accepts
 * `text` and `varchar` (binary-coercible to text) but **not** `bpchar`, so
 * indexing one fails with `operator class "gin_trgm_ops" does not accept data
 * type character`. A `country_code` field emits `CHAR(2)`, which is why
 * `pack-erp-core` could not boot on this store at all.
 */
function isTrigramIndexable(col: { sqlType: string; encryptAtRest: boolean }): boolean {
  if (col.encryptAtRest) return false;
  const t = col.sqlType.toUpperCase();
  return t === "TEXT" || t.startsWith("VARCHAR");
}

/** Deterministic trigram index name, capped at Postgres's 63-char identifier limit. */
function trigramIndexName(table: string, column: string): string {
  const name = `${table}_${column}_trgm`;
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

  // Trigram GIN index per plaintext text column, accelerating the `contains`
  // (ILIKE '%…%') substring filter. A *plain* column index (`gin (<col>
  // gin_trgm_ops)`), NOT a functional `unaccent(<col>)` index — unaccent() is
  // not IMMUTABLE and can't back an index. Requires the pg_trgm extension
  // (provisioned by the store's ensureSchema).
  for (const col of plan.columns) {
    if (!isTrigramIndexable(col)) continue;
    const idxName = trigramIndexName(plan.table, col.column);
    stmts.push(
      `CREATE INDEX IF NOT EXISTS ${quoteIdent(idxName)} ON ${qualified} USING gin (${quoteIdent(col.column)} gin_trgm_ops);`,
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
    `CREATE POLICY ${quoteIdent(policyName)} ON ${qualified} USING (${TENANT_ISOLATION});`,
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

/**
 * The whole idempotent DDL sequence for one resolved manifest's tables, in the
 * one order that is safe to apply: **every entity table** in topological
 * reference order, then **every foreign key** once all the targets exist, then
 * the `many_to_many` join tables whose FKs point at those entity tables.
 *
 * The three phases are not stylistic. Creating tables before any FK is what makes
 * a reference *cycle* applicable at all — which is the invariant
 * `topologicalEntityOrder` deliberately tolerates a cycle for (ADR-0285) — and
 * join tables come last because both of their FK targets must already exist.
 *
 * This is the single sequence: `ColumnMappedEntityStore.ensureSchema` executes it
 * against the deployment's shared boot schema and
 * `applyTenantManifestSchema` executes it against one tenant's own schema, so a
 * tenant-owned table cannot drift from a shared one in shape, order, tenancy or
 * RLS. Every statement is schema-qualified, so neither path depends on
 * `search_path` (the one exception is `gin_trgm_ops`, resolved from the extension's
 * own schema — conventionally `public`, which is on the default path).
 *
 * Neither the schema nor the extensions are here. Creating the schema is the
 * caller's: the per-tenant applier has to create it *before* it introspects what
 * is in it, so emitting it again here would be a duplicate — and the per-tenant
 * applier reports the statements it ran. Installing an extension is
 * database-wide, not part of any one schema's DDL.
 */
export function emitManifestSchemaDdl(
  plans: ReadonlyMap<string, EntityTablePlan>,
  joinPlans: readonly JoinTablePlan[] = [],
  deletePolicies: ReadonlyMap<string, OnDelete> = new Map(),
): readonly string[] {
  const stmts: string[] = [];
  const order = topologicalEntityOrder(plans);
  for (const name of order) {
    const plan = plans.get(name);
    if (plan !== undefined) stmts.push(...emitEntityTableDdl(plan));
  }
  const known = new Set(plans.keys());
  for (const name of order) {
    const plan = plans.get(name);
    if (plan === undefined) continue;
    const onDeleteFor = (field: string): OnDelete | undefined =>
      deletePolicies.get(`${plan.entity}.${field}`);
    stmts.push(...emitForeignKeyDdl(plan, known, onDeleteFor));
  }
  for (const joinPlan of joinPlans) stmts.push(...emitJoinTableDdl(joinPlan, known));
  return stmts;
}
