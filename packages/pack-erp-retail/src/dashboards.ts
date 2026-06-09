import { DashboardDeclarationSchema, type DashboardDeclaration } from "@crossengin/reporting";

/**
 * The retail overview dashboard: a revenue KPI + an orders-by-state breakdown +
 * a markdown header, laid out on the 12-column grid. The widget reports
 * (`salesRevenue`, `ordersByState`) resolve against `ERP_RETAIL_REPORTS`.
 */
export const RETAIL_OVERVIEW_DASHBOARD: DashboardDeclaration = DashboardDeclarationSchema.parse({
  label: { en: "Retail overview" },
  description: "Revenue + order pipeline at a glance.",
  layout: "grid",
  refreshIntervalSeconds: 120,
  cells: [
    { x: 0, y: 0, w: 12, h: 1, widget: { kind: "markdown", body: { en: "## Retail overview" } } },
    { x: 0, y: 1, w: 4, h: 2, widget: { kind: "kpi", report: "salesRevenue", title: { en: "Revenue" } } },
    { x: 4, y: 1, w: 8, h: 3, widget: { kind: "tabular", report: "ordersByState", title: { en: "Orders by state" } } },
  ],
});

export const ERP_RETAIL_DASHBOARDS: Readonly<Record<string, DashboardDeclaration>> = {
  retailOverview: RETAIL_OVERVIEW_DASHBOARD,
};
