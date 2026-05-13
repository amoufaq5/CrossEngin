import { describe, expect, it } from "vitest";
import {
  AGGREGATION_KINDS,
  AggregationSchema,
  ReportDeclarationSchema,
  ReportFilterSchema,
  REPORT_KINDS,
} from "./reports.js";

describe("ReportFilterSchema", () => {
  it("accepts a single-value operator with value", () => {
    expect(() =>
      ReportFilterSchema.parse({ field: "status", operator: "eq", value: "verified" }),
    ).not.toThrow();
  });

  it("accepts an array operator with values", () => {
    expect(() =>
      ReportFilterSchema.parse({
        field: "status",
        operator: "in",
        values: ["a", "b"],
      }),
    ).not.toThrow();
  });

  it("rejects a single-value operator missing value", () => {
    expect(() =>
      ReportFilterSchema.parse({ field: "status", operator: "eq" }),
    ).toThrow(/requires 'value'/);
  });

  it("rejects an array operator missing values", () => {
    expect(() =>
      ReportFilterSchema.parse({ field: "status", operator: "in" }),
    ).toThrow(/non-empty 'values' array/);
  });

  it("accepts a between operator with range tuple", () => {
    expect(() =>
      ReportFilterSchema.parse({ field: "qty", operator: "between", range: [0, 100] }),
    ).not.toThrow();
  });

  it("rejects is_null with stray values", () => {
    expect(() =>
      ReportFilterSchema.parse({
        field: "x",
        operator: "is_null",
        value: "foo",
      }),
    ).toThrow(/takes no value/);
  });
});

describe("AggregationSchema", () => {
  it("count is the only aggregation that may omit field", () => {
    expect(() => AggregationSchema.parse({ name: "n", kind: "count" })).not.toThrow();
  });

  it("sum requires field", () => {
    expect(() => AggregationSchema.parse({ name: "s", kind: "sum" })).toThrow(
      /requires a 'field'/,
    );
  });

  it("AGGREGATION_KINDS includes count_distinct + p95", () => {
    expect(AGGREGATION_KINDS).toContain("count_distinct");
    expect(AGGREGATION_KINDS).toContain("p95");
  });
});

describe("ReportDeclarationSchema — tabular", () => {
  it("parses a minimal tabular report", () => {
    const r = ReportDeclarationSchema.parse({
      kind: "tabular",
      entity: "prescription",
    });
    expect(r.kind).toBe("tabular");
    if (r.kind === "tabular") {
      expect(r.limit).toBe(100);
      expect(r.cacheTtlSeconds).toBe(60);
    }
  });

  it("parses the ADR-0013 weeklyDispensingSummary example", () => {
    const r = ReportDeclarationSchema.parse({
      kind: "tabular",
      label: { en: "Weekly Dispensing Summary" },
      entity: "prescription",
      filters: [
        { field: "status", operator: "in", values: ["dispensed"] },
        { field: "dispensedAt", operator: "gte", value: "$today - 7 days" },
      ],
      groupBy: ["drug.category", "dispensingPharmacist"],
      aggregations: [
        { name: "count", kind: "count" },
        { name: "totalValue", kind: "sum", field: "totalCost" },
      ],
      sort: [{ field: "count", direction: "desc" }],
      limit: 100,
      permissions: { roles: ["pharmacist", "manager", "auditor"] },
      abac: "data.report.access.weekly_dispensing",
    });
    if (r.kind === "tabular") {
      expect(r.groupBy).toHaveLength(2);
      expect(r.aggregations).toHaveLength(2);
    }
  });
});

describe("ReportDeclarationSchema — pivot", () => {
  it("parses a pivot report with measures", () => {
    const r = ReportDeclarationSchema.parse({
      kind: "pivot",
      entity: "deviation",
      rows: ["severity"],
      columns: ["month"],
      measures: [{ name: "count", kind: "count" }],
    });
    expect(r.kind).toBe("pivot");
  });

  it("rejects pivot without rows", () => {
    expect(() =>
      ReportDeclarationSchema.parse({
        kind: "pivot",
        entity: "x",
        columns: ["a"],
        measures: [{ name: "n", kind: "count" }],
      }),
    ).toThrow();
  });
});

describe("ReportDeclarationSchema — timeseries", () => {
  it("parses a timeseries with hourly bucket", () => {
    const r = ReportDeclarationSchema.parse({
      kind: "timeseries",
      entity: "dispensing",
      timeField: "occurredAt",
      bucket: "hour",
      series: [{ name: "count", kind: "count" }],
    });
    expect(r.kind).toBe("timeseries");
  });
});

describe("ReportDeclarationSchema — kpi", () => {
  it("parses a KPI with comparison + threshold", () => {
    const r = ReportDeclarationSchema.parse({
      kind: "kpi",
      entity: "prescription",
      measure: { name: "dispensed_today", kind: "count" },
      comparison: { period: "prev_week" },
      threshold: { warning: 50, critical: 10, direction: "higher_is_better" },
    });
    expect(r.kind).toBe("kpi");
    if (r.kind === "kpi") {
      expect(r.comparison?.showAsPercent).toBe(true);
    }
  });

  it("parses a KPI with sparkline", () => {
    const r = ReportDeclarationSchema.parse({
      kind: "kpi",
      entity: "prescription",
      measure: { name: "x", kind: "count" },
      sparkline: { timeField: "createdAt", bucket: "day" },
    });
    if (r.kind === "kpi") expect(r.sparkline?.points).toBe(30);
  });
});

describe("ReportDeclarationSchema — funnel + cohort", () => {
  it("parses a funnel with steps", () => {
    const r = ReportDeclarationSchema.parse({
      kind: "funnel",
      entity: "session",
      steps: [
        { name: "viewed", filter: { field: "event", operator: "eq", value: "view" } },
        { name: "added", filter: { field: "event", operator: "eq", value: "add" } },
      ],
    });
    expect(r.kind).toBe("funnel");
  });

  it("parses a cohort with retention buckets", () => {
    const r = ReportDeclarationSchema.parse({
      kind: "cohort",
      entity: "donation",
      cohortField: "donorJoinedAt",
      retentionEvent: { field: "event", operator: "eq", value: "donated_again" },
    });
    expect(r.kind).toBe("cohort");
    if (r.kind === "cohort") expect(r.retentionBuckets).toBe(12);
  });
});

describe("ReportDeclarationSchema — custom + schedule", () => {
  it("parses a custom report with parameters", () => {
    const r = ReportDeclarationSchema.parse({
      kind: "custom",
      entity: "audit_event",
      curatedBy: "u_admin",
      sqlTemplate: "SELECT * FROM audit_event WHERE day = :day",
      parameters: [{ name: "day", type: "date", required: true }],
    });
    expect(r.kind).toBe("custom");
  });

  it("attaches a schedule with delivery channels", () => {
    const r = ReportDeclarationSchema.parse({
      kind: "tabular",
      entity: "deviation",
      schedule: {
        cron: "0 8 1 * *",
        timezone: "Asia/Dubai",
        deliverTo: [
          {
            kind: "email",
            recipients: ["qa@example.com"],
            attachmentFormats: ["pdf"],
          },
        ],
      },
    });
    if (r.kind === "tabular") {
      expect(r.schedule?.cron).toBe("0 8 1 * *");
    }
  });
});

describe("REPORT_KINDS", () => {
  it("declares the seven documented kinds", () => {
    expect(REPORT_KINDS).toEqual([
      "tabular",
      "pivot",
      "timeseries",
      "kpi",
      "funnel",
      "cohort",
      "custom",
    ]);
  });
});
