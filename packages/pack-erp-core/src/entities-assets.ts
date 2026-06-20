import type { Entity } from "@crossengin/types/meta-schema";

const AUDITABLE = ["auditable"] as const;

export const FIXED_ASSET_ENTITY: Entity = {
  name: "FixedAsset",
  traits: [...AUDITABLE],
  fields: [
    { name: "asset_tag", type: { kind: "text", maxLength: 64 }, required: true, unique: true, indexed: true },
    { name: "name", type: { kind: "text", maxLength: 200 }, required: true, indexed: true },
    {
      name: "category",
      type: { kind: "enum", values: ["equipment", "vehicle", "building", "furniture", "it_hardware", "software", "other"] },
      required: true,
      default: { kind: "literal", value: "equipment" },
      indexed: true,
    },
    { name: "ledger_account_id", type: { kind: "reference", target: "LedgerAccount" }, indexed: true },
    { name: "acquisition_date", type: { kind: "date" }, required: true },
    { name: "acquisition_cost", type: { kind: "decimal", precision: 16, scale: 2, min: 0 }, required: true, classification: "commercial_sensitive" },
    {
      name: "depreciation_method",
      type: { kind: "enum", values: ["straight_line", "declining_balance", "units_of_production", "none"] },
      required: true,
      default: { kind: "literal", value: "straight_line" },
    },
    { name: "useful_life_months", type: { kind: "integer", min: 0 } },
    { name: "salvage_value", type: { kind: "decimal", precision: 16, scale: 2, min: 0 }, classification: "commercial_sensitive" },
    {
      name: "state",
      type: { kind: "enum", values: ["in_service", "under_maintenance", "retired", "disposed"] },
      required: true,
      default: { kind: "literal", value: "in_service" },
      indexed: true,
    },
  ],
  indexes: [{ fields: ["category", "state"] }],
};

export const MAINTENANCE_ORDER_ENTITY: Entity = {
  name: "MaintenanceOrder",
  traits: [...AUDITABLE],
  fields: [
    {
      name: "mo_number",
      type: { kind: "text", maxLength: 50 },
      required: true,
      unique: true,
      default: { kind: "sequence", sequence: "erp.maintenance_order", format: "MO-{YYYY}-{SEQ:5}", resetPeriod: "yearly" },
    },
    { name: "fixed_asset_id", type: { kind: "reference", target: "FixedAsset" }, required: true, indexed: true },
    { name: "assignee_id", type: { kind: "reference", target: "Employee" }, indexed: true },
    {
      name: "kind",
      type: { kind: "enum", values: ["preventive", "corrective", "inspection", "calibration"] },
      required: true,
      default: { kind: "literal", value: "preventive" },
    },
    {
      name: "state",
      type: { kind: "enum", values: ["requested", "scheduled", "in_progress", "completed", "cancelled"] },
      required: true,
      default: { kind: "literal", value: "requested" },
      indexed: true,
    },
    { name: "scheduled_date", type: { kind: "date" }, indexed: true },
    { name: "completed_at", type: { kind: "datetime" } },
    { name: "cost", type: { kind: "decimal", precision: 14, scale: 2, min: 0 }, classification: "commercial_sensitive" },
    { name: "description", type: { kind: "long_text" } },
  ],
  indexes: [{ fields: ["state", "scheduled_date"] }, { fields: ["fixed_asset_id"] }],
};

export const ERP_CORE_ASSET_ENTITIES: readonly Entity[] = [
  FIXED_ASSET_ENTITY,
  MAINTENANCE_ORDER_ENTITY,
];
