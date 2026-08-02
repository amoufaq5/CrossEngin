/**
 * A due timer claimed by a worker for firing. Structurally identical to
 * `@crossengin/workflow-runtime-pg`'s `ClaimedTimer`, so `claimDueTimers` adapts in with no
 * package dependency between the pure worker loop and the Postgres binding.
 */
export interface ClaimedTimer {
  readonly timerId: string;
  readonly instanceId: string;
  readonly tenantId: string;
  readonly timerName: string;
  readonly fireAt: string;
  readonly transitionToTrigger: string | null;
  readonly claimExpiresAt: string;
}

/** Options a worker passes to a claim call. */
export interface ClaimOptions {
  readonly workerId: string;
  readonly now: string;
  readonly limit: number;
  readonly leaseMs: number;
}

/** The durable queue the worker pulls from — satisfied by the Postgres `claimDueTimers` / `releaseTimerClaim`. */
export interface TimerClaimer {
  claim(opts: ClaimOptions): Promise<readonly ClaimedTimer[]>;
  release(opts: { readonly timerId: string; readonly workerId: string }): Promise<void>;
}

/**
 * Fires a claimed timer — typically advances the workflow instance (submit the timer-fired event
 * under the timer's tenant). A throw means "not processed": the worker releases the claim so it is
 * retried. Success is expected to flip the timer's status out of the claimable set.
 */
export interface TimerProcessor {
  process(timer: ClaimedTimer): Promise<void>;
}
