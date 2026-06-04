import type { TimeoutInstanceResult } from "@crossengin/workflow-runtime";

import type { InstanceTimeoutClaimStore } from "./instance-timeout-claim-store.js";
import type { Clock, IntervalHandle, IntervalScheduler } from "./worker.js";
import { DEFAULT_SCHEDULER } from "./worker.js";

/** The slice of `WorkflowEngine` the timeout sweeper drives (per-instance timeout). */
export interface TimeoutInstanceEngine {
  timeoutInstance(input: { instanceId: string; nowMs?: number }): Promise<TimeoutInstanceResult>;
}

export interface TimeoutSweeperWorkerOptions {
  readonly claimStore: InstanceTimeoutClaimStore;
  readonly engine: TimeoutInstanceEngine;
  readonly workerId: string;
  readonly batchSize?: number;
  readonly leaseMs?: number;
  readonly clock?: Clock;
  readonly onError?: (err: unknown) => void;
  readonly scheduler?: IntervalScheduler;
}

export interface TimeoutRunResult {
  readonly claimed: number;
  readonly timedOut: number;
}

/**
 * A **parallel** instance-timeout sweeper: each `runOnce` claims a disjoint batch
 * of non-terminal instances past their deadline (`FOR UPDATE SKIP LOCKED`) and
 * fails each via `engine.timeoutInstance` (idempotent + race-safe — a not-yet-due
 * or already-terminal instance is a no-op). The lease is released after each
 * attempt so the next poll re-evaluates. Running N of these sweeps the timeout
 * backlog in parallel, no global lock — the third time-based progression worker
 * alongside the timer claim + activity retry executors.
 */
export class TimeoutSweeperWorker {
  private readonly claimStore: InstanceTimeoutClaimStore;
  private readonly engine: TimeoutInstanceEngine;
  private readonly workerId: string;
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly clock: Clock;
  private readonly onError?: (err: unknown) => void;
  private readonly scheduler: IntervalScheduler;
  private handle: IntervalHandle | null = null;

  constructor(opts: TimeoutSweeperWorkerOptions) {
    this.claimStore = opts.claimStore;
    this.engine = opts.engine;
    this.workerId = opts.workerId;
    this.batchSize = opts.batchSize ?? 50;
    this.leaseMs = opts.leaseMs ?? 60_000;
    this.clock = opts.clock ?? { now: () => new Date() };
    if (opts.onError !== undefined) this.onError = opts.onError;
    this.scheduler = opts.scheduler ?? DEFAULT_SCHEDULER;
  }

  async runOnce(): Promise<TimeoutRunResult> {
    const now = this.clock.now();
    const claims = await this.claimStore.claimTimedOutInstances({
      workerId: this.workerId,
      now,
      limit: this.batchSize,
      leaseMs: this.leaseMs,
    });
    let timedOut = 0;
    for (const claim of claims) {
      try {
        const result = await this.engine.timeoutInstance({
          instanceId: claim.instanceRef,
          nowMs: now.getTime(),
        });
        if (result.timedOut) timedOut += 1;
      } finally {
        await this.claimStore.releaseInstance(claim.instanceRef);
      }
    }
    return { claimed: claims.length, timedOut };
  }

  start(intervalMs: number): void {
    if (this.handle !== null) return;
    this.handle = this.scheduler.setInterval(() => void this.safeRun(), intervalMs);
  }

  stop(): void {
    if (this.handle === null) return;
    this.scheduler.clearInterval(this.handle);
    this.handle = null;
  }

  private async safeRun(): Promise<void> {
    try {
      await this.runOnce();
    } catch (err) {
      this.onError?.(err);
    }
  }
}
