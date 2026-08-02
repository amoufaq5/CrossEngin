export const STRIPE_ERROR_TYPES = [
  "api_error",
  "card_error",
  "idempotency_error",
  "invalid_request_error",
  "authentication_error",
  "rate_limit_error",
  "network_error",
  "timeout_error",
  "unknown_error",
] as const;
export type StripeErrorType = (typeof STRIPE_ERROR_TYPES)[number];

export class StripeError extends Error {
  readonly type: StripeErrorType;
  readonly code: string | null;
  readonly httpStatus: number | null;

  constructor(input: {
    type: StripeErrorType;
    message: string;
    code?: string | null;
    httpStatus?: number | null;
  }) {
    super(input.message);
    this.name = "StripeError";
    this.type = input.type;
    this.code = input.code ?? null;
    this.httpStatus = input.httpStatus ?? null;
  }

  isRetryable(): boolean {
    if (this.type === "rate_limit_error" || this.type === "network_error" || this.type === "timeout_error") {
      return true;
    }
    if (this.httpStatus === null) return false;
    if (this.httpStatus === 429) return true;
    return this.httpStatus >= 500;
  }
}

export function classifyStripeHttpStatus(status: number): StripeErrorType {
  if (status === 400) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 402) return "card_error";
  if (status === 403) return "authentication_error";
  if (status === 404) return "invalid_request_error";
  if (status === 409) return "idempotency_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "api_error";
  return "unknown_error";
}

export function stripeErrorFromHttpResponse(input: { status: number; body: string }): StripeError {
  let message = `Stripe API responded with status ${input.status.toString()}`;
  let type = classifyStripeHttpStatus(input.status);
  let code: string | null = null;
  try {
    const parsed = JSON.parse(input.body) as {
      error?: { type?: string; code?: string; message?: string };
    };
    if (parsed.error?.message !== undefined) {
      message = parsed.error.message;
    }
    if (parsed.error?.code !== undefined) {
      code = parsed.error.code;
    }
    if (parsed.error?.type !== undefined) {
      const typed = parsed.error.type as StripeErrorType;
      if ((STRIPE_ERROR_TYPES as readonly string[]).includes(typed)) {
        type = typed;
      }
    }
  } catch {
    // Body wasn't JSON; keep the status-derived defaults.
  }
  return new StripeError({ type, message, code, httpStatus: input.status });
}

export function stripeErrorFromNetworkError(err: unknown): StripeError {
  const message = err instanceof Error ? err.message : "network request failed";
  const isTimeout =
    err instanceof Error && (err.name === "AbortError" || err.message.toLowerCase().includes("timeout"));
  return new StripeError({
    type: isTimeout ? "timeout_error" : "network_error",
    message,
  });
}
