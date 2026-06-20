import type { Entity } from "@crossengin/types/meta-schema";

const AUDITABLE = ["auditable"] as const;

export const BILL_OF_MATERIALS_ENTITY: Entity = {
  name: "BillOfMaterials",
  traits: [...AUDITABLE],
  fields: [
    { name: "bom_code", type: { kind: "text", maxLength: 64 }, required: true, unique: true, indexed: true },
    { name: "item_id", type: { kind: "reference", target: "Item" }, required: true, indexed: true },
    { name: "version", type: { kind: "text", maxLength: 20 }, required: true, default: { kind: "literal", value: "1" } },
    { name: "output_quantity", type: { kind: "decimal", precision: 16, scale: 3, min: 0 }, required: true, default: { kind: "literal", value: 1 } },
    {
      name: "status",
      type: { kind: "enum", values: ["draft", "active", "archived"] },
      required: true,
      default: { kind: "literal", value: "draft" },
      indexed: true,
    },
    { name: "notes", type: { kind: "long_text" } },
  ],
  indexes: [{ fields: ["item_id", "status"] }],
};

export const BOM_LINE_ENTITY: Entity = {
  name: "BomLine",
  traits: [...AUDITABLE],
  fields: [
    { name: "bom_id", type: { kind: "reference", target: "BillOfMaterials" }, required: true, indexed: true },
    { name: "component_item_id", type: { kind: "reference", target: "Item" }, required: true, indexed: true },
    { name: "quantity", type: { kind: "decimal", precision: 16, scale: 4, min: 0 }, required: true, default: { kind: "literal", value: 1 } },
    { name: "scrap_pct", type: { kind: "decimal", precision: 5, scale: 2, min: 0, max: 100 }, required: true, default: { kind: "literal", value: 0 } },
  ],
  indexes: [{ fields: ["bom_id"] }],
};

export const WORK_ORDER_ENTITY: Entity = {
  name: "WorkOrder",
  traits: [...AUDITABLE],
  fields: [
    {
      name: "wo_number",
      type: { kind: "text", maxLength: 50 },
      required: true,
      unique: true,
      default: { kind: "sequence", sequence: "erp.work_order", format: "WO-{YYYY}-{SEQ:5}", resetPeriod: "yearly" },
    },
    { name: "item_id", type: { kind: "reference", target: "Item" }, required: true, indexed: true },
    { name: "bom_id", type: { kind: "reference", target: "BillOfMaterials" }, indexed: true },
    { name: "warehouse_id", type: { kind: "reference", target: "Warehouse" }, indexed: true },
    { name: "quantity", type: { kind: "decimal", precision: 16, scale: 3, min: 0 }, required: true, default: { kind: "literal", value: 1 } },
    { name: "completed_quantity", type: { kind: "decimal", precision: 16, scale: 3, min: 0 }, required: true, default: { kind: "literal", value: 0 } },
    {
      name: "state",
      type: { kind: "enum", values: ["planned", "released", "in_progress", "completed", "cancelled"] },
      required: true,
      default: { kind: "literal", value: "planned" },
      indexed: true,
    },
    { name: "planned_start", type: { kind: "date" } },
    { name: "planned_end", type: { kind: "date" }, indexed: true },
  ],
  indexes: [{ fields: ["state", "planned_end"] }],
};

export const ERP_CORE_MANUFACTURING_ENTITIES: readonly Entity[] = [
  BILL_OF_MATERIALS_ENTITY,
  BOM_LINE_ENTITY,
  WORK_ORDER_ENTITY,
];
