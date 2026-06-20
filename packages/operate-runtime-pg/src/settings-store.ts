import type { PgConnection } from "@crossengin/kernel-pg";
import {
  EMPTY_TENANT_SETTINGS,
  TenantSettingsSchema,
  type SettingsStore,
  type TenantSettings,
} from "@crossengin/operate-runtime";

import { withTenantContext } from "./tenant-context.js";

/**
 * Persists per-tenant operational settings as a singleton JSONB document in
 * `meta.operate_tenant_settings`, one row per tenant, confined by RLS. Reads
 * validate the stored document so a hand-edited row can't widen the contract.
 */
export class PostgresSettingsStore implements SettingsStore {
  constructor(
    private readonly conn: PgConnection,
    private readonly schema = "meta",
  ) {
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
    }
  }

  async get(tenantId: string): Promise<TenantSettings> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const res = await tx.query<{ settings: unknown }>(
        `SELECT settings FROM ${this.schema}.operate_tenant_settings WHERE tenant_id = $1::uuid`,
        [tenantId],
      );
      const raw = res.rows[0]?.settings;
      if (raw === undefined || raw === null) return EMPTY_TENANT_SETTINGS;
      const doc = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
      const parsed = TenantSettingsSchema.safeParse(doc);
      return parsed.success ? parsed.data : EMPTY_TENANT_SETTINGS;
    });
  }

  async put(
    tenantId: string,
    settings: TenantSettings,
    updatedBy: string | null = null,
  ): Promise<TenantSettings> {
    const parsed = TenantSettingsSchema.parse(settings);
    return withTenantContext(this.conn, tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO ${this.schema}.operate_tenant_settings
           (tenant_id, settings, updated_at, updated_by)
         VALUES ($1::uuid, $2::jsonb, now(), $3)
         ON CONFLICT (tenant_id)
         DO UPDATE SET settings = EXCLUDED.settings, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [tenantId, JSON.stringify(parsed), updatedBy],
      );
      return parsed;
    });
  }
}
