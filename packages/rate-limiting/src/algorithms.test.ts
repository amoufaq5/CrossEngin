import { describe, expect, it } from "vitest";
import {
  ALGORITHM_IS_RECOMMENDED_FOR_DISTRIBUTED,
  ALGORITHM_SUPPORTS_BURST,
  AlgorithmParamsSchema,
  RATE_LIMIT_ALGORITHMS,
  algorithmSupportsBurst,
  computeFixedWindowStart,
  evaluateConcurrentRequest,
  evaluateFixedWindow,
  evaluateSlidingWindow,
  evaluateTokenBucket,
  isAlgorithmDistributedFriendly,
} from "./algorithms.js";

describe("constants", () => {
  it("has 6 algorithms", () => {
    expect(RATE_LIMIT_ALGORITHMS).toHaveLength(6);
  });
  it("token_bucket and sliding_window_log support burst", () => {
    expect(ALGORITHM_SUPPORTS_BURST.has("token_bucket")).toBe(true);
    expect(ALGORITHM_SUPPORTS_BURST.has("sliding_window_log")).toBe(true);
    expect(ALGORITHM_SUPPORTS_BURST.has("fixed_window")).toBe(false);
  });
  it("token_bucket / sliding_window / fixed_window are distributed-friendly", () => {
    expect(ALGORITHM_IS_RECOMMENDED_FOR_DISTRIBUTED.has("token_bucket")).toBe(true);
    expect(ALGORITHM_IS_RECOMMENDED_FOR_DISTRIBUTED.has("leaky_bucket")).toBe(false);
  });
});

describe("AlgorithmParamsSchema", () => {
  it("accepts a valid token_bucket", () => {
    expect(() =>
      AlgorithmParamsSchema.parse({
        kind: "token_bucket",
        capacity: 100,
        refillTokensPerSecond: 10,
        burstAllowance: 20,
      }),
    ).not.toThrow();
  });

  it("rejects burstAllowance > capacity", () => {
    expect(() =>
      AlgorithmParamsSchema.parse({
        kind: "token_bucket",
        capacity: 100,
        refillTokensPerSecond: 10,
        burstAllowance: 200,
      }),
    ).toThrow(/burstAllowance cannot exceed capacity/);
  });

  it("accepts fixed_window params", () => {
    expect(() =>
      AlgorithmParamsSchema.parse({
        kind: "fixed_window",
        windowSeconds: 60,
        maxRequestsPerWindow: 100,
      }),
    ).not.toThrow();
  });

  it("accepts sliding_window with precisionSeconds", () => {
    expect(() =>
      AlgorithmParamsSchema.parse({
        kind: "sliding_window",
        windowSeconds: 60,
        maxRequestsPerWindow: 100,
        precisionSeconds: 1,
      }),
    ).not.toThrow();
  });
});

describe("evaluateTokenBucket", () => {
  const params = { capacity: 100, refillTokensPerSecond: 10 };

  it("allows when tokens >= cost", () => {
    const r = evaluateTokenBucket({
      state: { tokens: 50, lastRefillAt: "2026-05-16T10:00:00.000Z" },
      params,
      cost: 10,
      now: new Date("2026-05-16T10:00:00Z"),
    });
    expect(r.allowed).toBe(true);
    expect(r.tokensAfter).toBe(40);
  });

  it("refills tokens proportional to elapsed seconds", () => {
    const r = evaluateTokenBucket({
      state: { tokens: 0, lastRefillAt: "2026-05-16T10:00:00.000Z" },
      params,
      cost: 5,
      now: new Date("2026-05-16T10:00:01.000Z"),
    });
    expect(r.allowed).toBe(true);
    expect(r.tokensAfter).toBe(5);
  });

  it("caps tokens at capacity", () => {
    const r = evaluateTokenBucket({
      state: { tokens: 50, lastRefillAt: "2026-05-16T10:00:00.000Z" },
      params,
      cost: 0,
      now: new Date("2026-05-16T10:01:00.000Z"),
    });
    expect(r.tokensAfter).toBe(100);
  });

  it("denies and computes wait time when tokens < cost", () => {
    const r = evaluateTokenBucket({
      state: { tokens: 2, lastRefillAt: "2026-05-16T10:00:00.000Z" },
      params,
      cost: 10,
      now: new Date("2026-05-16T10:00:00Z"),
    });
    expect(r.allowed).toBe(false);
    expect(r.waitSecondsForCost).toBeGreaterThan(0);
  });
});

describe("computeFixedWindowStart", () => {
  it("aligns to 60-second boundary", () => {
    const start = computeFixedWindowStart(
      new Date("2026-05-16T10:00:45Z"),
      60,
    );
    expect(start).toBe("2026-05-16T10:00:00.000Z");
  });
  it("aligns to hour boundary", () => {
    const start = computeFixedWindowStart(
      new Date("2026-05-16T10:42:13Z"),
      3600,
    );
    expect(start).toBe("2026-05-16T10:00:00.000Z");
  });
});

describe("evaluateFixedWindow", () => {
  it("allows when below max", () => {
    const r = evaluateFixedWindow({
      state: null,
      windowSeconds: 60,
      maxRequestsPerWindow: 10,
      now: new Date("2026-05-16T10:00:00Z"),
    });
    expect(r.allowed).toBe(true);
    expect(r.newState.count).toBe(1);
  });

  it("denies when count hits max", () => {
    const r = evaluateFixedWindow({
      state: {
        windowStartAt: "2026-05-16T10:00:00.000Z",
        count: 10,
      },
      windowSeconds: 60,
      maxRequestsPerWindow: 10,
      now: new Date("2026-05-16T10:00:30Z"),
    });
    expect(r.allowed).toBe(false);
  });

  it("resets when crossing window boundary", () => {
    const r = evaluateFixedWindow({
      state: {
        windowStartAt: "2026-05-16T10:00:00.000Z",
        count: 10,
      },
      windowSeconds: 60,
      maxRequestsPerWindow: 10,
      now: new Date("2026-05-16T10:01:30Z"),
    });
    expect(r.allowed).toBe(true);
    expect(r.newState.count).toBe(1);
  });
});

describe("evaluateSlidingWindow", () => {
  it("allows when below max", () => {
    const r = evaluateSlidingWindow({
      samples: [
        {
          bucketStartAt: "2026-05-16T10:00:00.000Z",
          count: 5,
        },
      ],
      windowSeconds: 60,
      maxRequestsPerWindow: 10,
      now: new Date("2026-05-16T10:00:30Z"),
    });
    expect(r.allowed).toBe(true);
    expect(r.currentCount).toBe(5);
  });

  it("excludes samples outside window", () => {
    const r = evaluateSlidingWindow({
      samples: [
        {
          bucketStartAt: "2026-05-16T09:00:00.000Z",
          count: 5,
        },
      ],
      windowSeconds: 60,
      maxRequestsPerWindow: 10,
      now: new Date("2026-05-16T10:00:30Z"),
    });
    expect(r.currentCount).toBe(0);
  });
});

describe("evaluateConcurrentRequest", () => {
  it("allows when slots available", () => {
    expect(
      evaluateConcurrentRequest({
        currentInFlight: 5,
        maxConcurrent: 10,
      }),
    ).toEqual({ allowed: true, slotsRemaining: 4 });
  });
  it("denies when at limit", () => {
    expect(
      evaluateConcurrentRequest({
        currentInFlight: 10,
        maxConcurrent: 10,
      }),
    ).toEqual({ allowed: false, slotsRemaining: 0 });
  });
});

describe("algorithmSupportsBurst / isAlgorithmDistributedFriendly", () => {
  it("token_bucket supports burst + is distributed-friendly", () => {
    expect(algorithmSupportsBurst("token_bucket")).toBe(true);
    expect(isAlgorithmDistributedFriendly("token_bucket")).toBe(true);
  });
});
