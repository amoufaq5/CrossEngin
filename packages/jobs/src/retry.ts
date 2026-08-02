import { durationToMillis, type RetryPolicy } from "./types.js";

/**
 * The delay (ms) before the next attempt of a job that just failed on `attemptNumber` (1-based),
 * derived from its `RetryPolicy.backoff`. Pure and deterministic:
 *
 * - no policy / no `backoff` → `0` (immediate retry, the prior behavior),
 * - `constant` → `initialDelay`,
 * - `linear` → `initialDelay × attemptNumber`,
 * - `exponential` → `initialDelay × 2^(attemptNumber − 1)`,
 *
 * each capped at `maxDelay` when set. `jitter` is applied only when a `[0,1)` sampler is supplied
 * (`rng`); it spreads the delay uniformly across `[delay/2, delay)` to de-correlate a thundering herd,
 * and is skipped (fully deterministic) when `rng` is omitted — so tests and replay stay reproducible.
 */
export function retryDelayMs(
  policy: RetryPolicy | undefined,
  attemptNumber: number,
  rng?: () => number,
): number {
  const backoff = policy?.backoff;
  if (backoff === undefined) return 0;
  const initial = durationToMillis(backoff.initialDelay);
  const n = Math.max(1, Math.floor(attemptNumber));

  let delay: number;
  switch (backoff.kind) {
    case "constant":
      delay = initial;
      break;
    case "linear":
      delay = initial * n;
      break;
    case "exponential":
      delay = initial * 2 ** (n - 1);
      break;
  }

  if (backoff.maxDelay !== undefined) delay = Math.min(delay, durationToMillis(backoff.maxDelay));
  if (backoff.jitter === true && rng !== undefined) {
    // Full jitter over the lower half: [delay/2, delay).
    delay = delay / 2 + rng() * (delay / 2);
  }
  return Math.round(delay);
}

/** The absolute next-attempt instant: `now + retryDelayMs(...)`, as an ISO string. */
export function nextRetryAt(
  policy: RetryPolicy | undefined,
  attemptNumber: number,
  now: string,
  rng?: () => number,
): string {
  return new Date(new Date(now).getTime() + retryDelayMs(policy, attemptNumber, rng)).toISOString();
}
