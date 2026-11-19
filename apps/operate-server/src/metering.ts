import { readFile } from "node:fs/promises";

import { z } from "zod";
import type { PipelineExecution } from "@crossengin/api-gateway";
import { METER_IDS, USAGE_SOURCES, type UsagePeriod, type UsageRecord } from "@crossengin/billing";
import {
  RandomUuidGenerator,
  UsageMeter,
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

export const DEFAULT_METERING_FLUSH_INTERVAL_MS = 60_000;

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
    /**
     * Interval to flush accumulated usage to Postgres (ms). It was optional with "omit to flush only
     * on demand", and nothing in the binary ever demanded — so a config without it metered every
     * request into memory and persisted none of it. Defaulted now; usage is also flushed on shutdown.
     */
    flushIntervalMs: z.number().int().positive().default(DEFAULT_METERING_FLUSH_INTERVAL_MS),
    /** How long a request id is remembered for de-duplication (ms). */
    dedupRetentionMs: z.number().int().positive().optional(),
    /** At most this many request ids are remembered for de-duplication. */
    maxDedupKeys: z.number().int().positive().optional(),
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
 * meter. Accumulated usage is flushed to Postgres by the `MeteringFlushScheduler`.
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

export interface UsageWindowOptions {
  readonly period: UsagePeriod;
  readonly source: MeteredUsageEvent["source"];
  readonly recordedAt: string;
  readonly ids: UuidGenerator;
}

/**
 * Takes each metered subscription's accumulated buckets out of the engine **in one step** and
 * returns them as the window's `UsageRecord`s. Taking rather than reading-then-clearing is what makes
 * a window own its quantities: a request metered while the window is being written lands in the next
 * window instead of in a bucket the writer is about to clear.
 */
export function takeUsageWindow(
  engine: PersistentBillingMeteringEngine,
  subscriptions: readonly string[],
  opts: UsageWindowOptions,
): UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const subscriptionId of subscriptions) {
    for (const bucket of engine.engine.takeSubscriptionUsage(subscriptionId)) {
      if (bucket.quantity <= 0) continue;
      records.push(
        usageRecordFrom({
          tenantId: bucket.tenantId,
          subscriptionId: bucket.subscriptionId,
          meter: bucket.meter,
          quantity: bucket.quantity,
          source: opts.source,
          period: opts.period,
          id: opts.ids.next(),
          recordedAt: opts.recordedAt,
        }),
      );
    }
  }
  return records;
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
 * Periodically flushes accumulated usage to Postgres, as one record per (subscription, meter) per
 * `[lastFlush, now]` window.
 *
 * Three things this did wrong before. Every window opening on one day shared one idempotency key, so
 * the second flush of a day upserted over the first and that usage was never billed. A flush that
 * wrote some subscriptions and failed on the next had already cleared the written ones and not
 * advanced the window, so the retry overwrote their rows with only the newer usage. And nothing
 * flushed on shutdown. Now a window's records are taken out of the meter when the window is cut,
 * held as **pending** until one transaction writes them all, and retried unchanged on the next tick
 * if it fails — the same records under the same keys, so a retry after an ambiguous commit is a
 * no-op rather than a second count. Flushes are serialised, so the interval and a shutdown flush
 * cannot cut two windows over one span.
 *
 * What it still cannot do is survive a crash: buckets and pending windows live in this process, so
 * usage metered since the last successful flush is lost if the process dies without its shutdown.
 */
export class MeteringFlushScheduler {
  private handle: IntervalHandle | null = null;
  private lastFlushAt: Date;
  private readonly ids: UuidGenerator;
  private readonly clock: () => Date;
  private readonly pending: UsageRecord[][] = [];
  private chain: Promise<unknown> = Promise.resolve();

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

  /** Records cut into windows and not yet written. */
  pendingRecords(): number {
    return this.pending.reduce((n, w) => n + w.length, 0);
  }

  flushOnce(): Promise<number> {
    const run = this.chain.then(() => this.flushNow());
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * A pending window is written **before** a new one is cut, and no window is cut while one is still
   * pending. Cutting on every tick regardless held one more window in memory per failed tick, so a
   * store that stayed down grew this process by a window an interval for as long as it was down. Left
   * uncut, the usage stays in the meter's buckets — bounded by subscriptions × meters — and the window
   * cut once the store recovers simply spans the outage.
   */
  private async flushNow(): Promise<number> {
    let written = 0;
    let attempted = false;
    try {
      written += await this.drainPending();
      const now = this.clock();
      if (now.getTime() > this.lastFlushAt.getTime()) {
        const period: UsagePeriod = { start: this.lastFlushAt.toISOString(), end: now.toISOString() };
        const records = takeUsageWindow(this.opts.engine, this.opts.observer.meteredSubscriptions(), {
          period,
          source: this.opts.source,
          recordedAt: now.toISOString(),
          ids: this.ids,
        });
        this.lastFlushAt = now;
        if (records.length > 0) this.pending.push(records);
      }
      attempted = this.pending.length > 0 || written > 0;
      written += await this.drainPending();
      if (attempted) this.opts.onFlush?.(written);
      return written;
    } catch (err) {
      this.opts.onError?.(err);
      return written;
    }
  }

  private async drainPending(): Promise<number> {
    let written = 0;
    while (this.pending.length > 0) {
      const window = this.pending[0] as UsageRecord[];
      written += await this.opts.engine.usageStore.recordWindow(window);
      this.pending.shift();
    }
    return written;
  }

  private scheduler(): IntervalScheduler {
    return this.opts.scheduler ?? DEFAULT_SCHEDULER;
  }
}

export interface RequestMetering {
  readonly engine: PersistentBillingMeteringEngine;
  readonly observer: RequestMeteringObserver;
  readonly flushScheduler: MeteringFlushScheduler;
}

export function buildRequestMetering(
  conn: PgConnection,
  config: MeteringConfig,
  opts: { readonly onFlush?: (written: number) => void; readonly onError?: (err: unknown) => void } = {},
): RequestMetering {
  const engine = buildPersistentBillingEngine(conn, {
    meter: new UsageMeter({
      ...(config.dedupRetentionMs !== undefined ? { dedupRetentionMs: config.dedupRetentionMs } : {}),
      ...(config.maxDedupKeys !== undefined ? { maxDedupKeys: config.maxDedupKeys } : {}),
    }),
  });
  const observer = new RequestMeteringObserver(engine, policyFromConfig(config));
  const flushScheduler = new MeteringFlushScheduler({
    observer,
    engine,
    source: config.source,
    intervalMs: config.flushIntervalMs,
    ...(opts.onFlush !== undefined ? { onFlush: opts.onFlush } : {}),
    ...(opts.onError !== undefined ? { onError: opts.onError } : {}),
  });
  return { engine, observer, flushScheduler };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
