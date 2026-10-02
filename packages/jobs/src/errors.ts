export class JobError extends Error {
  override readonly name: string = "JobError";
}

export class RetryableError extends JobError {
  override readonly name = "RetryableError" as const;
  readonly kind = "retryable" as const;
  readonly retryAfter?: string;

  constructor(message: string, options?: { retryAfter?: string; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    if (options?.retryAfter !== undefined) {
      this.retryAfter = options.retryAfter;
    }
  }
}

export class PermanentError extends JobError {
  override readonly name = "PermanentError" as const;
  readonly kind = "permanent" as const;
  readonly reason?: string;

  constructor(message: string, options?: { reason?: string; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    if (options?.reason !== undefined) {
      this.reason = options.reason;
    }
  }
}

/**
 * Thrown *into* a handler's `AbortSignal.reason` when a cancellation is observed mid-flight, and the
 * error a cooperating handler is expected to surface. Deliberately not a `RetryableError` or a
 * `PermanentError`: cancellation is not a failure classification, so `classifyError` does not report
 * it and the engine never routes it through the retry / dead-letter mapping.
 */
export class JobCancelledError extends JobError {
  override readonly name = "JobCancelledError" as const;
  readonly kind = "cancelled" as const;
  readonly requestedBy?: string;

  constructor(message = "job run cancelled", options?: { requestedBy?: string; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    if (options?.requestedBy !== undefined) {
      this.requestedBy = options.requestedBy;
    }
  }
}

export function isJobCancelled(err: unknown): err is JobCancelledError {
  return err instanceof JobCancelledError;
}

export function isRetryable(err: unknown): err is RetryableError {
  return err instanceof RetryableError;
}

export function isPermanent(err: unknown): err is PermanentError {
  return err instanceof PermanentError;
}

export function classifyError(err: unknown): "retryable" | "permanent" | "unknown" {
  if (isPermanent(err)) return "permanent";
  if (isRetryable(err)) return "retryable";
  return "unknown";
}
