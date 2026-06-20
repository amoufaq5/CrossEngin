import type { Entity } from "@crossengin/types/meta-schema";

const AUDITABLE = ["auditable"] as const;

export const SUPPLIER_ENTITY: Entity = {
  name: "Supplier",
  traits: [...AUDITABLE],
  fields: [
    // Cross-pack reference to the CORE Account (the operating company).
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
    { name: "contact_email", type: { kind: "email" }, classification: "pii" },
    {
      name: "payment_terms_days",
      type: { kind: "integer", min: 0, max: 365 },
      required: true,
      default: { kind: "literal", value: 30 },
    },
  ],
  indexes: [{ fields: ["account_id"] }],
};

export const PERISHABLE_LOT_ENTITY: Entity = {
  name: "PerishableLot",
  traits: [...AUDITABLE],
  fields: [
    // Cross-pack reference to the RETAIL Product (two levels up the chain).
    {
      name: "product_id",
      type: { kind: "reference", target: "Product" },
      required: true,
      indexed: true,
    },
    {
      name: "supplier_id",
      type: { kind: "reference", target: "Supplier" },
      required: true,
      indexed: true,
    },
    {
      name: "lot_code",
      type: { kind: "text", maxLength: 64 },
      required: true,
      unique: true,
    },
    {
      name: "state",
      type: {
        kind: "enum",
        values: ["received", "on_shelf", "depleted", "expired"],
      },
      required: true,
      default: { kind: "literal", value: "received" },
      indexed: true,
    },
    { name: "expiration_date", type: { kind: "date" }, required: true, indexed: true },
    {
      name: "quantity",
      type: { kind: "decimal", precision: 12, scale: 3, min: 0 },
      required: true,
    },
    {
      name: "cost_per_unit",
      type: { kind: "decimal", precision: 12, scale: 4, min: 0 },
      required: true,
      classification: "commercial_sensitive",
    },
    { name: "received_at", type: { kind: "datetime" }, required: true },
  ],
  indexes: [{ fields: ["state", "expiration_date"] }],
};

const GROCERY_MODULES: Readonly<Record<string, string>> = {
  Supplier: "Procurement",
  PerishableLot: "Supply Chain & Inventory",
};

export const ERP_GROCERY_ENTITIES: readonly Entity[] = [
  SUPPLIER_ENTITY,
  PERISHABLE_LOT_ENTITY,
].map((e) => (GROCERY_MODULES[e.name] !== undefined ? { ...e, module: GROCERY_MODULES[e.name] } : e));
