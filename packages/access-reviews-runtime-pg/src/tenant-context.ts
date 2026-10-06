import type { PgConnection } from "@crossengin/kernel-pg";

export const SET_TENANT_CONTEXT_SQL =
  "SELECT set_config('app.current_tenant_id', $1, true)";

/**
 * The `tenant_id` predicate every read in this package carries, **beside** RLS rather than instead
 * of it.
 *
 * `withTenantContext` sets `app.current_tenant_id` and the three tables' isolation policies do the
 * rest — as long as the connection is not the tables' owner, who bypasses them (ADR-0331). Until
 * this helper existed none of the four reads here carried a predicate, so the `tenantId` argument
 * they all take was **decorative as the owner**: `campaign_id` is table-wide unique, so
 * `getByCampaignId(tenantA, 'arc_…')` happily returned tenant B's campaign, `listByCampaign` its
 * items and decisions, and `listByTenant(tenantA)` every tenant's campaigns. The whole
 * `AccessReviewReplayer` then reported one tenant's drift under another's name.
 *
 * **Strict `tenant_id = $n`, and there is no inclusive spelling to choose from here.** All three
 * tables declare `tenant_id UUID NOT NULL` with the isolation policy as their *only* arm — no
 * `SELECT` platform read, no platform write — so a platform-scope row cannot exist and
 * `tenant_id IS NULL` would be a predicate no row can satisfy. That is why the scope type in this
 * package is `string` and not `string | null`, unlike `dr-runtime-pg`'s `DrReadScope`.
 *
 * `alias` is required because two of the reads join the campaign to its children, and a join is
 * where the predicate has to be stated twice: RLS applies each table's own policy to each table in
 * the join, so a non-owner is shown a row only when **both** sides sit in their tenant. Pinning one
 * side would be narrower than RLS in neither direction and wider in one — it would admit a child
 * whose parent belongs to another tenant, which is a corruption no finding in this package can see.
 */
export function tenantScopePredicate(alias: string, param: number): string {
  return `${alias}.tenant_id = $${String(param)}`;
}

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
