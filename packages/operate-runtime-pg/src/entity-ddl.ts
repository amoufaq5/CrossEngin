import { qualifyTable, quoteIdent, toTableName } from "@crossengin/kernel/ddl";

import type { EntityTablePlan } from "./column-plan.js";

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
 * Emits idempotent foreign-key DDL for a plan's reference columns. Each
 * reference is a **composite** FK `(tenant_id, <ref>_id) → target (tenant_id,
 * id)`, so a reference can only point to a row in the *same tenant* (the PK is
 * `(tenant_id, id)`). A target not in `knownEntities` is skipped (no table to
 * reference). `DROP CONSTRAINT IF EXISTS` → `ADD CONSTRAINT` keeps it
 * re-runnable; applied in a second pass after all tables exist (so reference
 * cycles are safe).
 */
export function emitForeignKeyDdl(plan: EntityTablePlan, knownEntities: ReadonlySet<string>): string[] {
  const qualified = qualifyTable(plan.schema, plan.table);
  const stmts: string[] = [];
  for (const col of plan.columns) {
    if (col.referenceTarget === null || !knownEntities.has(col.referenceTarget)) continue;
    const targetTable = qualifyTable(plan.schema, toTableName(col.referenceTarget));
    const constraint = `fk_${plan.table}_${col.column}`;
    stmts.push(`ALTER TABLE ${qualified} DROP CONSTRAINT IF EXISTS ${quoteIdent(constraint)};`);
    stmts.push(
      `ALTER TABLE ${qualified} ADD CONSTRAINT ${quoteIdent(constraint)} ` +
        `FOREIGN KEY (${quoteIdent("tenant_id")}, ${quoteIdent(col.column)}) ` +
        `REFERENCES ${targetTable} (${quoteIdent("tenant_id")}, ${quoteIdent("id")}) ON DELETE RESTRICT;`,
    );
  }
  return stmts;
}
