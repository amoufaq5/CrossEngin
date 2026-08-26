import type { Entity } from "@crossengin/types/meta-schema";

const AUDITABLE = ["auditable"] as const;

export const PROJECT_ENTITY: Entity = {
  name: "Project",
  // Deliberately replaces core's Project — construction's is site-oriented (site_address, target_completion_date).
  overrides: true,
  traits: [...AUDITABLE],
  fields: [
    {
      name: "account_id",
      type: { kind: "reference", target: "Account" },
      required: true,
      indexed: true,
    },
    {
      name: "project_code",
      type: { kind: "text", maxLength: 32 },
      required: true,
      unique: true,
    },
    { name: "name", type: { kind: "text", maxLength: 200 }, required: true, indexed: true },
    {
      name: "budget_amount",
      type: { kind: "decimal", precision: 16, scale: 2, min: 0 },
      required: true,
      // Contract budget is competitively sensitive — redacted from a foreman by default.
      classification: "commercial_sensitive",
    },
    { name: "start_date", type: { kind: "date" }, indexed: true },
    { name: "target_completion_date", type: { kind: "date" } },
    { name: "site_address", type: { kind: "text", maxLength: 300 } },
    {
      name: "status",
      type: {
        kind: "enum",
        values: ["bidding", "active", "on_hold", "completed", "cancelled"],
      },
      required: true,
      default: { kind: "literal", value: "bidding" },
      indexed: true,
    },
  ],
  indexes: [{ fields: ["account_id", "status"] }],
};

export const SUBCONTRACTOR_ENTITY: Entity = {
  name: "Subcontractor",
  traits: [...AUDITABLE],
  fields: [
    {
      name: "account_id",
      type: { kind: "reference", target: "Account" },
      indexed: true,
    },
    {
      name: "company_name",
      type: { kind: "text", maxLength: 200 },
      required: true,
      indexed: true,
    },
    { name: "contact_email", type: { kind: "email" }, classification: "pii" },
    { name: "contact_phone", type: { kind: "phone" } },
    {
      name: "trade",
      type: {
        kind: "enum",
        values: [
          "electrical",
          "plumbing",
          "framing",
          "concrete",
          "hvac",
          "roofing",
          "masonry",
          "other",
        ],
      },
      required: true,
      default: { kind: "literal", value: "other" },
      indexed: true,
    },
    {
      name: "tax_id",
      type: { kind: "text", maxLength: 64 },
      // Federal tax id is a competitively/legally sensitive commercial identifier.
      classification: "commercial_sensitive",
    },
    {
      name: "status",
      type: { kind: "enum", values: ["active", "suspended", "inactive"] },
      required: true,
      default: { kind: "literal", value: "active" },
    },
  ],
  indexes: [{ fields: ["trade", "status"] }],
};

export const WORK_ORDER_ENTITY: Entity = {
  name: "WorkOrder",
  // Deliberately replaces core's manufacturing WorkOrder — construction's is a subcontractor order.
  overrides: true,
  traits: [...AUDITABLE],
  fields: [
    {
      name: "project_id",
      type: { kind: "reference", target: "Project" },
      required: true,
      indexed: true,
    },
    {
      name: "subcontractor_id",
      type: { kind: "reference", target: "Subcontractor" },
      indexed: true,
    },
    {
      name: "wo_number",
      type: { kind: "text", maxLength: 50 },
      required: true,
      unique: true,
    },
    { name: "description", type: { kind: "long_text" }, required: true },
    {
      name: "cost_estimate",
      type: { kind: "decimal", precision: 14, scale: 2, min: 0 },
      required: true,
      // Line-item bid cost is competitively sensitive.
      classification: "commercial_sensitive",
    },
    {
      name: "status",
      type: {
        kind: "enum",
        values: ["draft", "scheduled", "in_progress", "done", "cancelled"],
      },
      required: true,
      default: { kind: "literal", value: "draft" },
      indexed: true,
    },
    { name: "scheduled_date", type: { kind: "date" }, indexed: true },
  ],
  indexes: [{ fields: ["project_id", "status"] }],
};

const CONSTRUCTION_MODULES: Readonly<Record<string, string>> = {
  Project: "Projects & Services",
  Subcontractor: "Procurement & Vendors",
  WorkOrder: "Projects & Services",
};

export const ERP_CONSTRUCTION_ENTITIES: readonly Entity[] = [
  PROJECT_ENTITY,
  SUBCONTRACTOR_ENTITY,
  WORK_ORDER_ENTITY,
].map((e) =>
  CONSTRUCTION_MODULES[e.name] !== undefined
    ? { ...e, module: CONSTRUCTION_MODULES[e.name] }
    : e,
);
