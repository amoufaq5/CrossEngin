import type { RetryActivityResult } from "@crossengin/workflow-runtime";

import type { ActivityRetryClaimStore } from "./activity-claim-store.js";
import type { Clock, IntervalHandle, IntervalScheduler, RunOutcome } from "./worker.js";
import { DEFAULT_SCHEDULER } from "./worker.js";

/** The slice of `WorkflowEngine` the retry executor drives (per-activity re-run). */
export interface RetryActivityEngine {
  retryActivity(input: { instanceId: string; activityId: string }): Promise<RetryActivityResult>;
}

export interface RetryExecutorWorkerOptions {
  readonly claimStore: ActivityRetryClaimStore;
  readonly engine: RetryActivityEngine;
  readonly workerId: string;
  readonly batchSize?: number;
  readonly leaseMs?: number;
  readonly clock?: Clock;
  readonly onError?: (err: unknown) => void;
  readonly onRun?: (outcome: RunOutcome) => void;
  readonly scheduler?: IntervalScheduler;
}

export interface RetryRunResult {
  readonly claimed: number;
  readonly retried: number;
  readonly succeeded: number;
}

/**
 * A **parallel** activity-retry executor: each `runOnce` claims a disjoint batch
 * of due retryable activities (`FOR UPDATE SKIP LOCKED`) and re-runs each via
 * `engine.retryActivity` (which replays the original input at the next attempt
 * and advances the workflow on success). The claim lease is released after each
 * attempt so the next poll re-evaluates the activity's new status / attempt
 * count. Running N of these drains the retry backlog in parallel, no global lock.
 */
export class RetryExecutorWorker {
  private readonly claimStore: ActivityRetryClaimStore;
  private readonly engine: RetryActivityEngine;
  private readonly workerId: string;
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly clock: Clock;
  private readonly onError?: (err: unknown) => void;
  private readonly onRun?: (outcome: RunOutcome) => void;
  private readonly scheduler: IntervalScheduler;
  private handle: IntervalHandle | null = null;

  constructor(opts: RetryExecutorWorkerOptions) {
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

  async runOnce(): Promise<RetryRunResult> {
    const claims = await this.claimStore.claimDueRetries({
      workerId: this.workerId,
      now: this.clock.now(),
      limit: this.batchSize,
      leaseMs: this.leaseMs,
    });
    let retried = 0;
    let succeeded = 0;
    for (const claim of claims) {
      try {
        const result = await this.engine.retryActivity({ instanceId: claim.instanceRef, activityId: claim.activityId });
        if (result.retried) {
          retried += 1;
          if (result.status === "succeeded") succeeded += 1;
        }
      } finally {
        // release the lease regardless: the engine has updated the activity's
        // status/attempt, so the next poll decides whether it's still eligible
        await this.claimStore.releaseActivity(claim.activityId);
      }
    }
    return { claimed: claims.length, retried, succeeded };
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
      this.onRun?.({ claimed: result.claimed, processed: result.retried });
    } catch (err) {
      this.onError?.(err);
    }
  }
}
