import type { PgConnection } from "@crossengin/kernel-pg";

import type { Clock, IntervalHandle, IntervalScheduler, RunOutcome } from "./worker.js";
import { DEFAULT_SCHEDULER } from "./worker.js";
import { DEFAULT_STALE_AFTER_MS, type StaleWorkerAlert } from "./worker-health.js";

export type HeartbeatMode = "tick" | "claim" | "retry" | "timeout" | "execute" | "reap" | "all";
export type HeartbeatStatus = "starting" | "running" | "stopped";

/** A point-in-time view of a worker's liveness + cumulative counters. */
export interface HeartbeatSnapshot {
  readonly workerId: string;
  readonly mode: HeartbeatMode;
  readonly status: HeartbeatStatus;
  readonly hostname: string | null;
  readonly startedAt: string;
  readonly lastHeartbeatAt: string;
  readonly lastRunAt: string | null;
  readonly pollCount: number;
  readonly claimedTotal: number;
  readonly processedTotal: number;
  readonly errorCount: number;
  readonly lastError: string | null;
}

export interface WorkerHeartbeatOptions {
  readonly workerId: string;
  readonly mode: HeartbeatMode;
  readonly hostname?: string | null;
  readonly clock?: Clock;
}

/**
 * Pure, in-memory accumulator of a worker's heartbeat counters. `recordRun`
 * folds each poll's `RunOutcome` (from a worker's `onRun`) into running totals;
 * `recordError` counts failures (from `onError`); `snapshot()` stamps the
 * current `lastHeartbeatAt` and returns the immutable view the store persists.
 */
export class WorkerHeartbeat {
  private readonly workerId: string;
  private readonly mode: HeartbeatMode;
  private readonly hostname: string | null;
  private readonly clock: Clock;
  private readonly startedAt: string;
  private status: HeartbeatStatus = "starting";
  private lastRunAt: string | null = null;
  private pollCount = 0;
  private claimedTotal = 0;
  private processedTotal = 0;
  private errorCount = 0;
  private lastError: string | null = null;

  constructor(opts: WorkerHeartbeatOptions) {
    this.workerId = opts.workerId;
    this.mode = opts.mode;
    this.hostname = opts.hostname ?? null;
    this.clock = opts.clock ?? { now: () => new Date() };
    this.startedAt = this.clock.now().toISOString();
  }

  setStatus(status: HeartbeatStatus): void {
    this.status = status;
  }

  recordRun(outcome: RunOutcome): void {
    this.pollCount += 1;
    this.claimedTotal += outcome.claimed;
    this.processedTotal += outcome.processed;
    this.lastRunAt = this.clock.now().toISOString();
  }

  recordError(err: unknown): void {
    this.errorCount += 1;
    this.lastError = err instanceof Error ? err.message : String(err);
  }

  snapshot(): HeartbeatSnapshot {
    return {
      workerId: this.workerId,
      mode: this.mode,
      status: this.status,
      hostname: this.hostname,
      startedAt: this.startedAt,
      lastHeartbeatAt: this.clock.now().toISOString(),
      lastRunAt: this.lastRunAt,
      pollCount: this.pollCount,
      claimedTotal: this.claimedTotal,
      processedTotal: this.processedTotal,
      errorCount: this.errorCount,
      lastError: this.lastError,
    };
  }
}

export interface WorkerHeartbeatStore {
  upsert(snapshot: HeartbeatSnapshot): Promise<void>;
}

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * Persists heartbeats to `meta.worker_heartbeats` (a platform-wide table — no
 * RLS — since one worker spans all tenants), upserting on `worker_id` so a
 * restarted worker reuses its row. Counters + status + liveness timestamps are
 * overwritten each flush; `started_at` is preserved across re-inserts.
 */
export class PostgresWorkerHeartbeatStore implements WorkerHeartbeatStore {
  private readonly conn: PgConnection;
  private readonly table: string;

  constructor(conn: PgConnection, opts: { readonly schema?: string } = {}) {
    this.conn = conn;
    const schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema name: ${JSON.stringify(schema)}`);
    this.table = `${schema}.worker_heartbeats`;
  }

  async upsert(s: HeartbeatSnapshot): Promise<void> {
    await this.conn.query(
      `INSERT INTO ${this.table} (
         worker_id, mode, status, hostname, started_at, last_heartbeat_at,
         last_run_at, poll_count, claimed_total, processed_total, error_count, last_error
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (worker_id) DO UPDATE
         SET mode = EXCLUDED.mode,
             status = EXCLUDED.status,
             hostname = EXCLUDED.hostname,
             last_heartbeat_at = EXCLUDED.last_heartbeat_at,
             last_run_at = EXCLUDED.last_run_at,
             poll_count = EXCLUDED.poll_count,
             claimed_total = EXCLUDED.claimed_total,
             processed_total = EXCLUDED.processed_total,
             error_count = EXCLUDED.error_count,
             last_error = EXCLUDED.last_error`,
      [
        s.workerId, s.mode, s.status, s.hostname, s.startedAt, s.lastHeartbeatAt,
        s.lastRunAt, s.pollCount, s.claimedTotal, s.processedTotal, s.errorCount, s.lastError,
      ],
    );
  }

  /** Reads every heartbeat row (for an in-memory health summary). */
  async listAll(): Promise<readonly HeartbeatSnapshot[]> {
    const res = await this.conn.query<HeartbeatRow>(
      `SELECT worker_id, mode, status, hostname, started_at, last_heartbeat_at,
              last_run_at, poll_count, claimed_total, processed_total, error_count, last_error
         FROM ${this.table}
        ORDER BY last_heartbeat_at`,
    );
    return res.rows.map(rowToSnapshot);
  }

  /**
   * Pushes the stale-worker filter into SQL: `running` workers whose
   * `last_heartbeat_at` is older than `staleAfterMs` before `now`, as
   * `StaleWorkerAlert`s (with a computed `age_ms`), oldest first. The one-query
   * "who's dead" lookup.
   */
  async listStale(opts: { now: Date; staleAfterMs?: number }): Promise<readonly StaleWorkerAlert[]> {
    const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    const nowIso = opts.now.toISOString();
    const cutoffIso = new Date(opts.now.getTime() - staleAfterMs).toISOString();
    const res = await this.conn.query<StaleRow>(
      `SELECT worker_id, mode, hostname, last_heartbeat_at,
              (EXTRACT(EPOCH FROM ($1::timestamptz - last_heartbeat_at)) * 1000)::bigint AS age_ms
         FROM ${this.table}
        WHERE status = 'running' AND last_heartbeat_at < $2
        ORDER BY last_heartbeat_at`,
      [nowIso, cutoffIso],
    );
    return res.rows.map((r) => ({
      workerId: String(r.worker_id),
      mode: r.mode as StaleWorkerAlert["mode"],
      hostname: r.hostname === null ? null : String(r.hostname),
      lastHeartbeatAt: typeof r.last_heartbeat_at === "string" ? r.last_heartbeat_at : new Date(r.last_heartbeat_at as unknown as string).toISOString(),
      ageMs: Number(r.age_ms),
    }));
  }
}

interface HeartbeatRow {
  readonly worker_id: string;
  readonly mode: string;
  readonly status: string;
  readonly hostname: string | null;
  readonly started_at: string;
  readonly last_heartbeat_at: string;
  readonly last_run_at: string | null;
  readonly poll_count: string | number;
  readonly claimed_total: string | number;
  readonly processed_total: string | number;
  readonly error_count: string | number;
  readonly last_error: string | null;
}

interface StaleRow {
  readonly worker_id: string;
  readonly mode: string;
  readonly hostname: string | null;
  readonly last_heartbeat_at: string;
  readonly age_ms: string | number;
}

function isoOf(value: string): string {
  return typeof value === "string" ? value : new Date(value).toISOString();
}

function rowToSnapshot(r: HeartbeatRow): HeartbeatSnapshot {
  return {
    workerId: String(r.worker_id),
    mode: r.mode as HeartbeatMode,
    status: r.status as HeartbeatStatus,
    hostname: r.hostname === null ? null : String(r.hostname),
    startedAt: isoOf(r.started_at),
    lastHeartbeatAt: isoOf(r.last_heartbeat_at),
    lastRunAt: r.last_run_at === null ? null : isoOf(r.last_run_at),
    pollCount: Number(r.poll_count),
    claimedTotal: Number(r.claimed_total),
    processedTotal: Number(r.processed_total),
    errorCount: Number(r.error_count),
    lastError: r.last_error,
  };
}

export interface HeartbeatReporterOptions {
  readonly heartbeat: WorkerHeartbeat;
  readonly store: WorkerHeartbeatStore;
  readonly scheduler?: IntervalScheduler;
  readonly onError?: (err: unknown) => void;
}

/**
 * Drives a `WorkerHeartbeat` to its store: exposes `onRun` / `onError` handlers
 * to wire into every worker, flushes the snapshot on a poll interval (injectable
 * `unref`'d timer), and marks the row `running` on start / `stopped` on a final
 * flush. A failed flush routes to `onError` and never throws from the loop.
 */
export class HeartbeatReporter {
  private readonly heartbeat: WorkerHeartbeat;
  private readonly store: WorkerHeartbeatStore;
  private readonly scheduler: IntervalScheduler;
  private readonly onErrorCb?: (err: unknown) => void;
  private handle: IntervalHandle | null = null;

  constructor(opts: HeartbeatReporterOptions) {
    this.heartbeat = opts.heartbeat;
    this.store = opts.store;
    this.scheduler = opts.scheduler ?? DEFAULT_SCHEDULER;
    if (opts.onError !== undefined) this.onErrorCb = opts.onError;
  }

  /** Feed into each worker's `onRun`. */
  readonly onRun = (outcome: RunOutcome): void => {
    this.heartbeat.recordRun(outcome);
  };

  /** Feed into each worker's `onError`. */
  readonly onError = (err: unknown): void => {
    this.heartbeat.recordError(err);
  };

  async flush(): Promise<void> {
    await this.store.upsert(this.heartbeat.snapshot());
  }

  start(intervalMs: number): void {
    if (this.handle !== null) return;
    this.heartbeat.setStatus("running");
    void this.safeFlush();
    this.handle = this.scheduler.setInterval(() => void this.safeFlush(), intervalMs);
  }

  async stop(): Promise<void> {
    if (this.handle !== null) {
      this.scheduler.clearInterval(this.handle);
      this.handle = null;
    }
    this.heartbeat.setStatus("stopped");
    await this.safeFlush();
  }

  private async safeFlush(): Promise<void> {
    try {
      await this.flush();
    } catch (err) {
      this.onErrorCb?.(err);
    }
  }
}
