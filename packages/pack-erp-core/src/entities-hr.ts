import type { Entity } from "@crossengin/types/meta-schema";

const AUDITABLE = ["auditable"] as const;

export const DEPARTMENT_ENTITY: Entity = {
  name: "Department",
  traits: [...AUDITABLE],
  fields: [
    { name: "dept_code", type: { kind: "text", maxLength: 32 }, required: true, unique: true },
    { name: "name", type: { kind: "text", maxLength: 200 }, required: true, indexed: true },
    { name: "parent_department_id", type: { kind: "reference", target: "Department" }, indexed: true },
    { name: "manager_id", type: { kind: "reference", target: "Employee" }, indexed: true },
    { name: "cost_center", type: { kind: "text", maxLength: 64 } },
    {
      name: "status",
      type: { kind: "enum", values: ["active", "inactive"] },
      required: true,
      default: { kind: "literal", value: "active" },
    },
  ],
  indexes: [{ fields: ["status"] }],
};

export const POSITION_ENTITY: Entity = {
  name: "Position",
  traits: [...AUDITABLE],
  fields: [
    { name: "code", type: { kind: "text", maxLength: 32 }, required: true, unique: true },
    { name: "title", type: { kind: "text", maxLength: 200 }, required: true, indexed: true },
    { name: "department_id", type: { kind: "reference", target: "Department" }, required: true, indexed: true },
    {
      name: "job_grade",
      type: { kind: "enum", values: ["intern", "junior", "mid", "senior", "lead", "manager", "director", "executive"] },
      required: true,
      default: { kind: "literal", value: "mid" },
    },
    { name: "headcount", type: { kind: "integer", min: 0 }, required: true, default: { kind: "literal", value: 1 } },
    {
      name: "status",
      type: { kind: "enum", values: ["open", "filled", "frozen", "closed"] },
      required: true,
      default: { kind: "literal", value: "open" },
      indexed: true,
    },
  ],
  indexes: [{ fields: ["department_id", "status"] }],
};

export const EMPLOYEE_ENTITY: Entity = {
  name: "Employee",
  traits: [...AUDITABLE],
  fields: [
    { name: "employee_number", type: { kind: "text", maxLength: 32 }, required: true, unique: true },
    { name: "given_name", type: { kind: "text", maxLength: 100 }, required: true },
    { name: "family_name", type: { kind: "text", maxLength: 100 }, required: true, indexed: true },
    { name: "work_email", type: { kind: "email" }, required: true, classification: "pii" },
    { name: "personal_email", type: { kind: "email" }, classification: "pii" },
    { name: "phone", type: { kind: "phone" }, classification: "pii" },
    { name: "national_id", type: { kind: "text", maxLength: 64 }, classification: "pii" },
    { name: "date_of_birth", type: { kind: "date" }, classification: "pii" },
    { name: "department_id", type: { kind: "reference", target: "Department" }, indexed: true },
    { name: "position_id", type: { kind: "reference", target: "Position" }, indexed: true },
    { name: "manager_id", type: { kind: "reference", target: "Employee" }, indexed: true },
    { name: "hire_date", type: { kind: "date" }, required: true, indexed: true },
    {
      name: "employment_type",
      type: { kind: "enum", values: ["full_time", "part_time", "contractor", "intern", "temporary"] },
      required: true,
      default: { kind: "literal", value: "full_time" },
    },
    {
      name: "status",
      type: { kind: "enum", values: ["active", "on_leave", "suspended", "terminated"] },
      required: true,
      default: { kind: "literal", value: "active" },
      indexed: true,
    },
    {
      name: "annual_salary",
      type: { kind: "decimal", precision: 14, scale: 2, min: 0 },
      classification: "commercial_sensitive",
    },
    { name: "currency", type: { kind: "text", maxLength: 3 }, required: true, default: { kind: "literal", value: "USD" } },
  ],
  indexes: [{ fields: ["status"] }, { fields: ["department_id", "status"] }],
};

export const LEAVE_REQUEST_ENTITY: Entity = {
  name: "LeaveRequest",
  traits: [...AUDITABLE],
  fields: [
    { name: "request_number", type: { kind: "text", maxLength: 50 }, required: true, unique: true },
    { name: "employee_id", type: { kind: "reference", target: "Employee" }, required: true, indexed: true },
    {
      name: "leave_type",
      type: { kind: "enum", values: ["annual", "sick", "unpaid", "parental", "bereavement", "study"] },
      required: true,
      default: { kind: "literal", value: "annual" },
    },
    { name: "start_date", type: { kind: "date" }, required: true, indexed: true },
    { name: "end_date", type: { kind: "date" }, required: true },
    { name: "days", type: { kind: "decimal", precision: 5, scale: 1, min: 0 }, required: true },
    {
      name: "state",
      type: { kind: "enum", values: ["draft", "submitted", "approved", "rejected", "cancelled"] },
      required: true,
      default: { kind: "literal", value: "draft" },
      indexed: true,
    },
    { name: "reason", type: { kind: "long_text" } },
  ],
  indexes: [{ fields: ["employee_id", "state"] }],
};

export const ERP_CORE_HR_ENTITIES: readonly Entity[] = [
  DEPARTMENT_ENTITY,
  POSITION_ENTITY,
  EMPLOYEE_ENTITY,
  LEAVE_REQUEST_ENTITY,
];
