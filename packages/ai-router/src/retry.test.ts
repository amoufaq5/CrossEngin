import { describe, expect, it, vi } from "vitest";

import { DEFAULT_RETRY_POLICY, computeBackoffMs, isRetryableError, withRetry } from "./retry.js";

class RetryableErr extends Error {
  isRetryable(): boolean {
    return true;
  }
}

class NonRetryableErr extends Error {
  isRetryable(): boolean {
    return false;
  }
}

describe("isRetryableError", () => {
  it("returns true for errors with isRetryable() === true (legacy method-based shape)", () => {
    expect(isRetryableError(new RetryableErr("x"))).toBe(true);
  });

  it("returns false for errors with isRetryable() === false", () => {
    expect(isRetryableError(new NonRetryableErr("x"))).toBe(false);
  });

  it("returns false for plain Error", () => {
    expect(isRetryableError(new Error("x"))).toBe(false);
  });

  it("returns false for non-objects", () => {
    expect(isRetryableError("x")).toBe(false);
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });

  it("returns true for errors with .kind in kernel RETRYABLE_ERROR_KINDS (M6.6)", () => {
    const err = Object.assign(new Error("rate limited"), { kind: "rate_limit_error" });
    expect(isRetryableError(err)).toBe(true);
  });

  it("returns true for .kind='network_error' (kernel shape)", () => {
    const err = Object.assign(new Error("net"), { kind: "network_error" });
    expect(isRetryableError(err)).toBe(true);
  });

  it("returns true for .kind='model_stream_error' (Bedrock-specific, kernel-recognized)", () => {
    const err = Object.assign(new Error("mid-stream"), { kind: "model_stream_error" });
    expect(isRetryableError(err)).toBe(true);
  });

  it("returns false for moderation .kind values (terminal)", () => {
    expect(isRetryableError(Object.assign(new Error(), { kind: "guardrail_intervened" }))).toBe(
      false,
    );
    expect(isRetryableError(Object.assign(new Error(), { kind: "content_filtered" }))).toBe(false);
    expect(isRetryableError(Object.assign(new Error(), { kind: "refusal" }))).toBe(false);
  });

  it("returns false for auth / invalid_request .kind values", () => {
    expect(isRetryableError(Object.assign(new Error(), { kind: "authentication_error" }))).toBe(
      false,
    );
    expect(isRetryableError(Object.assign(new Error(), { kind: "invalid_request_error" }))).toBe(
      false,
    );
  });
});

describe("computeBackoffMs", () => {
  it("returns 0 for attempt < 0", () => {
    expect(computeBackoffMs(-1, { policy: DEFAULT_RETRY_POLICY, random: () => 0.5 })).toBe(0);
  });

  it("doubles per attempt without jitter", () => {
    const policy = { ...DEFAULT_RETRY_POLICY, jitter: false };
    expect(computeBackoffMs(0, { policy })).toBe(1_000);
    expect(computeBackoffMs(1, { policy })).toBe(2_000);
    expect(computeBackoffMs(2, { policy })).toBe(4_000);
  });

  it("caps at maxDelayMs", () => {
    const policy = { ...DEFAULT_RETRY_POLICY, jitter: false, maxDelayMs: 3_000 };
    expect(computeBackoffMs(10, { policy })).toBe(3_000);
  });

  it("with jitter, random=1 returns the full delay", () => {
    expect(computeBackoffMs(0, { policy: DEFAULT_RETRY_POLICY, random: () => 1 })).toBe(1_000);
  });

  it("with jitter, random=0 returns half the delay", () => {
    expect(computeBackoffMs(0, { policy: DEFAULT_RETRY_POLICY, random: () => 0 })).toBe(500);
  });
});

describe("withRetry", () => {
  it("succeeds on first attempt without sleeping", async () => {
    const sleep = vi.fn(async () => undefined);
    const fn = vi.fn(async () => "ok");
    const result = await withRetry(fn, { sleep });
    expect(result.result).toBe("ok");
    expect(result.attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries on retryable errors and eventually succeeds", async () => {
    let attempts = 0;
    const sleep = vi.fn(async () => undefined);
    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new RetryableErr("transient");
        return "yay";
      },
      { sleep },
    );
    expect(result.result).toBe("yay");
    expect(result.attempts).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("throws immediately on non-retryable errors", async () => {
    const sleep = vi.fn(async () => undefined);
    await expect(
      withRetry(
        async () => {
          throw new NonRetryableErr("fatal");
        },
        { sleep },
      ),
    ).rejects.toThrow("fatal");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after maxAttempts and throws the last error", async () => {
    const sleep = vi.fn(async () => undefined);
    const policy = { ...DEFAULT_RETRY_POLICY, maxAttempts: 2 };
    await expect(
      withRetry(
        async () => {
          throw new RetryableErr("still failing");
        },
        { sleep, policy },
      ),
    ).rejects.toThrow("still failing");
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("invokes onRetry between attempts", async () => {
    const sleep = vi.fn(async () => undefined);
    const onRetry = vi.fn();
    let attempts = 0;
    await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 2) throw new RetryableErr("once");
        return 42;
      },
      { sleep, onRetry, policy: { ...DEFAULT_RETRY_POLICY, jitter: false } },
    );
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]?.[0]).toBe(1);
    expect(onRetry.mock.calls[0]?.[2]).toBe(1_000);
  });
});
