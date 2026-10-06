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

/**
 * The statement each *extra* transaction-local setting is applied with. **Both**
 * the setting name and its value ride as bound parameters, which is load-bearing
 * rather than stylistic: the one caller of this seam carries the pgcrypto column
 * key, and a value interpolated into SQL text lands in `log_statement = 'all'`
 * output, in `pg_stat_statements`, and in any plan or error that echoes the
 * statement. Bound, the SQL text is this constant for every key in every
 * deployment and the key itself never appears in it.
 *
 * The shape is `KeyRotationMigratorOptions.sessionSettings`' own
 * (`packages/kernel-pg/src/encryption-writepath.ts`), deliberately copied rather
 * than re-invented — that module already sets a column key this way inside a
 * caller's transaction, and two spellings of one idiom is how the two drift.
 */
export const SET_EXTRA_SETTING_SQL = "SELECT set_config($1, $2, true)";

const TENANT_ID_RE = /^[0-9a-fA-F-]{1,64}$/;

/**
 * Runs `fn` inside a transaction with the tenant RLS context established. The
 * tenant id is validated to a UUID-ish shape before it is bound, so a malformed
 * value fails fast rather than silently widening RLS scope.
 *
 * `settings` carries any **additional** transaction-local settings the body
 * needs — today `app.column_encryption_key`, which `ColumnMappedEntityStore`
 * resolves per tenant. They are applied after the tenant context and before
 * `fn`, each as one `SET_EXTRA_SETTING_SQL` round trip, and like the tenant id
 * they are `is_local = true`: the setting is discarded with the transaction, so a
 * pooled connection never carries one tenant's key into another tenant's
 * statement.
 *
 * Omitting `settings` (or passing an empty map) issues exactly the statement
 * sequence this function has always issued — one `set_config` and then `fn` — so
 * a deployment with no encrypted column pays nothing for the seam.
 */
export async function withTenantContext<T>(
  conn: PgConnection,
  tenantId: string,
  fn: (tx: PgConnection) => Promise<T>,
  settings?: ReadonlyMap<string, string>,
): Promise<T> {
  if (!TENANT_ID_RE.test(tenantId)) {
    throw new Error(`invalid tenantId for RLS context: ${JSON.stringify(tenantId)}`);
  }
  return conn.transaction(async (tx) => {
    await tx.query(SET_TENANT_CONTEXT_SQL, [tenantId]);
    if (settings !== undefined) {
      for (const [name, value] of settings) {
        await tx.query(SET_EXTRA_SETTING_SQL, [name, value]);
      }
    }
    return fn(tx);
  });
}
