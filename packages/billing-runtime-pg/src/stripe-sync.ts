import type { UsageRecord } from "@crossengin/billing";

import type { PostgresUsageRecordStore } from "./usage-store.js";

export interface UsageReportInput {
  readonly subscriptionItemId: string;
  readonly quantity: number;
  readonly timestamp?: number;
  readonly idempotencyKey?: string;
}

/** The Stripe usage-reporting surface the sync needs — `StripeClient` satisfies it structurally. */
export interface UsageReporter {
  createUsageRecord(input: UsageReportInput): Promise<{ readonly id: string }>;
}

/** Resolves a usage record to the Stripe subscription item to report it against (null ⇒ skip). */
export type SubscriptionItemResolver = (record: UsageRecord) => string | null;

/**
 * A static resolver keyed by `"<subscriptionId>|<meter>"` → Stripe subscription
 * item id — the deployment supplies the map from its plan's metered prices to the
 * tenant's Stripe subscription items.
 */
export function staticSubscriptionItemResolver(
  map: Readonly<Record<string, string>>,
): SubscriptionItemResolver {
  return (record) => map[`${record.subscriptionId}|${record.meter}`] ?? null;
}

export interface UsageStripeSyncOptions {
  readonly store: PostgresUsageRecordStore;
  readonly reporter: UsageReporter;
  readonly resolver: SubscriptionItemResolver;
  readonly now?: () => Date;
  readonly limit?: number;
}

export interface UsageStripeSyncResult {
  readonly synced: number;
  /** Records with no Stripe subscription-item mapping — left unsynced for a later run. */
  readonly skipped: number;
}

/**
 * Reports a tenant's un-synced `UsageRecord`s to Stripe and marks each synced.
 * The record's period idempotency key rides as Stripe's `Idempotency-Key`, so a
 * retried sync never double-reports; an unresolvable record is skipped (left
 * un-synced) rather than failing the batch.
 */
export class UsageStripeSync {
  private readonly store: PostgresUsageRecordStore;
  private readonly reporter: UsageReporter;
  private readonly resolver: SubscriptionItemResolver;
  private readonly now: () => Date;
  private readonly limit: number;

  constructor(options: UsageStripeSyncOptions) {
    this.store = options.store;
    this.reporter = options.reporter;
    this.resolver = options.resolver;
    this.now = options.now ?? (() => new Date());
    this.limit = options.limit ?? 500;
  }

  async syncTenant(tenantId: string): Promise<UsageStripeSyncResult> {
    const unsynced = await this.store.listUnsynced(tenantId, this.limit);
    let synced = 0;
    let skipped = 0;
    for (const record of unsynced) {
      const subscriptionItemId = this.resolver(record);
      if (subscriptionItemId === null) {
        skipped += 1;
        continue;
      }
      const stripe = await this.reporter.createUsageRecord({
        subscriptionItemId,
        quantity: Math.round(record.quantity),
        timestamp: Math.floor(Date.parse(record.period.end) / 1000),
        idempotencyKey: record.idempotencyKey,
      });
      await this.store.markSynced(tenantId, record.id, stripe.id, this.now().toISOString());
      synced += 1;
    }
    return { synced, skipped };
  }
}
