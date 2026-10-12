/**
 * A pending job run claimed by a worker for execution. Structurally identical to
 * `@crossengin/workflow-runtime-pg`'s `ClaimedJob`, so `claimDueJobs` adapts in with no package
 * dependency between the pure worker loop and the Postgres binding.
 */
export interface ClaimedJob {
  /**
   * `jobId` is the **run** id, not the job's — the twin in `workflow-runtime-pg` reads it from
   * `meta.job_runs.run_id` and every consumer here uses it as one (`observeJobCancellation`
   * takes `{runId: job.jobId}`, `renewWhile` leases it). The job's own id is `jobDefinitionId`.
   */
  readonly jobId: string;
  readonly tenantId: string;
  readonly jobDefinitionId: string;
  readonly jobKind: string;
  readonly attempts: number;
  readonly claimExpiresAt: string;
}

/** Options a worker passes to a job claim call. */
export interface JobClaimOptions {
  readonly workerId: string;
  readonly now: string;
  readonly limit: number;
  readonly leaseMs: number;
}

/** The durable queue the worker pulls from — satisfied by the Postgres `claimDueJobs` / `releaseJobClaim`. */
export interface JobClaimer {
  claim(opts: JobClaimOptions): Promise<readonly ClaimedJob[]>;
  release(opts: { readonly jobId: string; readonly workerId: string }): Promise<void>;
}

/**
 * Executes a claimed job — typically dispatches its handler by kind and flips the run's status out of
 * `pending` (running → completed/failed/dead-lettered). A throw means "not processed": the worker
 * releases the claim so it is retried. A processor that succeeds must move the run out of the
 * claimable set, or the lease will lapse and the run be re-claimed (at-least-once).
 */
export interface JobProcessor {
  process(job: ClaimedJob): Promise<void>;
}

/**
 * Reads whether a cancellation is durably recorded for a run — satisfied by the Postgres
 * `observeJobCancellation`. The worker consults it twice per run: once before starting an item (the
 * promise "no further items will start") and, while a handler runs, on a poll that trips the
 * handler's `AbortSignal`.
 */
export interface JobCancellationWatcher {
  isCancelRequested(opts: { readonly jobId: string; readonly tenantId: string }): Promise<boolean>;
}
