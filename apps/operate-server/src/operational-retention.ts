import {
  probeSessionPolicyVisibility,
  sessionWouldBeConfined,
  type PgConnection,
} from "@crossengin/kernel-pg";
import { withTenantContext } from "@crossengin/operate-runtime-pg";

import type { IntervalHandle, IntervalScheduler } from "./jwks.js";

/**
 * Retention for the operational tables that grow with traffic and are read only while recent.
 *
 * Four tables, and the selection is the decision. Each is a log of something that already
 * happened and is consulted only near the time it happened — a finished job run, a sampled request
 * execution, a rate-limit decision row (the limiter counts in memory and never reads it back), a
 * finished notification dispatch. None is in the Article 17 retention set (`PLATFORM_RECORD_TABLES`
 * or `STATUTORY_RETENTION_TABLES`), none carries a restrictive `DELETE` fence, and each one's
 * isolation arm is `ALL`-scope, so a tenant-context `DELETE` of that tenant's own rows is admitted
 * for the confined serving role. The chain, the audit log and every other retained record are
 * deliberately absent: their growth is unreclaimable by design. Gateway idempotency records have
 * their own reaper (`IdempotencyPruneScheduler`), keyed on each record's own expiry.
 *
 * Batched `DELETE … WHERE id IN (SELECT id … ORDER BY <time> LIMIT n)` rather than time
 * partitioning, which was weighed and refused: a partitioned table's unique constraints must carry
 * the partition key, so `(tenant_id, run_id)` and `(tenant_id, idempotency_key)` — the constraints
 * that make job enqueueing and dispatch idempotent — would weaken to per-partition; the reconciler
 * cannot convert a populated table to a partitioned one; and dropping a partition is a cross-tenant
 * act only the owner may do. Every candidate query here is served by an index the catalog already
 * declares on `(tenant_id, <time column>)`.
 */
export const RETENTION_TABLES = [
  "job_runs",
  "gateway_pipeline_executions",
  "rate_limit_decisions",
  "notification_dispatches",
] as const;

export type RetentionTable = (typeof RETENTION_TABLES)[number];

export interface RetentionTableSpec {
  readonly qualified: string;
  readonly defaultDays: number;
  /** What a pass never deletes, said on the boot line. */
  readonly keeps: string;
  /** `$1` tenant, `$2` cutoff instant, `$3` batch size. */
  readonly tenantSql: string;
  /**
   * `$1` cutoff, `$2` batch size, for a table whose `tenant_id` is nullable (platform scope). No
   * policy grants a non-owner `DELETE` of a platform row on either table, so this runs only for a
   * session `row_security_active` says is not confined.
   */
  readonly platformSql: string | null;
}

/**
 * `job_runs` keeps the **newest** run of every job whatever its age, and that clause is the reason
 * this table cannot be pruned by age alone: `enqueueScheduledJobs` derives a scheduled run's id from
 * `(tenant, job, fireAt)` for the latest cron tick only, and the row *is* the scheduler's memory —
 * so deleting the latest run of a monthly or yearly job makes the next tick re-insert it and the job
 * runs twice. Only terminal runs are candidates; a `pending` run is work, not history.
 */
export const RETENTION_TABLE_SPECS: Readonly<Record<RetentionTable, RetentionTableSpec>> = {
  job_runs: {
    qualified: "meta.job_runs",
    defaultDays: 90,
    keeps: "pending and running runs, and every job's newest run",
    tenantSql: `DELETE FROM meta.job_runs WHERE id IN (
  SELECT r.id FROM meta.job_runs r
   WHERE r.tenant_id = $1 AND r.started_at < $2::timestamptz
     AND r.status IN ('completed', 'failed', 'dead-lettered', 'cancelled')
     AND EXISTS (SELECT 1 FROM meta.job_runs n
                  WHERE n.tenant_id = r.tenant_id AND n.job_id = r.job_id
                    AND n.started_at > r.started_at)
   ORDER BY r.started_at LIMIT $3)`,
    platformSql: null,
  },
  gateway_pipeline_executions: {
    qualified: "meta.gateway_pipeline_executions",
    defaultDays: 30,
    keeps: "nothing younger than the period",
    tenantSql: `DELETE FROM meta.gateway_pipeline_executions WHERE id IN (
  SELECT id FROM meta.gateway_pipeline_executions
   WHERE tenant_id = $1 AND started_at < $2::timestamptz ORDER BY started_at LIMIT $3)`,
    platformSql: `DELETE FROM meta.gateway_pipeline_executions WHERE id IN (
  SELECT id FROM meta.gateway_pipeline_executions
   WHERE tenant_id IS NULL AND started_at < $1::timestamptz ORDER BY started_at LIMIT $2)`,
  },
  rate_limit_decisions: {
    qualified: "meta.rate_limit_decisions",
    defaultDays: 30,
    keeps: "nothing younger than the period",
    tenantSql: `DELETE FROM meta.rate_limit_decisions WHERE id IN (
  SELECT id FROM meta.rate_limit_decisions
   WHERE tenant_id = $1 AND decided_at < $2::timestamptz ORDER BY decided_at LIMIT $3)`,
    platformSql: `DELETE FROM meta.rate_limit_decisions WHERE id IN (
  SELECT id FROM meta.rate_limit_decisions
   WHERE tenant_id IS NULL AND decided_at < $1::timestamptz ORDER BY decided_at LIMIT $2)`,
  },
  notification_dispatches: {
    qualified: "meta.notification_dispatches",
    defaultDays: 365,
    keeps: "undelivered dispatches; deliveries, digest items and read state go with their dispatch",
    tenantSql: `DELETE FROM meta.notification_dispatches WHERE id IN (
  SELECT id FROM meta.notification_dispatches
   WHERE tenant_id = $1 AND queued_at < $2::timestamptz
     AND status IN ('completed', 'failed', 'cancelled')
   ORDER BY queued_at LIMIT $3)`,
    platformSql: null,
  },
};

/** Days per table, `null` meaning the table is not pruned. */
export type RetentionPolicy = Readonly<Record<RetentionTable, number | null>>;

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = Object.freeze(
  Object.fromEntries(RETENTION_TABLES.map((t) => [t, RETENTION_TABLE_SPECS[t].defaultDays])) as Record<
    RetentionTable,
    number
  >,
);

export const RETENTION_FLAG = "--retention";
const MAX_RETENTION_DAYS = 36_500;

export class RetentionPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetentionPolicyError";
  }
}

function isRetentionTable(value: string): value is RetentionTable {
  return (RETENTION_TABLES as readonly string[]).includes(value);
}

/**
 * Folds `--retention <table>=<days|off>` specs over the defaults. A table named twice is refused,
 * because which of two retention periods deletes a deployment's history must not depend on argv
 * order.
 *
 * One cross-table rule: `rate_limit_decisions` may not be pruned sooner than
 * `gateway_pipeline_executions`, since a captured execution names its decision and the replayer
 * reports an execution whose decision row is gone as drift.
 */
export function resolveRetentionPolicy(specs: readonly string[]): RetentionPolicy {
  const policy: Record<RetentionTable, number | null> = { ...DEFAULT_RETENTION_POLICY };
  const seen = new Set<RetentionTable>();
  for (const spec of specs) {
    const eq = spec.indexOf("=");
    const table = eq < 0 ? spec : spec.slice(0, eq);
    const value = eq < 0 ? "" : spec.slice(eq + 1);
    if (!isRetentionTable(table)) {
      throw new RetentionPolicyError(
        `${RETENTION_FLAG} ${JSON.stringify(spec)}: the table must be one of ${RETENTION_TABLES.join(", ")}`,
      );
    }
    if (seen.has(table)) {
      throw new RetentionPolicyError(`${RETENTION_FLAG} names ${table} twice`);
    }
    seen.add(table);
    if (value === "off") {
      policy[table] = null;
      continue;
    }
    const days = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(days) || days < 1 || days > MAX_RETENTION_DAYS) {
      throw new RetentionPolicyError(
        `${RETENTION_FLAG} ${JSON.stringify(spec)}: expected ${table}=<days 1..${String(MAX_RETENTION_DAYS)}> or ${table}=off`,
      );
    }
    policy[table] = days;
  }
  const executions = policy.gateway_pipeline_executions;
  const decisions = policy.rate_limit_decisions;
  if (decisions !== null && (executions === null || executions > decisions)) {
    throw new RetentionPolicyError(
      `${RETENTION_FLAG}: rate_limit_decisions (${String(decisions)} days) must not be pruned sooner ` +
        `than gateway_pipeline_executions (${executions === null ? "off" : `${String(executions)} days`}): ` +
        "a captured execution names its decision row, and the replayer reports one whose decision is gone",
    );
  }
  return policy;
}

/** The boot line, said either way including when every table is off. */
export function formatRetentionPolicy(policy: RetentionPolicy, intervalMs: number): string {
  const parts = RETENTION_TABLES.map((t) => {
    const days = policy[t];
    return days === null ? `${t} off` : `${t} ${String(days)}d (keeps ${RETENTION_TABLE_SPECS[t].keeps})`;
  });
  const platform = RETENTION_TABLES.filter((t) => RETENTION_TABLE_SPECS[t].platformSql !== null);
  return (
    `operational retention every ${String(Math.round(intervalMs / 60_000))} min: ${parts.join("; ")}. ` +
    `Platform-scope rows of ${platform.join(" and ")} are pruned only by a session RLS does not ` +
    `confine — no policy grants the serving role DELETE on them. Set ${RETENTION_FLAG} <table>=<days|off>.`
  );
}

export const DEFAULT_RETENTION_BATCH_SIZE = 1000;
export const DEFAULT_RETENTION_MAX_BATCHES = 50;

export type PlatformScopeOutcome = "not_applicable" | "pruned" | "confined" | "off";

export interface RetentionTableResult {
  readonly table: RetentionTable;
  readonly deleted: number;
  /** Scopes (tenants, or the platform) a pass stopped at its batch budget with rows left to go. */
  readonly truncatedScopes: number;
  readonly platform: PlatformScopeOutcome;
  readonly failures: readonly { readonly scope: string; readonly message: string }[];
}

export interface RetentionPassResult {
  readonly tenantsSwept: number;
  readonly tables: readonly RetentionTableResult[];
}

export interface RetentionPassOptions {
  readonly conn: PgConnection;
  readonly tenants: { activeTenantIds(): Promise<readonly string[]> | readonly string[] };
  readonly policy: RetentionPolicy;
  readonly now?: () => Date;
  readonly batchSize?: number;
  readonly maxBatches?: number;
}

const DAY_MS = 86_400_000;

async function drain(
  run: (batch: number) => Promise<number>,
  batchSize: number,
  maxBatches: number,
): Promise<{ deleted: number; truncated: boolean }> {
  let deleted = 0;
  for (let i = 0; i < maxBatches; i++) {
    const n = await run(batchSize);
    deleted += n;
    if (n < batchSize) return { deleted, truncated: false };
  }
  return { deleted, truncated: true };
}

/** An absent table reads as confined: there is nothing this session could prune there anyway. */
async function platformConfined(conn: PgConnection, table: string): Promise<boolean> {
  const visibility = await probeSessionPolicyVisibility(conn, "meta", table);
  return visibility === null || sessionWouldBeConfined(visibility);
}

/**
 * One pass over every table the policy prunes. Each batch is its own short transaction under the
 * tenant's own context, so a pass never holds a lock or a snapshot across a tenant, and the
 * `tenant_id = $1` predicate is beside RLS rather than relying on it (an owner session bypasses
 * RLS). A failing scope is collected and the pass continues, `pruneIdempotencyRecords`' rule.
 */
export async function pruneOperationalTables(
  opts: RetentionPassOptions,
): Promise<RetentionPassResult> {
  const now = (opts.now ?? (() => new Date()))();
  const batchSize = opts.batchSize ?? DEFAULT_RETENTION_BATCH_SIZE;
  const maxBatches = opts.maxBatches ?? DEFAULT_RETENTION_MAX_BATCHES;
  const tenantIds = await opts.tenants.activeTenantIds();
  const tables: RetentionTableResult[] = [];
  for (const table of RETENTION_TABLES) {
    const spec = RETENTION_TABLE_SPECS[table];
    const days = opts.policy[table];
    if (days === null) {
      tables.push({ table, deleted: 0, truncatedScopes: 0, platform: "off", failures: [] });
      continue;
    }
    const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
    let deleted = 0;
    let truncatedScopes = 0;
    const failures: { scope: string; message: string }[] = [];
    for (const tenantId of tenantIds) {
      try {
        const r = await drain(
          (limit) =>
            withTenantContext(opts.conn, tenantId, async (tx) => {
              const res = await tx.query(spec.tenantSql, [tenantId, cutoff, limit]);
              return res.rowCount;
            }),
          batchSize,
          maxBatches,
        );
        deleted += r.deleted;
        if (r.truncated) truncatedScopes += 1;
      } catch (err) {
        failures.push({ scope: tenantId, message: err instanceof Error ? err.message : String(err) });
      }
    }
    let platform: PlatformScopeOutcome = "not_applicable";
    const platformSql = spec.platformSql;
    if (platformSql !== null) {
      try {
        if (await platformConfined(opts.conn, table)) {
          platform = "confined";
        } else {
          const r = await drain(
            async (limit) => (await opts.conn.query(platformSql, [cutoff, limit])).rowCount,
            batchSize,
            maxBatches,
          );
          deleted += r.deleted;
          if (r.truncated) truncatedScopes += 1;
          platform = "pruned";
        }
      } catch (err) {
        failures.push({ scope: "platform", message: err instanceof Error ? err.message : String(err) });
      }
    }
    tables.push({ table, deleted, truncatedScopes, platform, failures });
  }
  return { tenantsSwept: tenantIds.length, tables };
}

/** Hourly: the periods are days, so an hour is fine-grained and far cheaper than the traffic. */
export const DEFAULT_RETENTION_INTERVAL_MS = 3_600_000;

const DEFAULT_SCHEDULER: IntervalScheduler = {
  setInterval(handler, ms) {
    const h = setInterval(handler, ms);
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

export interface OperationalRetentionSchedulerOptions extends RetentionPassOptions {
  readonly intervalMs?: number;
  readonly scheduler?: IntervalScheduler;
  readonly onPass: (result: RetentionPassResult) => void;
  readonly onError: (err: unknown) => void;
}

/**
 * Runs the pass on a timer, sweeping at start like `IdempotencyPruneScheduler` — the rows it deletes
 * are ones nothing reads any more. A pass already in flight makes a tick a no-op, so a slow pass over
 * a large backlog cannot stack.
 */
export class OperationalRetentionScheduler {
  private handle: IntervalHandle | null = null;
  private inFlight = false;

  constructor(private readonly opts: OperationalRetentionSchedulerOptions) {}

  start(): void {
    if (this.handle !== null) return;
    void this.passOnce();
    this.handle = (this.opts.scheduler ?? DEFAULT_SCHEDULER).setInterval(
      () => void this.passOnce(),
      this.opts.intervalMs ?? DEFAULT_RETENTION_INTERVAL_MS,
    );
  }

  stop(): void {
    if (this.handle === null) return;
    (this.opts.scheduler ?? DEFAULT_SCHEDULER).clearInterval(this.handle);
    this.handle = null;
  }

  /** `null` when a pass was already running. */
  async passOnce(): Promise<RetentionPassResult | null> {
    if (this.inFlight) return null;
    this.inFlight = true;
    try {
      const result = await pruneOperationalTables(this.opts);
      this.opts.onPass(result);
      return result;
    } catch (err) {
      this.opts.onError(err);
      return null;
    } finally {
      this.inFlight = false;
    }
  }
}

/** The per-pass log line, naming every table so a quiet pass reads as a pass and not a silence. */
export function formatRetentionPass(result: RetentionPassResult): string {
  const parts = result.tables.map((t) => {
    if (t.platform === "off") return `${t.table} off`;
    const extra = [
      t.truncatedScopes > 0 ? `${String(t.truncatedScopes)} scope(s) left for the next pass` : null,
      t.platform === "confined" ? "platform rows not pruned (confined)" : null,
      t.failures.length > 0 ? `${String(t.failures.length)} failure(s)` : null,
    ].filter((x): x is string => x !== null);
    return `${t.table} ${String(t.deleted)} deleted${extra.length > 0 ? ` (${extra.join(", ")})` : ""}`;
  });
  return `retention pass over ${String(result.tenantsSwept)} tenant(s): ${parts.join("; ")}`;
}
