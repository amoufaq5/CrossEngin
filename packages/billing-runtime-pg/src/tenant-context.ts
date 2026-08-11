import type { PgConnection } from "@crossengin/kernel-pg";

/**
 * Establishes `app.current_tenant_id` for the current transaction only (bound as
 * `$1`, never interpolated), so the tenant RLS policies on
 * `meta.billing_usage_records` / `meta.invoices` scope every read/write to the
 * caller's tenant.
 */
export const SET_TENANT_CONTEXT_SQL = "SELECT set_config('app.current_tenant_id', $1, true)";

const TENANT_ID_RE = /^[0-9a-fA-F-]{1,64}$/;

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
