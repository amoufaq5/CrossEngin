import { describe, expect, it } from "vitest";
import {
  ALLOWED_OUTCOMES,
  DECISION_OUTCOMES,
  DENIED_OUTCOMES,
  RateLimitDecisionSchema,
  aggregateDecisions,
  wasAllowed,
  wasBypassed,
  wasDenied,
  type RateLimitDecision,
} from "./decisions.js";

const baseDecision: RateLimitDecision = {
  id: "rld_dec000001",
  tenantId: "11111111-1111-1111-1111-111111111111",
  policyId: "rlp_apistd001",
  quotaDefinitionId: null,
  scopeKey: "tenant:11111111-1111-1111-1111-111111111111",
  principalId: "22222222-2222-2222-2222-222222222222",
  apiKeyPrefix: null,
  route: "/v1/things",
  decidedAt: "2026-05-16T10:00:00.000Z",
  outcome: "allowed",
  costUnits: 1,
  limitTotal: 1000,
  remainingAfter: 950,
  resetAt: "2026-05-16T10:00:10.000Z",
  retryAfterSeconds: null,
  softThrottleDelayMs: null,
  appliedHeaders: {
    limit: 1000,
    remaining: 950,
    resetAt: "2026-05-16T10:00:10.000Z",
    retryAfterSeconds: null,
    policy: "rlp_apistd001",
  },
  problemDetails: null,
  bypassReason: null,
};

describe("constants", () => {
  it("has 10 decision outcomes", () => {
    expect(DECISION_OUTCOMES).toHaveLength(10);
  });
  it("ALLOWED_OUTCOMES has 5 entries", () => {
    expect(ALLOWED_OUTCOMES.size).toBe(5);
  });
  it("DENIED_OUTCOMES has 5 entries", () => {
    expect(DENIED_OUTCOMES.size).toBe(5);
  });
});

describe("RateLimitDecisionSchema", () => {
  it("accepts an allowed decision", () => {
    expect(() => RateLimitDecisionSchema.parse(baseDecision)).not.toThrow();
  });

  it("rejects denied without retryAfterSeconds", () => {
    expect(() =>
      RateLimitDecisionSchema.parse({
        ...baseDecision,
        outcome: "denied_rate_limit_exceeded",
        remainingAfter: 0,
        problemDetails: {
          type: "https://crossengin.io/errors/rate-limited",
          title: "Too Many Requests",
          status: 429,
          detail: "Rate limit exceeded",
        },
      }),
    ).toThrow(/retryAfterSeconds/);
  });

  it("rejects denied with non-zero remainingAfter", () => {
    expect(() =>
      RateLimitDecisionSchema.parse({
        ...baseDecision,
        outcome: "denied_rate_limit_exceeded",
        remainingAfter: 50,
        retryAfterSeconds: 30,
        problemDetails: {
          type: "https://crossengin.io/errors/rate-limited",
          title: "Too Many Requests",
          status: 429,
          detail: "Rate limit exceeded",
        },
      }),
    ).toThrow(/requires remainingAfter=0/);
  });

  it("rejects denied without problemDetails", () => {
    expect(() =>
      RateLimitDecisionSchema.parse({
        ...baseDecision,
        outcome: "denied_quota_exceeded",
        remainingAfter: 0,
        retryAfterSeconds: 60,
      }),
    ).toThrow(/problemDetails/);
  });

  it("rejects problemDetails with status other than 429/503", () => {
    expect(() =>
      RateLimitDecisionSchema.parse({
        ...baseDecision,
        outcome: "denied_rate_limit_exceeded",
        remainingAfter: 0,
        retryAfterSeconds: 30,
        problemDetails: {
          type: "https://crossengin.io/errors/rate-limited",
          title: "Too Many Requests",
          status: 500,
          detail: "Rate limit exceeded",
        },
      }),
    ).toThrow(/429 or 503/);
  });

  it("rejects throttled_soft_delayed without softThrottleDelayMs", () => {
    expect(() =>
      RateLimitDecisionSchema.parse({
        ...baseDecision,
        outcome: "throttled_soft_delayed",
      }),
    ).toThrow(/softThrottleDelayMs/);
  });

  it("rejects bypass outcomes without bypassReason", () => {
    expect(() =>
      RateLimitDecisionSchema.parse({
        ...baseDecision,
        outcome: "bypassed_critical_priority",
      }),
    ).toThrow(/bypassReason/);
  });
});

describe("wasAllowed / wasDenied / wasBypassed", () => {
  it("classifies allowed correctly", () => {
    expect(wasAllowed(baseDecision)).toBe(true);
    expect(wasDenied(baseDecision)).toBe(false);
    expect(wasBypassed(baseDecision)).toBe(false);
  });
  it("classifies denied correctly", () => {
    const d: RateLimitDecision = {
      ...baseDecision,
      outcome: "denied_rate_limit_exceeded",
      remainingAfter: 0,
      retryAfterSeconds: 60,
      problemDetails: {
        type: "https://crossengin.io/errors/rate-limited",
        title: "Too Many Requests",
        status: 429,
        detail: "Rate limit exceeded",
      },
    };
    expect(wasDenied(d)).toBe(true);
    expect(wasAllowed(d)).toBe(false);
  });
});

describe("aggregateDecisions", () => {
  it("returns zeros for empty", () => {
    const a = aggregateDecisions([]);
    expect(a.totalDecisions).toBe(0);
    expect(a.denialRate).toBe(0);
  });

  it("computes denial rate", () => {
    const allowed = baseDecision;
    const denied: RateLimitDecision = {
      ...baseDecision,
      id: "rld_dec000002",
      outcome: "denied_rate_limit_exceeded",
      remainingAfter: 0,
      retryAfterSeconds: 30,
      problemDetails: {
        type: "https://crossengin.io/errors/rate-limited",
        title: "Too Many Requests",
        status: 429,
        detail: "Rate limit exceeded",
      },
    };
    const a = aggregateDecisions([allowed, allowed, denied]);
    expect(a.totalDecisions).toBe(3);
    expect(a.allowedCount).toBe(2);
    expect(a.deniedCount).toBe(1);
    expect(a.denialRate).toBeCloseTo(1 / 3);
  });
});
