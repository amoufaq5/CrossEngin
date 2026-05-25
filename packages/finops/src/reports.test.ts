import { describe, expect, it } from "vitest";
import {
  ANOMALY_KINDS,
  AnomalySchema,
  CostReportSchema,
  REPORT_KINDS,
  criticalAnomalies,
  reportRequiresStorageRef,
  spendDeltaPercent,
  type CostReport,
} from "./reports.js";

describe("constants", () => {
  it("REPORT_KINDS has 7 entries", () => {
    expect(REPORT_KINDS).toContain("tenant_invoice_attachment");
    expect(REPORT_KINDS).toContain("executive_summary");
    expect(REPORT_KINDS).toContain("monthly_close");
  });

  it("ANOMALY_KINDS has 6 entries", () => {
    expect(ANOMALY_KINDS).toContain("category_spike");
    expect(ANOMALY_KINDS).toContain("negative_margin");
    expect(ANOMALY_KINDS).toContain("provider_outage_cost");
  });
});

describe("AnomalySchema", () => {
  it("accepts a category spike with affectedCategory", () => {
    expect(() =>
      AnomalySchema.parse({
        kind: "category_spike",
        description: "AI inference 3x normal",
        severity: "warning",
        affectedCategory: "ai_inference",
        impactCents: 50_000,
        detectedAt: "2026-05-30T00:00:00Z",
      }),
    ).not.toThrow();
  });

  it("rejects category_spike without affectedCategory", () => {
    expect(() =>
      AnomalySchema.parse({
        kind: "category_spike",
        description: "x",
        severity: "warning",
        impactCents: 1,
        detectedAt: "2026-05-30T00:00:00Z",
      }),
    ).toThrow(/affectedCategory/);
  });

  it("rejects tenant_spike without affectedTenantId", () => {
    expect(() =>
      AnomalySchema.parse({
        kind: "tenant_spike",
        description: "x",
        severity: "warning",
        impactCents: 1,
        detectedAt: "2026-05-30T00:00:00Z",
      }),
    ).toThrow(/affectedTenantId/);
  });
});

describe("CostReportSchema", () => {
  const base: CostReport = {
    id: "rep-1",
    kind: "executive_summary",
    format: "pdf",
    periodStart: "2026-05-01T00:00:00Z",
    periodEnd: "2026-06-01T00:00:00Z",
    currency: "USD",
    totalCostCents: 100_000,
    priorPeriodTotalCents: 80_000,
    breakdown: [
      { category: "compute_serverless", costCents: 60_000, percentOfTotal: 60 },
      { category: "ai_inference", costCents: 40_000, percentOfTotal: 40 },
    ],
    topSpenders: [
      { tenantId: "t-1", costCents: 50_000, rank: 1, percentOfTotal: 50 },
      { tenantId: "t-2", costCents: 30_000, rank: 2, percentOfTotal: 30 },
    ],
    anomalies: [],
    tenantScope: null,
    generatedAt: "2026-06-02T00:00:00Z",
    generatedBy: "u-1",
  };

  it("accepts a valid executive summary", () => {
    expect(() => CostReportSchema.parse(base)).not.toThrow();
  });

  it("rejects breakdown sum mismatch", () => {
    expect(() => CostReportSchema.parse({ ...base, totalCostCents: 200_000 })).toThrow(
      /breakdown sum/,
    );
  });

  it("rejects duplicate categories in breakdown", () => {
    expect(() =>
      CostReportSchema.parse({
        ...base,
        breakdown: [
          { category: "compute_serverless", costCents: 60_000, percentOfTotal: 60 },
          { category: "compute_serverless", costCents: 40_000, percentOfTotal: 40 },
        ],
      }),
    ).toThrow(/duplicate category/);
  });

  it("rejects tenant_invoice_attachment without tenantScope", () => {
    expect(() =>
      CostReportSchema.parse({
        ...base,
        kind: "tenant_invoice_attachment",
      }),
    ).toThrow(/tenantScope/);
  });

  it("rejects duplicate topSpenders ranks", () => {
    expect(() =>
      CostReportSchema.parse({
        ...base,
        topSpenders: [
          { tenantId: "t-1", costCents: 50_000, rank: 1, percentOfTotal: 50 },
          { tenantId: "t-2", costCents: 30_000, rank: 1, percentOfTotal: 30 },
        ],
      }),
    ).toThrow(/duplicate rank/);
  });

  it("rejects topSpenders not sorted descending", () => {
    expect(() =>
      CostReportSchema.parse({
        ...base,
        topSpenders: [
          { tenantId: "t-1", costCents: 30_000, rank: 1, percentOfTotal: 30 },
          { tenantId: "t-2", costCents: 50_000, rank: 2, percentOfTotal: 50 },
        ],
      }),
    ).toThrow(/sorted descending/);
  });
});

describe("helpers", () => {
  const base: CostReport = {
    id: "rep-1",
    kind: "executive_summary",
    format: "json",
    periodStart: "2026-05-01T00:00:00Z",
    periodEnd: "2026-06-01T00:00:00Z",
    currency: "USD",
    totalCostCents: 100_000,
    priorPeriodTotalCents: 80_000,
    breakdown: [{ category: "compute_serverless", costCents: 100_000, percentOfTotal: 100 }],
    topSpenders: [],
    anomalies: [
      {
        kind: "category_spike",
        description: "x",
        severity: "critical",
        affectedCategory: "ai_inference",
        impactCents: 1,
        detectedAt: "2026-05-30T00:00:00Z",
      },
      {
        kind: "category_spike",
        description: "y",
        severity: "warning",
        affectedCategory: "compute_serverless",
        impactCents: 1,
        detectedAt: "2026-05-30T00:00:00Z",
      },
    ],
    tenantScope: null,
    generatedAt: "2026-06-02T00:00:00Z",
    generatedBy: "u-1",
  };

  it("spendDeltaPercent computes percent delta", () => {
    expect(spendDeltaPercent(base)).toBe(25);
  });

  it("spendDeltaPercent returns null without prior period", () => {
    expect(spendDeltaPercent({ ...base, priorPeriodTotalCents: null })).toBeNull();
  });

  it("criticalAnomalies filters by severity", () => {
    expect(criticalAnomalies(base)).toHaveLength(1);
  });

  it("reportRequiresStorageRef true for monthly_close", () => {
    expect(reportRequiresStorageRef("monthly_close")).toBe(true);
    expect(reportRequiresStorageRef("annual_review")).toBe(true);
    expect(reportRequiresStorageRef("anomaly_alert")).toBe(false);
  });
});
