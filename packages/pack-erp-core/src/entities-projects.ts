import type { Entity } from "@crossengin/types/meta-schema";

const AUDITABLE = ["auditable"] as const;

export const PROJECT_ENTITY: Entity = {
  name: "Project",
  traits: [...AUDITABLE],
  fields: [
    { name: "project_code", type: { kind: "text", maxLength: 64 }, required: true, unique: true, indexed: true },
    { name: "name", type: { kind: "text", maxLength: 200 }, required: true, indexed: true },
    { name: "account_id", type: { kind: "reference", target: "Account" }, indexed: true },
    { name: "manager_id", type: { kind: "reference", target: "Employee" }, indexed: true },
    {
      name: "state",
      type: { kind: "enum", values: ["planning", "active", "on_hold", "completed", "cancelled"] },
      required: true,
      default: { kind: "literal", value: "planning" },
      indexed: true,
    },
    { name: "start_date", type: { kind: "date" } },
    { name: "end_date", type: { kind: "date" } },
    { name: "budget", type: { kind: "decimal", precision: 16, scale: 2, min: 0 }, classification: "commercial_sensitive" },
    { name: "currency", type: { kind: "text", maxLength: 3 }, required: true, default: { kind: "literal", value: "USD" } },
  ],
  indexes: [{ fields: ["state", "manager_id"] }],
};

export const PROJECT_TASK_ENTITY: Entity = {
  name: "ProjectTask",
  traits: [...AUDITABLE],
  fields: [
    { name: "project_id", type: { kind: "reference", target: "Project" }, required: true, indexed: true },
    { name: "name", type: { kind: "text", maxLength: 200 }, required: true },
    { name: "assignee_id", type: { kind: "reference", target: "Employee" }, indexed: true },
    {
      name: "state",
      type: { kind: "enum", values: ["todo", "in_progress", "review", "done", "cancelled"] },
      required: true,
      default: { kind: "literal", value: "todo" },
      indexed: true,
    },
    { name: "priority", type: { kind: "enum", values: ["low", "medium", "high", "urgent"] }, required: true, default: { kind: "literal", value: "medium" } },
    { name: "due_date", type: { kind: "date" }, indexed: true },
    { name: "estimated_hours", type: { kind: "decimal", precision: 8, scale: 2, min: 0 } },
  ],
  indexes: [{ fields: ["project_id", "state"] }],
};

export const TIMESHEET_ENTITY: Entity = {
  name: "Timesheet",
  traits: [...AUDITABLE],
  fields: [
    { name: "employee_id", type: { kind: "reference", target: "Employee" }, required: true, indexed: true },
    { name: "project_id", type: { kind: "reference", target: "Project" }, indexed: true },
    { name: "project_task_id", type: { kind: "reference", target: "ProjectTask" }, indexed: true },
    { name: "work_date", type: { kind: "date" }, required: true, indexed: true },
    { name: "hours", type: { kind: "decimal", precision: 6, scale: 2, min: 0 }, required: true },
    { name: "billable", type: { kind: "boolean" }, required: true, default: { kind: "literal", value: true } },
    {
      name: "state",
      type: { kind: "enum", values: ["draft", "submitted", "approved", "rejected"] },
      required: true,
      default: { kind: "literal", value: "draft" },
      indexed: true,
    },
    { name: "notes", type: { kind: "long_text" } },
  ],
  indexes: [{ fields: ["employee_id", "work_date"] }],
};

export const ERP_CORE_PROJECT_ENTITIES: readonly Entity[] = [
  PROJECT_ENTITY,
  PROJECT_TASK_ENTITY,
  TIMESHEET_ENTITY,
];
