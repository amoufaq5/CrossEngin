import { describe, expect, it } from "vitest";
import {
  SEGMENT_KINDS,
  SegmentSchema,
  TARGETING_RULE_KINDS,
  TargetingRuleConditionSchema,
  TargetingRuleSchema,
  computeStableBucket,
  evaluateTargetingCondition,
  sortRulesByPriority,
  type TargetingContext,
  type TargetingRule,
} from "./targeting.js";

const baseContext: TargetingContext = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  principalId: "22222222-2222-2222-2222-222222222222",
  sessionId: "session-abc",
  tenantAttributes: { tier: "enterprise", region: "us-east" },
  principalAttributes: { role: "admin", country: "US" },
  geoCountry: "US",
  device: "desktop",
};

describe("constants", () => {
  it("has 10 targeting rule kinds", () => {
    expect(TARGETING_RULE_KINDS).toHaveLength(10);
  });
  it("has 6 segment kinds", () => {
    expect(SEGMENT_KINDS).toHaveLength(6);
  });
});

describe("TargetingRuleConditionSchema", () => {
  it("accepts all_users", () => {
    expect(() =>
      TargetingRuleConditionSchema.parse({ kind: "all_users" }),
    ).not.toThrow();
  });

  it("accepts specific_tenants", () => {
    expect(() =>
      TargetingRuleConditionSchema.parse({
        kind: "specific_tenants",
        tenantIds: ["11111111-1111-1111-1111-111111111111"],
      }),
    ).not.toThrow();
  });

  it("accepts percentage_bucket within range", () => {
    expect(() =>
      TargetingRuleConditionSchema.parse({
        kind: "percentage_bucket",
        bucketingKey: "tenant_id",
        salt: "rollout-2026-05",
        minBucketInclusive: 0,
        maxBucketExclusive: 1000,
      }),
    ).not.toThrow();
  });

  it("rejects percentage_bucket with min >= max", () => {
    expect(() =>
      TargetingRuleConditionSchema.parse({
        kind: "percentage_bucket",
        bucketingKey: "tenant_id",
        salt: "rollout",
        minBucketInclusive: 5000,
        maxBucketExclusive: 5000,
      }),
    ).toThrow(/must be greater than/);
  });
});

describe("TargetingRuleSchema", () => {
  const baseRule: TargetingRule = {
    id: "ftr_internal01",
    tenantId: null,
    flagId: "ff_newcheck01",
    priority: 10,
    label: "Internal users get new flow",
    condition: { kind: "all_users" },
    servedVariantKey: null,
    servedValueJson: "true",
    isExclusion: false,
    createdAt: "2026-05-15T10:00:00.000Z",
    createdBy: "22222222-2222-2222-2222-222222222222",
  };

  it("accepts a valid rule with servedValueJson", () => {
    expect(() => TargetingRuleSchema.parse(baseRule)).not.toThrow();
  });

  it("rejects rule with neither variant nor value", () => {
    expect(() =>
      TargetingRuleSchema.parse({
        ...baseRule,
        servedValueJson: null,
      }),
    ).toThrow(/either servedVariantKey or servedValueJson/);
  });

  it("rejects rule with both variant and value", () => {
    expect(() =>
      TargetingRuleSchema.parse({
        ...baseRule,
        servedVariantKey: "control",
      }),
    ).toThrow(/cannot specify both/);
  });

  it("rejects invalid servedValueJson", () => {
    expect(() =>
      TargetingRuleSchema.parse({
        ...baseRule,
        servedValueJson: "{not valid",
      }),
    ).toThrow(/must be valid JSON/);
  });
});

describe("SegmentSchema", () => {
  it("accepts a valid segment", () => {
    expect(() =>
      SegmentSchema.parse({
        id: "fseg_enterprise01",
        tenantId: null,
        key: "tier.enterprise",
        label: "Enterprise tier tenants",
        description: "Tenants on the enterprise tier",
        kind: "tenant_tier_based",
        rules: [
          {
            kind: "tenant_attribute_equals",
            attributePath: "tier",
            expectedValue: "enterprise",
          },
        ],
        createdAt: "2026-05-15T10:00:00.000Z",
        createdBy: "22222222-2222-2222-2222-222222222222",
        archivedAt: null,
      }),
    ).not.toThrow();
  });
});

describe("evaluateTargetingCondition", () => {
  it("all_users always matches", () => {
    expect(
      evaluateTargetingCondition({ kind: "all_users" }, baseContext),
    ).toBe(true);
  });

  it("specific_tenants matches when id in list", () => {
    expect(
      evaluateTargetingCondition(
        {
          kind: "specific_tenants",
          tenantIds: [baseContext.tenantId as string],
        },
        baseContext,
      ),
    ).toBe(true);
  });

  it("specific_principals matches", () => {
    expect(
      evaluateTargetingCondition(
        {
          kind: "specific_principals",
          principalIds: [baseContext.principalId as string],
        },
        baseContext,
      ),
    ).toBe(true);
  });

  it("tenant_attribute_equals matches", () => {
    expect(
      evaluateTargetingCondition(
        {
          kind: "tenant_attribute_equals",
          attributePath: "tier",
          expectedValue: "enterprise",
        },
        baseContext,
      ),
    ).toBe(true);
  });

  it("tenant_attribute_in matches list", () => {
    expect(
      evaluateTargetingCondition(
        {
          kind: "tenant_attribute_in",
          attributePath: "region",
          allowedValues: ["us-east", "us-west"],
        },
        baseContext,
      ),
    ).toBe(true);
  });

  it("principal_attribute_equals matches", () => {
    expect(
      evaluateTargetingCondition(
        {
          kind: "principal_attribute_equals",
          attributePath: "role",
          expectedValue: "admin",
        },
        baseContext,
      ),
    ).toBe(true);
  });

  it("percentage_bucket is deterministic for same input", () => {
    const result1 = evaluateTargetingCondition(
      {
        kind: "percentage_bucket",
        bucketingKey: "tenant_id",
        salt: "salt-1",
        minBucketInclusive: 0,
        maxBucketExclusive: 5000,
      },
      baseContext,
    );
    const result2 = evaluateTargetingCondition(
      {
        kind: "percentage_bucket",
        bucketingKey: "tenant_id",
        salt: "salt-1",
        minBucketInclusive: 0,
        maxBucketExclusive: 5000,
      },
      baseContext,
    );
    expect(result1).toBe(result2);
  });

  it("percentage_bucket 100% matches always", () => {
    expect(
      evaluateTargetingCondition(
        {
          kind: "percentage_bucket",
          bucketingKey: "tenant_id",
          salt: "salt-x",
          minBucketInclusive: 0,
          maxBucketExclusive: 10_000,
        },
        baseContext,
      ),
    ).toBe(true);
  });

  it("custom_predicate returns false (Phase 2 evaluator)", () => {
    expect(
      evaluateTargetingCondition(
        {
          kind: "custom_predicate",
          predicate: "tenant.tier === 'enterprise'",
          description: "x",
        },
        baseContext,
      ),
    ).toBe(false);
  });
});

describe("computeStableBucket", () => {
  it("returns deterministic bucket for same inputs", () => {
    const a = computeStableBucket("tenant-1", "salt");
    const b = computeStableBucket("tenant-1", "salt");
    expect(a).toBe(b);
  });

  it("returns different buckets for different salts", () => {
    const a = computeStableBucket("tenant-1", "salt-a");
    const b = computeStableBucket("tenant-1", "salt-b");
    expect(a).not.toBe(b);
  });

  it("returns bucket in [0, 10000)", () => {
    for (let i = 0; i < 100; i++) {
      const b = computeStableBucket(`tenant-${i}`, "salt");
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(10_000);
    }
  });
});

describe("sortRulesByPriority", () => {
  it("sorts ascending by priority", () => {
    const base: TargetingRule = {
      id: "ftr_a0000001",
      tenantId: null,
      flagId: "ff_newcheck01",
      priority: 50,
      label: "Mid",
      condition: { kind: "all_users" },
      servedVariantKey: null,
      servedValueJson: "true",
      isExclusion: false,
      createdAt: "2026-05-15T10:00:00.000Z",
      createdBy: "22222222-2222-2222-2222-222222222222",
    };
    const r1 = { ...base, id: "ftr_b0000001", priority: 10 };
    const r2 = { ...base, id: "ftr_c0000001", priority: 100 };
    const sorted = sortRulesByPriority([base, r1, r2]);
    expect(sorted.map((r) => r.priority)).toEqual([10, 50, 100]);
  });
});
