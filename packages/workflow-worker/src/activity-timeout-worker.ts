import type { TimeoutActivityResult } from "@crossengin/workflow-runtime";

import type { ActivityTimeoutClaimStore } from "./activity-timeout-claim-store.js";
import type { Clock, IntervalHandle, IntervalScheduler, RunOutcome } from "./worker.js";
import { DEFAULT_SCHEDULER } from "./worker.js";

/** The slice of `WorkflowEngine` the activity-timeout sweeper drives. */
export interface TimeoutActivityEngine {
  timeoutActivity(input: { instanceId: string; activityId: string; nowMs?: number }): Promise<TimeoutActivityResult>;
}

export interface ActivityTimeoutSweeperWorkerOptions {
  readonly claimStore: ActivityTimeoutClaimStore;
  readonly engine: TimeoutActivityEngine;
  readonly workerId: string;
  readonly batchSize?: number;
  readonly leaseMs?: number;
  readonly clock?: Clock;
  readonly onError?: (err: unknown) => void;
  readonly onRun?: (outcome: RunOutcome) => void;
  readonly scheduler?: IntervalScheduler;
}

export interface ActivityTimeoutRunResult {
  readonly claimed: number;
  readonly timedOut: number;
}

/**
 * A **parallel** activity-timeout sweeper: each `runOnce` claims a disjoint batch
 * of non-settled activities past their deadline (`FOR UPDATE SKIP LOCKED`) and
 * times out each via `engine.timeoutActivity` (idempotent — a settled or
 * not-yet-due activity is a no-op). The lease is released after each attempt so
 * the next poll re-evaluates (a timed-out activity becomes a retry-claim
 * candidate). Catches async activities no executor ran in time + in-flight
 * activities orphaned by a dead worker.
 */
export class ActivityTimeoutSweeperWorker {
  private readonly claimStore: ActivityTimeoutClaimStore;
  private readonly engine: TimeoutActivityEngine;
  private readonly workerId: string;
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly clock: Clock;
  private readonly onError?: (err: unknown) => void;
  private readonly onRun?: (outcome: RunOutcome) => void;
  private readonly scheduler: IntervalScheduler;
  private handle: IntervalHandle | null = null;

  constructor(opts: ActivityTimeoutSweeperWorkerOptions) {
    this.claimStore = opts.claimStore;
    this.engine = opts.engine;
    this.workerId = opts.workerId;
    this.batchSize = opts.batchSize ?? 50;
    this.leaseMs = opts.leaseMs ?? 60_000;
    this.clock = opts.clock ?? { now: () => new Date() };
    if (opts.onError !== undefined) this.onError = opts.onError;
    if (opts.onRun !== undefined) this.onRun = opts.onRun;
    this.scheduler = opts.scheduler ?? DEFAULT_SCHEDULER;
  }

  async runOnce(): Promise<ActivityTimeoutRunResult> {
    const now = this.clock.now();
    const claims = await this.claimStore.claimTimedOutActivities({
      workerId: this.workerId,
      now,
      limit: this.batchSize,
      leaseMs: this.leaseMs,
    });
    let timedOut = 0;
    for (const claim of claims) {
      try {
        const result = await this.engine.timeoutActivity({
          instanceId: claim.instanceRef,
          activityId: claim.activityId,
          nowMs: now.getTime(),
        });
        if (result.timedOut) timedOut += 1;
      } finally {
        await this.claimStore.releaseActivity(claim.activityId);
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
      const result = await this.runOnce();
      this.onRun?.({ claimed: result.claimed, processed: result.timedOut });
    } catch (err) {
      this.onError?.(err);
    }
  }
}
