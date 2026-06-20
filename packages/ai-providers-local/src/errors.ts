export const LOCAL_ERROR_KINDS = [
  "invalid_request_error",
  "authentication_error",
  "not_found_error",
  "model_not_loaded",
  "rate_limit_error",
  "server_error",
  "service_unavailable",
  "network_error",
  "timeout_error",
  "unknown_error",
] as const;
export type LocalErrorKind = (typeof LOCAL_ERROR_KINDS)[number];

export const RETRYABLE_KINDS: ReadonlySet<LocalErrorKind> = new Set([
  "rate_limit_error",
  "server_error",
  "service_unavailable",
  "network_error",
  "timeout_error",
  "model_not_loaded",
]);

/**
 * Error from a local OpenAI-compatible inference server. `model_not_loaded`
 * is retryable because servers like Ollama lazily pull/warm a model on the
 * first request and a retry usually succeeds once it is resident.
 */
export class LocalProviderError extends Error {
  readonly kind: LocalErrorKind;
  readonly status: number | null;

  constructor(input: { kind: LocalErrorKind; message: string; status?: number | null }) {
    super(input.message);
    this.name = "LocalProviderError";
    this.kind = input.kind;
    this.status = input.status ?? null;
  }

  isRetryable(): boolean {
    return RETRYABLE_KINDS.has(this.kind);
  }
}

export function classifyHttpStatus(status: number): LocalErrorKind {
  if (status === 400) return "invalid_request_error";
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 404) return "not_found_error";
  if (status === 408) return "timeout_error";
  if (status === 429) return "rate_limit_error";
  if (status === 503) return "service_unavailable";
  if (status >= 500) return "server_error";
  return "unknown_error";
}

export function fromHttpResponse(input: { status: number; body: string }): LocalProviderError {
  let message = `local inference server responded with status ${input.status.toString()}`;
  let kind = classifyHttpStatus(input.status);
  try {
    const parsed = JSON.parse(input.body) as {
      error?: string | { type?: string; message?: string };
    };
    if (typeof parsed.error === "string") {
      message = parsed.error;
    } else if (parsed.error?.message !== undefined) {
      message = parsed.error.message;
    }
    if (/not found|no such model|failed to load|pulling/i.test(message)) {
      kind = "model_not_loaded";
    }
  } catch {
    // Body wasn't JSON; keep the default message + status-derived kind.
  }
  return new LocalProviderError({ kind, message, status: input.status });
}

export function fromNetworkError(err: unknown): LocalProviderError {
  const message = err instanceof Error ? err.message : "network request failed";
  const isTimeout =
    err instanceof Error &&
    (err.name === "AbortError" || err.message.toLowerCase().includes("timeout"));
  return new LocalProviderError({
    kind: isTimeout ? "timeout_error" : "network_error",
    message,
  });
}
