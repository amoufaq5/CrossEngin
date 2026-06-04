import type { ExecuteActivityResult } from "@crossengin/workflow-runtime";

import type { ActivityExecuteClaimStore } from "./activity-execute-claim-store.js";
import type { Clock, IntervalHandle, IntervalScheduler, RunOutcome } from "./worker.js";
import { DEFAULT_SCHEDULER } from "./worker.js";

/** The slice of `WorkflowEngine` the executor drives (first run of an async activity). */
export interface ExecuteActivityEngine {
  executeActivity(input: { instanceId: string; activityId: string }): Promise<ExecuteActivityResult>;
}

export interface ActivityExecutorWorkerOptions {
  readonly claimStore: ActivityExecuteClaimStore;
  readonly engine: ExecuteActivityEngine;
  readonly workerId: string;
  readonly batchSize?: number;
  readonly leaseMs?: number;
  readonly clock?: Clock;
  readonly onError?: (err: unknown) => void;
  readonly onRun?: (outcome: RunOutcome) => void;
  readonly scheduler?: IntervalScheduler;
}

export interface ExecuteRunResult {
  readonly claimed: number;
  readonly executed: number;
  readonly succeeded: number;
}

/**
 * A **parallel** async-activity executor: each `runOnce` claims a disjoint batch
 * of `scheduled` async activities (`FOR UPDATE SKIP LOCKED`) and runs each via
 * `engine.executeActivity` (the first attempt, replaying the scheduled input,
 * advancing the workflow on success). This is the consume side of the async
 * activity queue — `applyScheduleActivity` with `executionMode: "async"` leaves
 * the activity `scheduled`, and N of these workers drain + run them in parallel,
 * no global lock. The lease is released after each attempt so the next poll
 * re-evaluates (a failed first run becomes a retry-claim candidate).
 */
export class ActivityExecutorWorker {
  private readonly claimStore: ActivityExecuteClaimStore;
  private readonly engine: ExecuteActivityEngine;
  private readonly workerId: string;
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly clock: Clock;
  private readonly onError?: (err: unknown) => void;
  private readonly onRun?: (outcome: RunOutcome) => void;
  private readonly scheduler: IntervalScheduler;
  private handle: IntervalHandle | null = null;

  constructor(opts: ActivityExecutorWorkerOptions) {
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

  async runOnce(): Promise<ExecuteRunResult> {
    const claims = await this.claimStore.claimScheduledActivities({
      workerId: this.workerId,
      now: this.clock.now(),
      limit: this.batchSize,
      leaseMs: this.leaseMs,
    });
    let executed = 0;
    let succeeded = 0;
    for (const claim of claims) {
      try {
        const result = await this.engine.executeActivity({ instanceId: claim.instanceRef, activityId: claim.activityId });
        if (result.executed) {
          executed += 1;
          if (result.status === "succeeded") succeeded += 1;
        }
      } finally {
        await this.claimStore.releaseActivity(claim.activityId);
      }
    }
    return { claimed: claims.length, executed, succeeded };
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
      this.onRun?.({ claimed: result.claimed, processed: result.executed });
    } catch (err) {
      this.onError?.(err);
    }
  }
}
