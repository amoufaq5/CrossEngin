import type { PgConnection } from "@crossengin/kernel-pg";
import {
  ClaimingTimerWorker,
  PostgresActivityRetryClaimStore,
  PostgresTimerClaimStore,
  RetryExecutorWorker,
  WorkflowWorker,
  type FireTimerEngine,
  type IntervalScheduler,
  type RetryActivityEngine,
  type TimerTickEngine,
} from "@crossengin/workflow-worker";

import type { WorkerMode } from "./cli.js";

/** The engine slice the worker set drives — all three per-mode capabilities. */
export interface WorkerEngine extends TimerTickEngine, FireTimerEngine, RetryActivityEngine {}

export interface BuildWorkerSetInput {
  readonly conn: PgConnection;
  readonly engine: WorkerEngine;
  readonly mode: WorkerMode;
  readonly workerId: string;
  readonly schema: string | null;
  readonly tickIntervalMs: number;
  readonly claimIntervalMs: number;
  readonly retryIntervalMs: number;
  readonly batchSize: number;
  readonly leaseMs: number;
  readonly scheduler?: IntervalScheduler;
  readonly onError?: (err: unknown) => void;
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
 * `RetryExecutorWorker` over `PostgresActivityRetryClaimStore`; `all` → claim +
 * retry (the parallel production combo). Each worker polls on its own interval;
 * `start()` / `stop()` drive them together. The connection + engine come from
 * `buildPersistentEngine`, so every fire/retry persists through the projecting
 * event log.
 */
export function buildWorkerSet(input: BuildWorkerSetInput): WorkerSet {
  const schemaOpts = input.schema !== null ? { schema: input.schema } : {};
  const sched = input.scheduler !== undefined ? { scheduler: input.scheduler } : {};
  const onErr = input.onError !== undefined ? { onError: input.onError } : {};
  const entries: WorkerEntry[] = [];

  const wantTick = input.mode === "tick";
  const wantClaim = input.mode === "claim" || input.mode === "all";
  const wantRetry = input.mode === "retry" || input.mode === "all";

  if (wantTick) {
    const worker = new WorkflowWorker({ conn: input.conn, engine: input.engine, ...sched, ...onErr });
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
    });
    entries.push({ worker, intervalMs: input.retryIntervalMs, label: "retry" });
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
