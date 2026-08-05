import type { Entity } from "@crossengin/types/meta-schema";

const AUDITABLE = ["auditable"] as const;

export const CITIZEN_ENTITY: Entity = {
  name: "Citizen",
  traits: [...AUDITABLE],
  fields: [
    {
      name: "account_id",
      type: { kind: "reference", target: "Account" },
      required: true,
      indexed: true,
    },
    {
      name: "full_name",
      type: { kind: "text", maxLength: 200 },
      required: true,
      indexed: true,
    },
    {
      name: "national_id",
      type: { kind: "text", maxLength: 64 },
      required: true,
      unique: true,
      // A government identifier under statutory protection — redacted by
      // default from anyone lacking an explicit grant.
      classification: "regulated",
    },
    { name: "contact_email", type: { kind: "email" }, classification: "pii" },
    { name: "contact_phone", type: { kind: "phone" }, classification: "pii" },
    { name: "mailing_address", type: { kind: "text", maxLength: 500 } },
    {
      name: "status",
      type: { kind: "enum", values: ["active", "inactive"] },
      required: true,
      default: { kind: "literal", value: "active" },
      indexed: true,
    },
  ],
  indexes: [{ fields: ["account_id", "status"] }, { fields: ["full_name"] }],
};

export const CASE_ENTITY: Entity = {
  name: "Case",
  traits: [...AUDITABLE],
  fields: [
    {
      name: "citizen_id",
      type: { kind: "reference", target: "Citizen" },
      required: true,
      indexed: true,
    },
    {
      name: "case_number",
      type: { kind: "text", maxLength: 50 },
      required: true,
      unique: true,
    },
    {
      name: "category",
      type: {
        kind: "enum",
        values: ["benefits", "licensing", "housing", "tax", "other"],
      },
      required: true,
      default: { kind: "literal", value: "other" },
      indexed: true,
    },
    { name: "summary", type: { kind: "long_text" }, required: true },
    {
      name: "state",
      type: {
        kind: "enum",
        values: ["intake", "under_review", "approved", "denied", "closed"],
      },
      required: true,
      default: { kind: "literal", value: "intake" },
      indexed: true,
    },
    { name: "opened_at", type: { kind: "datetime" }, required: true, indexed: true },
    { name: "sla_due_at", type: { kind: "datetime" } },
  ],
  indexes: [{ fields: ["state", "opened_at"] }],
};

export const PERMIT_ENTITY: Entity = {
  name: "Permit",
  traits: [...AUDITABLE],
  fields: [
    {
      name: "citizen_id",
      type: { kind: "reference", target: "Citizen" },
      required: true,
      indexed: true,
    },
    {
      name: "permit_number",
      type: { kind: "text", maxLength: 50 },
      required: true,
      unique: true,
    },
    {
      name: "permit_type",
      type: {
        kind: "enum",
        values: ["building", "business", "vehicle", "event", "other"],
      },
      required: true,
      default: { kind: "literal", value: "other" },
      indexed: true,
    },
    {
      name: "fee_amount",
      type: { kind: "decimal", precision: 12, scale: 2, min: 0 },
      required: true,
      // The assessed fee is treated as commercial-sensitive revenue data.
      classification: "commercial_sensitive",
    },
    {
      name: "status",
      type: { kind: "enum", values: ["issued", "expired", "revoked"] },
      required: true,
      default: { kind: "literal", value: "issued" },
      indexed: true,
    },
    { name: "issued_at", type: { kind: "datetime" }, required: true },
    { name: "expires_at", type: { kind: "datetime" }, indexed: true },
  ],
  indexes: [{ fields: ["permit_type", "status"] }],
};

const GOVERNMENT_MODULES: Readonly<Record<string, string>> = {
  Citizen: "Constituent Services",
  Case: "Case Management",
  Permit: "Licensing & Permits",
};

export const ERP_GOVERNMENT_ENTITIES: readonly Entity[] = [
  CITIZEN_ENTITY,
  CASE_ENTITY,
  PERMIT_ENTITY,
].map((e) =>
  GOVERNMENT_MODULES[e.name] !== undefined ? { ...e, module: GOVERNMENT_MODULES[e.name] } : e,
);
