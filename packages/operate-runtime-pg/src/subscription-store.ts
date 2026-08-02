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
  /** The Stripe subscription id; when present the row upserts in place (else it appends). */
  readonly stripeSubscriptionId: string | null;
  /** The Stripe customer id — read back to open a Billing Portal session for the tenant. */
  readonly stripeCustomerId: string | null;
}

export interface PostgresSubscriptionStoreOptions {
  /** Schema holding `billing_subscriptions` (default `meta`). */
  readonly schema?: string;
}

/**
 * Writes subscription snapshots to `meta.billing_subscriptions` under RLS (via
 * `withTenantContext`, so a row can only be written for the context tenant). When a row
 * carries a `stripeSubscriptionId`, `insert` **upserts in place** on
 * `(tenant_id, stripe_subscription_id)` — repeated events for the same Stripe subscription
 * update the one row rather than piling up snapshots. A row with a `null`
 * `stripeSubscriptionId` (offline license / manual) appends, since NULLs are distinct in the
 * unique index — preserving an audit trail for the non-Stripe path.
 * `PostgresEntitlementResolver` still reads the most-recently-updated row per tenant.
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
           (tenant_id, plan_id, status, current_period_end, trial_end, max_records_per_entity, features, stripe_subscription_id, stripe_customer_id, created_at, updated_at)
         VALUES ($1::uuid, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7::jsonb, $8, $9, now(), now())
         ON CONFLICT (tenant_id, stripe_subscription_id) DO UPDATE SET
           plan_id = EXCLUDED.plan_id,
           status = EXCLUDED.status,
           current_period_end = EXCLUDED.current_period_end,
           trial_end = EXCLUDED.trial_end,
           max_records_per_entity = EXCLUDED.max_records_per_entity,
           features = EXCLUDED.features,
           stripe_customer_id = EXCLUDED.stripe_customer_id,
           updated_at = now()`,
        [
          row.tenantId,
          row.planId,
          row.status,
          row.currentPeriodEnd,
          row.trialEnd,
          row.maxRecordsPerEntity,
          row.features === null ? null : JSON.stringify(row.features),
          row.stripeSubscriptionId,
          row.stripeCustomerId,
        ],
      );
    });
  }

  /**
   * The tenant's most-recent non-null Stripe customer id, for opening a Billing Portal
   * session. Runs under `withTenantContext` (RLS), so it only ever reads the caller tenant's
   * rows. Returns `null` when the tenant has no Stripe-linked subscription.
   */
  async resolveCustomerId(tenantId: string): Promise<string | null> {
    return withTenantContext(this.conn, tenantId, async (tx) => {
      const res = await tx.query<{ stripe_customer_id: unknown }>(
        `SELECT stripe_customer_id
           FROM ${this.schema}.billing_subscriptions
          WHERE tenant_id = $1::uuid AND stripe_customer_id IS NOT NULL
          ORDER BY updated_at DESC
          LIMIT 1`,
        [tenantId],
      );
      const raw = res.rows[0]?.stripe_customer_id;
      return typeof raw === "string" && raw.length > 0 ? raw : null;
    });
  }
}
