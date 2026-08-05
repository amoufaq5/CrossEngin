import {
  ListViewSchema,
  type ListView,
  type ViewDeclaration,
} from "@crossengin/views";

export const PROJECT_LIST_VIEW: ListView = ListViewSchema.parse({
  kind: "list",
  entity: "Project",
  label: { en: "Projects" },
  permissions: "inherit",
  sort: [{ field: "start_date", direction: "desc" }],
  columns: [
    { field: "project_code", label: { en: "Code" } },
    { field: "name", label: { en: "Name" } },
    { field: "account_id", label: { en: "Client" } },
    { field: "status", label: { en: "Status" } },
    { field: "start_date", label: { en: "Start" } },
  ],
  pageSize: 100,
  exportFormats: ["csv", "xlsx"],
});

export const WORK_ORDER_LIST_VIEW: ListView = ListViewSchema.parse({
  kind: "list",
  entity: "WorkOrder",
  label: { en: "Work orders" },
  permissions: "inherit",
  sort: [{ field: "scheduled_date", direction: "desc" }],
  columns: [
    { field: "wo_number", label: { en: "Number" } },
    { field: "project_id", label: { en: "Project" } },
    { field: "subcontractor_id", label: { en: "Subcontractor" } },
    { field: "status", label: { en: "Status" } },
    { field: "scheduled_date", label: { en: "Scheduled" } },
  ],
  pageSize: 100,
  exportFormats: ["csv"],
});

export const ERP_CONSTRUCTION_VIEWS: Readonly<Record<string, ViewDeclaration>> = {
  "project.list": PROJECT_LIST_VIEW,
  "work_order.list": WORK_ORDER_LIST_VIEW,
};
