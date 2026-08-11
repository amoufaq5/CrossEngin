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
 * An in-memory, idempotent usage accumulator: events are summed into per-(tenant,
 * subscription, meter) buckets, and a repeated `idempotencyKey` is ignored, so a
 * retried emit never double-counts. Pure state — no I/O; a `-pg` sibling persists.
 */
export class UsageMeter {
  private readonly buckets = new Map<string, { tenantId: string; subscriptionId: string; meter: MeterId; quantity: number; eventCount: number }>();
  private readonly seen = new Set<string>();

  record(event: MeteredUsageEvent): RecordResult {
    if (this.seen.has(event.idempotencyKey)) {
      return { accepted: false, duplicate: true };
    }
    this.seen.add(event.idempotencyKey);
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
