export const ANTHROPIC_ERROR_KINDS = [
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "not_found_error",
  "conflict_error",
  "rate_limit_error",
  "overloaded_error",
  "api_error",
  "request_too_large",
  "network_error",
  "timeout_error",
  "refusal",
  "unknown_error",
] as const;
export type AnthropicErrorKind = (typeof ANTHROPIC_ERROR_KINDS)[number];

export const RETRYABLE_KINDS: ReadonlySet<AnthropicErrorKind> = new Set([
  "rate_limit_error",
  "overloaded_error",
  "network_error",
  "timeout_error",
  "api_error",
]);

export class AnthropicError extends Error {
  readonly kind: AnthropicErrorKind;
  readonly status: number | null;

  constructor(input: { kind: AnthropicErrorKind; message: string; status?: number | null }) {
    super(input.message);
    this.name = "AnthropicError";
    this.kind = input.kind;
    this.status = input.status ?? null;
  }

  isRetryable(): boolean {
    return RETRYABLE_KINDS.has(this.kind);
  }
}

export function classifyHttpStatus(status: number): AnthropicErrorKind {
  if (status === 400) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 408) return "timeout_error";
  if (status === 409) return "conflict_error";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limit_error";
  if (status === 529) return "overloaded_error";
  if (status >= 500) return "api_error";
  return "unknown_error";
}

export function fromHttpResponse(input: {
  status: number;
  body: string;
}): AnthropicError {
  let message = `Anthropic API responded with status ${input.status.toString()}`;
  let kind = classifyHttpStatus(input.status);
  try {
    const parsed = JSON.parse(input.body) as { error?: { type?: string; message?: string } };
    if (parsed.error?.message !== undefined) {
      message = parsed.error.message;
    }
    if (parsed.error?.type !== undefined) {
      const typed = parsed.error.type as AnthropicErrorKind;
      if ((ANTHROPIC_ERROR_KINDS as readonly string[]).includes(typed)) {
        kind = typed;
      }
    }
  } catch {
    // Body wasn't JSON; keep the default message.
  }
  return new AnthropicError({ kind, message, status: input.status });
}

export function fromNetworkError(err: unknown): AnthropicError {
  const message = err instanceof Error ? err.message : "network request failed";
  const isTimeout =
    err instanceof Error && (err.name === "AbortError" || err.message.toLowerCase().includes("timeout"));
  return new AnthropicError({
    kind: isTimeout ? "timeout_error" : "network_error",
    message,
  });
}
