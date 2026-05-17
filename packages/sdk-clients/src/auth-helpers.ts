import { z } from "zod";

export const AUTH_METHODS = [
  "api_key_header",
  "api_key_bearer",
  "oauth2_client_credentials",
  "oauth2_authorization_code_pkce",
  "oauth2_refresh_token",
  "mtls_client_cert",
] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];
export const AuthMethodSchema = z.enum(AUTH_METHODS);

export const TOKEN_STORAGE_KINDS = [
  "in_memory",
  "platform_secure_storage",
  "encrypted_file",
  "process_environment",
] as const;
export type TokenStorageKind = (typeof TOKEN_STORAGE_KINDS)[number];

export const AuthHelperConfigSchema = z
  .object({
    method: AuthMethodSchema,
    tokenStorage: z.enum(TOKEN_STORAGE_KINDS).default("platform_secure_storage"),
    refreshBeforeExpirySeconds: z.number().int().min(0).max(3600).default(300),
    maxRefreshAttempts: z.number().int().min(1).max(10).default(3),
    refreshBackoffInitialMs: z.number().int().min(100).max(10_000).default(1000),
    redactCredentialsInLogs: z.boolean().default(true),
    requireHttps: z.boolean().default(true),
    rotationWarningDays: z.number().int().min(0).max(365).default(14),
  })
  .superRefine((v, ctx) => {
    if (!v.requireHttps) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requireHttps"],
        message: "requireHttps must be true (clients cannot transmit credentials over HTTP)",
      });
    }
    if (!v.redactCredentialsInLogs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["redactCredentialsInLogs"],
        message: "redactCredentialsInLogs must be true (security baseline)",
      });
    }
    if (v.method === "oauth2_refresh_token" && v.tokenStorage === "in_memory") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tokenStorage"],
        message: "oauth2_refresh_token requires persistent storage (refresh tokens must survive restart)",
      });
    }
    if (v.method === "api_key_header" && v.tokenStorage === "process_environment") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tokenStorage"],
        message: "api_key_header from environment variable is permitted only for CI/CD contexts; document explicitly",
      });
    }
    if (
      (v.method === "oauth2_authorization_code_pkce" ||
        v.method === "oauth2_client_credentials" ||
        v.method === "oauth2_refresh_token") &&
      v.refreshBeforeExpirySeconds === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["refreshBeforeExpirySeconds"],
        message: "OAuth flows require refreshBeforeExpirySeconds >= 1 (proactive refresh)",
      });
    }
  });
export type AuthHelperConfig = z.infer<typeof AuthHelperConfigSchema>;

export const RETRY_STRATEGIES = [
  "exponential_backoff",
  "linear_backoff",
  "fixed_interval",
  "no_retry",
] as const;
export type RetryStrategy = (typeof RETRY_STRATEGIES)[number];

export const RetryPolicySchema = z
  .object({
    strategy: z.enum(RETRY_STRATEGIES),
    maxAttempts: z.number().int().min(1).max(10),
    initialDelayMs: z.number().int().min(0).max(10_000),
    maxDelayMs: z.number().int().min(100).max(60_000),
    jitterFactor: z.number().min(0).max(1).default(0.1),
    retryOnStatuses: z.array(z.number().int().min(100).max(599)).default([408, 429, 500, 502, 503, 504]),
    retryOnNetworkErrors: z.boolean().default(true),
    respectRetryAfterHeader: z.boolean().default(true),
    idempotencyKeyOnNonIdempotentRetries: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.strategy === "no_retry" && v.maxAttempts > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxAttempts"],
        message: "strategy='no_retry' requires maxAttempts=1",
      });
    }
    if (v.maxDelayMs < v.initialDelayMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxDelayMs"],
        message: "maxDelayMs must be >= initialDelayMs",
      });
    }
    const statuses = new Set<number>();
    v.retryOnStatuses.forEach((s, i) => {
      if (statuses.has(s)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["retryOnStatuses", i],
          message: `duplicate status ${s.toString()}`,
        });
      }
      statuses.add(s);
    });
    if (statuses.has(200) || statuses.has(201) || statuses.has(204)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retryOnStatuses"],
        message: "2xx success codes must not be retried",
      });
    }
    if (statuses.has(400) || statuses.has(401) || statuses.has(403) || statuses.has(404)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retryOnStatuses"],
        message: "client-error statuses (400, 401, 403, 404) must not be retried — clients should fix the request",
      });
    }
    if (!v.idempotencyKeyOnNonIdempotentRetries) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["idempotencyKeyOnNonIdempotentRetries"],
        message: "idempotencyKeyOnNonIdempotentRetries must be true (retry safety guarantee)",
      });
    }
  });
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export function defaultRetryPolicy(): RetryPolicy {
  return {
    strategy: "exponential_backoff",
    maxAttempts: 4,
    initialDelayMs: 250,
    maxDelayMs: 8000,
    jitterFactor: 0.2,
    retryOnStatuses: [408, 429, 500, 502, 503, 504],
    retryOnNetworkErrors: true,
    respectRetryAfterHeader: true,
    idempotencyKeyOnNonIdempotentRetries: true,
  };
}

export function nextDelayMs(
  policy: RetryPolicy,
  attemptNumber: number,
): number {
  if (policy.strategy === "no_retry") return 0;
  if (attemptNumber < 1) return 0;
  let base: number;
  switch (policy.strategy) {
    case "exponential_backoff":
      base = policy.initialDelayMs * Math.pow(2, attemptNumber - 1);
      break;
    case "linear_backoff":
      base = policy.initialDelayMs * attemptNumber;
      break;
    case "fixed_interval":
      base = policy.initialDelayMs;
      break;
    default:
      base = policy.initialDelayMs;
  }
  return Math.min(base, policy.maxDelayMs);
}

export function shouldRetry(
  policy: RetryPolicy,
  attemptNumber: number,
  status: number | null,
  networkError: boolean,
): boolean {
  if (attemptNumber >= policy.maxAttempts) return false;
  if (networkError) return policy.retryOnNetworkErrors;
  if (status === null) return false;
  return policy.retryOnStatuses.includes(status);
}
