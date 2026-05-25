export const BEDROCK_ERROR_KINDS = [
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "not_found_error",
  "conflict_error",
  "rate_limit_error",
  "overloaded_error",
  "api_error",
  "request_too_large",
  "model_stream_error",
  "network_error",
  "timeout_error",
  "guardrail_intervened",
  "content_filtered",
  "unknown_error",
] as const;
export type BedrockErrorKind = (typeof BEDROCK_ERROR_KINDS)[number];

export const RETRYABLE_KINDS: ReadonlySet<BedrockErrorKind> = new Set([
  "rate_limit_error",
  "overloaded_error",
  "network_error",
  "timeout_error",
  "api_error",
  "model_stream_error",
]);

export class BedrockError extends Error {
  readonly kind: BedrockErrorKind;
  readonly status: number | null;
  readonly code: string | null;

  constructor(input: {
    kind: BedrockErrorKind;
    message: string;
    status?: number | null;
    code?: string | null;
  }) {
    super(input.message);
    this.name = "BedrockError";
    this.kind = input.kind;
    this.status = input.status ?? null;
    this.code = input.code ?? null;
  }

  isRetryable(): boolean {
    return RETRYABLE_KINDS.has(this.kind);
  }
}

export function classifyHttpStatus(status: number): BedrockErrorKind {
  if (status === 400) return "invalid_request_error";
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 404) return "not_found_error";
  if (status === 408) return "timeout_error";
  if (status === 409) return "conflict_error";
  if (status === 413) return "request_too_large";
  if (status === 424) return "model_stream_error";
  if (status === 429) return "rate_limit_error";
  if (status === 503) return "overloaded_error";
  if (status >= 500) return "api_error";
  return "unknown_error";
}

const CODE_TO_KIND: Readonly<Record<string, BedrockErrorKind>> = {
  AccessDeniedException: "permission_error",
  ExpiredTokenException: "authentication_error",
  InvalidSignatureException: "authentication_error",
  MissingAuthenticationTokenException: "authentication_error",
  UnrecognizedClientException: "authentication_error",
  ResourceNotFoundException: "not_found_error",
  ConflictException: "conflict_error",
  ValidationException: "invalid_request_error",
  ThrottlingException: "rate_limit_error",
  TooManyRequestsException: "rate_limit_error",
  ServiceQuotaExceededException: "rate_limit_error",
  ServiceUnavailableException: "overloaded_error",
  ModelTimeoutException: "timeout_error",
  ModelStreamErrorException: "model_stream_error",
  ModelErrorException: "api_error",
  ModelNotReadyException: "overloaded_error",
  InternalServerException: "api_error",
};

export function fromHttpResponse(input: { status: number; body: string }): BedrockError {
  let message = `Bedrock API responded with status ${input.status.toString()}`;
  let kind = classifyHttpStatus(input.status);
  let code: string | null = null;
  try {
    const parsed = JSON.parse(input.body) as {
      __type?: string;
      message?: string;
      Message?: string;
    };
    if (typeof parsed.__type === "string") {
      const bare = parsed.__type.split("#").pop() ?? parsed.__type;
      code = bare;
      const mapped = CODE_TO_KIND[bare];
      if (mapped !== undefined) kind = mapped;
    }
    const m = parsed.message ?? parsed.Message;
    if (typeof m === "string" && m.length > 0) {
      message = m;
    }
  } catch {
    // Non-JSON body — keep status-based classification.
  }
  return new BedrockError({ kind, message, status: input.status, code });
}

export function fromNetworkError(err: unknown): BedrockError {
  const message = err instanceof Error ? err.message : "network request failed";
  const isTimeout =
    err instanceof Error &&
    (err.name === "AbortError" || err.message.toLowerCase().includes("timeout"));
  return new BedrockError({
    kind: isTimeout ? "timeout_error" : "network_error",
    message,
  });
}
