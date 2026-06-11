import { ReportDeclarationSchema, type ReportDeclaration } from "@crossengin/reporting";

/** Total catalog seat capacity (a KPI over Course.capacity). */
export const COURSE_CAPACITY_REPORT: ReportDeclaration = ReportDeclarationSchema.parse({
  kind: "kpi",
  entity: "Course",
  label: { en: "Total capacity" },
  measure: { name: "total_capacity", kind: "sum", field: "capacity" },
});

/** Course count + capacity by department (tabular group-by over Course). */
export const COURSES_BY_DEPARTMENT_REPORT: ReportDeclaration = ReportDeclarationSchema.parse({
  kind: "tabular",
  entity: "Course",
  label: { en: "Courses by department" },
  groupBy: ["department"],
  aggregations: [
    { name: "courses", kind: "count" },
    { name: "capacity", kind: "sum", field: "capacity" },
  ],
  sort: [{ field: "capacity", direction: "desc" }],
});

/** Course counts pivoted by department × state. */
export const COURSES_BY_DEPT_STATE_REPORT: ReportDeclaration = ReportDeclarationSchema.parse({
  kind: "pivot",
  entity: "Course",
  label: { en: "Courses by department × state" },
  rows: ["department"],
  columns: ["state"],
  measures: [
    { name: "courses", kind: "count" },
    { name: "avg_credits", kind: "avg", field: "credits" },
  ],
});

export const ERP_EDUCATION_REPORTS: Readonly<Record<string, ReportDeclaration>> = {
  courseCapacity: COURSE_CAPACITY_REPORT,
  coursesByDepartment: COURSES_BY_DEPARTMENT_REPORT,
  coursesByDeptState: COURSES_BY_DEPT_STATE_REPORT,
};
