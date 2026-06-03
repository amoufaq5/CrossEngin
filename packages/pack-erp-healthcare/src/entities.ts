import type { Entity } from "@crossengin/types/meta-schema";

const AUDITABLE = ["auditable"] as const;

export const PATIENT_ENTITY: Entity = {
  name: "Patient",
  traits: [...AUDITABLE],
  fields: [
    {
      name: "account_id",
      type: { kind: "reference", target: "Account" },
      required: true,
      indexed: true,
    },
    {
      name: "mrn",
      type: { kind: "text", maxLength: 32 },
      required: true,
      unique: true,
    },
    { name: "given_name", type: { kind: "text", maxLength: 100 }, required: true },
    { name: "family_name", type: { kind: "text", maxLength: 100 }, required: true },
    { name: "date_of_birth", type: { kind: "date" }, required: true },
    {
      name: "sex",
      type: { kind: "enum", values: ["female", "male", "other", "unknown"] },
      required: true,
      default: { kind: "literal", value: "unknown" },
    },
    { name: "email", type: { kind: "email" } },
    { name: "phone", type: { kind: "phone" } },
    {
      name: "status",
      type: { kind: "enum", values: ["active", "inactive", "deceased"] },
      required: true,
      default: { kind: "literal", value: "active" },
      indexed: true,
    },
  ],
  indexes: [{ fields: ["account_id", "status"] }, { fields: ["family_name"] }],
};

export const ENCOUNTER_ENTITY: Entity = {
  name: "Encounter",
  traits: [...AUDITABLE],
  fields: [
    {
      name: "patient_id",
      type: { kind: "reference", target: "Patient" },
      required: true,
      indexed: true,
    },
    {
      name: "invoice_id",
      type: { kind: "reference", target: "Invoice" },
      indexed: true,
    },
    {
      name: "encounter_number",
      type: { kind: "text", maxLength: 50 },
      required: true,
      unique: true,
    },
    {
      name: "state",
      type: {
        kind: "enum",
        values: ["scheduled", "in_progress", "completed", "cancelled", "no_show"],
      },
      required: true,
      default: { kind: "literal", value: "scheduled" },
      indexed: true,
    },
    {
      name: "encounter_type",
      type: {
        kind: "enum",
        values: ["office_visit", "telehealth", "inpatient", "emergency"],
      },
      required: true,
      default: { kind: "literal", value: "office_visit" },
    },
    { name: "scheduled_at", type: { kind: "datetime" }, required: true, indexed: true },
    { name: "started_at", type: { kind: "datetime" } },
    { name: "ended_at", type: { kind: "datetime" } },
    { name: "provider_name", type: { kind: "text", maxLength: 200 } },
    { name: "chief_complaint", type: { kind: "long_text" } },
  ],
  indexes: [{ fields: ["state", "scheduled_at"] }],
};

export const OBSERVATION_ENTITY: Entity = {
  name: "Observation",
  traits: [...AUDITABLE],
  fields: [
    {
      name: "encounter_id",
      type: { kind: "reference", target: "Encounter" },
      required: true,
      indexed: true,
    },
    {
      name: "category",
      type: {
        kind: "enum",
        values: ["vital_signs", "laboratory", "imaging", "exam"],
      },
      required: true,
      indexed: true,
    },
    { name: "code", type: { kind: "text", maxLength: 64 }, required: true },
    { name: "display", type: { kind: "text", maxLength: 200 } },
    { name: "value_quantity", type: { kind: "decimal", precision: 14, scale: 4 } },
    { name: "value_unit", type: { kind: "text", maxLength: 32 } },
    { name: "value_text", type: { kind: "long_text" } },
    {
      name: "status",
      type: {
        kind: "enum",
        values: ["registered", "preliminary", "final", "amended"],
      },
      required: true,
      default: { kind: "literal", value: "final" },
    },
    { name: "effective_at", type: { kind: "datetime" }, required: true },
  ],
  indexes: [{ fields: ["encounter_id", "category"] }],
};

export const ERP_HEALTHCARE_ENTITIES: readonly Entity[] = [
  PATIENT_ENTITY,
  ENCOUNTER_ENTITY,
  OBSERVATION_ENTITY,
];
