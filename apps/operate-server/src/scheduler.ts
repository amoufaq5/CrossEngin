import type { JobDeclaration } from "@crossengin/jobs";
import type { PgConnection } from "@crossengin/kernel-pg";
import { enqueueScheduledJobs, type EnqueuedJobRun } from "@crossengin/workflow-runtime-pg";

import type { IntervalHandle, IntervalScheduler } from "./jwks.js";

const DEFAULT_SCHEDULER: IntervalScheduler = {
  setInterval(handler, ms) {
    const h = setInterval(handler, ms);
    (h as { unref?: () => void }).unref?.(); // don't keep the process alive
    return h;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

/**
 * Where the scheduler learns which tenants a cron job fires for. This is the explicit seam the
 * serving app fills — a cron job installed for a pack fires per tenant that has it, and the server
 * has no tenant registry of its own. `StaticTenantSource` covers a fixed deployment; a dynamic
 * implementation (querying the tenant table) drops in without touching the scheduler.
 */
export interface TenantSource {
  activeTenantIds(): Promise<readonly string[]> | readonly string[];
}

export class StaticTenantSource implements TenantSource {
  constructor(private readonly ids: readonly string[]) {}
  activeTenantIds(): readonly string[] {
    return this.ids;
  }
}

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const DEFAULT_TENANT_STATUSES = ["active"] as const;

export interface PostgresTenantSourceOptions {
  readonly schema?: string;
  /** Tenant statuses treated as active (default `['active']`); a suspended/deleted tenant is skipped. */
  readonly statuses?: readonly string[];
}

/**
 * A `TenantSource` that enumerates the live tenants from `meta.tenants` — so the scheduler fires cron
 * jobs for every active tenant without a hand-maintained list. Reads `id` where `status` is one of the
 * configured active statuses (default `active`), bound as a parameter; the schema identifier is
 * validated. Platform-scoped (the tenant registry is not RLS-guarded). Re-queried each tick, so a
 * newly-provisioned or newly-suspended tenant is picked up on the next pass.
 */
export class PostgresTenantSource implements TenantSource {
  private readonly schema: string;
  private readonly statuses: readonly string[];

  constructor(
    private readonly conn: PgConnection,
    options: PostgresTenantSourceOptions = {},
  ) {
    this.schema = options.schema ?? "meta";
    if (!SCHEMA_RE.test(this.schema)) throw new Error(`invalid schema identifier: ${JSON.stringify(this.schema)}`);
    this.statuses = options.statuses ?? DEFAULT_TENANT_STATUSES;
  }

  async activeTenantIds(): Promise<readonly string[]> {
    const result = await this.conn.query<{ id: unknown }>(
      `SELECT id FROM ${this.schema}.tenants WHERE status = ANY($1::text[]) ORDER BY id`,
      [this.statuses],
    );
    return result.rows
      .map((r) => (typeof r.id === "string" ? r.id : r.id instanceof Object ? String(r.id) : String(r.id ?? "")))
      .filter((id) => id.length > 0);
  }
}

/** What one tenant's tick enqueued (for metrics / logging). */
export interface SchedulerTickResult {
  readonly tenantId: string;
  readonly enqueued: readonly EnqueuedJobRun[];
}

export interface JobSchedulerOptions {
  readonly conn: PgConnection;
  /** The manifest's job declarations; only `scheduled`-trigger jobs are enqueued (the rest ignored). */
  readonly jobs: readonly JobDeclaration[];
  readonly tenants: TenantSource;
  readonly intervalMs: number;
  readonly schema?: string;
  readonly now?: () => Date;
  readonly scheduler?: IntervalScheduler;
  /** Run one tick immediately on start (default true; the deterministic run id makes it safe). */
  readonly runOnStart?: boolean;
  readonly onError?: (err: unknown) => void;
  readonly onTick?: (result: SchedulerTickResult) => void;
}

/**
 * Periodically fires the manifest's `scheduled` (cron) jobs into the durable `job_runs` queue for
 * each active tenant, so the distributed worker fleet picks them up — the producer side of the loop
 * living inside the serving app. Each tick calls `enqueueScheduledJobs` per tenant; because that
 * enqueue is idempotent (a deterministic `run_id` per cron tick + `ON CONFLICT DO NOTHING`), running
 * this on every replica and firing an extra tick on start are both safe. The timer is `unref`'d so it
 * never holds the process open; a per-tenant enqueue error is routed to `onError` and the loop
 * continues (one tenant's failure never blocks the others). Mirrors `JwksRefreshPoller`.
 */
export class JobScheduler {
  private handle: IntervalHandle | null = null;

  constructor(private readonly opts: JobSchedulerOptions) {}

  start(): void {
    if (this.handle !== null) return;
    if (this.opts.runOnStart !== false) void this.tick();
    this.handle = this.scheduler().setInterval(() => void this.tick(), this.opts.intervalMs);
  }

  stop(): void {
    if (this.handle === null) return;
    this.scheduler().clearInterval(this.handle);
    this.handle = null;
  }

  async tick(): Promise<void> {
    const now = (this.opts.now ?? (() => new Date()))().toISOString();
    const schemaOpt = this.opts.schema !== undefined ? { schema: this.opts.schema } : {};
    let tenantIds: readonly string[];
    try {
      tenantIds = await this.opts.tenants.activeTenantIds();
    } catch (err) {
      this.opts.onError?.(err);
      return;
    }
    for (const tenantId of tenantIds) {
      try {
        const enqueued = await enqueueScheduledJobs(this.opts.conn, {
          jobs: this.opts.jobs,
          tenantId,
          now,
          ...schemaOpt,
        });
        this.opts.onTick?.({ tenantId, enqueued });
      } catch (err) {
        this.opts.onError?.(err);
      }
    }
  }

  private scheduler(): IntervalScheduler {
    return this.opts.scheduler ?? DEFAULT_SCHEDULER;
  }
}
