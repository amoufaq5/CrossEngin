import { z } from "zod";

import { DATA_CLASSES, EventNameSchema, type JobDeclaration } from "./types.js";

/**
 * A domain event emitted by the platform (e.g. `retail.order_placed`) that may trigger jobs. `data`
 * is the event payload; `idempotencyKey` (when the emitter supplies one) makes a re-delivered event
 * enqueue the same run rather than a duplicate — event delivery is at-least-once.
 */
export const DomainEventSchema = z.object({
  name: EventNameSchema,
  tenantId: z.string().min(1),
  data: z.record(z.unknown()).default({}),
  idempotencyKey: z.string().min(1).optional(),
  occurredAt: z.string().datetime().optional(),
});
export type DomainEvent = z.infer<typeof DomainEventSchema>;

/**
 * A job run planned from an event, ready to be persisted as a `pending` `job_runs` row. `runKey` is
 * the deterministic idempotency key — the persistence layer derives a stable `run_id` from it so a
 * re-delivered event does not enqueue a duplicate run.
 */
export interface PlannedJobRun {
  readonly jobId: string;
  readonly jobKind: "event";
  readonly trigger: {
    readonly kind: "event";
    readonly eventName: string;
    readonly occurredAt?: string;
    readonly idempotencyKey?: string;
  };
  readonly input: Record<string, unknown>;
  readonly inputDataClass: (typeof DATA_CLASSES)[number];
  readonly outputDataClass: (typeof DATA_CLASSES)[number];
  readonly runKey: string;
}

/** Stable JSON of a value with object keys sorted, so `runKey` is invariant to key order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(",")}}`;
}

/**
 * The deterministic idempotency key for the (event, job) pair. Prefers the emitter's
 * `idempotencyKey`; absent one, it falls back to a stable hash-input of the payload, so identical
 * re-deliveries collapse to one run while genuinely distinct events (different payloads) do not.
 */
export function enqueueKeyForEvent(event: DomainEvent, jobId: string): string {
  const discriminator = event.idempotencyKey ?? stableStringify(event.data);
  return `${event.name}::${discriminator}::${jobId}`;
}

/**
 * The event-triggered jobs that fire for an event: `trigger.kind === "event"` with a matching
 * `eventName`, excluding deprecated jobs. Pure — the caller decides what to do with the matches.
 */
export function matchEventJobs(
  event: DomainEvent,
  jobs: readonly JobDeclaration[],
): readonly JobDeclaration[] {
  return jobs.filter(
    (j) => j.deprecated !== true && j.trigger.kind === "event" && j.trigger.eventName === event.name,
  );
}

/**
 * Plans a `pending` job run for every job an event triggers — the pure producer step. Each planned
 * run carries the job's data classes, the event as its input, and a deterministic `runKey` for
 * idempotent persistence.
 */
export function planJobRunsForEvent(
  event: DomainEvent,
  jobs: readonly JobDeclaration[],
): readonly PlannedJobRun[] {
  return matchEventJobs(event, jobs).map((job) => ({
    jobId: job.id,
    jobKind: "event",
    trigger: {
      kind: "event",
      eventName: event.name,
      ...(event.occurredAt !== undefined ? { occurredAt: event.occurredAt } : {}),
      ...(event.idempotencyKey !== undefined ? { idempotencyKey: event.idempotencyKey } : {}),
    },
    input: event.data,
    inputDataClass: job.inputDataClass,
    outputDataClass: job.outputDataClass,
    runKey: enqueueKeyForEvent(event, job.id),
  }));
}
