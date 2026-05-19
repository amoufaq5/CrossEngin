export const RETRYABLE_ERROR_KINDS = [
  "rate_limit_error",
  "overloaded_error",
  "network_error",
  "timeout_error",
  "api_error",
  "model_stream_error",
] as const;
export type RetryableErrorKind = (typeof RETRYABLE_ERROR_KINDS)[number];

export interface RetryableDiscriminator {
  readonly kind: string;
}

export function isRetryableErrorKind(value: string): value is RetryableErrorKind {
  return (RETRYABLE_ERROR_KINDS as readonly string[]).includes(value);
}

export function isRetryableError(
  err: unknown,
): err is Error & { readonly kind: RetryableErrorKind } {
  if (err === null || typeof err !== "object") return false;
  const candidate = err as Record<string, unknown>;
  const kind = candidate["kind"];
  if (typeof kind !== "string") return false;
  return isRetryableErrorKind(kind);
}
