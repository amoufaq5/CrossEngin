// The caller tenant's own subscription/plan state, as returned by
// GET /v1/meta/entitlement (registered ungated, so a lapsed tenant can still read it).

export interface TenantEntitlement {
  readonly status: string | null;
  readonly planId: string | null;
  readonly maxRecordsPerEntity: number | null;
  readonly features: readonly string[];
}

// The caller tenant's per-entity record usage, as returned by GET /v1/meta/usage
// (registered ungated alongside the entitlement route). Counts are bounded — `overflow`
// marks an entity whose true count exceeds the probe ceiling.
export interface EntityUsage {
  readonly entity: string;
  readonly used: number;
  readonly overflow: boolean;
  readonly atLimit: boolean;
}

export interface TenantUsage {
  readonly maxRecordsPerEntity: number | null;
  readonly entities: readonly EntityUsage[];
}
