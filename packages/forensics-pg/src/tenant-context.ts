import { assertScopeTenantId, type PgConnection } from "@crossengin/kernel-pg";

/**
 * `scopeFilter` was born here and now lives in `kernel-pg` beside `setPlatformWriteSql` and
 * `isoInstant`, because eight packages held a verbatim copy and `kernel-pg` is the only dependency
 * all eight share. The rule choosing between the strict and the inclusive spelling, and the two
 * measurements behind the branch, are written down there once. This package reads the strict form:
 * a hash chain is the archetypal closed set — a scope's entries are its own, and the defect was
 * precisely a platform read being handed a tenant's tail.
 */
export {
  scopeFilter,
  scopeFilterWithPlatform,
  type ScopeFilter,
} from "@crossengin/kernel-pg";

export const SET_TENANT_CONTEXT_SQL =
  "SELECT set_config('app.current_tenant_id', $1, true)";

/**
 * The elevation a **platform-scope** write needs: the `INSERT`-scoped policies on
 * `meta.forensic_chain_entries` and `meta.forensic_chain_checkpoints` check it.
 *
 * It is `app.platform_audit_write` — the same GUC `PostgresAuditEmitter` sets for a platform-scope
 * `meta.audit_log` row — and sharing it is not a convenience but a requirement. An anchored
 * platform audit row is **one transaction**: the emitter sets its elevation, then calls
 * `appendWithin` on the same `tx`. A second GUC for the chain would make that transaction
 * impossible without the emitter learning to set both, i.e. it would make the two privileges one in
 * practice while costing two things to configure. There is also no population that should be able to
 * write the platform's audit row but not the entry that anchors it.
 *
 * It is deliberately NOT `app.platform_audit`, which is ADR-0313's cross-tenant **read** grant: a
 * read grant that also authorised a write would let a reader of the trail forge the chain it reads.
 *
 * Transaction-local (`set_config(..., true)`), never a session-wide `SET`, so a pooled connection
 * cannot carry the elevation past the statement that needed it.
 */
export const SET_PLATFORM_AUDIT_WRITE_SQL =
  "SELECT set_config('app.platform_audit_write', 'on', true)";

export function assertTenantId(tenantId: string): void {
  assertScopeTenantId(tenantId);
}

export async function withTenantContext<T>(
  conn: PgConnection,
  tenantId: string,
  fn: (tx: PgConnection) => Promise<T>,
): Promise<T> {
  assertTenantId(tenantId);
  return conn.transaction(async (tx) => {
    await tx.query(SET_TENANT_CONTEXT_SQL, [tenantId]);
    return fn(tx);
  });
}
