import { describe, expect, it } from "vitest";
import {
  AUTH_METHODS,
  AuthHelperConfigSchema,
  RETRY_STRATEGIES,
  RetryPolicySchema,
  TOKEN_STORAGE_KINDS,
  defaultRetryPolicy,
  nextDelayMs,
  shouldRetry,
  type AuthHelperConfig,
  type RetryPolicy,
} from "./auth-helpers.js";

describe("constants", () => {
  it("AUTH_METHODS has 6 entries", () => {
    expect(AUTH_METHODS).toContain("api_key_header");
    expect(AUTH_METHODS).toContain("oauth2_authorization_code_pkce");
    expect(AUTH_METHODS).toContain("mtls_client_cert");
  });

  it("TOKEN_STORAGE_KINDS has 4 entries", () => {
    expect(TOKEN_STORAGE_KINDS).toContain("in_memory");
    expect(TOKEN_STORAGE_KINDS).toContain("platform_secure_storage");
  });

  it("RETRY_STRATEGIES has 4 entries", () => {
    expect(RETRY_STRATEGIES).toEqual([
      "exponential_backoff",
      "linear_backoff",
      "fixed_interval",
      "no_retry",
    ]);
  });
});

describe("AuthHelperConfigSchema", () => {
  const base: AuthHelperConfig = {
    method: "api_key_header",
    tokenStorage: "platform_secure_storage",
    refreshBeforeExpirySeconds: 300,
    maxRefreshAttempts: 3,
    refreshBackoffInitialMs: 1000,
    redactCredentialsInLogs: true,
    requireHttps: true,
    rotationWarningDays: 14,
  };

  it("accepts a valid api_key_header config", () => {
    expect(() => AuthHelperConfigSchema.parse(base)).not.toThrow();
  });

  it("rejects requireHttps=false (security baseline)", () => {
    expect(() =>
      AuthHelperConfigSchema.parse({ ...base, requireHttps: false }),
    ).toThrow(/requireHttps must be true/);
  });

  it("rejects redactCredentialsInLogs=false (security baseline)", () => {
    expect(() =>
      AuthHelperConfigSchema.parse({ ...base, redactCredentialsInLogs: false }),
    ).toThrow(/redactCredentialsInLogs must be true/);
  });

  it("rejects oauth2_refresh_token with in_memory storage", () => {
    expect(() =>
      AuthHelperConfigSchema.parse({
        ...base,
        method: "oauth2_refresh_token",
        tokenStorage: "in_memory",
      }),
    ).toThrow(/persistent storage/);
  });

  it("rejects OAuth flows with refreshBeforeExpirySeconds=0", () => {
    expect(() =>
      AuthHelperConfigSchema.parse({
        ...base,
        method: "oauth2_client_credentials",
        refreshBeforeExpirySeconds: 0,
      }),
    ).toThrow(/proactive refresh/);
  });
});

describe("RetryPolicySchema", () => {
  it("accepts the default retry policy", () => {
    expect(() => RetryPolicySchema.parse(defaultRetryPolicy())).not.toThrow();
  });

  it("rejects no_retry with maxAttempts > 1", () => {
    expect(() =>
      RetryPolicySchema.parse({
        strategy: "no_retry",
        maxAttempts: 3,
        initialDelayMs: 0,
        maxDelayMs: 100,
        jitterFactor: 0,
        retryOnStatuses: [],
        retryOnNetworkErrors: false,
        respectRetryAfterHeader: false,
        idempotencyKeyOnNonIdempotentRetries: true,
      }),
    ).toThrow(/maxAttempts=1/);
  });

  it("rejects maxDelayMs < initialDelayMs", () => {
    expect(() =>
      RetryPolicySchema.parse({
        ...defaultRetryPolicy(),
        maxDelayMs: 100,
        initialDelayMs: 500,
      }),
    ).toThrow(/maxDelayMs must be >= initialDelayMs/);
  });

  it("rejects retrying 2xx statuses", () => {
    expect(() =>
      RetryPolicySchema.parse({
        ...defaultRetryPolicy(),
        retryOnStatuses: [200],
      }),
    ).toThrow(/2xx success codes/);
  });

  it("rejects retrying 4xx statuses (except 408/429)", () => {
    expect(() =>
      RetryPolicySchema.parse({
        ...defaultRetryPolicy(),
        retryOnStatuses: [400],
      }),
    ).toThrow(/client-error statuses/);
  });

  it("rejects duplicate statuses", () => {
    expect(() =>
      RetryPolicySchema.parse({
        ...defaultRetryPolicy(),
        retryOnStatuses: [500, 500],
      }),
    ).toThrow(/duplicate status/);
  });

  it("rejects idempotencyKeyOnNonIdempotentRetries=false", () => {
    expect(() =>
      RetryPolicySchema.parse({
        ...defaultRetryPolicy(),
        idempotencyKeyOnNonIdempotentRetries: false,
      }),
    ).toThrow(/retry safety/);
  });
});

describe("nextDelayMs", () => {
  const policy: RetryPolicy = defaultRetryPolicy();

  it("exponential_backoff doubles each attempt", () => {
    expect(nextDelayMs(policy, 1)).toBe(250);
    expect(nextDelayMs(policy, 2)).toBe(500);
    expect(nextDelayMs(policy, 3)).toBe(1000);
    expect(nextDelayMs(policy, 4)).toBe(2000);
  });

  it("caps at maxDelayMs", () => {
    expect(nextDelayMs(policy, 100)).toBe(policy.maxDelayMs);
  });

  it("linear_backoff scales linearly", () => {
    const linear: RetryPolicy = {
      ...policy,
      strategy: "linear_backoff",
      initialDelayMs: 100,
    };
    expect(nextDelayMs(linear, 1)).toBe(100);
    expect(nextDelayMs(linear, 2)).toBe(200);
    expect(nextDelayMs(linear, 3)).toBe(300);
  });

  it("fixed_interval is constant", () => {
    const fixed: RetryPolicy = {
      ...policy,
      strategy: "fixed_interval",
      initialDelayMs: 500,
    };
    expect(nextDelayMs(fixed, 1)).toBe(500);
    expect(nextDelayMs(fixed, 5)).toBe(500);
  });

  it("no_retry returns 0", () => {
    const none: RetryPolicy = {
      ...policy,
      strategy: "no_retry",
      maxAttempts: 1,
    };
    expect(nextDelayMs(none, 1)).toBe(0);
  });
});

describe("shouldRetry", () => {
  const policy: RetryPolicy = defaultRetryPolicy();

  it("retries 5xx", () => {
    expect(shouldRetry(policy, 1, 500, false)).toBe(true);
    expect(shouldRetry(policy, 1, 502, false)).toBe(true);
  });

  it("retries 408 and 429", () => {
    expect(shouldRetry(policy, 1, 408, false)).toBe(true);
    expect(shouldRetry(policy, 1, 429, false)).toBe(true);
  });

  it("does not retry 4xx", () => {
    expect(shouldRetry(policy, 1, 400, false)).toBe(false);
    expect(shouldRetry(policy, 1, 404, false)).toBe(false);
  });

  it("does not retry 2xx", () => {
    expect(shouldRetry(policy, 1, 200, false)).toBe(false);
  });

  it("stops at maxAttempts", () => {
    expect(shouldRetry(policy, policy.maxAttempts, 500, false)).toBe(false);
  });

  it("retries network errors when enabled", () => {
    expect(shouldRetry(policy, 1, null, true)).toBe(true);
  });
});
