import type { PgConnection } from "@crossengin/kernel-pg";
import type { TickTimersResult } from "@crossengin/workflow-runtime";

import { DEFAULT_WORKFLOW_TICK_NAMESPACE, advisoryLockKey } from "./lock-key.js";

/** The slice of `WorkflowEngine` the worker drives (just the timer tick). */
export interface TimerTickEngine {
  tickTimers(nowMs: number): Promise<TickTimersResult>;
}

export interface Clock {
  now(): Date;
}

export type IntervalHandle = unknown;

/** Injectable timer (defaults to the global one) so the poll loop is deterministic in tests. */
export interface IntervalScheduler {
  setInterval(handler: () => void, ms: number): IntervalHandle;
  clearInterval(handle: IntervalHandle): void;
}

export const DEFAULT_SCHEDULER: IntervalScheduler = {
  setInterval(handler, ms) {
    const h = setInterval(handler, ms);
    (h as { unref?: () => void }).unref?.(); // don't keep the process alive
    return h;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

export interface WorkflowWorkerOptions {
  readonly conn: PgConnection;
  readonly engine: TimerTickEngine;
  /** Advisory-lock key that serializes the tick across workers (default `crossengin.workflow.tick`). */
  readonly lockKey?: bigint;
  readonly clock?: Clock;
  readonly onTick?: (result: TickTimersResult) => void;
  readonly onError?: (err: unknown) => void;
  readonly scheduler?: IntervalScheduler;
}

export interface WorkerStatus {
  readonly running: boolean;
  readonly tickCount: number;
  readonly lastTickAt: string | null;
  readonly lastFiredCount: number;
}

/**
 * A distributed workflow worker: advances time-based workflow progression
 * (firing due timers, which drives the engine's auto-transitions) on a poll
 * interval, **coordinated by a Postgres advisory lock** so that running N worker
 * processes is safe — only one ticks at a time, and the engine's
 * `status='scheduled'` check means even a racing tick can't double-fire a timer.
 * If the lock holder's session dies, Postgres releases the advisory lock and
 * another worker takes over (failover). Per-unit `FOR UPDATE SKIP LOCKED`
 * claiming + decoupled async activity execution are the deeper follow-up.
 */
export class WorkflowWorker {
  private readonly conn: PgConnection;
  private readonly engine: TimerTickEngine;
  private readonly lockKey: bigint;
  private readonly clock: Clock;
  private readonly onTick?: (result: TickTimersResult) => void;
  private readonly onError?: (err: unknown) => void;
  private readonly scheduler: IntervalScheduler;
  private handle: IntervalHandle | null = null;
  private tickCount = 0;
  private lastTickAt: string | null = null;
  private lastFiredCount = 0;

  constructor(opts: WorkflowWorkerOptions) {
    this.conn = opts.conn;
    this.engine = opts.engine;
    this.lockKey = opts.lockKey ?? advisoryLockKey(DEFAULT_WORKFLOW_TICK_NAMESPACE);
    this.clock = opts.clock ?? { now: () => new Date() };
    if (opts.onTick !== undefined) this.onTick = opts.onTick;
    if (opts.onError !== undefined) this.onError = opts.onError;
    this.scheduler = opts.scheduler ?? DEFAULT_SCHEDULER;
  }

  /**
   * Runs one tick: acquires the advisory lock, fires due timers via the engine,
   * releases the lock. Returns the engine's result (fired timer ids + affected
   * instances). Safe to call concurrently from multiple processes — the lock
   * serializes them.
   */
  async tickOnce(): Promise<TickTimersResult> {
    const result = await this.conn.withAdvisoryLock(this.lockKey, () =>
      this.engine.tickTimers(this.clock.now().getTime()),
    );
    this.tickCount += 1;
    this.lastTickAt = this.clock.now().toISOString();
    this.lastFiredCount = result.firedTimerIds.length;
    this.onTick?.(result);
    return result;
  }

  /** Begins polling: ticks every `intervalMs` (errors routed to `onError`, never thrown from the loop). */
  start(intervalMs: number): void {
    if (this.handle !== null) return;
    this.handle = this.scheduler.setInterval(() => void this.safeTick(), intervalMs);
  }

  /** Stops the poll loop (the in-flight tick, if any, completes). */
  stop(): void {
    if (this.handle === null) return;
    this.scheduler.clearInterval(this.handle);
    this.handle = null;
  }

  status(): WorkerStatus {
    return {
      running: this.handle !== null,
      tickCount: this.tickCount,
      lastTickAt: this.lastTickAt,
      lastFiredCount: this.lastFiredCount,
    };
  }

  private async safeTick(): Promise<void> {
    try {
      await this.tickOnce();
    } catch (err) {
      this.onError?.(err);
    }
  }
}
