import { DashboardDeclarationSchema, type DashboardDeclaration } from "@crossengin/reporting";

/**
 * The education overview dashboard: a capacity KPI + a courses-by-department
 * breakdown + a markdown header on the 12-column grid. The widget reports
 * (`courseCapacity`, `coursesByDepartment`) resolve against `ERP_EDUCATION_REPORTS`.
 */
export const EDUCATION_OVERVIEW_DASHBOARD: DashboardDeclaration = DashboardDeclarationSchema.parse({
  label: { en: "Education overview" },
  description: "Catalog capacity + course mix at a glance.",
  layout: "grid",
  refreshIntervalSeconds: 300,
  cells: [
    { x: 0, y: 0, w: 12, h: 1, widget: { kind: "markdown", body: { en: "## Education overview" } } },
    { x: 0, y: 1, w: 4, h: 2, widget: { kind: "kpi", report: "courseCapacity", title: { en: "Total capacity" } } },
    { x: 4, y: 1, w: 8, h: 3, widget: { kind: "tabular", report: "coursesByDepartment", title: { en: "Courses by department" } } },
  ],
});

export const ERP_EDUCATION_DASHBOARDS: Readonly<Record<string, DashboardDeclaration>> = {
  educationOverview: EDUCATION_OVERVIEW_DASHBOARD,
};
