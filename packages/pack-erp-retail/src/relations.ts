import type { Relation } from "@crossengin/types/meta-schema";

// Cross-pack: `from` is the core ERP `Account` (the operating company).
export const ACCOUNT_STORES_RELATION: Relation = {
  kind: "one_to_many",
  from: "Account",
  field: "stores",
  to: "Store",
  onDelete: "cascade",
};

export const STORE_ORDERS_RELATION: Relation = {
  kind: "one_to_many",
  from: "Store",
  field: "sales_orders",
  to: "SalesOrder",
  onDelete: "cascade",
};

export const SALES_ORDER_LINES_RELATION: Relation = {
  kind: "one_to_many",
  from: "SalesOrder",
  field: "lines",
  to: "OrderLine",
  onDelete: "cascade",
};

// Cross-pack: a SalesOrder optionally bills to a core ERP `Invoice`.
export const SALES_ORDER_INVOICE_RELATION: Relation = {
  kind: "many_to_one",
  from: "SalesOrder",
  field: "invoice_id",
  to: "Invoice",
  onDelete: "restrict",
};

export const PRODUCT_ORDER_LINES_RELATION: Relation = {
  kind: "one_to_many",
  from: "Product",
  field: "order_lines",
  to: "OrderLine",
  onDelete: "restrict",
};

export const ERP_RETAIL_RELATIONS: readonly Relation[] = [
  ACCOUNT_STORES_RELATION,
  STORE_ORDERS_RELATION,
  SALES_ORDER_LINES_RELATION,
  SALES_ORDER_INVOICE_RELATION,
  PRODUCT_ORDER_LINES_RELATION,
];
