import type { PgConnection } from "@crossengin/kernel-pg";
import {
  WorkflowJobWorker,
  renewWhile,
  type ClaimRenewer,
  type ClaimedJob,
  type JobClaimer,
  type JobProcessor,
} from "@crossengin/workflow-worker";

import { claimDueJobs, releaseJobClaim, renewJobClaim } from "./job-claim.js";
import type { PostgresJobRunEngine } from "./job-engine.js";

/** The engine surface a job processor needs — the log-driven, targeted execute. */
export type JobExecutingEngine = Pick<PostgresJobRunEngine, "executeJobRun">;

/** Adapts the Postgres `claimDueJobs` / `releaseJobClaim` SQL to the worker's `JobClaimer`. */
export function buildJobClaimer(conn: PgConnection, opts: { readonly schema?: string } = {}): JobClaimer {
  const schemaOpt = opts.schema !== undefined ? { schema: opts.schema } : {};
  return {
    claim: (o) => claimDueJobs(conn, { ...o, ...schemaOpt }),
    release: (o) => releaseJobClaim(conn, { ...o, ...schemaOpt }),
  };
}

/**
 * Adapts the Postgres `renewJobClaim` to the worker's `ClaimRenewer`, closing over the lease duration
 * + clock so `renew({timerId, workerId})` extends the lease to `now + leaseMs`. The `ClaimRenewer`
 * shape carries the id under `timerId` (shared across timer / activity / job paths); here it carries
 * the run id, mapped through to `jobId`.
 */
export function buildJobClaimRenewer(
  conn: PgConnection,
  opts: { readonly leaseMs: number; readonly now?: () => Date; readonly schema?: string },
): ClaimRenewer {
  const now = opts.now ?? (() => new Date());
  const schemaOpt = opts.schema !== undefined ? { schema: opts.schema } : {};
  return {
    renew: ({ timerId, workerId }) =>
      renewJobClaim(conn, { jobId: timerId, workerId, now: now().toISOString(), leaseMs: opts.leaseMs, ...schemaOpt }),
  };
}

/** Lease-renewal config for a processor: heartbeat a claim while a slow execute runs. */
export interface JobRenewalConfig {
  readonly renewer: ClaimRenewer;
  readonly workerId: string;
  readonly intervalMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly onLeaseLost?: () => void;
}

/**
 * A `JobProcessor` that runs a claimed run through the job execution engine (`engine.executeJobRun`).
 * The worker connection is platform-scoped (RLS-bypassing), but the engine re-establishes the run's
 * tenant context for each finalize, so RLS still confines every write. Execution is idempotent — an
 * already-finalized run is a no-op — matching the worker's at-least-once retry semantics.
 */
export function buildJobProcessor(
  engine: JobExecutingEngine,
  opts: { readonly renewal?: JobRenewalConfig } = {},
): JobProcessor {
  const renewal = opts.renewal;
  return {
    process: async (job: ClaimedJob) => {
      const execute = engine.executeJobRun(job.jobId, job.tenantId);
      if (renewal === undefined) {
        await execute;
        return;
      }
      await renewWhile(execute, {
        renewer: renewal.renewer,
        timerId: job.jobId,
        workerId: renewal.workerId,
        intervalMs: renewal.intervalMs,
        sleep: renewal.sleep,
        ...(renewal.onLeaseLost !== undefined ? { onLeaseLost: renewal.onLeaseLost } : {}),
      });
    },
  };
}

export interface BuildWorkflowJobWorkerInput {
  readonly conn: PgConnection;
  readonly engine: JobExecutingEngine;
  readonly workerId: string;
  readonly schema?: string;
  readonly batchLimit?: number;
  readonly leaseMs?: number;
  readonly idlePollMs?: number;
  readonly activePollMs?: number;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onError?: (err: unknown) => void;
  readonly onBatch?: (result: { claimed: number }) => void;
  /** Enable lease renewal during an execute, heartbeating every N ms (default: off). Needs `leaseMs`. */
  readonly renewIntervalMs?: number;
}

/**
 * Wires the three P2 primitives into a runnable distributed job worker: the Postgres claim
 * (`FOR UPDATE SKIP LOCKED`) behind a `JobClaimer`, the job execution engine behind a `JobProcessor`,
 * and the poll loop. Many of these run against one queue; each claims a disjoint batch and executes
 * its runs. `now` drives the claim's due-check. The job counterpart of `buildWorkflowActivityWorker`.
 */
export function buildWorkflowJobWorker(input: BuildWorkflowJobWorkerInput): WorkflowJobWorker {
  const claimer = buildJobClaimer(input.conn, input.schema !== undefined ? { schema: input.schema } : {});
  const renewal: JobRenewalConfig | undefined =
    input.renewIntervalMs !== undefined
      ? {
          renewer: buildJobClaimRenewer(input.conn, {
            leaseMs: input.leaseMs ?? 30_000,
            ...(input.now !== undefined ? { now: input.now } : {}),
            ...(input.schema !== undefined ? { schema: input.schema } : {}),
          }),
          workerId: input.workerId,
          intervalMs: input.renewIntervalMs,
          sleep: input.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
        }
      : undefined;
  const processor = buildJobProcessor(input.engine, {
    ...(renewal !== undefined ? { renewal } : {}),
  });
  return new WorkflowJobWorker({
    workerId: input.workerId,
    claimer,
    processor,
    ...(input.batchLimit !== undefined ? { batchLimit: input.batchLimit } : {}),
    ...(input.leaseMs !== undefined ? { leaseMs: input.leaseMs } : {}),
    ...(input.idlePollMs !== undefined ? { idlePollMs: input.idlePollMs } : {}),
    ...(input.activePollMs !== undefined ? { activePollMs: input.activePollMs } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.sleep !== undefined ? { sleep: input.sleep } : {}),
    ...(input.onError !== undefined ? { onError: input.onError } : {}),
    ...(input.onBatch !== undefined ? { onBatch: input.onBatch } : {}),
  });
}
