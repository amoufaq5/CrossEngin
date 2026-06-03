import { qualifyTable, quoteIdent } from "@crossengin/kernel/ddl";

import type { EntityTablePlan } from "./column-plan.js";

const TENANT_ISOLATION = "tenant_id = current_setting('app.current_tenant_id', true)::UUID";

/**
 * Emits idempotent DDL for one entity's per-tenant table: a `CREATE TABLE IF
 * NOT EXISTS` with the system columns (`tenant_id`, TEXT `id`, timestamps) plus
 * each typed domain column, the `(tenant_id, id)` primary key, a tenant index,
 * RLS enabled with the standard tenant-isolation policy
 * (`DROP POLICY IF EXISTS` → `CREATE POLICY`, so re-runs are safe), and a
 * `crossengin.data_class=…[; crossengin.encrypt=at_rest]` comment per classified
 * column (the same convention the kernel-pg encryption applier reads).
 */
export function emitEntityTableDdl(plan: EntityTablePlan): string[] {
  const qualified = qualifyTable(plan.schema, plan.table);
  const columnLines: string[] = [
    `${quoteIdent("tenant_id")} UUID NOT NULL`,
    `${quoteIdent("id")} TEXT NOT NULL`,
    ...plan.columns.map((c) => `${quoteIdent(c.column)} ${c.sqlType}${c.notNull ? " NOT NULL" : ""}`),
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
