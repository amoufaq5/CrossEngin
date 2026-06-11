import { ReportDeclarationSchema, type ReportDeclaration } from "@crossengin/reporting";

/** Total project budget under management (a KPI over Project.budget). */
export const PROJECT_BUDGET_REPORT: ReportDeclaration = ReportDeclarationSchema.parse({
  kind: "kpi",
  entity: "Project",
  label: { en: "Total budget" },
  measure: { name: "total_budget", kind: "sum", field: "budget" },
});

/** Project count + budget by lifecycle state (tabular group-by over Project). */
export const PROJECTS_BY_STATE_REPORT: ReportDeclaration = ReportDeclarationSchema.parse({
  kind: "tabular",
  entity: "Project",
  label: { en: "Projects by state" },
  groupBy: ["state"],
  aggregations: [
    { name: "projects", kind: "count" },
    { name: "budget", kind: "sum", field: "budget" },
  ],
  sort: [{ field: "budget", direction: "desc" }],
});

/** Project counts pivoted by type × state. */
export const PROJECTS_BY_TYPE_STATE_REPORT: ReportDeclaration = ReportDeclarationSchema.parse({
  kind: "pivot",
  entity: "Project",
  label: { en: "Projects by type × state" },
  rows: ["project_type"],
  columns: ["state"],
  measures: [
    { name: "projects", kind: "count" },
    { name: "avg_budget", kind: "avg", field: "budget" },
  ],
});

export const ERP_CONSTRUCTION_REPORTS: Readonly<Record<string, ReportDeclaration>> = {
  projectBudget: PROJECT_BUDGET_REPORT,
  projectsByState: PROJECTS_BY_STATE_REPORT,
  projectsByTypeState: PROJECTS_BY_TYPE_STATE_REPORT,
};
