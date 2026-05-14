import { describe, expect, it } from "vitest";
import {
  CostCeilingsSchema,
  DEFAULT_BASE_CEILINGS,
  DEFAULT_PREMIUM_CEILINGS,
  decideSessionAction,
  HOURLY_RUNAWAY_THRESHOLD_DOLLARS,
  isCostRunaway,
} from "./cost-ceilings.js";

describe("DEFAULT_BASE_CEILINGS / DEFAULT_PREMIUM_CEILINGS", () => {
  it("base = 50K tokens, $200/mo; premium = 250K, $2000/mo", () => {
    expect(DEFAULT_BASE_CEILINGS.perSessionTokens).toBe(50_000);
    expect(DEFAULT_BASE_CEILINGS.perTenantMonthlyDollars).toBe(200);
    expect(DEFAULT_PREMIUM_CEILINGS.perSessionTokens).toBe(250_000);
    expect(DEFAULT_PREMIUM_CEILINGS.perTenantMonthlyDollars).toBe(2_000);
  });

  it("per-turn tool-call cap defaults to 12 (matches ADR-0005)", () => {
    expect(DEFAULT_BASE_CEILINGS.perTurnToolCallCap).toBe(12);
  });
});

describe("CostCeilingsSchema", () => {
  it("rejects perToolMaxCallsPerSession unreasonably high vs. perTurnToolCallCap", () => {
    expect(() =>
      CostCeilingsSchema.parse({
        perSessionTokens: 50_000,
        perTenantMonthlyDollars: 200,
        perTurnToolCallCap: 5,
        perToolMaxCallsPerSession: 50,
      }),
    ).toThrow(/unreasonably high/);
  });
});

describe("decideSessionAction", () => {
  const ceilings = DEFAULT_BASE_CEILINGS;

  it("returns 'allow' under all thresholds", () => {
    const r = decideSessionAction({
      ceilings,
      session: { tokensUsed: 1_000, toolCallsThisTurn: 0, toolCallsBySession: {} },
      tenant: { monthlyDollarsUsed: 5 },
    });
    expect(r.decision).toBe("allow");
  });

  it("returns 'warn' at >= warnAtPercent (80% default)", () => {
    const r = decideSessionAction({
      ceilings,
      session: { tokensUsed: 41_000, toolCallsThisTurn: 0, toolCallsBySession: {} },
      tenant: { monthlyDollarsUsed: 5 },
    });
    expect(r.decision).toBe("warn");
  });

  it("blocks when session tokens are exhausted", () => {
    const r = decideSessionAction({
      ceilings,
      session: { tokensUsed: 50_000, toolCallsThisTurn: 0, toolCallsBySession: {} },
      tenant: { monthlyDollarsUsed: 0 },
    });
    expect(r.decision).toBe("block");
    expect(r.reason).toContain("session token ceiling");
  });

  it("blocks when monthly dollar ceiling is exhausted", () => {
    const r = decideSessionAction({
      ceilings,
      session: { tokensUsed: 100, toolCallsThisTurn: 0, toolCallsBySession: {} },
      tenant: { monthlyDollarsUsed: 200 },
    });
    expect(r.decision).toBe("block");
    expect(r.reason).toContain("monthly dollar");
  });

  it("blocks when per-turn tool-call cap is reached", () => {
    const r = decideSessionAction({
      ceilings,
      session: { tokensUsed: 100, toolCallsThisTurn: 12, toolCallsBySession: {} },
      tenant: { monthlyDollarsUsed: 0 },
    });
    expect(r.decision).toBe("block");
    expect(r.reason).toContain("per-turn tool-call cap");
  });

  it("blocks when per-tool session cap is reached for the proposed tool", () => {
    const r = decideSessionAction({
      ceilings,
      session: {
        tokensUsed: 100,
        toolCallsThisTurn: 0,
        toolCallsBySession: { searchManifest: 8 },
      },
      tenant: { monthlyDollarsUsed: 0 },
      proposedTool: "searchManifest",
    });
    expect(r.decision).toBe("block");
    expect(r.reason).toContain("searchManifest");
  });
});

describe("isCostRunaway", () => {
  it("flags > $1000/hr by default", () => {
    expect(isCostRunaway({ hourlyDollarsUsed: HOURLY_RUNAWAY_THRESHOLD_DOLLARS })).toBe(true);
    expect(isCostRunaway({ hourlyDollarsUsed: 500 })).toBe(false);
  });

  it("honors a custom threshold", () => {
    expect(
      isCostRunaway({ hourlyDollarsUsed: 50, hourlyThresholdDollars: 25 }),
    ).toBe(true);
  });
});
