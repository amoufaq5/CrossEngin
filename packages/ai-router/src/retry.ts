export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitter: boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 1_000,
  maxDelayMs: 15_000,
  jitter: true,
};

export interface RetryableError {
  isRetryable(): boolean;
}

export function isRetryableError(err: unknown): err is RetryableError {
  return (
    err !== null &&
    typeof err === "object" &&
    typeof (err as { isRetryable?: unknown }).isRetryable === "function" &&
    (err as RetryableError).isRetryable()
  );
}

export interface BackoffOptions {
  readonly policy: RetryPolicy;
  readonly random?: () => number;
}

export function computeBackoffMs(attempt: number, opts: BackoffOptions): number {
  if (attempt < 0) return 0;
  const base = opts.policy.initialDelayMs * 2 ** attempt;
  const capped = Math.min(base, opts.policy.maxDelayMs);
  if (!opts.policy.jitter) return capped;
  const random = opts.random ?? Math.random;
  return Math.floor(capped * (0.5 + 0.5 * random()));
}

export interface AttemptOutcome<T> {
  readonly result: T;
  readonly attempts: number;
}

export interface RetryOptions {
  readonly policy?: RetryPolicy;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<AttemptOutcome<T>> {
  const policy = opts.policy ?? DEFAULT_RETRY_POLICY;
  const sleep = opts.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 0; attempt < policy.maxAttempts; attempt += 1) {
    try {
      const result = await fn(attempt);
      return { result, attempts: attempt + 1 };
    } catch (err) {
      lastError = err;
      if (!isRetryableError(err)) throw err;
      if (attempt === policy.maxAttempts - 1) break;
      const delay = computeBackoffMs(attempt, { policy, random: opts.random });
      opts.onRetry?.(attempt + 1, err, delay);
      await sleep(delay);
    }
  }
  throw lastError;
}

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
