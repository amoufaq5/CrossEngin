import { createHash } from "node:crypto";

import type { PgConnection } from "@crossengin/kernel-pg";
import {
  planJobRunsForEvent,
  planUserInvokedJobRuns,
  scheduledJobsDue,
  type DomainEvent,
  type JobDeclaration,
  type PlannedJobRun,
  type UserInvocation,
} from "@crossengin/jobs";

import { withTenantContext } from "./tenant-context.js";

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;
const DEFAULT_SCHEMA = "meta";

/** A fixed CrossEngin namespace UUID for deriving deterministic v5 run ids from an idempotency key. */
const RUN_ID_NAMESPACE = "8b1a9953-c461-4b6d-9f3e-0c5a2f7d41aa";

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * A deterministic RFC 4122 v5 UUID over `(namespace, name)` — the same idempotency key always yields
 * the same run id, so a re-delivered event's `INSERT` collides on `(tenant_id, run_id)` and is a
 * no-op rather than a duplicate run.
 */
export function deterministicRunId(name: string, namespace: string = RUN_ID_NAMESPACE): string {
  const hash = createHash("sha1").update(Buffer.concat([uuidToBytes(namespace), Buffer.from(name, "utf8")])).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  return bytesToUuid(bytes);
}

/** One planned run resolved to its deterministic run id (what actually hits the table). */
export interface EnqueuedJobRun {
  readonly jobId: string;
  readonly runId: string;
  /** `false` when the row already existed (a re-delivered event) — an idempotent no-op. */
  readonly inserted: boolean;
}

export interface EnqueueJobsForEventOptions {
  readonly event: DomainEvent;
  readonly jobs: readonly JobDeclaration[];
  /** Enqueue time; becomes `started_at` (the due column), so event runs are immediately claimable. */
  readonly now: string;
  readonly schema?: string;
}

/**
 * The producer half of the distributed job loop: for every job an event triggers (pure
 * `planJobRunsForEvent`), inserts a `pending` `job_runs` row a worker will then claim + execute. The
 * `run_id` is derived deterministically from the plan's idempotency key, so the insert is
 * `ON CONFLICT (tenant_id, run_id) DO NOTHING` — a re-delivered event never enqueues a duplicate run
 * (`inserted: false`). `started_at` is set to `now`, so the run is immediately due. All values are
 * bound; the validated schema is the only interpolated identifier.
 *
 * The clause this replaced claimed "the connection is platform-scoped (RLS-bypassing), with
 * `tenant_id` bound from the event on each row", and it was the premise that made a bare
 * `conn.query` here read as correct. It is false twice: the caller passes the ordinary serving
 * connection (`PostgresEntityEventSink`'s own `this.conn`), and *RLS-bypassing* is a property of the
 * **role**, true only for the table's owner. `meta.job_runs` carries one `ALL`-scope isolation
 * policy with a NULL `WITH CHECK`, so as any other role the write check is
 * `tenant_id = NULL` — never true. The tenant context is established in `insertPlannedRuns` now;
 * see `tenant-context.ts` for the live measurement and for why a platform write arm cannot serve
 * this table.
 */
export async function enqueueJobsForEvent(
  conn: PgConnection,
  options: EnqueueJobsForEventOptions,
): Promise<readonly EnqueuedJobRun[]> {
  const schema = options.schema ?? DEFAULT_SCHEMA;
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);

  const planned = planJobRunsForEvent(options.event, options.jobs);
  return insertPlannedRuns(conn, schema, options.event.tenantId, options.now, planned);
}

/**
 * Inserts a `pending` `job_runs` row per planned run (shared by the event / delayed / userInvoked
 * producers). The `run_id` is deterministic from the plan's `runKey`, so the insert is
 * `ON CONFLICT (tenant_id, run_id) DO NOTHING` — a duplicate producer pass is a no-op
 * (`inserted: false`). `started_at` is `now + delayMs` (a delayed trigger defers past the enqueue
 * time; every other kind has `delayMs 0` → `now`, immediately due). All values are bound; the caller
 * has already validated the schema identifier.
 *
 * The whole batch runs inside **one** tenant-scoped transaction, which is where both of its callers
 * get their RLS context — one place rather than two, because the scope is the same fact for both
 * (`options.event.tenantId` and `options.invocation.tenantId` are each the tenant being enqueued
 * for). `enqueueScheduledJobs` does **not** come through here: it has its own statement, which is
 * why it carries its own wrapper, and a fix applied to this function alone would have left the one
 * producer `--schedule-ms` drives still raising 42501.
 */
async function insertPlannedRuns(
  conn: PgConnection,
  schema: string,
  tenantId: string,
  now: string,
  planned: readonly PlannedJobRun[],
): Promise<readonly EnqueuedJobRun[]> {
  if (planned.length === 0) return [];
  return withTenantContext(conn, tenantId, async (tx) => insertPlannedRunsWithin(tx, schema, tenantId, now, planned));
}

/** The statements themselves, inside a caller's tenant-scoped transaction. */
async function insertPlannedRunsWithin(
  conn: PgConnection,
  schema: string,
  tenantId: string,
  now: string,
  planned: readonly PlannedJobRun[],
): Promise<readonly EnqueuedJobRun[]> {
  const results: EnqueuedJobRun[] = [];
  for (const plan of planned) {
    const runId = deterministicRunId(plan.runKey);
    const startedAt =
      plan.delayMs > 0 ? new Date(new Date(now).getTime() + plan.delayMs).toISOString() : now;
    const result = await conn.query<{ run_id: unknown }>(
      `INSERT INTO ${schema}.job_runs
         (tenant_id, job_id, job_kind, run_id, trigger, started_at, status,
          input_redacted, input_data_class, output_data_class, attempts)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5::jsonb, $6::timestamptz, 'pending',
               $7::jsonb, $8, $9, 1)
       ON CONFLICT (tenant_id, run_id) DO NOTHING
       RETURNING run_id`,
      [
        tenantId,
        plan.jobId,
        plan.jobKind,
        runId,
        JSON.stringify(plan.trigger),
        startedAt,
        JSON.stringify(plan.input),
        plan.inputDataClass,
        plan.outputDataClass,
      ],
    );
    results.push({ jobId: plan.jobId, runId, inserted: (result.rowCount ?? 0) > 0 });
  }
  return results;
}

export interface EnqueueUserInvokedJobOptions {
  readonly invocation: UserInvocation;
  readonly jobs: readonly JobDeclaration[];
  readonly now: string;
  readonly schema?: string;
}

/**
 * The on-demand producer: for every `userInvoked`-trigger job whose `action` matches a user/API
 * invocation (pure `planUserInvokedJobRuns`), inserts a `pending` `job_runs` row a worker claims +
 * executes. Idempotent by the same deterministic-`run_id` + `ON CONFLICT DO NOTHING` mechanism as the
 * event producer, so a re-submitted invocation (same `idempotencyKey` / payload) never double-runs.
 */
export async function enqueueUserInvokedJob(
  conn: PgConnection,
  options: EnqueueUserInvokedJobOptions,
): Promise<readonly EnqueuedJobRun[]> {
  const schema = options.schema ?? DEFAULT_SCHEMA;
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);
  const planned = planUserInvokedJobRuns(options.invocation, options.jobs);
  return insertPlannedRuns(conn, schema, options.invocation.tenantId, options.now, planned);
}

export interface EnqueueScheduledJobsOptions {
  readonly jobs: readonly JobDeclaration[];
  readonly tenantId: string;
  /** The scheduler's current wall-clock; each due job resolves to its current cron tick. */
  readonly now: string;
  readonly schema?: string;
}

/**
 * The scheduled (cron) producer: for every scheduled job due as of `now` (pure `scheduledJobsDue` →
 * the current cron tick), inserts a `pending` `job_runs` row a worker will claim + execute. The
 * `run_id` is derived deterministically from `(tenant, job, fireAt)`, so every scheduler pass within
 * the same tick window computes the same id — the `ON CONFLICT (tenant_id, run_id) DO NOTHING` insert
 * fires the tick exactly once with no last-fired state table (the row *is* the state). `started_at`
 * is the tick instant (≤ now), so the run is immediately due for the claim. Overlapping schedulers /
 * multiple replicas are safe: they race on the same run id and only one wins.
 *
 * Its own statement rather than `insertPlannedRuns`', so it carries its own tenant context — and
 * that separation is the whole reason this producer is named here: it is the one `--schedule-ms`
 * drives, so a scope fix applied to the shared helper would have closed the two producers that are
 * off by default and missed the one an operator turns on.
 */
export async function enqueueScheduledJobs(
  conn: PgConnection,
  options: EnqueueScheduledJobsOptions,
): Promise<readonly EnqueuedJobRun[]> {
  const schema = options.schema ?? DEFAULT_SCHEMA;
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);

  const byId = new Map(options.jobs.map((j) => [j.id, j]));
  const due = scheduledJobsDue(options.jobs, { now: options.now });
  if (due.length === 0) return [];
  return withTenantContext(conn, options.tenantId, async (tx) =>
    insertDueScheduledRuns(tx, schema, options, byId, due),
  );
}

/** The statements themselves, inside the caller's tenant-scoped transaction. */
async function insertDueScheduledRuns(
  conn: PgConnection,
  schema: string,
  options: EnqueueScheduledJobsOptions,
  byId: ReadonlyMap<string, JobDeclaration>,
  due: readonly { readonly jobId: string; readonly fireAt: string }[],
): Promise<readonly EnqueuedJobRun[]> {
  const results: EnqueuedJobRun[] = [];

  for (const { jobId, fireAt } of due) {
    const job = byId.get(jobId);
    if (job === undefined || job.trigger.kind !== "scheduled") continue;
    const runKey = `scheduled::${options.tenantId}::${jobId}::${fireAt}`;
    const runId = deterministicRunId(runKey);
    const trigger = { kind: "scheduled", cron: job.trigger.cron, fireAt };
    const result = await conn.query<{ run_id: unknown }>(
      `INSERT INTO ${schema}.job_runs
         (tenant_id, job_id, job_kind, run_id, trigger, started_at, status,
          input_redacted, input_data_class, output_data_class, attempts)
       VALUES ($1::uuid, $2, 'scheduled', $3::uuid, $4::jsonb, $5::timestamptz, 'pending',
               '{}'::jsonb, $6, $7, 1)
       ON CONFLICT (tenant_id, run_id) DO NOTHING
       RETURNING run_id`,
      [options.tenantId, jobId, runId, JSON.stringify(trigger), fireAt, job.inputDataClass, job.outputDataClass],
    );
    results.push({ jobId, runId, inserted: (result.rowCount ?? 0) > 0 });
  }

  return results;
}
