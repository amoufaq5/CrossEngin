import { describe, expect, it } from "vitest";
import {
  AccessibilityBudgetSchema,
  BackendBudgetSchema,
  checkAccessibilityBudget,
  checkFrontendBudget,
  DEFAULT_BACKEND_BUDGET,
  DEFAULT_FRONTEND_BUDGET,
  FrontendBudgetSchema,
  RendererBudgetSchema,
} from "./budgets.js";

describe("FrontendBudgetSchema + DEFAULT_FRONTEND_BUDGET", () => {
  it("matches the ADR-0017 frontend budget (FCP 1.5s, TTI 3s, JS 250KB)", () => {
    expect(DEFAULT_FRONTEND_BUDGET.fcpMs).toBe(1_500);
    expect(DEFAULT_FRONTEND_BUDGET.ttiMs).toBe(3_000);
    expect(DEFAULT_FRONTEND_BUDGET.perRouteJsBundleKb).toBe(250);
  });

  it("regressionTolerancePercent defaults to 20%", () => {
    expect(DEFAULT_FRONTEND_BUDGET.regressionTolerancePercent).toBe(20);
  });
});

describe("checkFrontendBudget", () => {
  const measured = {
    fcpMs: 1_400,
    ttiMs: 2_900,
    lcpMs: 2_400,
    cls: 0.09,
    tbtMs: 180,
    perRouteJsBundleKb: 240,
  };

  it("passes when all metrics are within budget", () => {
    const r = checkFrontendBudget({ budget: DEFAULT_FRONTEND_BUDGET, measured });
    expect(r.decision).toBe("pass");
  });

  it("warns on a single violation", () => {
    const r = checkFrontendBudget({
      budget: DEFAULT_FRONTEND_BUDGET,
      measured: { ...measured, ttiMs: 5_000 },
    });
    expect(r.decision).toBe("warn");
  });

  it("blocks on three or more violations", () => {
    const r = checkFrontendBudget({
      budget: DEFAULT_FRONTEND_BUDGET,
      measured: {
        ...measured,
        fcpMs: 5_000,
        ttiMs: 8_000,
        lcpMs: 6_000,
      },
    });
    expect(r.decision).toBe("block");
    expect(r.violations.length).toBeGreaterThanOrEqual(3);
  });

  it("respects the regression tolerance percent", () => {
    const tight = FrontendBudgetSchema.parse({
      ...DEFAULT_FRONTEND_BUDGET,
      regressionTolerancePercent: 0,
    });
    const r = checkFrontendBudget({
      budget: tight,
      measured: { ...measured, fcpMs: 1_501 },
    });
    expect(r.decision).toBe("warn");
  });
});

describe("RendererBudgetSchema", () => {
  it("accepts a list renderer target of 50ms for 1000 rows", () => {
    expect(() =>
      RendererBudgetSchema.parse({
        renderer: "list",
        representativeRows: 1_000,
        targetRenderMs: 50,
      }),
    ).not.toThrow();
  });

  it("flags an unusually high target for a list renderer", () => {
    expect(() =>
      RendererBudgetSchema.parse({
        renderer: "list",
        representativeRows: 1_000,
        targetRenderMs: 5_000,
      }),
    ).toThrow(/unusually high/);
  });
});

describe("BackendBudgetSchema + defaults", () => {
  it("ADR-0017 backend defaults: read p95 300ms, write 1000ms", () => {
    expect(DEFAULT_BACKEND_BUDGET.apiReadP95Ms).toBe(300);
    expect(DEFAULT_BACKEND_BUDGET.apiWriteP95Ms).toBe(1_000);
    expect(DEFAULT_BACKEND_BUDGET.dbQueryP95Ms).toBe(100);
  });

  it("parses an override", () => {
    expect(() =>
      BackendBudgetSchema.parse({ apiReadP95Ms: 200, apiWriteP95Ms: 500, dbQueryP95Ms: 50 }),
    ).not.toThrow();
  });
});

describe("checkAccessibilityBudget", () => {
  const budget = AccessibilityBudgetSchema.parse({});

  it("passes when no violations meet the impact threshold", () => {
    const r = checkAccessibilityBudget(
      [{ ruleId: "color-contrast", impact: "moderate", count: 3 }],
      budget,
    );
    expect(r.decision).toBe("pass");
  });

  it("blocks on a single serious violation", () => {
    const r = checkAccessibilityBudget(
      [{ ruleId: "aria-required-children", impact: "serious", count: 1 }],
      budget,
    );
    expect(r.decision).toBe("block");
    expect(r.failingRules).toContain("aria-required-children");
  });

  it("blocks on critical regardless of impact level setting", () => {
    const r = checkAccessibilityBudget(
      [{ ruleId: "html-has-lang", impact: "critical", count: 1 }],
      budget,
    );
    expect(r.decision).toBe("block");
  });

  it("AccessibilityBudgetSchema defaults: WCAG AA, fail on serious", () => {
    expect(budget.wcagLevel).toBe("AA");
    expect(budget.failOnImpact).toBe("serious");
  });
});
