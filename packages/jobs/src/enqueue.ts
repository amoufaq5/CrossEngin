import { z } from "zod";

import { DATA_CLASSES, EventNameSchema, durationToMillis, type JobDeclaration } from "./types.js";

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
  readonly jobKind: "event" | "delayed" | "userInvoked";
  readonly trigger: {
    readonly kind: "event" | "delayed" | "userInvoked";
    /** Present for `event` / `delayed` triggers (the source event name). */
    readonly eventName?: string;
    /** Present for a `userInvoked` trigger (the invoked action). */
    readonly action?: string;
    readonly occurredAt?: string;
    readonly idempotencyKey?: string;
    /** For a delayed trigger: the ISO 8601 delay after `afterEvent` before the run becomes due. */
    readonly delay?: string;
  };
  readonly input: Record<string, unknown>;
  readonly inputDataClass: (typeof DATA_CLASSES)[number];
  readonly outputDataClass: (typeof DATA_CLASSES)[number];
  /** Milliseconds to defer the run past the enqueue time (0 for an event trigger). */
  readonly delayMs: number;
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
 * The jobs an event triggers: `event`-trigger jobs whose `eventName` matches, plus `delayed`-trigger
 * jobs whose `afterEvent` matches (fired after their `delay`). Excludes deprecated jobs. Pure — the
 * caller decides what to do with the matches.
 */
export function matchEventJobs(
  event: DomainEvent,
  jobs: readonly JobDeclaration[],
): readonly JobDeclaration[] {
  return jobs.filter((j) => {
    if (j.deprecated === true) return false;
    if (j.trigger.kind === "event") return j.trigger.eventName === event.name;
    if (j.trigger.kind === "delayed") return j.trigger.afterEvent === event.name;
    return false;
  });
}

/**
 * Plans a `pending` job run for every job an event triggers — the pure producer step. Each planned
 * run carries the job's data classes, the event as its input, a deterministic `runKey` for idempotent
 * persistence, and a `delayMs` (0 for an `event` trigger; the `delayed` trigger's `delay` in ms), so
 * the persistence layer can defer the run's `started_at` past enqueue time.
 */
export function planJobRunsForEvent(
  event: DomainEvent,
  jobs: readonly JobDeclaration[],
): readonly PlannedJobRun[] {
  return matchEventJobs(event, jobs).map((job) => {
    const delayed = job.trigger.kind === "delayed" ? job.trigger : undefined;
    return {
      jobId: job.id,
      jobKind: delayed !== undefined ? "delayed" : "event",
      trigger: {
        kind: delayed !== undefined ? "delayed" : "event",
        eventName: event.name,
        ...(event.occurredAt !== undefined ? { occurredAt: event.occurredAt } : {}),
        ...(event.idempotencyKey !== undefined ? { idempotencyKey: event.idempotencyKey } : {}),
        ...(delayed !== undefined ? { delay: delayed.delay } : {}),
      },
      input: event.data,
      inputDataClass: job.inputDataClass,
      outputDataClass: job.outputDataClass,
      delayMs: delayed !== undefined ? durationToMillis(delayed.delay) : 0,
      runKey: enqueueKeyForEvent(event, job.id),
    };
  });
}

/**
 * A user- or API-driven "run this job now" invocation. `data` is the invocation payload;
 * `idempotencyKey` (when the caller supplies one) collapses a re-submitted invocation to the same run
 * rather than a duplicate. `action` names the invoked action a `userInvoked`-trigger job listens for.
 */
export const UserInvocationSchema = z.object({
  tenantId: z.string().min(1),
  action: z.string().min(1),
  data: z.record(z.unknown()).default({}),
  idempotencyKey: z.string().min(1).optional(),
  occurredAt: z.string().datetime().optional(),
});
export type UserInvocation = z.infer<typeof UserInvocationSchema>;

/**
 * The jobs a user invocation triggers: `userInvoked`-trigger jobs whose `action` matches. Excludes
 * deprecated jobs. Pure — the caller decides what to do with the matches.
 */
export function matchUserInvokedJobs(
  invocation: UserInvocation,
  jobs: readonly JobDeclaration[],
): readonly JobDeclaration[] {
  return jobs.filter((j) => {
    if (j.deprecated === true) return false;
    return j.trigger.kind === "userInvoked" && j.trigger.action === invocation.action;
  });
}

/**
 * The deterministic idempotency key for the (invocation, job) pair. Prefers the caller's
 * `idempotencyKey`; absent one, it falls back to a stable hash-input of the payload. The
 * `userInvoked::` prefix keeps it distinct from event keys so an action and an event of the same name
 * never collide.
 */
export function enqueueKeyForUserInvocation(invocation: UserInvocation, jobId: string): string {
  const discriminator = invocation.idempotencyKey ?? stableStringify(invocation.data);
  return `userInvoked::${invocation.action}::${discriminator}::${jobId}`;
}

/**
 * Plans a `pending` job run for every job a user invocation triggers — the pure producer step,
 * mirroring `planJobRunsForEvent`. Each planned run carries the job's data classes, the invocation
 * payload as its input, a deterministic `runKey` for idempotent persistence, and `delayMs` 0.
 */
export function planUserInvokedJobRuns(
  invocation: UserInvocation,
  jobs: readonly JobDeclaration[],
): readonly PlannedJobRun[] {
  return matchUserInvokedJobs(invocation, jobs).map((job) => ({
    jobId: job.id,
    jobKind: "userInvoked",
    trigger: {
      kind: "userInvoked",
      action: invocation.action,
      ...(invocation.occurredAt !== undefined ? { occurredAt: invocation.occurredAt } : {}),
      ...(invocation.idempotencyKey !== undefined ? { idempotencyKey: invocation.idempotencyKey } : {}),
    },
    input: invocation.data,
    inputDataClass: job.inputDataClass,
    outputDataClass: job.outputDataClass,
    delayMs: 0,
    runKey: enqueueKeyForUserInvocation(invocation, job.id),
  }));
}
