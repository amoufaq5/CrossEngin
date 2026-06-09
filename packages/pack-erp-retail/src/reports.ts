import { ReportDeclarationSchema, type ReportDeclaration } from "@crossengin/reporting";

/** Total order revenue (a KPI over SalesOrder.total). */
export const SALES_REVENUE_REPORT: ReportDeclaration = ReportDeclarationSchema.parse({
  kind: "kpi",
  entity: "SalesOrder",
  label: { en: "Total revenue" },
  measure: { name: "total_revenue", kind: "sum", field: "total" },
});

/** Order count by lifecycle state (a tabular group-by over SalesOrder). */
export const ORDERS_BY_STATE_REPORT: ReportDeclaration = ReportDeclarationSchema.parse({
  kind: "tabular",
  entity: "SalesOrder",
  label: { en: "Orders by state" },
  groupBy: ["state"],
  aggregations: [
    { name: "orders", kind: "count" },
    { name: "revenue", kind: "sum", field: "total" },
  ],
  sort: [{ field: "revenue", direction: "desc" }],
});

/** Product counts pivoted by category × status. */
export const PRODUCTS_BY_CATEGORY_STATUS_REPORT: ReportDeclaration = ReportDeclarationSchema.parse({
  kind: "pivot",
  entity: "Product",
  label: { en: "Products by category × status" },
  rows: ["category"],
  columns: ["status"],
  measures: [
    { name: "products", kind: "count" },
    { name: "avg_price", kind: "avg", field: "unit_price" },
  ],
});

export const ERP_RETAIL_REPORTS: Readonly<Record<string, ReportDeclaration>> = {
  salesRevenue: SALES_REVENUE_REPORT,
  ordersByState: ORDERS_BY_STATE_REPORT,
  productByCategoryStatus: PRODUCTS_BY_CATEGORY_STATUS_REPORT,
};
