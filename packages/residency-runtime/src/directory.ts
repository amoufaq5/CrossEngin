import type { ResidencyProfile } from "@crossengin/residency";

/**
 * Resolves a tenant's residency profile — the home/allowed/forbidden regions the
 * serving edge routes against. Structural, and possibly async (a Postgres-backed
 * directory is a follow-up), so the router awaits the result either way.
 */
export interface TenantResidencyDirectory {
  resolve(tenantId: string): ResidencyProfile | null | Promise<ResidencyProfile | null>;
}

/** An in-memory `TenantResidencyDirectory` seeded from a tenantId → profile map. */
export class InMemoryTenantResidencyDirectory implements TenantResidencyDirectory {
  private readonly byTenant = new Map<string, ResidencyProfile>();

  constructor(entries: Iterable<readonly [string, ResidencyProfile]> = []) {
    for (const [tenantId, profile] of entries) this.byTenant.set(tenantId, profile);
  }

  /** Registers (or replaces) a tenant's profile; returns `this` for chaining. */
  set(tenantId: string, profile: ResidencyProfile): this {
    this.byTenant.set(tenantId, profile);
    return this;
  }

  resolve(tenantId: string): ResidencyProfile | null {
    return this.byTenant.get(tenantId) ?? null;
  }
}
