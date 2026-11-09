import type { UsageRecord } from "@crossengin/billing";
import type { UnreadableRowReporter } from "@crossengin/kernel-pg";

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
  /**
   * What a usage row the contract refuses is worth, decided by the deployment.
   *
   * **Required, and deliberately not optional like `now` and `limit` beside it.** A reporter
   * defaulting to "drop it silently" is the defect restated as a default (ADR-0364's addendum), and
   * the two optional siblings in the scheduler one layer up — `onSync` and `onError` — are
   * precisely the wrong shape to copy here: a missed sync notification costs a log line, where a
   * dropped refusal costs the only record that a tenant's usage is not being billed.
   */
  readonly onUnreadable: UnreadableRowReporter;
  readonly now?: () => Date;
  readonly limit?: number;
}

export interface UsageStripeSyncResult {
  readonly synced: number;
  /** Records with no Stripe subscription-item mapping — left unsynced for a later run. */
  readonly skipped: number;
  /**
   * Records the contract refused, so neither reported nor skipped.
   *
   * A **third** outcome rather than a value folded into `skipped`, which is documented as a
   * different thing entirely. Before the page went through the primitive a refused row threw and
   * took the batch with it, which was loud; the reporter keeps the other records moving, and
   * without this field the result would read `{synced: 4, skipped: 0}` for a page of five — a
   * silent undercount of what reached Stripe, which is the loud failure traded for a quiet one.
   */
  readonly unreadable: number;
}

/**
 * Reports a tenant's un-synced `UsageRecord`s to Stripe and marks each synced.
 * The record's period idempotency key rides as Stripe's `Idempotency-Key`, so a
 * retried sync never double-reports; an unresolvable record is skipped (left
 * un-synced) rather than failing the batch.
 *
 * A record the contract **refuses** is a third outcome and is counted as one: it is reported
 * through `onUnreadable` and left un-synced, where before it threw and took the rest of the
 * tenant's backlog with it.
 */
export class UsageStripeSync {
  private readonly store: PostgresUsageRecordStore;
  private readonly reporter: UsageReporter;
  private readonly resolver: SubscriptionItemResolver;
  private readonly onUnreadable: UnreadableRowReporter;
  private readonly now: () => Date;
  private readonly limit: number;

  constructor(options: UsageStripeSyncOptions) {
    this.store = options.store;
    this.reporter = options.reporter;
    this.resolver = options.resolver;
    this.onUnreadable = options.onUnreadable;
    this.now = options.now ?? (() => new Date());
    this.limit = options.limit ?? 500;
  }

  async syncTenant(tenantId: string): Promise<UsageStripeSyncResult> {
    // Counted here rather than inside the store's reporter so the figure is this batch's: the
    // deployment's handler is still called for every refused row, and a sync that reports three
    // and a sync that reports one are different facts about one tenant's billing.
    let unreadable = 0;
    const unsynced = await this.store.listUnsynced(
      tenantId,
      (row) => {
        unreadable += 1;
        this.onUnreadable(row);
      },
      this.limit,
    );
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
    return { synced, skipped, unreadable };
  }
}
