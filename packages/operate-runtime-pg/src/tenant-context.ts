import type { PgConnection } from "@crossengin/kernel-pg";

/**
 * Sets `app.current_tenant_id` for the *current transaction only*
 * (`set_config(..., is_local => true)`), so the row-level-security policy on
 * `meta.operate_entity_records`
 * (`tenant_id = current_setting('app.current_tenant_id', true)::UUID`) scopes
 * every read/write to the caller's tenant. A `SELECT set_config(...)` is used
 * (not `SET LOCAL`) so the tenant id rides as a bound `$1` parameter rather
 * than being interpolated into SQL.
 */
export const SET_TENANT_CONTEXT_SQL = "SELECT set_config('app.current_tenant_id', $1, true)";

const TENANT_ID_RE = /^[0-9a-fA-F-]{1,64}$/;

/**
 * Runs `fn` inside a transaction with the tenant RLS context established. The
 * tenant id is validated to a UUID-ish shape before it is bound, so a malformed
 * value fails fast rather than silently widening RLS scope.
 */
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
