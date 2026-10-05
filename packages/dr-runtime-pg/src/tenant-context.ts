const TENANT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A `tenant_id` predicate and the parameters it binds, to splice into a read's `WHERE`. */
export interface ScopeFilter {
  readonly sql: string;
  readonly params: readonly unknown[];
}

export function assertTenantId(tenantId: string): void {
  if (!TENANT_ID_RE.test(tenantId)) {
    throw new Error(`invalid tenantId for a DR read scope: ${JSON.stringify(tenantId)}`);
  }
}

/**
 * The `tenant_id` predicate every DR read carries, **beside** RLS rather than instead of it.
 *
 * All three DR tables are `tenant_id`-nullable with a `SELECT`-scoped platform read arm, and **a
 * table's owner bypasses its policies** (ADR-0331) — so a read that carries no predicate answers
 * from whichever scope happens to hold the newest row. These three reads took no scope argument at
 * all, so there was nothing to carry: `listRecent`, `countSince` and `latest` were global.
 *
 * What that cost is not a long result set. `dr-readiness.ts` feeds both `listRecent` results
 * straight into `assessDrReadiness`, which scores **drill recency** and **failover breaches** — so
 * a deployment connected as the owner scored its DR readiness off other tenants' drills, and
 * `PostgresDrReadinessStore.latest()` returned whichever tenant's snapshot was newest as the
 * platform's own readiness. Observed live: a tenant's snapshot answering for the platform, and
 * `countSince` answering 3 where the platform's own count is 1. A DR readiness report is what an
 * auditor reads, which is the same reason the stale-row half of this defect mattered.
 *
 * **Strict rather than inclusive**, unlike `crypto-pg`'s `scopeFilterWithPlatform`. Lane E's rule
 * is that the predicate reproduces what a non-owner would have been shown, no wider and no
 * narrower — and here each scope's rows are a *closed set*. A platform public key is meant to be
 * read by a tenant (that is what a public key is for); a platform *failover drill* is not evidence
 * about a tenant's disaster recovery, and mixing them is precisely the defect. So the platform's
 * readiness is scored from the platform's own history and a tenant's from its own.
 *
 * The predicate **branches** rather than using `tenant_id IS NOT DISTINCT FROM $1`, the one
 * operator matching NULL to NULL. ADR-0331 measured that as not indexable; Lane E measured the
 * sharper form of the same fact, which is the one worth knowing: with a **literal** NULL it *is*
 * index-scanned, because Postgres constant-folds it — but with a **bound parameter**, which is how
 * a store issues it, it is a sequential scan. 10.67 ms against 0.73 ms on 45,003 rows. So the
 * penalty is invisible in a psql session and real in production.
 *
 * Verbatim from `forensics-pg`'s `scopeFilter`; it belongs in `kernel-pg` beside
 * `setPlatformWriteSql`, and lives here only because five other packages already hold a copy for
 * the same reason.
 */
export function scopeFilter(tenantId: string | null, firstParam = 1): ScopeFilter {
  // `tenant_id = NULL` is never true, so the platform scope has to be asked for as `IS NULL`.
  if (tenantId === null) return { sql: "tenant_id IS NULL", params: [] };
  assertTenantId(tenantId);
  return { sql: `tenant_id = $${String(firstParam)}`, params: [tenantId] };
}

/**
 * The scope a DR read is taken in. Spelled as a required argument with no default, deliberately:
 * the defect this closes is a read that *could not* name a scope, and a default would let a caller
 * go on not naming one — which is how `listRecent()` came to mean "every tenant's".
 */
export type DrReadScope = string | null;
