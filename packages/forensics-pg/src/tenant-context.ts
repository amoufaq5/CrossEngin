import type { PgConnection } from "@crossengin/kernel-pg";

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

const TENANT_ID_RE = /^[0-9a-fA-F-]{1,64}$/;

export function assertTenantId(tenantId: string): void {
  if (!TENANT_ID_RE.test(tenantId)) {
    throw new Error(`invalid tenantId for RLS context: ${JSON.stringify(tenantId)}`);
  }
}

/** A `tenant_id` predicate and the parameters it binds, for one scope. */
export interface ScopeFilter {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * The `tenant_id` predicate a scoped read must carry, beside RLS rather than instead of it.
 *
 * RLS alone is not enough, and the reason is ordinary rather than exotic: **a table's owner
 * bypasses its policies**, and a deployment that connects as the owner is a normal deployment. With
 * no predicate, a platform-scope read returned every tenant's chain entries interleaved with the
 * platform's, so `verifyChainIntegrity` reported a sequence gap on perfectly healthy data and the
 * tail a scope chained its next entry onto belonged to another scope.
 *
 * The predicate **branches** rather than using `tenant_id IS NOT DISTINCT FROM $1`, which is the one
 * operator that matches NULL to NULL and would let both scopes share a single string. Measured
 * against 45k entries: `IS NOT DISTINCT FROM` is not an indexable operator — with `enable_seqscan`
 * off Postgres still has no index path for it and takes the sequential scan anyway (16 ms, and 355 ms
 * under the disable penalty), while `tenant_id = $1` is an index scan on
 * `idx_forensic_chain_entries_tenant_seq` at 0.09 ms. On a table that only grows, and for a read that
 * runs on **every append** to find the tail, that is not a cost worth the single code path.
 * `tenant_id IS NULL` is indexable, so the platform arm keeps an index too.
 *
 * `firstParam` is the 1-based position the predicate's own parameter takes, so a caller that already
 * binds values can place this anywhere in its list.
 */
export function scopeFilter(tenantId: string | null, firstParam = 1): ScopeFilter {
  // `tenant_id = NULL` is never true, so the platform scope cannot ride along as a bound parameter
  // and has to be asked for as `IS NULL`. Same split as `PostgresAuditEmitter.whereFor`.
  if (tenantId === null) return { sql: "tenant_id IS NULL", params: [] };
  assertTenantId(tenantId);
  return { sql: `tenant_id = $${String(firstParam)}`, params: [tenantId] };
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
