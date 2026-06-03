import type { Entity } from "@crossengin/types/meta-schema";

const AUDITABLE = ["auditable"] as const;

export const PRODUCT_ENTITY: Entity = {
  name: "Product",
  traits: [...AUDITABLE],
  fields: [
    {
      name: "sku",
      type: { kind: "text", maxLength: 64 },
      required: true,
      unique: true,
    },
    { name: "name", type: { kind: "text", maxLength: 200 }, required: true, indexed: true },
    {
      name: "category",
      type: {
        kind: "enum",
        values: ["apparel", "grocery", "electronics", "home", "other"],
      },
      required: true,
      default: { kind: "literal", value: "other" },
      indexed: true,
    },
    { name: "barcode", type: { kind: "text", maxLength: 64 } },
    {
      name: "unit_price",
      type: { kind: "decimal", precision: 12, scale: 2, min: 0 },
      required: true,
    },
    {
      name: "unit_cost",
      type: { kind: "decimal", precision: 12, scale: 2, min: 0 },
      required: true,
      // Wholesale cost is a competitive secret — redacted from cashiers by default.
      classification: "commercial_sensitive",
    },
    {
      name: "status",
      type: { kind: "enum", values: ["active", "discontinued"] },
      required: true,
      default: { kind: "literal", value: "active" },
      indexed: true,
    },
  ],
  indexes: [{ fields: ["category", "status"] }],
};

export const STORE_ENTITY: Entity = {
  name: "Store",
  traits: [...AUDITABLE],
  fields: [
    {
      name: "account_id",
      type: { kind: "reference", target: "Account" },
      required: true,
      indexed: true,
    },
    {
      name: "code",
      type: { kind: "text", maxLength: 32 },
      required: true,
      unique: true,
    },
    { name: "name", type: { kind: "text", maxLength: 200 }, required: true },
    { name: "region", type: { kind: "text", maxLength: 64 }, indexed: true },
    {
      name: "status",
      type: { kind: "enum", values: ["open", "closed", "temporarily_closed"] },
      required: true,
      default: { kind: "literal", value: "open" },
    },
  ],
  indexes: [{ fields: ["account_id", "status"] }],
};

export const SALES_ORDER_ENTITY: Entity = {
  name: "SalesOrder",
  traits: [...AUDITABLE],
  fields: [
    {
      name: "store_id",
      type: { kind: "reference", target: "Store" },
      required: true,
      indexed: true,
    },
    {
      name: "invoice_id",
      type: { kind: "reference", target: "Invoice" },
      indexed: true,
    },
    {
      name: "order_number",
      type: { kind: "text", maxLength: 50 },
      required: true,
      unique: true,
    },
    {
      name: "state",
      type: {
        kind: "enum",
        values: ["cart", "placed", "fulfilled", "cancelled", "returned"],
      },
      required: true,
      default: { kind: "literal", value: "cart" },
      indexed: true,
    },
    {
      name: "channel",
      type: { kind: "enum", values: ["in_store", "online", "phone"] },
      required: true,
      default: { kind: "literal", value: "in_store" },
    },
    { name: "customer_email", type: { kind: "email" }, classification: "pii" },
    {
      name: "total",
      type: { kind: "decimal", precision: 14, scale: 2, min: 0 },
      required: true,
      default: { kind: "literal", value: 0 },
    },
    { name: "currency", type: { kind: "text", maxLength: 3 }, required: true },
    { name: "placed_at", type: { kind: "datetime" }, indexed: true },
  ],
  indexes: [{ fields: ["state", "placed_at"] }],
};

export const ORDER_LINE_ENTITY: Entity = {
  name: "OrderLine",
  traits: [...AUDITABLE],
  fields: [
    {
      name: "sales_order_id",
      type: { kind: "reference", target: "SalesOrder" },
      required: true,
      indexed: true,
    },
    {
      name: "product_id",
      type: { kind: "reference", target: "Product" },
      required: true,
      indexed: true,
    },
    { name: "position", type: { kind: "integer", min: 0 }, required: true },
    {
      name: "quantity",
      type: { kind: "decimal", precision: 12, scale: 3, min: 0 },
      required: true,
    },
    {
      name: "unit_price",
      type: { kind: "decimal", precision: 12, scale: 2, min: 0 },
      required: true,
    },
    {
      name: "line_total",
      type: { kind: "decimal", precision: 14, scale: 2, min: 0 },
      required: true,
    },
  ],
};

export const ERP_RETAIL_ENTITIES: readonly Entity[] = [
  PRODUCT_ENTITY,
  STORE_ENTITY,
  SALES_ORDER_ENTITY,
  ORDER_LINE_ENTITY,
];
