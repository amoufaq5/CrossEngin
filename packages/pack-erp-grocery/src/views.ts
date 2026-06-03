import {
  ListViewSchema,
  type ListView,
  type ViewDeclaration,
} from "@crossengin/views";

export const PERISHABLE_LOT_LIST_VIEW: ListView = ListViewSchema.parse({
  kind: "list",
  entity: "PerishableLot",
  label: { en: "Perishable lots" },
  permissions: "inherit",
  sort: [{ field: "expiration_date", direction: "asc" }],
  columns: [
    { field: "lot_code", label: { en: "Lot" } },
    { field: "product_id", label: { en: "Product" } },
    { field: "supplier_id", label: { en: "Supplier" } },
    { field: "state", label: { en: "State" } },
    { field: "expiration_date", label: { en: "Expires" } },
    { field: "quantity", label: { en: "Qty" } },
  ],
  pageSize: 100,
  exportFormats: ["csv"],
});

export const ERP_GROCERY_VIEWS: Readonly<Record<string, ViewDeclaration>> = {
  "perishable_lot.list": PERISHABLE_LOT_LIST_VIEW,
};
