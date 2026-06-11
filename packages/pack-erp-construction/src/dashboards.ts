import { DashboardDeclarationSchema, type DashboardDeclaration } from "@crossengin/reporting";

/**
 * The construction overview dashboard: a budget KPI + a projects-by-state
 * breakdown + a markdown header on the 12-column grid. The widget reports
 * (`projectBudget`, `projectsByState`) resolve against `ERP_CONSTRUCTION_REPORTS`.
 */
export const CONSTRUCTION_OVERVIEW_DASHBOARD: DashboardDeclaration = DashboardDeclarationSchema.parse({
  label: { en: "Construction overview" },
  description: "Portfolio budget + project pipeline at a glance.",
  layout: "grid",
  refreshIntervalSeconds: 300,
  cells: [
    { x: 0, y: 0, w: 12, h: 1, widget: { kind: "markdown", body: { en: "## Construction overview" } } },
    { x: 0, y: 1, w: 4, h: 2, widget: { kind: "kpi", report: "projectBudget", title: { en: "Total budget" } } },
    { x: 4, y: 1, w: 8, h: 3, widget: { kind: "tabular", report: "projectsByState", title: { en: "Projects by state" } } },
  ],
});

export const ERP_CONSTRUCTION_DASHBOARDS: Readonly<Record<string, DashboardDeclaration>> = {
  constructionOverview: CONSTRUCTION_OVERVIEW_DASHBOARD,
};
