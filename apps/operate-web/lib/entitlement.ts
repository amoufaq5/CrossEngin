// The caller tenant's own subscription/plan state, as returned by
// GET /v1/meta/entitlement (registered ungated, so a lapsed tenant can still read it).

export interface TenantEntitlement {
  readonly status: string | null;
  readonly planId: string | null;
  readonly maxRecordsPerEntity: number | null;
  readonly features: readonly string[];
}
