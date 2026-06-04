import type { FireTimerResult } from "@crossengin/workflow-runtime";

import type { TimerClaimStore } from "./claim-store.js";
import type { Clock, IntervalHandle, IntervalScheduler, RunOutcome } from "./worker.js";
import { DEFAULT_SCHEDULER } from "./worker.js";

/** The slice of `WorkflowEngine` the claiming worker drives (per-timer firing). */
export interface FireTimerEngine {
  fireTimer(input: { instanceId: string; timerId: string; nowMs?: number }): Promise<FireTimerResult>;
}

export interface ClaimingTimerWorkerOptions {
  readonly claimStore: TimerClaimStore;
  readonly engine: FireTimerEngine;
  /** Identifies this worker in the lease (`claimed_by`). */
  readonly workerId: string;
  readonly batchSize?: number;
  readonly leaseMs?: number;
  readonly clock?: Clock;
  readonly onError?: (err: unknown) => void;
  readonly onRun?: (outcome: RunOutcome) => void;
  readonly scheduler?: IntervalScheduler;
}

export interface ClaimRunResult {
  readonly claimed: number;
  readonly fired: number;
}

/**
 * A **parallel** timer worker: each `runOnce` claims a disjoint batch of due
 * timers (`FOR UPDATE SKIP LOCKED`) and fires each via `engine.fireTimer` — so
 * running N of these drains the timer backlog in parallel, no global lock. A
 * claimed timer that doesn't fire (already fired by a racing worker, or not due)
 * has its lease released; `engine.fireTimer` is itself idempotent, so a race
 * can't double-fire. Complements the advisory-lock `WorkflowWorker` (bulk tick).
 */
export class ClaimingTimerWorker {
  private readonly claimStore: TimerClaimStore;
  private readonly engine: FireTimerEngine;
  private readonly workerId: string;
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly clock: Clock;
  private readonly onError?: (err: unknown) => void;
  private readonly onRun?: (outcome: RunOutcome) => void;
  private readonly scheduler: IntervalScheduler;
  private handle: IntervalHandle | null = null;

  constructor(opts: ClaimingTimerWorkerOptions) {
    this.claimStore = opts.claimStore;
    this.engine = opts.engine;
    this.workerId = opts.workerId;
    this.batchSize = opts.batchSize ?? 50;
    this.leaseMs = opts.leaseMs ?? 30_000;
    this.clock = opts.clock ?? { now: () => new Date() };
    if (opts.onError !== undefined) this.onError = opts.onError;
    if (opts.onRun !== undefined) this.onRun = opts.onRun;
    this.scheduler = opts.scheduler ?? DEFAULT_SCHEDULER;
  }

  /** Claims a batch of due timers and fires them; releases the lease on any that didn't fire. */
  async runOnce(): Promise<ClaimRunResult> {
    const now = this.clock.now();
    const claims = await this.claimStore.claimDueTimers({
      workerId: this.workerId,
      now,
      limit: this.batchSize,
      leaseMs: this.leaseMs,
    });
    let fired = 0;
    for (const claim of claims) {
      const result = await this.engine.fireTimer({
        instanceId: claim.instanceRef,
        timerId: claim.timerId,
        nowMs: now.getTime(),
      });
      if (result.fired) {
        fired += 1;
      } else {
        await this.claimStore.releaseTimer(claim.timerId);
      }
    }
    return { claimed: claims.length, fired };
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
      this.onRun?.({ claimed: result.claimed, processed: result.fired });
    } catch (err) {
      this.onError?.(err);
    }
  }
}
