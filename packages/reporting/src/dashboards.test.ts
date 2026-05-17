import { describe, expect, it } from "vitest";
import {
  DashboardDeclarationSchema,
  GRID_COLUMNS,
  widgetReferencedReports,
  WIDGET_KINDS,
} from "./dashboards.js";

describe("DashboardDeclarationSchema", () => {
  it("parses a single-cell KPI dashboard", () => {
    const d = DashboardDeclarationSchema.parse({
      label: { en: "Quick KPIs" },
      cells: [
        {
          x: 0,
          y: 0,
          w: 4,
          h: 2,
          widget: { kind: "kpi", report: "todayDispensedCount" },
        },
      ],
    });
    expect(d.layout).toBe("grid");
    expect(d.refreshIntervalSeconds).toBe(60);
  });

  it("parses the ADR-0013 managerDailyDashboard layout", () => {
    const d = DashboardDeclarationSchema.parse({
      label: { en: "Manager's Daily Dashboard" },
      cells: [
        { x: 0, y: 0, w: 4, h: 2, widget: { kind: "kpi", report: "todayDispensedCount" } },
        { x: 4, y: 0, w: 4, h: 2, widget: { kind: "kpi", report: "todayRevenue" } },
        {
          x: 8,
          y: 0,
          w: 4,
          h: 2,
          widget: { kind: "kpi", report: "pendingPrescriptionsCount" },
        },
        {
          x: 0,
          y: 2,
          w: 12,
          h: 4,
          widget: { kind: "timeseries", report: "hourlyDispensingTrend" },
        },
        { x: 0, y: 6, w: 6, h: 4, widget: { kind: "list", report: "expiringStockNext30d" } },
        { x: 6, y: 6, w: 6, h: 4, widget: { kind: "list", report: "topPrescribers" } },
      ],
      permissions: { roles: ["manager"] },
    });
    expect(d.cells).toHaveLength(6);
  });

  it("rejects an overflowing cell width", () => {
    expect(() =>
      DashboardDeclarationSchema.parse({
        cells: [
          {
            x: 10,
            y: 0,
            w: 5,
            h: 2,
            widget: { kind: "kpi", report: "x" },
          },
        ],
      }),
    ).toThrow(/overflows the 12-column grid/);
  });

  it("rejects two cells overlapping in the grid", () => {
    expect(() =>
      DashboardDeclarationSchema.parse({
        cells: [
          { x: 0, y: 0, w: 4, h: 2, widget: { kind: "kpi", report: "a" } },
          { x: 2, y: 0, w: 4, h: 2, widget: { kind: "kpi", report: "b" } },
        ],
      }),
    ).toThrow(/cell overlaps/);
  });

  it("accepts markdown + divider widgets without a report ref", () => {
    expect(() =>
      DashboardDeclarationSchema.parse({
        cells: [
          { x: 0, y: 0, w: 12, h: 1, widget: { kind: "divider", label: { en: "Top" } } },
          {
            x: 0,
            y: 1,
            w: 12,
            h: 2,
            widget: { kind: "markdown", body: { en: "## Welcome" } },
          },
        ],
      }),
    ).not.toThrow();
  });
});

describe("widgetReferencedReports", () => {
  const dashboard = DashboardDeclarationSchema.parse({
    cells: [
      { x: 0, y: 0, w: 4, h: 2, widget: { kind: "kpi", report: "a" } },
      { x: 4, y: 0, w: 4, h: 2, widget: { kind: "kpi", report: "b" } },
      { x: 8, y: 0, w: 4, h: 2, widget: { kind: "divider" } },
    ],
  });

  it("returns the list of report ids referenced by widgets", () => {
    expect(widgetReferencedReports(dashboard)).toEqual(["a", "b"]);
  });
});

describe("constants", () => {
  it("GRID_COLUMNS is 12", () => {
    expect(GRID_COLUMNS).toBe(12);
  });

  it("WIDGET_KINDS includes list and markdown", () => {
    expect(WIDGET_KINDS).toContain("list");
    expect(WIDGET_KINDS).toContain("markdown");
  });
});
