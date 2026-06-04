import type { Clock, IntervalHandle, IntervalScheduler, RunOutcome } from "./worker.js";
import { DEFAULT_SCHEDULER } from "./worker.js";

/** Per-instance resync result — the projection writes a re-projection produced. */
export interface DriftResyncReport {
  readonly upserts: {
    readonly instance: boolean;
    readonly activities: number;
    readonly signals: number;
    readonly timers: number;
  };
}

/**
 * The slice of `WorkflowReplayer` the drift sweeper drives: re-project a batch of
 * instances from the canonical event log and re-upsert their projection rows
 * (fixing any drift left by a crash / schema change). `WorkflowReplayer`
 * satisfies it structurally.
 */
export interface DriftResyncer {
  bulkResync(opts: {
    batchSize?: number;
    maxInstances?: number;
    status?: string;
  }): Promise<readonly DriftResyncReport[]>;
}

export interface DriftSweepWorkerOptions {
  readonly resyncer: DriftResyncer;
  /** Page size for the replayer's instance scan (default 100). */
  readonly batchSize?: number;
  /** Cap on instances re-projected per run (default 500), so a sweep is bounded. */
  readonly maxInstances?: number;
  /** Optional status filter (e.g. only sweep non-terminal instances). */
  readonly status?: string;
  readonly clock?: Clock;
  readonly onError?: (err: unknown) => void;
  readonly onRun?: (outcome: RunOutcome) => void;
  readonly scheduler?: IntervalScheduler;
}

export interface DriftSweepRunResult {
  /** Instances re-projected this run. */
  readonly resynced: number;
  /** Total projection rows upserted (instance + activities + signals + timers). */
  readonly upserts: number;
}

/**
 * A periodic projection-drift sweeper: each `runOnce` re-projects a bounded batch
 * of instances from the canonical event log and re-upserts their projection rows
 * via `WorkflowReplayer.bulkResync` — a self-healing safety net that fixes drift
 * left by a crash or schema change (re-upsert is idempotent, so re-projecting a
 * correct instance is harmless). Runs on a **slow** interval and a
 * `maxInstances` cap so it never floods writes. (A rolling cursor across runs to
 * cover very large datasets is the deeper follow-up.)
 */
export class DriftSweepWorker {
  private readonly resyncer: DriftResyncer;
  private readonly batchSize: number;
  private readonly maxInstances: number;
  private readonly status?: string;
  private readonly onError?: (err: unknown) => void;
  private readonly onRun?: (outcome: RunOutcome) => void;
  private readonly scheduler: IntervalScheduler;
  private handle: IntervalHandle | null = null;

  constructor(opts: DriftSweepWorkerOptions) {
    this.resyncer = opts.resyncer;
    this.batchSize = opts.batchSize ?? 100;
    this.maxInstances = opts.maxInstances ?? 500;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.onError !== undefined) this.onError = opts.onError;
    if (opts.onRun !== undefined) this.onRun = opts.onRun;
    this.scheduler = opts.scheduler ?? DEFAULT_SCHEDULER;
  }

  async runOnce(): Promise<DriftSweepRunResult> {
    const reports = await this.resyncer.bulkResync({
      batchSize: this.batchSize,
      maxInstances: this.maxInstances,
      ...(this.status !== undefined ? { status: this.status } : {}),
    });
    let upserts = 0;
    for (const r of reports) {
      upserts += (r.upserts.instance ? 1 : 0) + r.upserts.activities + r.upserts.signals + r.upserts.timers;
    }
    return { resynced: reports.length, upserts };
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
      this.onRun?.({ claimed: result.resynced, processed: result.upserts });
    } catch (err) {
      this.onError?.(err);
    }
  }
}
