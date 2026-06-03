export const OPENAI_ERROR_KINDS = [
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "not_found_error",
  "rate_limit_error",
  "server_error",
  "service_unavailable",
  "request_too_large",
  "network_error",
  "timeout_error",
  "unknown_error",
] as const;
export type OpenAiErrorKind = (typeof OPENAI_ERROR_KINDS)[number];

export const RETRYABLE_KINDS: ReadonlySet<OpenAiErrorKind> = new Set([
  "rate_limit_error",
  "server_error",
  "service_unavailable",
  "network_error",
  "timeout_error",
]);

export class OpenAiError extends Error {
  readonly kind: OpenAiErrorKind;
  readonly status: number | null;

  constructor(input: { kind: OpenAiErrorKind; message: string; status?: number | null }) {
    super(input.message);
    this.name = "OpenAiError";
    this.kind = input.kind;
    this.status = input.status ?? null;
  }

  isRetryable(): boolean {
    return RETRYABLE_KINDS.has(this.kind);
  }
}

export function classifyHttpStatus(status: number): OpenAiErrorKind {
  if (status === 400) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 408) return "timeout_error";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limit_error";
  if (status === 503) return "service_unavailable";
  if (status >= 500) return "server_error";
  return "unknown_error";
}

export function fromHttpResponse(input: { status: number; body: string }): OpenAiError {
  let message = `OpenAI API responded with status ${input.status.toString()}`;
  const kind = classifyHttpStatus(input.status);
  try {
    const parsed = JSON.parse(input.body) as { error?: { type?: string; message?: string } };
    if (parsed.error?.message !== undefined) {
      message = parsed.error.message;
    }
  } catch {
    // Body wasn't JSON; keep the default message.
  }
  return new OpenAiError({ kind, message, status: input.status });
}

export function fromNetworkError(err: unknown): OpenAiError {
  const message = err instanceof Error ? err.message : "network request failed";
  const isTimeout =
    err instanceof Error &&
    (err.name === "AbortError" || err.message.toLowerCase().includes("timeout"));
  return new OpenAiError({
    kind: isTimeout ? "timeout_error" : "network_error",
    message,
  });
}
