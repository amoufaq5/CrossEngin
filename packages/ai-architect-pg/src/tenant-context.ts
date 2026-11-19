import type { PgConnection } from "@crossengin/kernel-pg";

/**
 * Sets `app.current_tenant_id` for one transaction, so the single `ALL`-scope isolation policy on
 * each `meta.architect_*` table admits the statement. Without it a non-owner's `INSERT` raises
 * `42501`, its `UPDATE` matches nothing and reports nothing, and its reads come back empty — so a
 * transcript written as the serving role (`crossengin_app`) recorded no row at all.
 *
 * Transaction-local by necessity: `set_config(…, true)` on a bare `query` is discarded with the
 * implicit single-statement transaction before the statement it was set for runs.
 */
export const SET_TENANT_CONTEXT_SQL = "SELECT set_config('app.current_tenant_id', $1, true)";

const TENANT_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export async function withTenantContext<T>(
  conn: PgConnection,
  tenantId: string,
  fn: (tx: PgConnection) => Promise<T>,
): Promise<T> {
  if (!TENANT_ID_RE.test(tenantId)) {
    throw new Error(`invalid tenantId for RLS context: ${JSON.stringify(tenantId)}`);
  }
  return conn.transaction(async (tx) => {
    await tx.query(SET_TENANT_CONTEXT_SQL, [tenantId]);
    return fn(tx);
  });
}
