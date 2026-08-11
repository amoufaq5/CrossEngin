import {
  isUsageAnomalous,
  type Invoice,
  type Plan,
  type Subscription,
  type UsagePeriod,
  type UsageRecord,
} from "@crossengin/billing";

import { RandomUuidGenerator, SystemClock, type Clock, type UuidGenerator } from "./clock.js";
import { type MeteredUsageEvent } from "./ingest.js";
import { usageRecordFrom } from "./ingest.js";
import { UsageMeter, type MeterBucket, type RecordResult } from "./meter.js";
import { draftInvoice, hasBillableUsage, type MeterUsage } from "./invoicing.js";

export interface BillingMeteringEngineOptions {
  readonly clock?: Clock;
  readonly ids?: UuidGenerator;
  readonly meter?: UsageMeter;
  /** Per-meter rolling averages for anomaly detection (optional). */
  readonly rollingAverages?: ReadonlyMap<string, number>;
  readonly onAnomaly?: (event: MeteredUsageEvent, bucketQuantity: number) => void;
}

export interface ClosePeriodInput {
  readonly subscription: Subscription;
  readonly plan: Plan;
  readonly period: UsagePeriod;
  readonly number: string;
  readonly source?: MeteredUsageEvent["source"];
  /** Clear the subscription's accumulated buckets after drafting (default true). */
  readonly clearAfter?: boolean;
  readonly dueInDays?: number;
}

export interface ClosePeriodResult {
  readonly invoice: Invoice | null;
  readonly usageRecords: readonly UsageRecord[];
  readonly buckets: readonly MeterBucket[];
}

const DAY_MS = 86_400_000;

/**
 * The metering keystone: ingests platform usage events idempotently, and on
 * period close rolls each subscription's accumulated meters into a set of
 * `UsageRecord`s + a `draft` `Invoice` rated against the plan. Pure in-process
 * (no I/O), mirroring the other `*-runtime` engines; a `-pg` sibling persists.
 */
export class BillingMeteringEngine {
  private readonly clock: Clock;
  private readonly ids: UuidGenerator;
  private readonly meter: UsageMeter;
  private readonly rollingAverages: ReadonlyMap<string, number>;
  private readonly onAnomaly?: (event: MeteredUsageEvent, bucketQuantity: number) => void;

  constructor(options: BillingMeteringEngineOptions = {}) {
    this.clock = options.clock ?? new SystemClock();
    this.ids = options.ids ?? new RandomUuidGenerator();
    this.meter = options.meter ?? new UsageMeter();
    this.rollingAverages = options.rollingAverages ?? new Map();
    this.onAnomaly = options.onAnomaly;
  }

  recordUsage(event: MeteredUsageEvent): RecordResult {
    const result = this.meter.record(event);
    if (result.accepted && this.onAnomaly !== undefined) {
      const bucketQuantity = this.meter.quantityFor(event.subscriptionId, event.meter);
      const rollingAverage = this.rollingAverages.get(event.meter) ?? 0;
      if (isUsageAnomalous({ meter: event.meter, currentQuantity: bucketQuantity, rollingAverage })) {
        this.onAnomaly(event, bucketQuantity);
      }
    }
    return result;
  }

  usage(subscriptionId: string): readonly MeterBucket[] {
    return this.meter.bucketsFor(subscriptionId);
  }

  closePeriod(input: ClosePeriodInput): ClosePeriodResult {
    const buckets = this.meter.bucketsFor(input.subscription.id);
    const source = input.source ?? "manual";
    const recordedAt = this.clock.nowIso();
    const usageRecords: UsageRecord[] = buckets.map((bucket) =>
      usageRecordFrom({
        tenantId: bucket.tenantId,
        subscriptionId: bucket.subscriptionId,
        meter: bucket.meter,
        quantity: bucket.quantity,
        source,
        period: input.period,
        id: this.ids.next(),
        recordedAt,
      }),
    );
    const usage: MeterUsage[] = buckets.map((b) => ({ meter: b.meter, usedUnits: b.quantity }));

    let invoice: Invoice | null = null;
    if (hasBillableUsage(input.plan, usage)) {
      const issuedAt = this.clock.nowIso();
      const dueAt = new Date(this.clock.now().getTime() + (input.dueInDays ?? 30) * DAY_MS).toISOString();
      invoice = draftInvoice({
        tenantId: input.subscription.tenantId,
        subscriptionId: input.subscription.id,
        plan: input.plan,
        usage,
        period: input.period,
        number: input.number,
        issuedAt,
        dueAt,
        ids: this.ids,
      });
    }

    if (input.clearAfter !== false) {
      this.meter.clearSubscription(input.subscription.id);
    }
    return { invoice, usageRecords, buckets };
  }
}
