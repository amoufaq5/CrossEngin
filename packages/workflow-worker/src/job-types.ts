/**
 * A pending job run claimed by a worker for execution. Structurally identical to
 * `@crossengin/workflow-runtime-pg`'s `ClaimedJob`, so `claimDueJobs` adapts in with no package
 * dependency between the pure worker loop and the Postgres binding.
 */
export interface ClaimedJob {
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
