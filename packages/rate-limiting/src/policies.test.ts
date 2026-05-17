import { describe, expect, it } from "vitest";
import {
  OVERAGE_HANDLING,
  POLICY_STATUSES,
  POLICY_TRANSITIONS,
  PRIORITY_OVERRIDES,
  RateLimitPolicySchema,
  canTransitionPolicy,
  isApiKeyExempt,
  isPolicyActive,
  isPrincipalExempt,
  isRouteSubjectToPolicy,
  type RateLimitPolicy,
} from "./policies.js";

const basePolicy: RateLimitPolicy = {
  id: "rlp_apistd001",
  tenantId: null,
  label: "Standard API policy",
  description: "Standard tenant-wide API rate limit",
  version: "1.0.0",
  status: "active",
  algorithm: "token_bucket",
  algorithmParams: {
    kind: "token_bucket",
    capacity: 1000,
    refillTokensPerSecond: 100,
    burstAllowance: 50,
  },
  scope: {
    kind: "per_tenant",
    routePattern: null,
    componentScopes: [],
  },
  overageHandling: "hard_block",
  priorityOverride: "critical_only",
  softThrottleDelayMsPerOverage: 0,
  queueMaxWaitMs: 0,
  responseCode: 429,
  includeRetryAfterHeader: true,
  includeRateLimitHeaders: true,
  problemTypeUri: "https://crossengin.io/errors/rate-limited",
  enabledRoutes: [],
  excludedRoutes: ["/health"],
  exemptPrincipalIds: [],
  exemptApiKeyPrefixes: [],
  createdAt: "2026-05-15T10:00:00.000Z",
  createdBy: "11111111-1111-1111-1111-111111111111",
  activatedAt: "2026-05-15T11:00:00.000Z",
  activatedBy: "22222222-2222-2222-2222-222222222222",
  deprecatedAt: null,
  supersededByPolicyId: null,
};

describe("constants", () => {
  it("has 5 policy statuses", () => {
    expect(POLICY_STATUSES).toHaveLength(5);
  });
  it("has 5 overage handling kinds", () => {
    expect(OVERAGE_HANDLING).toHaveLength(5);
  });
  it("has 4 priority overrides", () => {
    expect(PRIORITY_OVERRIDES).toHaveLength(4);
  });
});

describe("canTransitionPolicy", () => {
  it("allows draft → active", () => {
    expect(canTransitionPolicy("draft", "active")).toBe(true);
  });
  it("blocks active → draft", () => {
    expect(canTransitionPolicy("active", "draft")).toBe(false);
  });
  it("retired is terminal", () => {
    expect(POLICY_TRANSITIONS.retired).toEqual([]);
  });
});

describe("RateLimitPolicySchema", () => {
  it("accepts a valid active policy", () => {
    expect(() => RateLimitPolicySchema.parse(basePolicy)).not.toThrow();
  });

  it("rejects algorithm/params mismatch", () => {
    expect(() =>
      RateLimitPolicySchema.parse({
        ...basePolicy,
        algorithm: "leaky_bucket",
      }),
    ).toThrow(/does not match/);
  });

  it("rejects soft_throttle_delay overage with delay=0", () => {
    expect(() =>
      RateLimitPolicySchema.parse({
        ...basePolicy,
        overageHandling: "soft_throttle_delay",
        softThrottleDelayMsPerOverage: 0,
      }),
    ).toThrow(/softThrottleDelayMsPerOverage > 0/);
  });

  it("rejects queue_and_serve with queueMaxWaitMs=0", () => {
    expect(() =>
      RateLimitPolicySchema.parse({
        ...basePolicy,
        overageHandling: "queue_and_serve",
        queueMaxWaitMs: 0,
      }),
    ).toThrow(/queueMaxWaitMs > 0/);
  });

  it("rejects active without activatedAt+activatedBy", () => {
    expect(() =>
      RateLimitPolicySchema.parse({
        ...basePolicy,
        activatedAt: null,
        activatedBy: null,
      }),
    ).toThrow(/active policy requires/);
  });

  it("enforces four-eyes (activatedBy ≠ createdBy)", () => {
    expect(() =>
      RateLimitPolicySchema.parse({
        ...basePolicy,
        activatedBy: basePolicy.createdBy,
      }),
    ).toThrow(/four-eyes/);
  });

  it("rejects route in both enabledRoutes and excludedRoutes", () => {
    expect(() =>
      RateLimitPolicySchema.parse({
        ...basePolicy,
        enabledRoutes: ["/api/x"],
        excludedRoutes: ["/api/x"],
      }),
    ).toThrow(/cannot be in both/);
  });

  it("rejects response_code other than 429/503", () => {
    expect(() =>
      RateLimitPolicySchema.parse({
        ...basePolicy,
        responseCode: 500,
      }),
    ).toThrow();
  });
});

describe("isPolicyActive", () => {
  it("returns true for active", () => {
    expect(isPolicyActive(basePolicy)).toBe(true);
  });
  it("returns false for paused", () => {
    expect(isPolicyActive({ ...basePolicy, status: "paused" })).toBe(false);
  });
});

describe("isRouteSubjectToPolicy", () => {
  it("returns true for any route when enabledRoutes empty and route not excluded", () => {
    expect(isRouteSubjectToPolicy(basePolicy, "/v1/things")).toBe(true);
  });
  it("returns false for explicitly excluded route", () => {
    expect(isRouteSubjectToPolicy(basePolicy, "/health")).toBe(false);
  });
  it("respects allowlist when enabledRoutes is set", () => {
    const explicit: RateLimitPolicy = {
      ...basePolicy,
      enabledRoutes: ["/v1/things"],
    };
    expect(isRouteSubjectToPolicy(explicit, "/v1/things")).toBe(true);
    expect(isRouteSubjectToPolicy(explicit, "/v1/other")).toBe(false);
  });
});

describe("isPrincipalExempt / isApiKeyExempt", () => {
  it("returns true for exempt principal", () => {
    const p: RateLimitPolicy = {
      ...basePolicy,
      exemptPrincipalIds: ["33333333-3333-3333-3333-333333333333"],
    };
    expect(
      isPrincipalExempt(p, "33333333-3333-3333-3333-333333333333"),
    ).toBe(true);
  });
  it("returns false for non-exempt principal", () => {
    expect(
      isPrincipalExempt(
        basePolicy,
        "44444444-4444-4444-4444-444444444444",
      ),
    ).toBe(false);
  });
  it("returns false for null principal", () => {
    expect(isPrincipalExempt(basePolicy, null)).toBe(false);
  });
  it("returns true for exempt API key prefix", () => {
    const p: RateLimitPolicy = {
      ...basePolicy,
      exemptApiKeyPrefixes: ["ce_live_AbCdEfGh"],
    };
    expect(isApiKeyExempt(p, "ce_live_AbCdEfGh")).toBe(true);
  });
});
