import type { Entity } from "@crossengin/types/meta-schema";

const AUDITABLE = ["auditable"] as const;

export const ITEM_ENTITY: Entity = {
  name: "Item",
  traits: [...AUDITABLE],
  fields: [
    { name: "sku", type: { kind: "text", maxLength: 64 }, required: true, unique: true },
    { name: "name", type: { kind: "text", maxLength: 200 }, required: true, indexed: true },
    { name: "description", type: { kind: "long_text" } },
    {
      name: "item_type",
      type: {
        kind: "enum",
        values: ["stock", "service", "kit", "raw_material", "finished_good", "consumable"],
      },
      required: true,
      default: { kind: "literal", value: "stock" },
      indexed: true,
    },
    {
      name: "unit_of_measure",
      type: { kind: "enum", values: ["each", "kg", "g", "l", "ml", "m", "cm", "box", "pallet", "hour"] },
      required: true,
      default: { kind: "literal", value: "each" },
    },
    { name: "category", type: { kind: "text", maxLength: 100 }, indexed: true },
    { name: "barcode", type: { kind: "text", maxLength: 64 } },
    {
      name: "tracking",
      type: { kind: "enum", values: ["none", "lot", "serial"] },
      required: true,
      default: { kind: "literal", value: "none" },
    },
    {
      name: "standard_cost",
      type: { kind: "decimal", precision: 14, scale: 4, min: 0 },
      classification: "commercial_sensitive",
    },
    { name: "list_price", type: { kind: "decimal", precision: 14, scale: 2, min: 0 } },
    { name: "currency", type: { kind: "text", maxLength: 3 }, required: true, default: { kind: "literal", value: "USD" } },
    { name: "reorder_point", type: { kind: "decimal", precision: 14, scale: 3, min: 0 } },
    { name: "reorder_quantity", type: { kind: "decimal", precision: 14, scale: 3, min: 0 } },
    { name: "weight_kg", type: { kind: "decimal", precision: 12, scale: 3, min: 0 } },
    {
      name: "status",
      type: { kind: "enum", values: ["draft", "active", "discontinued"] },
      required: true,
      default: { kind: "literal", value: "active" },
      indexed: true,
    },
  ],
  indexes: [{ fields: ["item_type", "status"] }, { fields: ["category"] }],
};

export const WAREHOUSE_ENTITY: Entity = {
  name: "Warehouse",
  traits: [...AUDITABLE],
  fields: [
    { name: "code", type: { kind: "text", maxLength: 32 }, required: true, unique: true },
    { name: "name", type: { kind: "text", maxLength: 200 }, required: true, indexed: true },
    {
      name: "warehouse_type",
      type: { kind: "enum", values: ["distribution", "retail", "transit", "manufacturing", "virtual"] },
      required: true,
      default: { kind: "literal", value: "distribution" },
    },
    { name: "address_line1", type: { kind: "text", maxLength: 200 } },
    { name: "city", type: { kind: "text", maxLength: 120 } },
    { name: "country", type: { kind: "country_code" } },
    {
      name: "status",
      type: { kind: "enum", values: ["active", "inactive", "closed"] },
      required: true,
      default: { kind: "literal", value: "active" },
      indexed: true,
    },
  ],
  indexes: [{ fields: ["warehouse_type", "status"] }],
};

export const STOCK_LEVEL_ENTITY: Entity = {
  name: "StockLevel",
  traits: [...AUDITABLE],
  fields: [
    { name: "item_id", type: { kind: "reference", target: "Item" }, required: true, indexed: true },
    { name: "warehouse_id", type: { kind: "reference", target: "Warehouse" }, required: true, indexed: true },
    {
      name: "quantity_on_hand",
      type: { kind: "decimal", precision: 16, scale: 3 },
      required: true,
      default: { kind: "literal", value: 0 },
    },
    {
      name: "quantity_reserved",
      type: { kind: "decimal", precision: 16, scale: 3 },
      required: true,
      default: { kind: "literal", value: 0 },
    },
    {
      name: "quantity_incoming",
      type: { kind: "decimal", precision: 16, scale: 3 },
      required: true,
      default: { kind: "literal", value: 0 },
    },
    { name: "bin_location", type: { kind: "text", maxLength: 64 } },
    { name: "last_counted_at", type: { kind: "datetime" } },
  ],
  indexes: [{ fields: ["item_id", "warehouse_id"] }],
};

export const STOCK_MOVEMENT_ENTITY: Entity = {
  name: "StockMovement",
  traits: [...AUDITABLE],
  fields: [
    { name: "item_id", type: { kind: "reference", target: "Item" }, required: true, indexed: true },
    { name: "warehouse_id", type: { kind: "reference", target: "Warehouse" }, required: true, indexed: true },
    {
      name: "movement_type",
      type: {
        kind: "enum",
        values: ["receipt", "issue", "transfer_in", "transfer_out", "adjustment", "return"],
      },
      required: true,
      indexed: true,
    },
    { name: "quantity", type: { kind: "decimal", precision: 16, scale: 3 }, required: true },
    { name: "reference", type: { kind: "text", maxLength: 120 } },
    { name: "reason", type: { kind: "text", maxLength: 200 } },
    { name: "occurred_at", type: { kind: "datetime" }, required: true, indexed: true },
  ],
  indexes: [{ fields: ["item_id", "occurred_at"] }],
};

export const ERP_CORE_INVENTORY_ENTITIES: readonly Entity[] = [
  ITEM_ENTITY,
  WAREHOUSE_ENTITY,
  STOCK_LEVEL_ENTITY,
  STOCK_MOVEMENT_ENTITY,
];
