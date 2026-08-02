import type { PgConnection } from "@crossengin/kernel-pg";

import { withTenantContext } from "./tenant-context.js";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

/** A subscription snapshot to persist to `billing_subscriptions`. */
export interface SubscriptionUpsertRow {
  readonly tenantId: string;
  readonly planId: string | null;
  readonly status: string;
  /** ISO 8601 or null. */
  readonly currentPeriodEnd: string | null;
  readonly trialEnd: string | null;
  readonly maxRecordsPerEntity: number | null;
  readonly features: readonly string[] | null;
}

export interface PostgresSubscriptionStoreOptions {
  /** Schema holding `billing_subscriptions` (default `meta`). */
  readonly schema?: string;
}

/**
 * Writes subscription snapshots to `meta.billing_subscriptions`. Each `insert` appends a
 * new row (the table's `id` is an auto-generated UUID); `PostgresEntitlementResolver` reads
 * the most-recently-updated row per tenant, so the newest snapshot wins. Append-only keeps
 * a subscription-state audit trail; compaction is a follow-up. Runs under RLS via
 * `withTenantContext`, so a row can only be written for the context tenant.
 */
export class PostgresSubscriptionStore {
  private readonly schema: string;

  constructor(
    private readonly conn: PgConnection,
    opts: PostgresSubscriptionStoreOptions = {},
  ) {
    this.schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(this.schema)) {
      throw new Error(`invalid schema identifier: ${JSON.stringify(this.schema)}`);
    }
  }

  async insert(row: SubscriptionUpsertRow): Promise<void> {
    await withTenantContext(this.conn, row.tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO ${this.schema}.billing_subscriptions
           (tenant_id, plan_id, status, current_period_end, trial_end, max_records_per_entity, features, created_at, updated_at)
         VALUES ($1::uuid, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7::jsonb, now(), now())`,
        [
          row.tenantId,
          row.planId,
          row.status,
          row.currentPeriodEnd,
          row.trialEnd,
          row.maxRecordsPerEntity,
          row.features === null ? null : JSON.stringify(row.features),
        ],
      );
    });
  }
}
