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
