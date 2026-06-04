import type { PgConnection } from "@crossengin/kernel-pg";

import type { Clock, IntervalHandle, IntervalScheduler, RunOutcome } from "./worker.js";
import { DEFAULT_SCHEDULER } from "./worker.js";

/** Per-table count of leases cleared by a reap pass. */
export interface LeaseReapResult {
  readonly timers: number;
  readonly activities: number;
  readonly instances: number;
  readonly total: number;
}

export interface LeaseReaper {
  reapExpired(now: Date): Promise<LeaseReapResult>;
}

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * Proactively clears **expired** worker leases (`lease_expires_at < now`) across
 * the three lease-bearing tables (`workflow_timers` / `workflow_activities` /
 * `workflow_instances`), so a crashed worker's claimed rows are visibly
 * unclaimed without waiting for the next claim pass to skip them. It only touches
 * *expired* leases — a live worker holding a valid (future) lease is untouched —
 * and the engine's idempotent claim primitives already make a reclaim safe, so
 * reaping is no less safe than the lazy `OR lease_expires_at < now` reclaim the
 * claim stores do.
 */
export class PostgresLeaseReaper implements LeaseReaper {
  private readonly conn: PgConnection;
  private readonly schema: string;

  constructor(conn: PgConnection, opts: { readonly schema?: string } = {}) {
    this.conn = conn;
    const schema = opts.schema ?? "meta";
    if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema name: ${JSON.stringify(schema)}`);
    this.schema = schema;
  }

  private async reapTable(table: string, nowIso: string): Promise<number> {
    const res = await this.conn.query(
      `UPDATE ${this.schema}.${table}
          SET claimed_by = NULL, lease_expires_at = NULL
        WHERE lease_expires_at IS NOT NULL AND lease_expires_at < $1`,
      [nowIso],
    );
    return res.rowCount;
  }

  async reapExpired(now: Date): Promise<LeaseReapResult> {
    const nowIso = now.toISOString();
    const timers = await this.reapTable("workflow_timers", nowIso);
    const activities = await this.reapTable("workflow_activities", nowIso);
    const instances = await this.reapTable("workflow_instances", nowIso);
    return { timers, activities, instances, total: timers + activities + instances };
  }
}

export interface LeaseReaperWorkerOptions {
  readonly reaper: LeaseReaper;
  readonly clock?: Clock;
  readonly onError?: (err: unknown) => void;
  readonly onRun?: (outcome: RunOutcome) => void;
  readonly scheduler?: IntervalScheduler;
}

export interface ReapRunResult {
  readonly reaped: number;
}

/**
 * Polls the `LeaseReaper` on an interval, clearing expired leases proactively.
 * Emits a `RunOutcome` ({claimed: 0, processed: reaped}) via `onRun` for the
 * heartbeat, routes errors to `onError`, never throws from the loop. The
 * maintenance counterpart to the claim/execute workers.
 */
export class LeaseReaperWorker {
  private readonly reaper: LeaseReaper;
  private readonly clock: Clock;
  private readonly onError?: (err: unknown) => void;
  private readonly onRun?: (outcome: RunOutcome) => void;
  private readonly scheduler: IntervalScheduler;
  private handle: IntervalHandle | null = null;

  constructor(opts: LeaseReaperWorkerOptions) {
    this.reaper = opts.reaper;
    this.clock = opts.clock ?? { now: () => new Date() };
    if (opts.onError !== undefined) this.onError = opts.onError;
    if (opts.onRun !== undefined) this.onRun = opts.onRun;
    this.scheduler = opts.scheduler ?? DEFAULT_SCHEDULER;
  }

  async runOnce(): Promise<ReapRunResult> {
    const result = await this.reaper.reapExpired(this.clock.now());
    return { reaped: result.total };
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
      this.onRun?.({ claimed: 0, processed: result.reaped });
    } catch (err) {
      this.onError?.(err);
    }
  }
}
