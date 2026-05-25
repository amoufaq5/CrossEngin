import { describe, expect, it } from "vitest";
import {
  THROTTLE_ALGORITHMS,
  THROTTLE_SCOPES,
  THROTTLE_VERDICTS,
  ThrottlePolicySchema,
  ThrottlePolicySetSchema,
  effectiveLimit,
  evaluateThrottle,
  type ThrottlePolicy,
} from "./throttling.js";

describe("constants", () => {
  it("THROTTLE_SCOPES has 6 entries", () => {
    expect(THROTTLE_SCOPES).toContain("per_tenant");
    expect(THROTTLE_SCOPES).toContain("global");
  });

  it("THROTTLE_ALGORITHMS has 4 entries", () => {
    expect(THROTTLE_ALGORITHMS).toEqual([
      "token_bucket",
      "fixed_window",
      "sliding_window",
      "leaky_bucket",
    ]);
  });

  it("THROTTLE_VERDICTS has 4 entries", () => {
    expect(THROTTLE_VERDICTS).toContain("allowed");
    expect(THROTTLE_VERDICTS).toContain("rate_limited");
    expect(THROTTLE_VERDICTS).toContain("shed");
  });
});

describe("ThrottlePolicySchema", () => {
  const base: ThrottlePolicy = {
    id: "tenant-api",
    scope: "per_tenant",
    algorithm: "token_bucket",
    requestsPerWindow: 1000,
    windowSeconds: 60,
    burst: 200,
    queueDepth: 0,
    queueTimeoutMs: 0,
    overflowResponse: "429",
    exemptApiKeyTags: ["internal"],
  };

  it("accepts a valid token_bucket policy", () => {
    expect(() => ThrottlePolicySchema.parse(base)).not.toThrow();
  });

  it("rejects token_bucket without burst", () => {
    expect(() => ThrottlePolicySchema.parse({ ...base, burst: 0 })).toThrow(/burst >= 1/);
  });

  it("rejects leaky_bucket without queueDepth", () => {
    expect(() =>
      ThrottlePolicySchema.parse({
        ...base,
        algorithm: "leaky_bucket",
        burst: 0,
      }),
    ).toThrow(/queueDepth >= 1/);
  });

  it("rejects overflowResponse='queue' without queueDepth", () => {
    expect(() => ThrottlePolicySchema.parse({ ...base, overflowResponse: "queue" })).toThrow(
      /queueDepth >= 1/,
    );
  });

  it("rejects queueDepth > 0 without queueTimeoutMs", () => {
    expect(() =>
      ThrottlePolicySchema.parse({
        ...base,
        algorithm: "leaky_bucket",
        burst: 0,
        queueDepth: 100,
      }),
    ).toThrow(/queueTimeoutMs > 0/);
  });

  it("rejects global scope with exempt tags", () => {
    expect(() =>
      ThrottlePolicySchema.parse({
        ...base,
        scope: "global",
        exemptApiKeyTags: ["internal"],
      }),
    ).toThrow(/global scope cannot exempt/);
  });

  it("rejects duplicate exempt tags", () => {
    expect(() =>
      ThrottlePolicySchema.parse({
        ...base,
        exemptApiKeyTags: ["a", "a"],
      }),
    ).toThrow(/duplicate exempt tag/);
  });
});

describe("ThrottlePolicySetSchema", () => {
  const policy = (id: string, scope: ThrottlePolicy["scope"] = "per_tenant"): ThrottlePolicy => ({
    id,
    scope,
    algorithm: "fixed_window",
    requestsPerWindow: 100,
    windowSeconds: 60,
    burst: 0,
    queueDepth: 0,
    queueTimeoutMs: 0,
    overflowResponse: "429",
    exemptApiKeyTags: [],
  });

  it("accepts non-duplicating policies", () => {
    expect(() =>
      ThrottlePolicySetSchema.parse([policy("a"), policy("b", "per_user")]),
    ).not.toThrow();
  });

  it("rejects duplicate ids", () => {
    expect(() => ThrottlePolicySetSchema.parse([policy("a"), policy("a")])).toThrow(
      /duplicate throttle policy/,
    );
  });

  it("rejects more than one global policy", () => {
    expect(() =>
      ThrottlePolicySetSchema.parse([policy("a", "global"), policy("b", "global")]),
    ).toThrow(/only one global throttle/);
  });
});

describe("evaluateThrottle", () => {
  const policy: ThrottlePolicy = {
    id: "p",
    scope: "per_tenant",
    algorithm: "token_bucket",
    requestsPerWindow: 100,
    windowSeconds: 60,
    burst: 20,
    queueDepth: 0,
    queueTimeoutMs: 0,
    overflowResponse: "429",
    exemptApiKeyTags: ["internal"],
  };

  it("returns allowed when under limit", () => {
    const r = evaluateThrottle(policy, {
      observedRequestsInWindow: 50,
      currentQueueSize: 0,
      apiKeyTags: [],
    });
    expect(r.verdict).toBe("allowed");
    expect(r.remaining).toBe(69);
  });

  it("returns rate_limited when at limit (no queue)", () => {
    const r = evaluateThrottle(policy, {
      observedRequestsInWindow: 120,
      currentQueueSize: 0,
      apiKeyTags: [],
    });
    expect(r.verdict).toBe("rate_limited");
    expect(r.retryAfterMs).toBe(60_000);
  });

  it("bypasses limit for exempt tags", () => {
    const r = evaluateThrottle(policy, {
      observedRequestsInWindow: 9999,
      currentQueueSize: 0,
      apiKeyTags: ["internal"],
    });
    expect(r.verdict).toBe("allowed");
  });

  it("returns queued when limit exceeded but queue has room", () => {
    const queuedPolicy: ThrottlePolicy = {
      ...policy,
      algorithm: "leaky_bucket",
      burst: 0,
      queueDepth: 100,
      queueTimeoutMs: 5000,
      overflowResponse: "queue",
    };
    const r = evaluateThrottle(queuedPolicy, {
      observedRequestsInWindow: 200,
      currentQueueSize: 50,
      apiKeyTags: [],
    });
    expect(r.verdict).toBe("queued");
    expect(r.retryAfterMs).toBe(5000);
  });

  it("returns shed when queue is full and overflowResponse='queue'", () => {
    const queuedPolicy: ThrottlePolicy = {
      ...policy,
      algorithm: "leaky_bucket",
      burst: 0,
      queueDepth: 100,
      queueTimeoutMs: 5000,
      overflowResponse: "queue",
    };
    const r = evaluateThrottle(queuedPolicy, {
      observedRequestsInWindow: 200,
      currentQueueSize: 100,
      apiKeyTags: [],
    });
    expect(r.verdict).toBe("shed");
  });
});

describe("effectiveLimit", () => {
  it("adds burst for token_bucket", () => {
    expect(
      effectiveLimit({
        id: "p",
        scope: "per_tenant",
        algorithm: "token_bucket",
        requestsPerWindow: 100,
        windowSeconds: 60,
        burst: 20,
        queueDepth: 0,
        queueTimeoutMs: 0,
        overflowResponse: "429",
        exemptApiKeyTags: [],
      }),
    ).toBe(120);
  });

  it("ignores burst for non-token_bucket algorithms", () => {
    expect(
      effectiveLimit({
        id: "p",
        scope: "per_tenant",
        algorithm: "fixed_window",
        requestsPerWindow: 100,
        windowSeconds: 60,
        burst: 20,
        queueDepth: 0,
        queueTimeoutMs: 0,
        overflowResponse: "429",
        exemptApiKeyTags: [],
      }),
    ).toBe(100);
  });
});
