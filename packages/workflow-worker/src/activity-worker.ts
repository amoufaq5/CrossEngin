import { processActivityBatch, type ActivityBatchResult } from "./activity-batch.js";
import type { ActivityClaimer, ActivityProcessor } from "./activity-types.js";

export interface WorkflowActivityWorkerOptions {
  /** Stable id recorded on claimed rows; distinct per process for lease ownership + observability. */
  readonly workerId: string;
  readonly claimer: ActivityClaimer;
  readonly processor: ActivityProcessor;
  /** Max activities claimed per poll (default 20). */
  readonly batchLimit?: number;
  /** Lease each claim holds before another worker may steal it (default 30_000 ms). */
  readonly leaseMs?: number;
  /** Sleep after an empty poll (default 1_000 ms). */
  readonly idlePollMs?: number;
  /** Sleep after a poll that found work — short, to drain a backlog fast (default 0 ms). */
  readonly activePollMs?: number;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Notified when a poll cycle throws (claim error); the loop keeps running. */
  readonly onError?: (err: unknown) => void;
  /** Notified with each completed batch result (metrics / logging). */
  readonly onBatch?: (result: ActivityBatchResult) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t === "object" && t !== null && "unref" in t) (t as { unref(): void }).unref();
  });
}

/**
 * Polls a durable activity queue and executes due activities, forever, until `stop()`. Many instances
 * run concurrently against the same queue — `claimDueActivities`' `FOR UPDATE SKIP LOCKED` gives each a
 * disjoint batch, so the fleet scales horizontally with no coordination. After a poll that found
 * work it re-polls almost immediately (drain the backlog); after an empty poll it backs off to
 * `idlePollMs`. A claim error is reported via `onError` and the loop continues (transient DB blips
 * shouldn't kill a worker).
 */
export class WorkflowActivityWorker {
  private readonly workerId: string;
  private readonly claimer: ActivityClaimer;
  private readonly processor: ActivityProcessor;
  private readonly batchLimit: number;
  private readonly leaseMs: number;
  private readonly idlePollMs: number;
  private readonly activePollMs: number;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onError: ((err: unknown) => void) | undefined;
  private readonly onBatch: ((result: ActivityBatchResult) => void) | undefined;

  private running = false;
  private loop: Promise<void> | null = null;

  constructor(opts: WorkflowActivityWorkerOptions) {
    this.workerId = opts.workerId;
    this.claimer = opts.claimer;
    this.processor = opts.processor;
    this.batchLimit = opts.batchLimit ?? 20;
    this.leaseMs = opts.leaseMs ?? 30_000;
    this.idlePollMs = opts.idlePollMs ?? 1_000;
    this.activePollMs = opts.activePollMs ?? 0;
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? defaultSleep;
    this.onError = opts.onError;
    this.onBatch = opts.onBatch;
  }

  /** Runs a single poll cycle (claim → process → release-failures) and returns its result. */
  async runOnce(): Promise<ActivityBatchResult> {
    return processActivityBatch(this.claimer, this.processor, {
      workerId: this.workerId,
      now: this.now().toISOString(),
      limit: this.batchLimit,
      leaseMs: this.leaseMs,
    });
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Starts the poll loop (idempotent). Returns immediately; use `stop()` to await a clean halt. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        let result: ActivityBatchResult | null = null;
        try {
          result = await this.runOnce();
          this.onBatch?.(result);
        } catch (err) {
          this.onError?.(err);
        }
        if (!this.running) break;
        await this.sleep(result !== null && result.claimed > 0 ? this.activePollMs : this.idlePollMs);
      }
    })();
  }

  /** Signals the loop to stop and awaits the in-flight cycle. */
  async stop(): Promise<void> {
    this.running = false;
    const loop = this.loop;
    this.loop = null;
    if (loop !== null) await loop;
  }
}
