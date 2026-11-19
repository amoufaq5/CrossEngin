import type { PgConnection } from "@crossengin/kernel-pg";
import { JobCancelledError } from "@crossengin/jobs";
import {
  WorkflowJobWorker,
  abortWhile,
  renewWhile,
  type ClaimRenewer,
  type ClaimedJob,
  type JobCancellationWatcher,
  type JobClaimer,
  type JobProcessor,
  type JobSkipReason,
} from "@crossengin/workflow-worker";

import {
  observeJobCancellation,
  reapCancelledJobRuns,
  type ReapedJobRun,
} from "./job-cancellation.js";
import {
  claimDueJobsPerTenant,
  listJobClaimTenants,
  releaseJobClaim,
  renewJobClaim,
  type JobClaimScope,
} from "./job-claim.js";
import type { PostgresJobRunEngine } from "./job-engine.js";

/** The engine surface a job processor needs — the log-driven, targeted execute. */
export type JobExecutingEngine = Pick<PostgresJobRunEngine, "executeJobRun">;

export interface BuildJobClaimerOptions {
  readonly schema?: string;
  /**
   * Sweep cancel-requested runs whose lease is gone to terminal `cancelled` before each claim
   * (default: off — it reads the cancellation columns, so a deployment opts in once they exist).
   * `claimDueJobs` refuses to hand out a cancel-requested run, so without this sweep a
   * cancellation recorded against a worker that then died would leave the run `pending` and
   * unclaimable forever. Running it on the claim path means a live fleet needs no extra scheduler.
   */
  readonly reapCancellations?: boolean;
  readonly reapLimit?: number;
  readonly onReaped?: (runs: readonly ReapedJobRun[]) => void;
  /**
   * What this worker's registry can execute. Passed straight to `claimDueJobs`, where absent means
   * unfiltered and an empty declaration claims nothing.
   */
  readonly serves?: JobClaimScope;
}

/**
 * Adapts the Postgres claim / `releaseJobClaim` SQL to the worker's `JobClaimer`.
 *
 * The claim is **per tenant** (`claimDueJobsPerTenant`): the tenants are read from `meta.tenants`
 * each poll and each one's queue is claimed under its own context. The cross-tenant single statement
 * it replaced claimed nothing on the shipped serving role, which RLS confines (ADR-0424); per tenant
 * works for that role and for an exempt one alike, so there is one path rather than a branch on a
 * boot-time probe. The rotation index lives here, in the claimer, so successive polls start with
 * successive tenants.
 */
export function buildJobClaimer(conn: PgConnection, opts: BuildJobClaimerOptions = {}): JobClaimer {
  const schemaOpt = opts.schema !== undefined ? { schema: opts.schema } : {};
  const servesOpt = opts.serves !== undefined ? { serves: opts.serves } : {};
  const reap = opts.reapCancellations === true;
  let startIndex = 0;
  return {
    claim: async (o) => {
      const tenantIds = await listJobClaimTenants(conn, schemaOpt);
      const reaped: ReapedJobRun[] = [];
      const result = await claimDueJobsPerTenant(conn, {
        ...o,
        ...schemaOpt,
        ...servesOpt,
        tenantIds,
        startIndex,
        ...(reap
          ? {
              beforeClaim: async (tx: PgConnection, tenantId: string) => {
                reaped.push(
                  ...(await reapCancelledJobRuns(tx, {
                    now: o.now,
                    tenantId,
                    ...(opts.reapLimit !== undefined ? { limit: opts.reapLimit } : {}),
                    ...schemaOpt,
                  })),
                );
              },
            }
          : {}),
      });
      startIndex = result.nextStartIndex;
      if (reaped.length > 0) opts.onReaped?.(reaped);
      return result.claimed;
    },
    release: (o) => releaseJobClaim(conn, { ...o, ...schemaOpt }),
  };
}

/** Adapts `observeJobCancellation` to the worker's pre-flight / mid-flight cancellation probe. */
export function buildJobCancellationWatcher(
  conn: PgConnection,
  opts: { readonly schema?: string } = {},
): JobCancellationWatcher {
  const schemaOpt = opts.schema !== undefined ? { schema: opts.schema } : {};
  return {
    isCancelRequested: async ({ jobId, tenantId }) =>
      (await observeJobCancellation(conn, { runId: jobId, tenantId, ...schemaOpt })).cancelRequested,
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
    renew: ({ timerId, workerId, tenantId }) =>
      renewJobClaim(conn, {
        jobId: timerId,
        workerId,
        tenantId,
        now: now().toISOString(),
        leaseMs: opts.leaseMs,
        ...schemaOpt,
      }),
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

/** Mid-flight cancellation polling: trips the handler's `AbortSignal` while an execute is running. */
export interface JobCancellationPollConfig {
  readonly watcher: JobCancellationWatcher;
  readonly intervalMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly onCancelObserved?: (job: ClaimedJob) => void;
}

/**
 * A `JobProcessor` that runs a claimed run through the job execution engine (`engine.executeJobRun`).
 * The worker connection is platform-scoped (RLS-bypassing), but the engine re-establishes the run's
 * tenant context for each finalize, so RLS still confines every write. Execution is idempotent — an
 * already-finalized run is a no-op — matching the worker's at-least-once retry semantics.
 *
 * With `cancellation` wired, the execute runs under an `AbortSignal` the engine hands to the handler
 * and a poll that trips it when a cancellation appears. The lease keeps being renewed while that
 * happens: the holding worker is the one that must write the terminal `cancelled`, so dropping the
 * lease at the moment of cancellation would hand the run to the reaper instead.
 */
export function buildJobProcessor(
  engine: JobExecutingEngine,
  opts: {
    /** The worker whose claim fences the run's read and finalize (`ExecuteJobRunOptions.claimedBy`). */
    readonly workerId: string;
    readonly renewal?: JobRenewalConfig;
    readonly cancellation?: JobCancellationPollConfig;
  },
): JobProcessor {
  const renewal = opts.renewal;
  const cancellation = opts.cancellation;
  return {
    process: async (job: ClaimedJob) => {
      const run = (signal?: AbortSignal): Promise<unknown> =>
        engine.executeJobRun(job.jobId, job.tenantId, {
          claimedBy: opts.workerId,
          ...(signal !== undefined ? { signal } : {}),
        });

      const execute =
        cancellation === undefined
          ? run()
          : abortWhile(run, {
              shouldAbort: () =>
                cancellation.watcher.isCancelRequested({ jobId: job.jobId, tenantId: job.tenantId }),
              intervalMs: cancellation.intervalMs,
              sleep: cancellation.sleep,
              reason: new JobCancelledError(`job run ${job.jobId} cancelled`),
              ...(cancellation.onCancelObserved !== undefined
                ? { onAbort: () => cancellation.onCancelObserved?.(job) }
                : {}),
            });

      if (renewal === undefined) {
        await execute;
        return;
      }
      await renewWhile(execute, {
        renewer: renewal.renewer,
        timerId: job.jobId,
        workerId: renewal.workerId,
        tenantId: job.tenantId,
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
  /**
   * Enable server-side cancellation (default: off). The worker then clears every claimed run against
   * `meta.job_runs` before starting it, polls every `cancelPollIntervalMs` while a handler runs to trip
   * its `AbortSignal`, and sweeps abandoned cancellations on each claim. Off, a recorded cancellation
   * still keeps the run out of the claim set — but nothing finalizes it and nothing aborts a handler.
   */
  readonly cancellation?: boolean;
  /** How often to re-probe for a cancellation while a handler runs (default 2_000 ms). */
  readonly cancelPollIntervalMs?: number;
  readonly onCancelObserved?: (job: ClaimedJob) => void;
  readonly onSkipped?: (job: ClaimedJob, reason: JobSkipReason) => void;
  readonly onReaped?: (runs: readonly ReapedJobRun[]) => void;
  /** The job ids / kinds this process's registry serves — `buildJobHandlerRegistry().servedJobIds`. */
  readonly serves?: JobClaimScope;
}

/**
 * Wires the three P2 primitives into a runnable distributed job worker: the Postgres claim
 * (`FOR UPDATE SKIP LOCKED`) behind a `JobClaimer`, the job execution engine behind a `JobProcessor`,
 * and the poll loop. Many of these run against one queue; each claims a disjoint batch and executes
 * its runs. `now` drives the claim's due-check. The job counterpart of `buildWorkflowActivityWorker`.
 */
export function buildWorkflowJobWorker(input: BuildWorkflowJobWorkerInput): WorkflowJobWorker {
  const cancelling = input.cancellation === true;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const claimer = buildJobClaimer(input.conn, {
    ...(input.schema !== undefined ? { schema: input.schema } : {}),
    reapCancellations: cancelling,
    ...(input.onReaped !== undefined ? { onReaped: input.onReaped } : {}),
    ...(input.serves !== undefined ? { serves: input.serves } : {}),
  });
  const watcher = cancelling
    ? buildJobCancellationWatcher(input.conn, input.schema !== undefined ? { schema: input.schema } : {})
    : undefined;
  // Built whether or not the heartbeat is on: the batch reaffirms every claim before its item starts,
  // which is what keeps an item queued behind a slow one from running on a lease it no longer holds.
  const claimRenewer = buildJobClaimRenewer(input.conn, {
    leaseMs: input.leaseMs ?? 30_000,
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.schema !== undefined ? { schema: input.schema } : {}),
  });
  const renewal: JobRenewalConfig | undefined =
    input.renewIntervalMs !== undefined
      ? {
          renewer: claimRenewer,
          workerId: input.workerId,
          intervalMs: input.renewIntervalMs,
          sleep,
        }
      : undefined;
  const processor = buildJobProcessor(input.engine, {
    workerId: input.workerId,
    ...(renewal !== undefined ? { renewal } : {}),
    ...(watcher !== undefined
      ? {
          cancellation: {
            watcher,
            intervalMs: input.cancelPollIntervalMs ?? 2_000,
            sleep,
            ...(input.onCancelObserved !== undefined ? { onCancelObserved: input.onCancelObserved } : {}),
          },
        }
      : {}),
  });
  return new WorkflowJobWorker({
    workerId: input.workerId,
    claimer,
    processor,
    claimRenewer,
    ...(input.batchLimit !== undefined ? { batchLimit: input.batchLimit } : {}),
    ...(input.leaseMs !== undefined ? { leaseMs: input.leaseMs } : {}),
    ...(input.idlePollMs !== undefined ? { idlePollMs: input.idlePollMs } : {}),
    ...(input.activePollMs !== undefined ? { activePollMs: input.activePollMs } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.sleep !== undefined ? { sleep: input.sleep } : {}),
    ...(input.onError !== undefined ? { onError: input.onError } : {}),
    ...(input.onBatch !== undefined ? { onBatch: input.onBatch } : {}),
    ...(watcher !== undefined ? { cancellation: watcher } : {}),
    ...(input.onSkipped !== undefined ? { onSkipped: input.onSkipped } : {}),
  });
}
