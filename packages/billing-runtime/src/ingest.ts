import { z } from "zod";
import {
  METER_IDS,
  USAGE_SOURCES,
  UsageRecordSchema,
  buildIdempotencyKey,
  type UsagePeriod,
  type UsageRecord,
} from "@crossengin/billing";

/**
 * A single unit of platform usage as the runtime ingests it — one AI call, one
 * job run, one integration call, etc. `idempotencyKey` de-duplicates the event
 * (a retried emit must carry the same key); it is distinct from the rolled-up
 * `UsageRecord`'s per-(tenant, meter, period) idempotency key.
 */
export const MeteredUsageEventSchema = z
  .object({
    idempotencyKey: z.string().min(1),
    tenantId: z.string().uuid(),
    subscriptionId: z.string().uuid(),
    meter: z.enum(METER_IDS),
    quantity: z.number().nonnegative(),
    source: z.enum(USAGE_SOURCES),
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type MeteredUsageEvent = z.infer<typeof MeteredUsageEventSchema>;

export function parseMeteredUsageEvent(value: unknown): MeteredUsageEvent {
  return MeteredUsageEventSchema.parse(value);
}

/** The key a bucket accumulates under — one metered stream per tenant + subscription + meter. */
export function bucketKey(event: {
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly meter: string;
}): string {
  return `${event.tenantId}|${event.subscriptionId}|${event.meter}`;
}

export interface UsageRecordInput {
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly meter: MeteredUsageEvent["meter"];
  readonly quantity: number;
  readonly source: MeteredUsageEvent["source"];
  readonly period: UsagePeriod;
  readonly id: string;
  readonly recordedAt: string;
  /**
   * The writer that cut the window, or `null` for a record that is its period's own (see
   * `buildIdempotencyKey`). Required, so a new caller has to say which it is.
   */
  readonly writer: string | null;
}

/**
 * Projects an accumulated per-meter total into a schema-valid `UsageRecord` for a
 * period, using the contract's `buildIdempotencyKey` so re-emitting the same
 * period's record is idempotent downstream (e.g. Stripe usage sync).
 */
export function usageRecordFrom(input: UsageRecordInput): UsageRecord {
  return UsageRecordSchema.parse({
    id: input.id,
    tenantId: input.tenantId,
    subscriptionId: input.subscriptionId,
    meter: input.meter,
    period: input.period,
    quantity: input.quantity,
    source: input.source,
    recordedAt: input.recordedAt,
    idempotencyKey: buildIdempotencyKey({
      tenantId: input.tenantId,
      subscriptionId: input.subscriptionId,
      meter: input.meter,
      periodStart: input.period.start,
      writer: input.writer,
    }),
  });
}
