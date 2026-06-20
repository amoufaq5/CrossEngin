import type { Entity } from "@crossengin/types/meta-schema";

const AUDITABLE = ["auditable"] as const;

export const VENDOR_ENTITY: Entity = {
  name: "Vendor",
  traits: [...AUDITABLE],
  fields: [
    { name: "vendor_code", type: { kind: "text", maxLength: 32 }, required: true, unique: true },
    { name: "name", type: { kind: "text", maxLength: 200 }, required: true, indexed: true },
    { name: "legal_name", type: { kind: "text", maxLength: 200 } },
    { name: "tax_id", type: { kind: "text", maxLength: 64 }, classification: "commercial_sensitive" },
    { name: "contact_email", type: { kind: "email" }, classification: "pii" },
    { name: "contact_phone", type: { kind: "phone" }, classification: "pii" },
    { name: "country", type: { kind: "country_code" } },
    {
      name: "payment_terms",
      type: { kind: "enum", values: ["net_15", "net_30", "net_45", "net_60", "due_on_receipt", "prepaid"] },
      required: true,
      default: { kind: "literal", value: "net_30" },
    },
    { name: "currency", type: { kind: "text", maxLength: 3 }, required: true, default: { kind: "literal", value: "USD" } },
    {
      name: "status",
      type: { kind: "enum", values: ["prospect", "active", "on_hold", "blacklisted", "inactive"] },
      required: true,
      default: { kind: "literal", value: "active" },
      indexed: true,
    },
  ],
  indexes: [{ fields: ["status"] }, { fields: ["name"] }],
};

export const PURCHASE_ORDER_ENTITY: Entity = {
  name: "PurchaseOrder",
  traits: [...AUDITABLE],
  fields: [
    { name: "po_number", type: { kind: "text", maxLength: 50 }, required: true, unique: true },
    { name: "vendor_id", type: { kind: "reference", target: "Vendor" }, required: true, indexed: true },
    { name: "warehouse_id", type: { kind: "reference", target: "Warehouse" }, indexed: true },
    {
      name: "state",
      type: {
        kind: "enum",
        values: ["draft", "submitted", "approved", "received", "closed", "cancelled"],
      },
      required: true,
      default: { kind: "literal", value: "draft" },
      indexed: true,
    },
    { name: "order_date", type: { kind: "date" }, required: true },
    { name: "expected_date", type: { kind: "date" } },
    {
      name: "subtotal",
      type: { kind: "decimal", precision: 16, scale: 2, min: 0 },
      required: true,
      default: { kind: "literal", value: 0 },
    },
    {
      name: "tax_total",
      type: { kind: "decimal", precision: 16, scale: 2, min: 0 },
      required: true,
      default: { kind: "literal", value: 0 },
    },
    {
      name: "total",
      type: { kind: "decimal", precision: 16, scale: 2, min: 0 },
      required: true,
      default: { kind: "literal", value: 0 },
    },
    { name: "currency", type: { kind: "text", maxLength: 3 }, required: true, default: { kind: "literal", value: "USD" } },
    { name: "notes", type: { kind: "long_text" } },
  ],
  indexes: [{ fields: ["state", "order_date"] }, { fields: ["vendor_id", "state"] }],
};

export const PURCHASE_ORDER_LINE_ENTITY: Entity = {
  name: "PurchaseOrderLine",
  traits: [...AUDITABLE],
  fields: [
    { name: "purchase_order_id", type: { kind: "reference", target: "PurchaseOrder" }, required: true, indexed: true },
    { name: "item_id", type: { kind: "reference", target: "Item" }, required: true, indexed: true },
    { name: "description", type: { kind: "text", maxLength: 300 } },
    { name: "quantity", type: { kind: "decimal", precision: 16, scale: 3, min: 0 }, required: true },
    { name: "unit_price", type: { kind: "decimal", precision: 14, scale: 4, min: 0 }, required: true },
    {
      name: "received_quantity",
      type: { kind: "decimal", precision: 16, scale: 3, min: 0 },
      required: true,
      default: { kind: "literal", value: 0 },
    },
    { name: "line_total", type: { kind: "decimal", precision: 16, scale: 2, min: 0 }, required: true, default: { kind: "literal", value: 0 } },
  ],
  indexes: [{ fields: ["purchase_order_id"] }],
};

export const GOODS_RECEIPT_ENTITY: Entity = {
  name: "GoodsReceipt",
  traits: [...AUDITABLE],
  fields: [
    { name: "grn_number", type: { kind: "text", maxLength: 50 }, required: true, unique: true },
    { name: "purchase_order_id", type: { kind: "reference", target: "PurchaseOrder" }, required: true, indexed: true },
    { name: "warehouse_id", type: { kind: "reference", target: "Warehouse" }, required: true, indexed: true },
    { name: "received_date", type: { kind: "date" }, required: true, indexed: true },
    { name: "received_by", type: { kind: "text", maxLength: 200 } },
    {
      name: "status",
      type: { kind: "enum", values: ["draft", "posted", "cancelled"] },
      required: true,
      default: { kind: "literal", value: "draft" },
    },
    { name: "notes", type: { kind: "long_text" } },
  ],
  indexes: [{ fields: ["purchase_order_id"] }],
};

export const ERP_CORE_PROCUREMENT_ENTITIES: readonly Entity[] = [
  VENDOR_ENTITY,
  PURCHASE_ORDER_ENTITY,
  PURCHASE_ORDER_LINE_ENTITY,
  GOODS_RECEIPT_ENTITY,
];
