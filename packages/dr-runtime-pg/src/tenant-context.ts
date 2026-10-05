import {
  scopeFilter as kernelScopeFilter,
  type ScopeFilter,
} from "@crossengin/kernel-pg";

export { type ScopeFilter };

/**
 * **Stricter than `kernel-pg`'s shared shape guard, deliberately, and this is the one package where
 * that is true.** The shared `assertScopeTenantId` admits hex digits and dashes up to 64 characters,
 * which is what seven of the eight copies spelled; a DR read scope is always a tenant row's `id`, so
 * this demands the full UUID. It is applied *before* delegating, so a value the shared guard would
 * have let through is refused here with this package's own message, and behaviour is unchanged by
 * the move.
 */
const TENANT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertTenantId(tenantId: string): void {
  if (!TENANT_ID_RE.test(tenantId)) {
    throw new Error(`invalid tenantId for a DR read scope: ${JSON.stringify(tenantId)}`);
  }
}

/**
 * The `tenant_id` predicate every DR read carries, **beside** RLS rather than instead of it.
 *
 * The predicate itself, the rule that chooses the strict spelling over the inclusive one, and the
 * two measurements behind the branch now live in `kernel-pg` beside `setPlatformWriteSql`; this is
 * the strict guard above plus that function. What stays here is the reason **this** package reads
 * the strict form, which is a fact about these three tables and not about the function:
 *
 * All three are `tenant_id`-nullable with a `SELECT`-scoped platform read arm, and **a table's owner
 * bypasses its policies** (ADR-0331) — so a read that carries no predicate answers from whichever
 * scope happens to hold the newest row. These three reads took no scope argument *at all*, so there
 * was nothing to carry: `listRecent`, `countSince` and `latest` were global. What that cost is not a
 * long result set. `dr-readiness.ts` feeds `listRecent` straight into `assessDrReadiness`, which
 * scores **drill recency** and **failover breaches** — so a deployment connected as the owner scored
 * its DR readiness off other tenants' drills, and `PostgresDrReadinessStore.latest()` returned
 * whichever tenant's snapshot was newest as the platform's own. Observed live, with `countSince`
 * answering 3 where the platform's own count is 1.
 *
 * **Strict rather than inclusive**, unlike `crypto-pg`'s point lookups: each scope's rows are a
 * *closed set*. A platform public key is meant to be read by a tenant (that is what a public key
 * is for); a platform *failover drill* is not evidence about a tenant's disaster recovery, and
 * mixing them is precisely the defect.
 */
export function scopeFilter(tenantId: string | null, firstParam = 1): ScopeFilter {
  if (tenantId !== null) assertTenantId(tenantId);
  return kernelScopeFilter(tenantId, firstParam);
}

/**
 * The scope a DR read is taken in. Spelled as a required argument with no default, deliberately:
 * the defect this closes is a read that *could not* name a scope, and a default would let a caller
 * go on not naming one — which is how `listRecent()` came to mean "every tenant's".
 */
export type DrReadScope = string | null;
