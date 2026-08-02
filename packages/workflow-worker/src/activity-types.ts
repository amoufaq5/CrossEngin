/**
 * A scheduled activity claimed by a worker for execution. Structurally identical to
 * `@crossengin/workflow-runtime-pg`'s `ClaimedActivity`, so `claimDueActivities` adapts in with no
 * package dependency between the pure worker loop and the Postgres binding.
 */
export interface ClaimedActivity {
  readonly activityId: string;
  readonly instanceId: string;
  readonly tenantId: string;
  readonly definitionActivityKey: string;
  readonly kind: string;
  readonly attemptNumber: number;
  readonly maxAttempts: number;
  readonly claimExpiresAt: string;
}

/** Options a worker passes to an activity claim call. */
export interface ActivityClaimOptions {
  readonly workerId: string;
  readonly now: string;
  readonly limit: number;
  readonly leaseMs: number;
}

/** The durable queue the worker pulls from — satisfied by the Postgres `claimDueActivities` / `releaseActivityClaim`. */
export interface ActivityClaimer {
  claim(opts: ActivityClaimOptions): Promise<readonly ClaimedActivity[]>;
  release(opts: { readonly activityId: string; readonly workerId: string }): Promise<void>;
}

/**
 * Executes a claimed activity — typically runs its handler and appends the result event under the
 * activity's tenant. A throw means "not processed": the worker releases the claim so it is retried.
 * Success is expected to flip the activity's status out of the claimable set.
 */
export interface ActivityProcessor {
  process(activity: ClaimedActivity): Promise<void>;
}
