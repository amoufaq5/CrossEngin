import type { Entity } from "@crossengin/types/meta-schema";

const PACK_TRAITS = ["auditable", "tenant_owned"] as const;

export const PAYMENT_PROVIDERS = [
  "stripe",
  "adyen",
  "braintree",
  "manual",
  "bank_transfer",
] as const;

export const PAYMENT_ENTITY: Entity = {
  name: "Payment",
  traits: [...PACK_TRAITS],
  fields: [
    {
      name: "invoice_id",
      type: { kind: "reference", target: "Invoice" },
      required: true,
      indexed: true,
    },
    {
      name: "state",
      type: {
        kind: "enum",
        values: ["pending", "captured", "settled", "refunded", "failed", "cancelled"],
      },
      required: true,
      default: { kind: "literal", value: "pending" },
      indexed: true,
    },
    {
      name: "amount",
      type: { kind: "decimal", precision: 14, scale: 2, min: 0 },
      required: true,
    },
    { name: "currency", type: { kind: "text", maxLength: 3 }, required: true },
    {
      name: "provider",
      type: { kind: "enum", values: [...PAYMENT_PROVIDERS] },
      required: true,
    },
    {
      name: "provider_reference",
      type: { kind: "text", maxLength: 200 },
      required: true,
      unique: { scope: ["provider"] },
    },
    { name: "captured_at", type: { kind: "datetime" } },
    { name: "settled_at", type: { kind: "datetime" } },
    { name: "refunded_at", type: { kind: "datetime" } },
    { name: "failure_code", type: { kind: "text", maxLength: 50 } },
    { name: "failure_message", type: { kind: "long_text" } },
    {
      name: "refund_amount",
      type: { kind: "decimal", precision: 14, scale: 2, min: 0 },
    },
    { name: "metadata", type: { kind: "json" } },
  ],
  indexes: [{ fields: ["invoice_id", "state"] }],
};

export const ERP_PAYMENTS_ENTITIES: readonly Entity[] = [PAYMENT_ENTITY];
