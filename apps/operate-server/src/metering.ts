import { readFile } from "node:fs/promises";

import { z } from "zod";
import type { PipelineExecution } from "@crossengin/api-gateway";
import { METER_IDS, USAGE_SOURCES, type UsagePeriod } from "@crossengin/billing";
import {
  RandomUuidGenerator,
  usageRecordFrom,
  type MeteredUsageEvent,
  type UuidGenerator,
} from "@crossengin/billing-runtime";
import {
  buildPersistentBillingEngine,
  type PersistentBillingMeteringEngine,
} from "@crossengin/billing-runtime-pg";
import type { PgConnection } from "@crossengin/kernel-pg";

import type { IntervalHandle, IntervalScheduler } from "./jwks.js";

/**
 * Maps a served request to a metered usage event. Only authenticated requests
 * (a tenant) with a mapped subscription and a counted status become billable
 * usage; the request id is the idempotency key, so each request meters once.
 */
export const MeteringConfigSchema = z
  .object({
    meter: z.enum(METER_IDS).default("integration_call"),
    source: z.enum(USAGE_SOURCES).default("integration_calls"),
    quantityPerRequest: z.number().positive().default(1),
    /** tenantId → subscriptionId; unmapped tenants are not metered. */
    tenantSubscriptions: z.record(z.string().uuid(), z.string().uuid()),
    /** Response statuses to count; omit to count every non-error (< 400) response. */
    countStatuses: z.array(z.number().int().min(100).max(599)).min(1).optional(),
    /** Interval to flush accumulated usage to Postgres (ms); omit to flush only on demand. */
    flushIntervalMs: z.number().int().positive().optional(),
  })
  .strict();
export type MeteringConfig = z.infer<typeof MeteringConfigSchema>;

export function parseMeteringConfig(json: unknown): MeteringConfig {
  return MeteringConfigSchema.parse(json);
}

export async function loadMeteringConfig(path: string): Promise<MeteringConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`--metering-config: cannot read ${path}: ${errMessage(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`--metering-config: invalid JSON in ${path}: ${errMessage(err)}`);
  }
  return parseMeteringConfig(parsed);
}

export interface MeteringPolicy {
  readonly meter: MeteringConfig["meter"];
  readonly source: MeteringConfig["source"];
  readonly quantityPerRequest: number;
  readonly subscriptionFor: (tenantId: string) => string | null;
  readonly countStatuses?: readonly number[];
}

export function policyFromConfig(config: MeteringConfig): MeteringPolicy {
  const map = config.tenantSubscriptions;
  return {
    meter: config.meter,
    source: config.source,
    quantityPerRequest: config.quantityPerRequest,
    subscriptionFor: (tenantId) => map[tenantId] ?? null,
    ...(config.countStatuses !== undefined ? { countStatuses: config.countStatuses } : {}),
  };
}

function isCounted(status: number, countStatuses?: readonly number[]): boolean {
  return countStatuses === undefined ? status < 400 : countStatuses.includes(status);
}

/** Projects a pipeline execution into a billable usage event, or null when not billable. */
export function meteredEventFromExecution(
  execution: PipelineExecution,
  policy: MeteringPolicy,
): MeteredUsageEvent | null {
  const tenantId = execution.tenantId;
  if (tenantId === null) return null;
  if (!isCounted(execution.finalResponseStatus, policy.countStatuses)) return null;
  const subscriptionId = policy.subscriptionFor(tenantId);
  if (subscriptionId === null) return null;
  return {
    idempotencyKey: execution.requestId,
    tenantId,
    subscriptionId,
    meter: policy.meter,
    quantity: policy.quantityPerRequest,
    source: policy.source,
    occurredAt: execution.completedAt,
  };
}

/**
 * Feeds the live request stream into a billing engine: each billable request
 * accumulates (idempotently, keyed by request id) into the engine's in-memory
 * meter. Accumulated usage is flushed to Postgres by `flushUsage` / the
 * `MeteringFlushScheduler`.
 */
export class RequestMeteringObserver {
  private readonly subscriptions = new Set<string>();

  constructor(
    private readonly engine: PersistentBillingMeteringEngine,
    private readonly policy: MeteringPolicy,
  ) {}

  observe(execution: PipelineExecution): void {
    const event = meteredEventFromExecution(execution, this.policy);
    if (event === null) return;
    this.engine.recordUsage(event);
    this.subscriptions.add(event.subscriptionId);
  }

  asExecutionSink(): (execution: PipelineExecution) => void {
    return (execution) => this.observe(execution);
  }

  meteredSubscriptions(): readonly string[] {
    return [...this.subscriptions];
  }
}

export interface FlushUsageOptions {
  readonly period: UsagePeriod;
  readonly source: MeteredUsageEvent["source"];
  readonly recordedAt: string;
  readonly ids: UuidGenerator;
  /** Reset each subscription's buckets after persisting (default true). */
  readonly clear?: boolean;
}

/**
 * Persists each metered subscription's accumulated buckets as `UsageRecord`s for
 * the flush window, then clears them — so the next window starts fresh and each
 * window persists as a distinct record (distinct period ⇒ distinct idempotency
 * key). Returns the number of records written.
 */
export async function flushUsage(
  engine: PersistentBillingMeteringEngine,
  subscriptions: readonly string[],
  opts: FlushUsageOptions,
): Promise<number> {
  let written = 0;
  for (const subscriptionId of subscriptions) {
    const buckets = engine.engine.usage(subscriptionId);
    for (const bucket of buckets) {
      if (bucket.quantity <= 0) continue;
      const record = usageRecordFrom({
        tenantId: bucket.tenantId,
        subscriptionId: bucket.subscriptionId,
        meter: bucket.meter,
        quantity: bucket.quantity,
        source: opts.source,
        period: opts.period,
        id: opts.ids.next(),
        recordedAt: opts.recordedAt,
      });
      await engine.usageStore.record(record);
      written += 1;
    }
    if (opts.clear !== false) engine.engine.clearSubscription(subscriptionId);
  }
  return written;
}

const DEFAULT_SCHEDULER: IntervalScheduler = {
  setInterval(handler, ms) {
    const h = setInterval(handler, ms);
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

export interface MeteringFlushSchedulerOptions {
  readonly observer: RequestMeteringObserver;
  readonly engine: PersistentBillingMeteringEngine;
  readonly source: MeteredUsageEvent["source"];
  readonly intervalMs: number;
  readonly ids?: UuidGenerator;
  readonly clock?: () => Date;
  readonly scheduler?: IntervalScheduler;
  readonly onFlush?: (written: number) => void;
  readonly onError?: (err: unknown) => void;
}

/**
 * Periodically flushes accumulated usage to Postgres. Each tick persists the
 * usage since the previous tick as a `[lastFlush, now]` window (unref'd timer,
 * `onFlush`/`onError` sinks — the `PruneScheduler` shape).
 */
export class MeteringFlushScheduler {
  private handle: IntervalHandle | null = null;
  private lastFlushAt: Date;
  private readonly ids: UuidGenerator;
  private readonly clock: () => Date;

  constructor(private readonly opts: MeteringFlushSchedulerOptions) {
    this.ids = opts.ids ?? new RandomUuidGenerator();
    this.clock = opts.clock ?? (() => new Date());
    this.lastFlushAt = this.clock();
  }

  start(): void {
    if (this.handle !== null) return;
    this.handle = this.scheduler().setInterval(() => void this.flushOnce(), this.opts.intervalMs);
  }

  stop(): void {
    if (this.handle === null) return;
    this.scheduler().clearInterval(this.handle);
    this.handle = null;
  }

  async flushOnce(): Promise<number> {
    const now = this.clock();
    try {
      if (now.getTime() <= this.lastFlushAt.getTime()) return 0;
      const period: UsagePeriod = { start: this.lastFlushAt.toISOString(), end: now.toISOString() };
      const written = await flushUsage(this.opts.engine, this.opts.observer.meteredSubscriptions(), {
        period,
        source: this.opts.source,
        recordedAt: now.toISOString(),
        ids: this.ids,
      });
      this.lastFlushAt = now;
      this.opts.onFlush?.(written);
      return written;
    } catch (err) {
      this.opts.onError?.(err);
      return 0;
    }
  }

  private scheduler(): IntervalScheduler {
    return this.opts.scheduler ?? DEFAULT_SCHEDULER;
  }
}

export interface RequestMetering {
  readonly engine: PersistentBillingMeteringEngine;
  readonly observer: RequestMeteringObserver;
  readonly flushScheduler: MeteringFlushScheduler | null;
}

export function buildRequestMetering(
  conn: PgConnection,
  config: MeteringConfig,
  opts: { readonly onFlush?: (written: number) => void; readonly onError?: (err: unknown) => void } = {},
): RequestMetering {
  const engine = buildPersistentBillingEngine(conn);
  const observer = new RequestMeteringObserver(engine, policyFromConfig(config));
  const flushScheduler =
    config.flushIntervalMs !== undefined
      ? new MeteringFlushScheduler({
          observer,
          engine,
          source: config.source,
          intervalMs: config.flushIntervalMs,
          ...(opts.onFlush !== undefined ? { onFlush: opts.onFlush } : {}),
          ...(opts.onError !== undefined ? { onError: opts.onError } : {}),
        })
      : null;
  return { engine, observer, flushScheduler };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
