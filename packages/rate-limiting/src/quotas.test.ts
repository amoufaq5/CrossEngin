import { describe, expect, it } from "vitest";
import {
  PERIOD_SECONDS,
  QUOTA_CLASSES,
  QUOTA_PERIODS,
  QUOTA_TARGETS,
  QuotaDefinitionSchema,
  QuotaUsageSchema,
  computePeriodEnd,
  computePeriodStart,
  evaluateQuota,
  type QuotaDefinition,
  type QuotaUsage,
} from "./quotas.js";

const baseDefinition: QuotaDefinition = {
  id: "rlq_apirpd0001",
  tenantId: "11111111-1111-1111-1111-111111111111",
  label: "Pro tier API requests/day",
  target: "api_requests",
  quotaClass: "pro",
  period: "day",
  hardLimit: 1_000_000,
  softLimit: 900_000,
  overageAllowed: true,
  overageUnitPriceCents: 1,
  appliesAfterPlanSwitchSeconds: 0,
  createdAt: "2026-05-15T10:00:00.000Z",
  createdBy: "22222222-2222-2222-2222-222222222222",
};

const baseUsage: QuotaUsage = {
  id: "rlu_currdayapi",
  tenantId: "11111111-1111-1111-1111-111111111111",
  quotaDefinitionId: "rlq_apirpd0001",
  target: "api_requests",
  period: "day",
  periodStartAt: "2026-05-16T00:00:00.000Z",
  periodEndAt: "2026-05-17T00:00:00.000Z",
  consumedUnits: 500_000,
  softLimitBreachedAt: null,
  hardLimitBreachedAt: null,
  overageUnitsConsumed: 0,
  overageBilledAt: null,
  lastUpdatedAt: "2026-05-16T12:00:00.000Z",
};

describe("constants", () => {
  it("has 7 quota periods", () => {
    expect(QUOTA_PERIODS).toHaveLength(7);
  });
  it("has 6 quota classes", () => {
    expect(QUOTA_CLASSES).toHaveLength(6);
  });
  it("has 10 quota targets", () => {
    expect(QUOTA_TARGETS).toHaveLength(10);
  });
  it("lifetime period has null seconds", () => {
    expect(PERIOD_SECONDS.lifetime).toBeNull();
  });
  it("day period is 86400 seconds", () => {
    expect(PERIOD_SECONDS.day).toBe(86_400);
  });
});

describe("QuotaDefinitionSchema", () => {
  it("accepts a valid definition", () => {
    expect(() => QuotaDefinitionSchema.parse(baseDefinition)).not.toThrow();
  });

  it("rejects softLimit >= hardLimit", () => {
    expect(() =>
      QuotaDefinitionSchema.parse({
        ...baseDefinition,
        softLimit: 1_500_000,
      }),
    ).toThrow(/softLimit must be less than hardLimit/);
  });

  it("rejects overageAllowed without overageUnitPriceCents", () => {
    expect(() =>
      QuotaDefinitionSchema.parse({
        ...baseDefinition,
        overageUnitPriceCents: null,
      }),
    ).toThrow(/overageUnitPriceCents/);
  });

  it("rejects free_tier with overage allowed", () => {
    expect(() =>
      QuotaDefinitionSchema.parse({
        ...baseDefinition,
        quotaClass: "free_tier",
      }),
    ).toThrow(/free_tier quotas cannot allow overage/);
  });

  it("rejects lifetime period for api_requests", () => {
    expect(() =>
      QuotaDefinitionSchema.parse({
        ...baseDefinition,
        period: "lifetime",
      }),
    ).toThrow(/lifetime period is only valid for cumulative targets/);
  });
});

describe("QuotaUsageSchema", () => {
  it("accepts a daily usage record", () => {
    expect(() => QuotaUsageSchema.parse(baseUsage)).not.toThrow();
  });

  it("rejects periodEndAt <= periodStartAt", () => {
    expect(() =>
      QuotaUsageSchema.parse({
        ...baseUsage,
        periodEndAt: baseUsage.periodStartAt,
      }),
    ).toThrow(/periodEndAt must be after/);
  });

  it("rejects lifetime period with non-null periodEndAt", () => {
    expect(() =>
      QuotaUsageSchema.parse({
        ...baseUsage,
        period: "lifetime",
      }),
    ).toThrow(/lifetime period must have null periodEndAt/);
  });

  it("rejects non-lifetime without periodEndAt", () => {
    expect(() =>
      QuotaUsageSchema.parse({
        ...baseUsage,
        periodEndAt: null,
      }),
    ).toThrow(/day period requires periodEndAt/);
  });

  it("rejects hardLimitBreachedAt before softLimitBreachedAt", () => {
    expect(() =>
      QuotaUsageSchema.parse({
        ...baseUsage,
        softLimitBreachedAt: "2026-05-16T15:00:00.000Z",
        hardLimitBreachedAt: "2026-05-16T14:00:00.000Z",
      }),
    ).toThrow(/cannot precede softLimitBreachedAt/);
  });
});

describe("computePeriodStart / computePeriodEnd", () => {
  it("aligns to day boundary", () => {
    const start = computePeriodStart("day", new Date("2026-05-16T10:42:13Z"), null);
    expect(start).toBe("2026-05-16T00:00:00.000Z");
  });
  it("uses billingCycleStart for billing_period", () => {
    const start = computePeriodStart(
      "billing_period",
      new Date("2026-05-16T10:00:00Z"),
      new Date("2026-05-01T00:00:00Z"),
    );
    expect(start).toBe("2026-05-01T00:00:00.000Z");
  });
  it("computePeriodEnd returns null for lifetime", () => {
    expect(computePeriodEnd("lifetime", new Date("2026-05-16T00:00:00Z"))).toBeNull();
  });
  it("computePeriodEnd returns +day for day period", () => {
    const end = computePeriodEnd("day", new Date("2026-05-16T00:00:00Z"));
    expect(end).toBe("2026-05-17T00:00:00.000Z");
  });
});

describe("evaluateQuota", () => {
  it("returns within_soft_limit when below soft", () => {
    const r = evaluateQuota({
      definition: baseDefinition,
      currentUsage: 100,
      costUnits: 50,
      now: new Date(),
    });
    expect(r.outcome).toBe("within_soft_limit");
    expect(r.allowed).toBe(true);
  });

  it("returns soft_limit_exceeded between soft and hard", () => {
    const r = evaluateQuota({
      definition: baseDefinition,
      currentUsage: 920_000,
      costUnits: 100,
      now: new Date(),
    });
    expect(r.outcome).toBe("soft_limit_exceeded");
    expect(r.allowed).toBe(true);
  });

  it("returns overage_billable when overage allowed", () => {
    const r = evaluateQuota({
      definition: baseDefinition,
      currentUsage: 1_000_000,
      costUnits: 100,
      now: new Date(),
    });
    expect(r.outcome).toBe("overage_billable");
    expect(r.overageUnits).toBe(100);
  });

  it("returns hard_limit_blocked when overage not allowed", () => {
    const r = evaluateQuota({
      definition: { ...baseDefinition, overageAllowed: false, overageUnitPriceCents: null },
      currentUsage: 1_000_000,
      costUnits: 100,
      now: new Date(),
    });
    expect(r.outcome).toBe("hard_limit_blocked");
    expect(r.allowed).toBe(false);
  });
});
