import { describe, expect, it } from "vitest";
import {
  BUDGET_ACTIONS,
  BUDGET_PERIODS,
  BudgetBreachRecordSchema,
  BudgetThresholdSchema,
  CostBudgetSchema,
  currentSpendPercent,
  highestSeverityAction,
  thresholdsCrossed,
  type CostBudget,
} from "./budgets.js";

describe("constants", () => {
  it("BUDGET_PERIODS has 5 entries", () => {
    expect(BUDGET_PERIODS).toContain("daily");
    expect(BUDGET_PERIODS).toContain("annual");
  });

  it("BUDGET_ACTIONS has 4 entries", () => {
    expect(BUDGET_ACTIONS).toEqual(["alert_only", "throttle", "block_new_usage", "page_oncall"]);
  });
});

describe("BudgetThresholdSchema", () => {
  it("accepts alert_only at 50%", () => {
    expect(() =>
      BudgetThresholdSchema.parse({
        percentOfBudget: 50,
        action: "alert_only",
        notifyChannels: ["email"],
      }),
    ).not.toThrow();
  });

  it("rejects throttle below 80%", () => {
    expect(() =>
      BudgetThresholdSchema.parse({
        percentOfBudget: 50,
        action: "throttle",
        notifyChannels: ["slack"],
      }),
    ).toThrow(/must trigger at >=80/);
  });

  it("rejects page_oncall without pagerduty channel", () => {
    expect(() =>
      BudgetThresholdSchema.parse({
        percentOfBudget: 100,
        action: "page_oncall",
        notifyChannels: ["email"],
      }),
    ).toThrow(/'pagerduty' channel/);
  });
});

describe("CostBudgetSchema", () => {
  const base: CostBudget = {
    id: "tenant-monthly",
    tenantId: "t-1",
    label: "Tenant monthly cap",
    period: "monthly",
    amountCents: 100_000,
    currency: "USD",
    appliesToCategories: [],
    thresholds: [
      { percentOfBudget: 50, action: "alert_only", notifyChannels: ["email"] },
      { percentOfBudget: 80, action: "throttle", notifyChannels: ["slack"] },
    ],
    autoResetAtPeriodEnd: true,
    enabled: true,
    createdAt: "2026-05-01T00:00:00Z",
    createdBy: "u-1",
    updatedAt: "2026-05-01T00:00:00Z",
  };

  it("accepts a valid budget", () => {
    expect(() => CostBudgetSchema.parse(base)).not.toThrow();
  });

  it("rejects duplicate threshold percents", () => {
    expect(() =>
      CostBudgetSchema.parse({
        ...base,
        thresholds: [
          { percentOfBudget: 80, action: "throttle", notifyChannels: ["slack"] },
          { percentOfBudget: 80, action: "alert_only", notifyChannels: ["email"] },
        ],
      }),
    ).toThrow(/duplicate threshold/);
  });

  it("rejects duplicate categories", () => {
    expect(() =>
      CostBudgetSchema.parse({
        ...base,
        appliesToCategories: ["compute_serverless", "compute_serverless"],
      }),
    ).toThrow(/duplicate category/);
  });
});

describe("BudgetBreachRecordSchema", () => {
  it("accepts a valid breach", () => {
    expect(() =>
      BudgetBreachRecordSchema.parse({
        id: "br-1",
        budgetId: "tenant-monthly",
        tenantId: "t-1",
        periodStart: "2026-05-01T00:00:00Z",
        periodEnd: "2026-06-01T00:00:00Z",
        budgetAmountCents: 100_000,
        actualSpendCents: 110_000,
        breachPercent: 110,
        triggeredAction: "alert_only",
        detectedAt: "2026-05-30T00:00:00Z",
        notifiedChannels: ["email"],
        acknowledgedAt: null,
        acknowledgedBy: null,
        resolvedAt: null,
      }),
    ).not.toThrow();
  });

  it("rejects actualSpend < budget (not a breach)", () => {
    expect(() =>
      BudgetBreachRecordSchema.parse({
        id: "br-1",
        budgetId: "x",
        tenantId: "t-1",
        periodStart: "2026-05-01T00:00:00Z",
        periodEnd: "2026-06-01T00:00:00Z",
        budgetAmountCents: 100_000,
        actualSpendCents: 50_000,
        breachPercent: 50,
        triggeredAction: "alert_only",
        detectedAt: "2026-05-30T00:00:00Z",
        notifiedChannels: ["email"],
        acknowledgedAt: null,
        acknowledgedBy: null,
        resolvedAt: null,
      }),
    ).toThrow(/actualSpendCents >= budgetAmountCents/);
  });

  it("rejects breachPercent mismatch", () => {
    expect(() =>
      BudgetBreachRecordSchema.parse({
        id: "br-1",
        budgetId: "x",
        tenantId: "t-1",
        periodStart: "2026-05-01T00:00:00Z",
        periodEnd: "2026-06-01T00:00:00Z",
        budgetAmountCents: 100_000,
        actualSpendCents: 110_000,
        breachPercent: 200,
        triggeredAction: "alert_only",
        detectedAt: "2026-05-30T00:00:00Z",
        notifiedChannels: ["email"],
        acknowledgedAt: null,
        acknowledgedBy: null,
        resolvedAt: null,
      }),
    ).toThrow(/does not match/);
  });

  it("rejects page_oncall without pagerduty in notifiedChannels", () => {
    expect(() =>
      BudgetBreachRecordSchema.parse({
        id: "br-1",
        budgetId: "x",
        tenantId: "t-1",
        periodStart: "2026-05-01T00:00:00Z",
        periodEnd: "2026-06-01T00:00:00Z",
        budgetAmountCents: 100_000,
        actualSpendCents: 150_000,
        breachPercent: 150,
        triggeredAction: "page_oncall",
        detectedAt: "2026-05-30T00:00:00Z",
        notifiedChannels: ["email"],
        acknowledgedAt: null,
        acknowledgedBy: null,
        resolvedAt: null,
      }),
    ).toThrow(/pagerduty/);
  });
});

describe("helpers", () => {
  const budget: CostBudget = {
    id: "b",
    tenantId: "t-1",
    label: "x",
    period: "monthly",
    amountCents: 1000,
    currency: "USD",
    appliesToCategories: [],
    thresholds: [
      { percentOfBudget: 50, action: "alert_only", notifyChannels: ["email"] },
      { percentOfBudget: 80, action: "throttle", notifyChannels: ["slack"] },
      {
        percentOfBudget: 100,
        action: "page_oncall",
        notifyChannels: ["pagerduty", "slack"],
      },
    ],
    autoResetAtPeriodEnd: true,
    enabled: true,
    createdAt: "2026-05-01T00:00:00Z",
    createdBy: "u-1",
    updatedAt: "2026-05-01T00:00:00Z",
  };

  it("currentSpendPercent computes ratio", () => {
    expect(currentSpendPercent(budget, 500)).toBe(50);
    expect(currentSpendPercent(budget, 1500)).toBe(150);
  });

  it("thresholdsCrossed returns all triggered thresholds in order", () => {
    expect(thresholdsCrossed(budget, 850).map((t) => t.percentOfBudget)).toEqual([50, 80]);
    expect(thresholdsCrossed(budget, 1200).map((t) => t.percentOfBudget)).toEqual([50, 80, 100]);
  });

  it("highestSeverityAction returns most severe action", () => {
    const triggered = thresholdsCrossed(budget, 1200);
    expect(highestSeverityAction(triggered)).toBe("page_oncall");
  });

  it("highestSeverityAction returns null for empty", () => {
    expect(highestSeverityAction([])).toBeNull();
  });
});
