import {
  ListViewSchema,
  type ListView,
  type ViewDeclaration,
} from "@crossengin/views";

export const PAYMENT_LIST_VIEW: ListView = ListViewSchema.parse({
  kind: "list",
  entity: "Payment",
  label: { en: "Payments" },
  permissions: "inherit",
  sort: [{ field: "state", direction: "asc" }],
  columns: [
    { field: "invoice_id", label: { en: "Invoice" } },
    { field: "state", label: { en: "State" } },
    { field: "amount", label: { en: "Amount" } },
    { field: "currency", label: { en: "Currency" } },
    { field: "provider", label: { en: "Provider" } },
    { field: "provider_reference", label: { en: "Provider ref" } },
    { field: "captured_at", label: { en: "Captured at" } },
    { field: "settled_at", label: { en: "Settled at" } },
  ],
  pageSize: 100,
  exportFormats: ["csv"],
});

export const ERP_PAYMENTS_VIEWS: Readonly<Record<string, ViewDeclaration>> = {
  "payment.list": PAYMENT_LIST_VIEW,
};
