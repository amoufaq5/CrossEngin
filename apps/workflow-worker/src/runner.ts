import type { PgConnection } from "@crossengin/kernel-pg";
import {
  ActivityExecutorWorker,
  ActivityTimeoutSweeperWorker,
  ClaimingTimerWorker,
  DriftSweepWorker,
  LeaseReaperWorker,
  PostgresActivityExecuteClaimStore,
  PostgresActivityRetryClaimStore,
  PostgresActivityTimeoutClaimStore,
  PostgresInstanceTimeoutClaimStore,
  PostgresLeaseReaper,
  PostgresTimerClaimStore,
  RetryExecutorWorker,
  TimeoutSweeperWorker,
  WorkflowWorker,
  type DriftResyncer,
  type ExecuteActivityEngine,
  type FireTimerEngine,
  type IntervalScheduler,
  type RetryActivityEngine,
  type RunOutcome,
  type TimeoutActivityEngine,
  type TimeoutInstanceEngine,
  type TimerTickEngine,
} from "@crossengin/workflow-worker";

import type { WorkerMode } from "./cli.js";

/** The engine slice the worker set drives — all per-mode capabilities. */
export interface WorkerEngine
  extends TimerTickEngine,
    FireTimerEngine,
    RetryActivityEngine,
    TimeoutInstanceEngine,
    TimeoutActivityEngine,
    ExecuteActivityEngine {}

export interface BuildWorkerSetInput {
  readonly conn: PgConnection;
  readonly engine: WorkerEngine;
  readonly mode: WorkerMode;
  readonly workerId: string;
  readonly schema: string | null;
  readonly tickIntervalMs: number;
  readonly claimIntervalMs: number;
  readonly retryIntervalMs: number;
  readonly timeoutIntervalMs: number;
  readonly executeIntervalMs: number;
  readonly reapIntervalMs: number;
  readonly resyncIntervalMs: number;
  readonly resyncMax: number;
  readonly batchSize: number;
  readonly leaseMs: number;
  /** Required only for `--mode resync` — the projection drift sweeper's replayer. */
  readonly resyncer?: DriftResyncer;
  readonly scheduler?: IntervalScheduler;
  readonly onError?: (err: unknown) => void;
  readonly onRun?: (outcome: RunOutcome) => void;
}

interface PollWorker {
  start(intervalMs: number): void;
  stop(): void;
}

interface WorkerEntry {
  readonly worker: PollWorker;
  readonly intervalMs: number;
  readonly label: string;
}

export interface WorkerSet {
  /** Labels of the workers wired for the selected `--mode` (e.g. `["claim", "retry"]`). */
  readonly labels: readonly string[];
  /** Starts every worker's poll loop. */
  start(): void;
  /** Stops every worker's poll loop. */
  stop(): void;
}

/**
 * Wires the worker(s) for the selected `--mode` over one engine + connection:
 * `tick` → the advisory-lock bulk `WorkflowWorker`; `claim` → the parallel
 * `ClaimingTimerWorker` over `PostgresTimerClaimStore`; `retry` → the
 * `RetryExecutorWorker` over `PostgresActivityRetryClaimStore`; `timeout` → the
 * `TimeoutSweeperWorker` over `PostgresInstanceTimeoutClaimStore` **plus** the
 * `ActivityTimeoutSweeperWorker` over `PostgresActivityTimeoutClaimStore` (both
 * deadline sweeps); `execute` →
 * the `ActivityExecutorWorker` over `PostgresActivityExecuteClaimStore` (the
 * async activity queue); `reap` → the `LeaseReaperWorker` over
 * `PostgresLeaseReaper` (clears expired leases); `all` → claim + retry + timeout
 * + execute + reap (the parallel production combo). Each worker polls on its own interval;
 * `start()` / `stop()` drive them together. The connection + engine come from
 * `buildPersistentEngine`, so every fire/retry persists through the projecting
 * event log.
 */
export function buildWorkerSet(input: BuildWorkerSetInput): WorkerSet {
  const schemaOpts = input.schema !== null ? { schema: input.schema } : {};
  const sched = input.scheduler !== undefined ? { scheduler: input.scheduler } : {};
  const onErr = input.onError !== undefined ? { onError: input.onError } : {};
  const onRun = input.onRun !== undefined ? { onRun: input.onRun } : {};
  const entries: WorkerEntry[] = [];

  const wantTick = input.mode === "tick";
  const wantClaim = input.mode === "claim" || input.mode === "all";
  const wantRetry = input.mode === "retry" || input.mode === "all";
  const wantTimeout = input.mode === "timeout" || input.mode === "all";
  const wantExecute = input.mode === "execute" || input.mode === "all";
  const wantReap = input.mode === "reap" || input.mode === "all";
  const wantResync = input.mode === "resync"; // opt-in, not in `all` (heavy re-projection)

  if (wantTick) {
    const tickOnRun =
      input.onRun !== undefined
        ? { onTick: (r: { firedTimerIds: readonly string[] }) => input.onRun?.({ claimed: r.firedTimerIds.length, processed: r.firedTimerIds.length }) }
        : {};
    const worker = new WorkflowWorker({ conn: input.conn, engine: input.engine, ...sched, ...onErr, ...tickOnRun });
    entries.push({ worker, intervalMs: input.tickIntervalMs, label: "tick" });
  }
  if (wantClaim) {
    const claimStore = new PostgresTimerClaimStore(input.conn, schemaOpts);
    const worker = new ClaimingTimerWorker({
      claimStore,
      engine: input.engine,
      workerId: input.workerId,
      batchSize: input.batchSize,
      leaseMs: input.leaseMs,
      ...sched,
      ...onErr,
      ...onRun,
    });
    entries.push({ worker, intervalMs: input.claimIntervalMs, label: "claim" });
  }
  if (wantRetry) {
    const claimStore = new PostgresActivityRetryClaimStore(input.conn, schemaOpts);
    const worker = new RetryExecutorWorker({
      claimStore,
      engine: input.engine,
      workerId: input.workerId,
      batchSize: input.batchSize,
      leaseMs: input.leaseMs,
      ...sched,
      ...onErr,
      ...onRun,
    });
    entries.push({ worker, intervalMs: input.retryIntervalMs, label: "retry" });
  }
  if (wantTimeout) {
    const claimStore = new PostgresInstanceTimeoutClaimStore(input.conn, schemaOpts);
    const worker = new TimeoutSweeperWorker({
      claimStore,
      engine: input.engine,
      workerId: input.workerId,
      batchSize: input.batchSize,
      leaseMs: input.leaseMs,
      ...sched,
      ...onErr,
      ...onRun,
    });
    entries.push({ worker, intervalMs: input.timeoutIntervalMs, label: "timeout" });
    const activityClaimStore = new PostgresActivityTimeoutClaimStore(input.conn, schemaOpts);
    const activityWorker = new ActivityTimeoutSweeperWorker({
      claimStore: activityClaimStore,
      engine: input.engine,
      workerId: input.workerId,
      batchSize: input.batchSize,
      leaseMs: input.leaseMs,
      ...sched,
      ...onErr,
      ...onRun,
    });
    entries.push({ worker: activityWorker, intervalMs: input.timeoutIntervalMs, label: "activity-timeout" });
  }
  if (wantExecute) {
    const claimStore = new PostgresActivityExecuteClaimStore(input.conn, schemaOpts);
    const worker = new ActivityExecutorWorker({
      claimStore,
      engine: input.engine,
      workerId: input.workerId,
      batchSize: input.batchSize,
      leaseMs: input.leaseMs,
      ...sched,
      ...onErr,
      ...onRun,
    });
    entries.push({ worker, intervalMs: input.executeIntervalMs, label: "execute" });
  }
  if (wantReap) {
    const reaper = new PostgresLeaseReaper(input.conn, schemaOpts);
    const worker = new LeaseReaperWorker({ reaper, ...sched, ...onErr, ...onRun });
    entries.push({ worker, intervalMs: input.reapIntervalMs, label: "reap" });
  }
  if (wantResync) {
    if (input.resyncer === undefined) throw new Error("--mode resync requires a resyncer (WorkflowReplayer)");
    const worker = new DriftSweepWorker({ resyncer: input.resyncer, maxInstances: input.resyncMax, ...sched, ...onErr, ...onRun });
    entries.push({ worker, intervalMs: input.resyncIntervalMs, label: "resync" });
  }

  return {
    labels: entries.map((e) => e.label),
    start() {
      for (const e of entries) e.worker.start(e.intervalMs);
    },
    stop() {
      for (const e of entries) e.worker.stop();
    },
  };
}
