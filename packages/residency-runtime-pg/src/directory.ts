import type { PgConnection } from "@crossengin/kernel-pg";
import { ResidencyProfileSchema, type ResidencyProfile } from "@crossengin/residency";
import type { TenantResidencyDirectory } from "@crossengin/residency-runtime";

import { withTenantContext } from "./tenant-context.js";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

export interface PostgresTenantResidencyDirectoryOptions {
  /** Schema holding `tenant_residency_profiles` (default `meta`). */
  readonly schema?: string;
}

/** The `meta.tenant_residency_profiles` row shape as read back from the driver. */
interface ProfileRow {
  readonly profile: unknown;
}

/**
 * A Postgres-backed `TenantResidencyDirectory` over `meta.tenant_residency_profiles`
 * — the durable tenant→profile map the region guard routes against, so residency
 * isn't a static file. Each read/write runs under the tenant RLS context; a row
 * that comes back is re-validated through `ResidencyProfileSchema`, so drift/corruption
 * surfaces as an error rather than a bad routing decision.
 */
export class PostgresTenantResidencyDirectory implements TenantResidencyDirectory {
  private readonly conn: PgConnection;
  private readonly table: string;

  constructor(conn: PgConnection, opts: PostgresTenantResidencyDirectoryOptions = {}) {
    this.conn = conn;
    const schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) {
      throw new Error(`invalid schema name: ${JSON.stringify(schema)}`);
    }
    this.table = `${schema}.tenant_residency_profiles`;
  }

  /** The tenant's residency profile, or null if none is registered. */
  async resolve(tenantId: string): Promise<ResidencyProfile | null> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const res = await tx.query<ProfileRow>(
        `SELECT profile FROM ${this.table} WHERE tenant_id = $1`,
        [tenantId],
      );
      const row = res.rows[0];
      return row === undefined ? null : ResidencyProfileSchema.parse(row.profile);
    });
  }

  /** Registers or replaces a tenant's residency profile (profile stored as JSONB). */
  async upsert(tenantId: string, profile: ResidencyProfile, updatedBy: string | null = null): Promise<void> {
    const validated = ResidencyProfileSchema.parse(profile);
    await withTenantContext(this.conn, tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO ${this.table} (tenant_id, profile, updated_by) VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (tenant_id) DO UPDATE SET profile = EXCLUDED.profile, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [tenantId, JSON.stringify(validated), updatedBy],
      );
    });
  }
}
