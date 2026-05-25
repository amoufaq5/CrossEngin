import { ListViewSchema, type ListView, type ViewDeclaration } from "@crossengin/views";

export const ACCOUNT_LIST_VIEW: ListView = ListViewSchema.parse({
  kind: "list",
  entity: "Account",
  label: { en: "Accounts" },
  permissions: "inherit",
  sort: [{ field: "name", direction: "asc" }],
  columns: [
    { field: "name", label: { en: "Name" } },
    { field: "status", label: { en: "Status" } },
    { field: "industry", label: { en: "Industry" } },
    { field: "billing_email", label: { en: "Billing email" } },
    { field: "country", label: { en: "Country" } },
  ],
  pageSize: 50,
  exportFormats: ["csv", "xlsx"],
});

export const INVOICE_LIST_VIEW: ListView = ListViewSchema.parse({
  kind: "list",
  entity: "Invoice",
  label: { en: "Invoices" },
  permissions: "inherit",
  sort: [{ field: "due_date", direction: "asc" }],
  columns: [
    { field: "invoice_number", label: { en: "Number" } },
    { field: "account_id", label: { en: "Account" } },
    { field: "state", label: { en: "State" } },
    { field: "total", label: { en: "Total" } },
    { field: "currency", label: { en: "Currency" } },
    { field: "due_date", label: { en: "Due date" } },
  ],
  pageSize: 100,
  exportFormats: ["csv"],
});

export const ERP_CORE_VIEWS: Readonly<Record<string, ViewDeclaration>> = {
  "account.list": ACCOUNT_LIST_VIEW,
  "invoice.list": INVOICE_LIST_VIEW,
};
