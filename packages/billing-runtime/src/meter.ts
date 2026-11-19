import type { MeterId } from "@crossengin/billing";

import { bucketKey, type MeteredUsageEvent } from "./ingest.js";

export interface MeterBucket {
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly meter: MeterId;
  readonly quantity: number;
  readonly eventCount: number;
}

export interface RecordResult {
  /** True when the event was counted; false when it was a duplicate (same idempotencyKey). */
  readonly accepted: boolean;
  readonly duplicate: boolean;
}

/**
 * How long an event's idempotency key is remembered, and how many keys at most.
 *
 * The set was unbounded: every request id the gateway ever metered stayed in it for the life of
 * the process, so the meter grew by one key per billable request for ever. A duplicate is a
 * *retried* emit of one event, which arrives seconds after the original rather than days, so a key
 * only needs to outlive the window a retry can land in. Pruning is by the event's own
 * `occurredAt` against the newest one seen (the meter holds no clock), and the cap evicts the
 * oldest key first — an eviction inside the retention window is counted, because it is the one
 * case where a late retry could now be double-counted.
 */
export interface UsageMeterOptions {
  readonly dedupRetentionMs?: number;
  readonly maxDedupKeys?: number;
}

export const DEFAULT_DEDUP_RETENTION_MS = 60 * 60 * 1000;
export const DEFAULT_MAX_DEDUP_KEYS = 100_000;

export interface DedupStats {
  readonly remembered: number;
  /** Keys dropped by the cap while still inside the retention window. */
  readonly evictedWithinRetention: number;
}

/**
 * An in-memory, idempotent usage accumulator: events are summed into per-(tenant,
 * subscription, meter) buckets, and a repeated `idempotencyKey` is ignored for as long as the key
 * is remembered, so a retried emit never double-counts. Pure state — no I/O; a `-pg` sibling
 * persists.
 */
export class UsageMeter {
  private readonly buckets = new Map<string, { tenantId: string; subscriptionId: string; meter: MeterId; quantity: number; eventCount: number }>();
  private readonly seen = new Map<string, number>();
  private readonly retentionMs: number;
  private readonly maxKeys: number;
  private newestMs = Number.NEGATIVE_INFINITY;
  private evictedWithinRetention = 0;

  constructor(options: UsageMeterOptions = {}) {
    this.retentionMs = options.dedupRetentionMs ?? DEFAULT_DEDUP_RETENTION_MS;
    this.maxKeys = options.maxDedupKeys ?? DEFAULT_MAX_DEDUP_KEYS;
    if (!(this.retentionMs > 0) || !Number.isInteger(this.maxKeys) || this.maxKeys < 1) {
      throw new Error("UsageMeter: dedupRetentionMs must be > 0 and maxDedupKeys a positive integer");
    }
  }

  record(event: MeteredUsageEvent): RecordResult {
    if (this.seen.has(event.idempotencyKey)) {
      return { accepted: false, duplicate: true };
    }
    this.remember(event);
    const key = bucketKey(event);
    const existing = this.buckets.get(key);
    if (existing === undefined) {
      this.buckets.set(key, {
        tenantId: event.tenantId,
        subscriptionId: event.subscriptionId,
        meter: event.meter,
        quantity: event.quantity,
        eventCount: 1,
      });
    } else {
      existing.quantity += event.quantity;
      existing.eventCount += 1;
    }
    return { accepted: true, duplicate: false };
  }

  private remember(event: MeteredUsageEvent): void {
    const at = Date.parse(event.occurredAt);
    if (at > this.newestMs) this.newestMs = at;
    this.seen.set(event.idempotencyKey, at);
    const horizon = this.newestMs - this.retentionMs;
    for (const [key, keptAt] of this.seen) {
      if (keptAt >= horizon) break;
      this.seen.delete(key);
    }
    while (this.seen.size > this.maxKeys) {
      const oldest = this.seen.entries().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest[0]);
      if (oldest[1] >= horizon) this.evictedWithinRetention += 1;
    }
  }

  dedupStats(): DedupStats {
    return { remembered: this.seen.size, evictedWithinRetention: this.evictedWithinRetention };
  }

  /** Buckets for a subscription, or all buckets when no subscription is given. */
  bucketsFor(subscriptionId?: string): readonly MeterBucket[] {
    const out: MeterBucket[] = [];
    for (const b of this.buckets.values()) {
      if (subscriptionId === undefined || b.subscriptionId === subscriptionId) {
        out.push({ ...b });
      }
    }
    return out;
  }

  /**
   * Removes and returns a subscription's buckets in one step, so a caller persisting them owns the
   * quantities: an event recorded after this call lands in a fresh bucket rather than in one the
   * caller is about to clear.
   */
  takeSubscription(subscriptionId: string): readonly MeterBucket[] {
    const out = this.bucketsFor(subscriptionId);
    this.clearSubscription(subscriptionId);
    return out;
  }

  quantityFor(subscriptionId: string, meter: MeterId): number {
    let total = 0;
    for (const b of this.buckets.values()) {
      if (b.subscriptionId === subscriptionId && b.meter === meter) total += b.quantity;
    }
    return total;
  }

  /** Clears a subscription's buckets (e.g. after a period is closed + invoiced). */
  clearSubscription(subscriptionId: string): void {
    for (const [key, b] of this.buckets) {
      if (b.subscriptionId === subscriptionId) this.buckets.delete(key);
    }
  }

  reset(): void {
    this.buckets.clear();
    this.seen.clear();
  }
}
