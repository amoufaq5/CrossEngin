import type { Entity } from "@crossengin/types/meta-schema";

const PACK_TRAITS = ["auditable", "tenant_owned"] as const;

export const SEX_ASSIGNED_AT_BIRTH = [
  "female",
  "male",
  "intersex",
  "unknown",
] as const;

export const BLOOD_TYPES = [
  "a_pos",
  "a_neg",
  "b_pos",
  "b_neg",
  "ab_pos",
  "ab_neg",
  "o_pos",
  "o_neg",
  "unknown",
] as const;

export const ENCOUNTER_CLASSES = [
  "ambulatory",
  "emergency",
  "inpatient",
  "telephone",
  "virtual",
  "home",
] as const;

export const ENCOUNTER_STATES = [
  "scheduled",
  "checked_in",
  "in_progress",
  "completed",
  "cancelled",
  "no_show",
] as const;

export const OBSERVATION_CODE_SYSTEMS = [
  "loinc",
  "snomed_ct",
  "icd10",
  "custom",
] as const;

export const OBSERVATION_STATUSES = [
  "preliminary",
  "final",
  "amended",
  "entered_in_error",
] as const;

export const PATIENT_ENTITY: Entity = {
  name: "Patient",
  traits: [...PACK_TRAITS],
  fields: [
    {
      name: "account_id",
      type: { kind: "reference", target: "Account" },
      required: true,
      indexed: true,
    },
    {
      name: "contact_id",
      type: { kind: "reference", target: "Contact" },
      required: true,
      indexed: true,
    },
    {
      name: "mrn",
      type: { kind: "text", maxLength: 64 },
      required: true,
      unique: { scope: ["account_id"] },
      indexed: true,
    },
    {
      name: "date_of_birth",
      type: { kind: "date" },
      required: true,
    },
    {
      name: "sex_assigned_at_birth",
      type: { kind: "enum", values: [...SEX_ASSIGNED_AT_BIRTH] },
      required: true,
      default: { kind: "literal", value: "unknown" },
    },
    {
      name: "gender_identity",
      type: { kind: "text", maxLength: 100 },
    },
    {
      name: "preferred_language",
      type: { kind: "language_code" },
    },
    {
      name: "blood_type",
      type: { kind: "enum", values: [...BLOOD_TYPES] },
    },
    {
      name: "allergies",
      type: { kind: "long_text" },
    },
    {
      name: "emergency_contact_name",
      type: { kind: "text", maxLength: 200 },
    },
    {
      name: "emergency_contact_phone",
      type: { kind: "phone" },
    },
    {
      name: "active",
      type: { kind: "boolean" },
      required: true,
      default: { kind: "literal", value: true },
      indexed: true,
    },
  ],
  indexes: [{ fields: ["account_id", "active"] }],
};

export const ENCOUNTER_ENTITY: Entity = {
  name: "Encounter",
  traits: [...PACK_TRAITS],
  fields: [
    {
      name: "patient_id",
      type: { kind: "reference", target: "Patient" },
      required: true,
      indexed: true,
    },
    {
      name: "encounter_class",
      type: { kind: "enum", values: [...ENCOUNTER_CLASSES] },
      required: true,
      default: { kind: "literal", value: "ambulatory" },
    },
    {
      name: "state",
      type: { kind: "enum", values: [...ENCOUNTER_STATES] },
      required: true,
      default: { kind: "literal", value: "scheduled" },
      indexed: true,
    },
    {
      name: "scheduled_at",
      type: { kind: "datetime" },
      required: true,
      indexed: true,
    },
    {
      name: "started_at",
      type: { kind: "datetime" },
    },
    {
      name: "ended_at",
      type: { kind: "datetime" },
    },
    {
      name: "reason_code",
      type: { kind: "text", maxLength: 200 },
    },
    {
      name: "provider_name",
      type: { kind: "text", maxLength: 200 },
    },
    {
      name: "location",
      type: { kind: "text", maxLength: 200 },
    },
    {
      name: "notes",
      type: { kind: "long_text" },
    },
  ],
  indexes: [{ fields: ["patient_id", "state"] }, { fields: ["state", "scheduled_at"] }],
};

export const OBSERVATION_ENTITY: Entity = {
  name: "Observation",
  traits: [...PACK_TRAITS],
  fields: [
    {
      name: "encounter_id",
      type: { kind: "reference", target: "Encounter" },
      required: true,
      indexed: true,
    },
    {
      name: "patient_id",
      type: { kind: "reference", target: "Patient" },
      required: true,
      indexed: true,
    },
    {
      name: "code_system",
      type: { kind: "enum", values: [...OBSERVATION_CODE_SYSTEMS] },
      required: true,
      default: { kind: "literal", value: "loinc" },
    },
    {
      name: "code",
      type: { kind: "text", maxLength: 50 },
      required: true,
      indexed: true,
    },
    {
      name: "display_label",
      type: { kind: "text", maxLength: 200 },
      required: true,
    },
    {
      name: "value_quantity",
      type: { kind: "decimal", precision: 18, scale: 6 },
    },
    {
      name: "unit",
      type: { kind: "text", maxLength: 50 },
    },
    {
      name: "value_string",
      type: { kind: "long_text" },
    },
    {
      name: "recorded_at",
      type: { kind: "datetime" },
      required: true,
    },
    {
      name: "status",
      type: { kind: "enum", values: [...OBSERVATION_STATUSES] },
      required: true,
      default: { kind: "literal", value: "preliminary" },
      indexed: true,
    },
    {
      name: "recorded_by",
      type: { kind: "text", maxLength: 200 },
    },
  ],
  indexes: [{ fields: ["patient_id", "code"] }, { fields: ["encounter_id", "recorded_at"] }],
};

export const ERP_HEALTHCARE_ENTITIES: readonly Entity[] = [
  PATIENT_ENTITY,
  ENCOUNTER_ENTITY,
  OBSERVATION_ENTITY,
];
