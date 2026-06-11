import type { Entity } from "@crossengin/types/meta-schema";

const AUDITABLE = ["auditable"] as const;

/** A construction project for a core ERP `Account` (the client). The lifecycle hub. */
export const PROJECT_ENTITY: Entity = {
  name: "Project",
  traits: [...AUDITABLE],
  fields: [
    {
      name: "account_id",
      type: { kind: "reference", target: "Account" },
      required: true,
      indexed: true,
    },
    { name: "code", type: { kind: "text", maxLength: 32 }, required: true, unique: true },
    { name: "name", type: { kind: "text", maxLength: 200 }, required: true, indexed: true },
    {
      name: "project_type",
      type: { kind: "enum", values: ["residential", "commercial", "infrastructure", "industrial", "other"] },
      required: true,
      default: { kind: "literal", value: "other" },
      indexed: true,
    },
    {
      name: "state",
      type: { kind: "enum", values: ["planning", "active", "on_hold", "completed", "cancelled"] },
      required: true,
      default: { kind: "literal", value: "planning" },
      indexed: true,
    },
    { name: "site_region", type: { kind: "text", maxLength: 64 }, indexed: true },
    { name: "start_date", type: { kind: "date" }, indexed: true },
    { name: "target_end_date", type: { kind: "date" } },
    {
      name: "budget",
      type: { kind: "decimal", precision: 14, scale: 2, min: 0 },
      required: true,
      default: { kind: "literal", value: 0 },
    },
    {
      name: "contract_value",
      type: { kind: "decimal", precision: 14, scale: 2, min: 0 },
      required: true,
      // The negotiated contract price is competitively sensitive — redacted from
      // site supervisors by default (an explicit grant lets PMs/estimators read it).
      classification: "commercial_sensitive",
    },
  ],
  indexes: [{ fields: ["state", "project_type"] }],
};

/** A budget line / cost code within a project. */
export const COST_CODE_ENTITY: Entity = {
  name: "CostCode",
  traits: [...AUDITABLE],
  fields: [
    {
      name: "project_id",
      type: { kind: "reference", target: "Project" },
      required: true,
      indexed: true,
    },
    { name: "code", type: { kind: "text", maxLength: 32 }, required: true },
    { name: "description", type: { kind: "text", maxLength: 200 } },
    {
      name: "category",
      type: { kind: "enum", values: ["labor", "materials", "equipment", "subcontractor", "overhead"] },
      required: true,
      default: { kind: "literal", value: "labor" },
      indexed: true,
    },
    {
      name: "budget_amount",
      type: { kind: "decimal", precision: 14, scale: 2, min: 0 },
      required: true,
    },
    {
      name: "committed_amount",
      type: { kind: "decimal", precision: 14, scale: 2, min: 0 },
      required: true,
      default: { kind: "literal", value: 0 },
    },
  ],
  indexes: [{ fields: ["project_id", "category"] }],
};

/** A change order on a project — its own approval lifecycle; optionally bills a core Invoice. */
export const CHANGE_ORDER_ENTITY: Entity = {
  name: "ChangeOrder",
  traits: [...AUDITABLE],
  fields: [
    {
      name: "project_id",
      type: { kind: "reference", target: "Project" },
      required: true,
      indexed: true,
    },
    { name: "invoice_id", type: { kind: "reference", target: "Invoice" }, indexed: true },
    { name: "number", type: { kind: "text", maxLength: 50 }, required: true, unique: true },
    { name: "description", type: { kind: "long_text" }, required: true },
    {
      name: "amount",
      type: { kind: "decimal", precision: 14, scale: 2 },
      required: true,
    },
    {
      name: "co_state",
      type: { kind: "enum", values: ["draft", "submitted", "approved", "rejected"] },
      required: true,
      default: { kind: "literal", value: "draft" },
      indexed: true,
    },
    { name: "submitted_at", type: { kind: "datetime" }, indexed: true },
  ],
  indexes: [{ fields: ["co_state", "submitted_at"] }],
};

/** A daily site log entry. */
export const DAILY_LOG_ENTITY: Entity = {
  name: "DailyLog",
  traits: [...AUDITABLE],
  fields: [
    {
      name: "project_id",
      type: { kind: "reference", target: "Project" },
      required: true,
      indexed: true,
    },
    { name: "log_date", type: { kind: "date" }, required: true, indexed: true },
    {
      name: "weather",
      type: { kind: "enum", values: ["clear", "rain", "snow", "wind", "extreme_heat"] },
    },
    { name: "crew_count", type: { kind: "integer", min: 0 } },
    { name: "hours_worked", type: { kind: "decimal", precision: 8, scale: 2, min: 0 } },
    { name: "notes", type: { kind: "long_text" } },
    { name: "reported_by_email", type: { kind: "email" }, classification: "pii" },
  ],
  indexes: [{ fields: ["project_id", "log_date"] }],
};

export const ERP_CONSTRUCTION_ENTITIES: readonly Entity[] = [
  PROJECT_ENTITY,
  COST_CODE_ENTITY,
  CHANGE_ORDER_ENTITY,
  DAILY_LOG_ENTITY,
];
