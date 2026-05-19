export const OPENAI_ERROR_KINDS = [
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "not_found_error",
  "rate_limit_error",
  "overloaded_error",
  "api_error",
  "request_too_large",
  "network_error",
  "timeout_error",
  "content_filtered",
  "unknown_error",
] as const;
export type OpenAIErrorKind = (typeof OPENAI_ERROR_KINDS)[number];

export const RETRYABLE_KINDS: ReadonlySet<OpenAIErrorKind> = new Set([
  "rate_limit_error",
  "overloaded_error",
  "network_error",
  "timeout_error",
  "api_error",
]);

export class OpenAIError extends Error {
  readonly kind: OpenAIErrorKind;
  readonly status: number | null;
  readonly code: string | null;

  constructor(input: {
    kind: OpenAIErrorKind;
    message: string;
    status?: number | null;
    code?: string | null;
  }) {
    super(input.message);
    this.name = "OpenAIError";
    this.kind = input.kind;
    this.status = input.status ?? null;
    this.code = input.code ?? null;
  }

  isRetryable(): boolean {
    return RETRYABLE_KINDS.has(this.kind);
  }
}

export function classifyHttpStatus(status: number): OpenAIErrorKind {
  if (status === 400) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 408) return "timeout_error";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limit_error";
  if (status === 529) return "overloaded_error";
  if (status >= 500) return "api_error";
  return "unknown_error";
}

const TYPE_TO_KIND: Readonly<Record<string, OpenAIErrorKind>> = {
  invalid_request_error: "invalid_request_error",
  authentication_error: "authentication_error",
  permission_error: "permission_error",
  not_found_error: "not_found_error",
  rate_limit_error: "rate_limit_error",
  rate_limit_exceeded: "rate_limit_error",
  server_error: "api_error",
  service_unavailable: "overloaded_error",
};

export function fromHttpResponse(input: {
  status: number;
  body: string;
}): OpenAIError {
  let message = `OpenAI API responded with status ${input.status.toString()}`;
  let kind = classifyHttpStatus(input.status);
  let code: string | null = null;
  try {
    const parsed = JSON.parse(input.body) as {
      error?: { type?: string; message?: string; code?: string };
    };
    if (parsed.error?.message !== undefined) {
      message = parsed.error.message;
    }
    if (parsed.error?.type !== undefined) {
      const mapped = TYPE_TO_KIND[parsed.error.type];
      if (mapped !== undefined) kind = mapped;
    }
    if (parsed.error?.code !== undefined) {
      code = parsed.error.code;
    }
  } catch {
    // Non-JSON body — keep status-based classification.
  }
  return new OpenAIError({ kind, message, status: input.status, code });
}

export function fromNetworkError(err: unknown): OpenAIError {
  const message = err instanceof Error ? err.message : "network request failed";
  const isTimeout =
    err instanceof Error &&
    (err.name === "AbortError" || err.message.toLowerCase().includes("timeout"));
  return new OpenAIError({
    kind: isTimeout ? "timeout_error" : "network_error",
    message,
  });
}
