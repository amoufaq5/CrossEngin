import { createHash } from "node:crypto";

import type { PgConnection } from "@crossengin/kernel-pg";
import { planJobRunsForEvent, type DomainEvent, type JobDeclaration, type PlannedJobRun } from "@crossengin/jobs";

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
 * bound; the validated schema is the only interpolated identifier. The connection is platform-scoped
 * (RLS-bypassing), with `tenant_id` bound from the event on each row.
 */
export async function enqueueJobsForEvent(
  conn: PgConnection,
  options: EnqueueJobsForEventOptions,
): Promise<readonly EnqueuedJobRun[]> {
  const schema = options.schema ?? DEFAULT_SCHEMA;
  if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema identifier: ${JSON.stringify(schema)}`);

  const planned: readonly PlannedJobRun[] = planJobRunsForEvent(options.event, options.jobs);
  const results: EnqueuedJobRun[] = [];

  for (const plan of planned) {
    const runId = deterministicRunId(plan.runKey);
    const result = await conn.query<{ run_id: unknown }>(
      `INSERT INTO ${schema}.job_runs
         (tenant_id, job_id, job_kind, run_id, trigger, started_at, status,
          input_redacted, input_data_class, output_data_class, attempts)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5::jsonb, $6::timestamptz, 'pending',
               $7::jsonb, $8, $9, 1)
       ON CONFLICT (tenant_id, run_id) DO NOTHING
       RETURNING run_id`,
      [
        options.event.tenantId,
        plan.jobId,
        plan.jobKind,
        runId,
        JSON.stringify(plan.trigger),
        options.now,
        JSON.stringify(plan.input),
        plan.inputDataClass,
        plan.outputDataClass,
      ],
    );
    results.push({ jobId: plan.jobId, runId, inserted: (result.rowCount ?? 0) > 0 });
  }

  return results;
}
