import type { Entity } from "@crossengin/types/meta-schema";

const AUDITABLE = ["auditable"] as const;

export const LEAD_ENTITY: Entity = {
  name: "Lead",
  traits: [...AUDITABLE],
  fields: [
    { name: "full_name", type: { kind: "text", maxLength: 200 }, required: true, indexed: true, classification: "pii" },
    { name: "company", type: { kind: "text", maxLength: 200 } },
    { name: "email", type: { kind: "email" }, indexed: true, classification: "pii" },
    { name: "phone", type: { kind: "phone" }, classification: "pii" },
    {
      name: "source",
      type: { kind: "enum", values: ["web", "referral", "event", "outbound", "partner", "other"] },
      required: true,
      default: { kind: "literal", value: "web" },
    },
    {
      name: "state",
      type: { kind: "enum", values: ["new", "working", "qualified", "converted", "disqualified"] },
      required: true,
      default: { kind: "literal", value: "new" },
      indexed: true,
    },
    { name: "owner_id", type: { kind: "reference", target: "Employee" }, indexed: true },
    { name: "estimated_value", type: { kind: "decimal", precision: 16, scale: 2, min: 0 }, classification: "commercial_sensitive" },
    { name: "notes", type: { kind: "long_text" } },
  ],
  indexes: [{ fields: ["state", "source"] }],
};

export const OPPORTUNITY_ENTITY: Entity = {
  name: "Opportunity",
  traits: [...AUDITABLE],
  fields: [
    { name: "name", type: { kind: "text", maxLength: 200 }, required: true, indexed: true },
    { name: "account_id", type: { kind: "reference", target: "Account" }, required: true, indexed: true },
    { name: "owner_id", type: { kind: "reference", target: "Employee" }, indexed: true },
    { name: "amount", type: { kind: "decimal", precision: 16, scale: 2, min: 0 }, required: true, default: { kind: "literal", value: 0 }, classification: "commercial_sensitive" },
    { name: "currency", type: { kind: "text", maxLength: 3 }, required: true, default: { kind: "literal", value: "USD" } },
    { name: "probability_pct", type: { kind: "decimal", precision: 5, scale: 2, min: 0, max: 100 }, required: true, default: { kind: "literal", value: 0 } },
    {
      name: "stage",
      type: { kind: "enum", values: ["prospecting", "qualification", "proposal", "negotiation", "won", "lost"] },
      required: true,
      default: { kind: "literal", value: "prospecting" },
      indexed: true,
    },
    { name: "expected_close_date", type: { kind: "date" }, indexed: true },
    { name: "lost_reason", type: { kind: "text", maxLength: 200 } },
  ],
  indexes: [{ fields: ["stage", "expected_close_date"] }, { fields: ["account_id", "stage"] }],
};

export const QUOTE_ENTITY: Entity = {
  name: "Quote",
  traits: [...AUDITABLE],
  fields: [
    {
      name: "quote_number",
      type: { kind: "text", maxLength: 50 },
      required: true,
      unique: true,
      default: { kind: "sequence", sequence: "erp.quote", format: "QUO-{YYYY}-{SEQ:5}", resetPeriod: "yearly" },
    },
    { name: "account_id", type: { kind: "reference", target: "Account" }, required: true, indexed: true },
    { name: "opportunity_id", type: { kind: "reference", target: "Opportunity" }, indexed: true },
    {
      name: "state",
      type: { kind: "enum", values: ["draft", "sent", "accepted", "rejected", "expired"] },
      required: true,
      default: { kind: "literal", value: "draft" },
      indexed: true,
    },
    { name: "valid_until", type: { kind: "date" } },
    { name: "currency", type: { kind: "text", maxLength: 3 }, required: true, default: { kind: "literal", value: "USD" } },
    { name: "subtotal", type: { kind: "decimal", precision: 16, scale: 2, min: 0 }, required: true, default: { kind: "literal", value: 0 } },
    { name: "tax_total", type: { kind: "decimal", precision: 16, scale: 2, min: 0 }, required: true, default: { kind: "literal", value: 0 } },
    { name: "total", type: { kind: "decimal", precision: 16, scale: 2, min: 0 }, required: true, default: { kind: "literal", value: 0 } },
  ],
  indexes: [{ fields: ["state", "account_id"] }],
};

export const QUOTE_LINE_ENTITY: Entity = {
  name: "QuoteLine",
  traits: [...AUDITABLE],
  fields: [
    { name: "quote_id", type: { kind: "reference", target: "Quote" }, required: true, indexed: true },
    { name: "item_id", type: { kind: "reference", target: "Item" }, indexed: true },
    { name: "description", type: { kind: "text", maxLength: 300 }, required: true },
    { name: "quantity", type: { kind: "decimal", precision: 16, scale: 3, min: 0 }, required: true, default: { kind: "literal", value: 1 } },
    { name: "unit_price", type: { kind: "decimal", precision: 14, scale: 4, min: 0 }, required: true },
    { name: "discount_pct", type: { kind: "decimal", precision: 5, scale: 2, min: 0, max: 100 }, required: true, default: { kind: "literal", value: 0 } },
    { name: "line_total", type: { kind: "decimal", precision: 16, scale: 2, min: 0 }, required: true, default: { kind: "literal", value: 0 } },
  ],
  indexes: [{ fields: ["quote_id"] }],
};

export const SALES_ORDER_ENTITY: Entity = {
  name: "SalesOrder",
  traits: [...AUDITABLE],
  fields: [
    {
      name: "so_number",
      type: { kind: "text", maxLength: 50 },
      required: true,
      unique: true,
      default: { kind: "sequence", sequence: "erp.sales_order", format: "SO-{YYYY}-{SEQ:5}", resetPeriod: "yearly" },
    },
    { name: "account_id", type: { kind: "reference", target: "Account" }, required: true, indexed: true },
    { name: "quote_id", type: { kind: "reference", target: "Quote" }, indexed: true },
    {
      name: "state",
      type: { kind: "enum", values: ["draft", "confirmed", "fulfilled", "invoiced", "closed", "cancelled"] },
      required: true,
      default: { kind: "literal", value: "draft" },
      indexed: true,
    },
    { name: "order_date", type: { kind: "date" }, required: true, indexed: true },
    { name: "requested_delivery_date", type: { kind: "date" } },
    { name: "currency", type: { kind: "text", maxLength: 3 }, required: true, default: { kind: "literal", value: "USD" } },
    { name: "subtotal", type: { kind: "decimal", precision: 16, scale: 2, min: 0 }, required: true, default: { kind: "literal", value: 0 } },
    { name: "tax_total", type: { kind: "decimal", precision: 16, scale: 2, min: 0 }, required: true, default: { kind: "literal", value: 0 } },
    { name: "total", type: { kind: "decimal", precision: 16, scale: 2, min: 0 }, required: true, default: { kind: "literal", value: 0 } },
  ],
  indexes: [{ fields: ["state", "order_date"] }, { fields: ["account_id", "state"] }],
};

export const SALES_ORDER_LINE_ENTITY: Entity = {
  name: "SalesOrderLine",
  traits: [...AUDITABLE],
  fields: [
    { name: "sales_order_id", type: { kind: "reference", target: "SalesOrder" }, required: true, indexed: true },
    { name: "item_id", type: { kind: "reference", target: "Item" }, indexed: true },
    { name: "description", type: { kind: "text", maxLength: 300 }, required: true },
    { name: "quantity", type: { kind: "decimal", precision: 16, scale: 3, min: 0 }, required: true, default: { kind: "literal", value: 1 } },
    { name: "fulfilled_quantity", type: { kind: "decimal", precision: 16, scale: 3, min: 0 }, required: true, default: { kind: "literal", value: 0 } },
    { name: "unit_price", type: { kind: "decimal", precision: 14, scale: 4, min: 0 }, required: true },
    { name: "line_total", type: { kind: "decimal", precision: 16, scale: 2, min: 0 }, required: true, default: { kind: "literal", value: 0 } },
  ],
  indexes: [{ fields: ["sales_order_id"] }],
};

export const SHIPMENT_ENTITY: Entity = {
  name: "Shipment",
  traits: [...AUDITABLE],
  fields: [
    {
      name: "shipment_number",
      type: { kind: "text", maxLength: 50 },
      required: true,
      unique: true,
      default: { kind: "sequence", sequence: "erp.shipment", format: "SHP-{YYYY}-{SEQ:5}", resetPeriod: "yearly" },
    },
    { name: "sales_order_id", type: { kind: "reference", target: "SalesOrder" }, required: true, indexed: true },
    { name: "warehouse_id", type: { kind: "reference", target: "Warehouse" }, indexed: true },
    {
      name: "state",
      type: { kind: "enum", values: ["pending", "picked", "packed", "shipped", "delivered", "cancelled"] },
      required: true,
      default: { kind: "literal", value: "pending" },
      indexed: true,
    },
    { name: "carrier", type: { kind: "text", maxLength: 120 } },
    { name: "tracking_number", type: { kind: "text", maxLength: 120 }, indexed: true },
    { name: "shipped_at", type: { kind: "datetime" } },
    { name: "delivered_at", type: { kind: "datetime" } },
  ],
  indexes: [{ fields: ["state", "sales_order_id"] }],
};

export const ERP_CORE_SALES_ENTITIES: readonly Entity[] = [
  LEAD_ENTITY,
  OPPORTUNITY_ENTITY,
  QUOTE_ENTITY,
  QUOTE_LINE_ENTITY,
  SALES_ORDER_ENTITY,
  SALES_ORDER_LINE_ENTITY,
  SHIPMENT_ENTITY,
];
