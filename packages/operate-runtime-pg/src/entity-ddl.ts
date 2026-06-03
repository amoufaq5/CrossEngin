import { qualifyTable, quoteIdent, toTableName } from "@crossengin/kernel/ddl";
import type { OnDelete } from "@crossengin/types/meta-schema";

import type { EntityTablePlan, JoinTablePlan } from "./column-plan.js";

const TENANT_ISOLATION = "tenant_id = current_setting('app.current_tenant_id', true)::UUID";

/**
 * Emits idempotent DDL for one entity's per-tenant table: a `CREATE TABLE IF
 * NOT EXISTS` with the system columns (`tenant_id`, TEXT `id`, timestamps) plus
 * each typed domain column, the `(tenant_id, id)` primary key, a tenant index,
 * RLS enabled with the standard tenant-isolation policy
 * (`DROP POLICY IF EXISTS` → `CREATE POLICY`, so re-runs are safe), and a
 * `crossengin.data_class=…[; crossengin.encrypt=at_rest]` comment per classified
 * column (the same convention the kernel-pg encryption applier reads). A column
 * flagged `encryptAtRest` is stored as `BYTEA` (pgcrypto ciphertext), not its
 * plaintext type.
 */
export function emitEntityTableDdl(plan: EntityTablePlan): string[] {
  const qualified = qualifyTable(plan.schema, plan.table);
  const columnLines: string[] = [
    `${quoteIdent("tenant_id")} UUID NOT NULL`,
    `${quoteIdent("id")} TEXT NOT NULL`,
    ...plan.columns.map(
      (c) => `${quoteIdent(c.column)} ${c.encryptAtRest ? "BYTEA" : c.sqlType}${c.notNull ? " NOT NULL" : ""}`,
    ),
    `${quoteIdent("created_at")} TIMESTAMPTZ NOT NULL DEFAULT now()`,
    `${quoteIdent("updated_at")} TIMESTAMPTZ NOT NULL DEFAULT now()`,
    `PRIMARY KEY (${quoteIdent("tenant_id")}, ${quoteIdent("id")})`,
  ];

  const policyName = `${plan.table}_tenant_isolation`;
  const indexNm = `idx_${plan.table}_tenant`;

  const stmts: string[] = [
    `CREATE TABLE IF NOT EXISTS ${qualified} (\n  ${columnLines.join(",\n  ")}\n);`,
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
