import type { PgConnection } from "@crossengin/kernel-pg";
import {
  ClaimingTimerWorker,
  PostgresActivityRetryClaimStore,
  PostgresInstanceTimeoutClaimStore,
  PostgresTimerClaimStore,
  RetryExecutorWorker,
  TimeoutSweeperWorker,
  WorkflowWorker,
  type FireTimerEngine,
  type IntervalScheduler,
  type RetryActivityEngine,
  type RunOutcome,
  type TimeoutInstanceEngine,
  type TimerTickEngine,
} from "@crossengin/workflow-worker";

import type { WorkerMode } from "./cli.js";

/** The engine slice the worker set drives — all four per-mode capabilities. */
export interface WorkerEngine
  extends TimerTickEngine,
    FireTimerEngine,
    RetryActivityEngine,
    TimeoutInstanceEngine {}

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
  readonly batchSize: number;
  readonly leaseMs: number;
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
 * `TimeoutSweeperWorker` over `PostgresInstanceTimeoutClaimStore`; `all` → claim
 * + retry + timeout (the parallel production combo). Each worker polls on its own interval;
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
