import {
  ListViewSchema,
  type ListView,
  type ViewDeclaration,
} from "@crossengin/views";

export const CITIZEN_LIST_VIEW: ListView = ListViewSchema.parse({
  kind: "list",
  entity: "Citizen",
  label: { en: "Citizens" },
  permissions: "inherit",
  sort: [{ field: "full_name", direction: "asc" }],
  columns: [
    { field: "full_name", label: { en: "Name" } },
    { field: "contact_email", label: { en: "Email" } },
    { field: "contact_phone", label: { en: "Phone" } },
    { field: "status", label: { en: "Status" } },
  ],
  pageSize: 100,
  exportFormats: ["csv", "xlsx"],
});

export const CASE_LIST_VIEW: ListView = ListViewSchema.parse({
  kind: "list",
  entity: "Case",
  label: { en: "Cases" },
  permissions: "inherit",
  sort: [{ field: "opened_at", direction: "desc" }],
  columns: [
    { field: "case_number", label: { en: "Number" } },
    { field: "citizen_id", label: { en: "Citizen" } },
    { field: "category", label: { en: "Category" } },
    { field: "state", label: { en: "State" } },
    { field: "opened_at", label: { en: "Opened" } },
    { field: "sla_due_at", label: { en: "SLA due" } },
  ],
  pageSize: 100,
  exportFormats: ["csv"],
});

export const ERP_GOVERNMENT_VIEWS: Readonly<Record<string, ViewDeclaration>> = {
  "citizen.list": CITIZEN_LIST_VIEW,
  "case.list": CASE_LIST_VIEW,
};
