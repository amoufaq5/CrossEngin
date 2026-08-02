import { describe, expect, it } from "vitest";

import { nextRetryAt, retryDelayMs } from "./retry.js";
import { RetryPolicySchema, type RetryPolicy } from "./types.js";

function policy(p: unknown): RetryPolicy {
  return RetryPolicySchema.parse(p);
}

describe("retryDelayMs", () => {
  it("is 0 when there is no policy or no backoff (immediate retry)", () => {
    expect(retryDelayMs(undefined, 1)).toBe(0);
    expect(retryDelayMs(policy({ maxAttempts: 3 }), 2)).toBe(0);
  });

  it("constant backoff returns the initial delay every attempt", () => {
    const p = policy({ maxAttempts: 5, backoff: { kind: "constant", initialDelay: "PT30S" } });
    expect(retryDelayMs(p, 1)).toBe(30_000);
    expect(retryDelayMs(p, 4)).toBe(30_000);
  });

  it("linear backoff scales with attempt number", () => {
    const p = policy({ maxAttempts: 5, backoff: { kind: "linear", initialDelay: "PT10S" } });
    expect(retryDelayMs(p, 1)).toBe(10_000);
    expect(retryDelayMs(p, 3)).toBe(30_000);
  });

  it("exponential backoff doubles each attempt", () => {
    const p = policy({ maxAttempts: 5, backoff: { kind: "exponential", initialDelay: "PT5S" } });
    expect(retryDelayMs(p, 1)).toBe(5_000);
    expect(retryDelayMs(p, 2)).toBe(10_000);
    expect(retryDelayMs(p, 4)).toBe(40_000);
  });

  it("caps at maxDelay", () => {
    const p = policy({
      maxAttempts: 10,
      backoff: { kind: "exponential", initialDelay: "PT10S", maxDelay: "PT1M" },
    });
    expect(retryDelayMs(p, 5)).toBe(60_000); // 10s * 2^4 = 160s → capped to 60s
  });

  it("applies jitter only when an rng is supplied, within [delay/2, delay)", () => {
    const p = policy({
      maxAttempts: 5,
      backoff: { kind: "constant", initialDelay: "PT40S", jitter: true },
    });
    expect(retryDelayMs(p, 1)).toBe(40_000); // no rng → deterministic, no jitter
    expect(retryDelayMs(p, 1, () => 0)).toBe(20_000); // low bound
    expect(retryDelayMs(p, 1, () => 0.999999)).toBeCloseTo(40_000, -2); // approaches full
  });
});

describe("nextRetryAt", () => {
  it("adds the delay to now", () => {
    const p = policy({ maxAttempts: 5, backoff: { kind: "exponential", initialDelay: "PT30S" } });
    expect(nextRetryAt(p, 2, "2026-05-17T12:00:00.000Z")).toBe("2026-05-17T12:01:00.000Z");
  });

  it("returns now when there is no backoff", () => {
    expect(nextRetryAt(undefined, 1, "2026-05-17T12:00:00.000Z")).toBe("2026-05-17T12:00:00.000Z");
  });
});
