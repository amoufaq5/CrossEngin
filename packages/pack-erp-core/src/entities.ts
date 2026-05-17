import type { Entity } from "@crossengin/types/meta-schema";

const AUDITABLE = ["auditable"] as const;

export const ACCOUNT_ENTITY: Entity = {
  name: "Account",
  traits: [...AUDITABLE],
  fields: [
    {
      name: "name",
      type: { kind: "text", maxLength: 200 },
      required: true,
      indexed: true,
    },
    { name: "legal_name", type: { kind: "text", maxLength: 200 } },
    {
      name: "status",
      type: {
        kind: "enum",
        values: ["prospect", "active", "suspended", "churned"],
      },
      required: true,
      default: { kind: "literal", value: "prospect" },
      indexed: true,
    },
    { name: "industry", type: { kind: "text", maxLength: 100 } },
    { name: "website", type: { kind: "url" } },
    { name: "billing_email", type: { kind: "email" }, required: true },
    { name: "country", type: { kind: "country_code" } },
  ],
  indexes: [{ fields: ["status"] }, { fields: ["name"] }],
};

export const CONTACT_ENTITY: Entity = {
  name: "Contact",
  traits: [...AUDITABLE],
  fields: [
    {
      name: "account_id",
      type: { kind: "reference", target: "Account" },
      required: true,
      indexed: true,
    },
    {
      name: "given_name",
      type: { kind: "text", maxLength: 100 },
      required: true,
    },
    {
      name: "family_name",
      type: { kind: "text", maxLength: 100 },
      required: true,
    },
    { name: "title", type: { kind: "text", maxLength: 100 } },
    { name: "email", type: { kind: "email" }, required: true, indexed: true },
    { name: "phone", type: { kind: "phone" } },
    {
      name: "is_primary",
      type: { kind: "boolean" },
      required: true,
      default: { kind: "literal", value: false },
    },
  ],
  indexes: [{ fields: ["account_id", "is_primary"] }],
};

export const INVOICE_ENTITY: Entity = {
  name: "Invoice",
  traits: [...AUDITABLE],
  fields: [
    {
      name: "account_id",
      type: { kind: "reference", target: "Account" },
      required: true,
      indexed: true,
    },
    {
      name: "invoice_number",
      type: { kind: "text", maxLength: 50 },
      required: true,
      unique: true,
    },
    {
      name: "state",
      type: {
        kind: "enum",
        values: ["draft", "sent", "paid", "overdue", "void"],
      },
      required: true,
      default: { kind: "literal", value: "draft" },
      indexed: true,
    },
    { name: "currency", type: { kind: "text", maxLength: 3 }, required: true },
    {
      name: "subtotal",
      type: { kind: "decimal", precision: 14, scale: 2, min: 0 },
      required: true,
      default: { kind: "literal", value: 0 },
    },
    {
      name: "tax_total",
      type: { kind: "decimal", precision: 14, scale: 2, min: 0 },
      required: true,
      default: { kind: "literal", value: 0 },
    },
    {
      name: "total",
      type: { kind: "decimal", precision: 14, scale: 2, min: 0 },
      required: true,
      default: { kind: "literal", value: 0 },
    },
    { name: "issue_date", type: { kind: "date" }, required: true },
    { name: "due_date", type: { kind: "date" }, required: true, indexed: true },
    { name: "sent_at", type: { kind: "datetime" } },
    { name: "paid_at", type: { kind: "datetime" } },
    { name: "notes", type: { kind: "long_text" } },
  ],
  indexes: [{ fields: ["state", "due_date"] }],
};

export const INVOICE_LINE_ENTITY: Entity = {
  name: "InvoiceLine",
  traits: [...AUDITABLE],
  fields: [
    {
      name: "invoice_id",
      type: { kind: "reference", target: "Invoice" },
      required: true,
      indexed: true,
    },
    { name: "position", type: { kind: "integer", min: 0 }, required: true },
    {
      name: "description",
      type: { kind: "text", maxLength: 500 },
      required: true,
    },
    {
      name: "quantity",
      type: { kind: "decimal", precision: 12, scale: 4, min: 0 },
      required: true,
    },
    {
      name: "unit_price",
      type: { kind: "decimal", precision: 14, scale: 4, min: 0 },
      required: true,
    },
    {
      name: "tax_rate_pct",
      type: { kind: "decimal", precision: 5, scale: 2, min: 0, max: 100 },
      required: true,
      default: { kind: "literal", value: 0 },
    },
    {
      name: "line_total",
      type: { kind: "decimal", precision: 14, scale: 2, min: 0 },
      required: true,
    },
  ],
};

export const ERP_CORE_ENTITIES: readonly Entity[] = [
  ACCOUNT_ENTITY,
  CONTACT_ENTITY,
  INVOICE_ENTITY,
  INVOICE_LINE_ENTITY,
];
