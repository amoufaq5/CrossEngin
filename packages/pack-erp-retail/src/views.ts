import {
  ListViewSchema,
  type ListView,
  type ViewDeclaration,
} from "@crossengin/views";

export const PRODUCT_LIST_VIEW: ListView = ListViewSchema.parse({
  kind: "list",
  entity: "Product",
  label: { en: "Products" },
  permissions: "inherit",
  sort: [{ field: "name", direction: "asc" }],
  columns: [
    { field: "sku", label: { en: "SKU" } },
    { field: "name", label: { en: "Name" } },
    { field: "category", label: { en: "Category" } },
    { field: "unit_price", label: { en: "Price" } },
    { field: "status", label: { en: "Status" } },
  ],
  pageSize: 100,
  exportFormats: ["csv", "xlsx"],
});

export const SALES_ORDER_LIST_VIEW: ListView = ListViewSchema.parse({
  kind: "list",
  entity: "SalesOrder",
  label: { en: "Sales orders" },
  permissions: "inherit",
  sort: [{ field: "placed_at", direction: "desc" }],
  columns: [
    { field: "order_number", label: { en: "Number" } },
    { field: "store_id", label: { en: "Store" } },
    { field: "state", label: { en: "State" } },
    { field: "channel", label: { en: "Channel" } },
    { field: "total", label: { en: "Total" } },
    { field: "placed_at", label: { en: "Placed" } },
  ],
  pageSize: 100,
  exportFormats: ["csv"],
});

export const ERP_RETAIL_VIEWS: Readonly<Record<string, ViewDeclaration>> = {
  "product.list": PRODUCT_LIST_VIEW,
  "sales_order.list": SALES_ORDER_LIST_VIEW,
};
