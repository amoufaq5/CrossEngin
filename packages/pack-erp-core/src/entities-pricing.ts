import type { Entity } from "@crossengin/types/meta-schema";

const AUDITABLE = ["auditable"] as const;

export const TAX_CODE_ENTITY: Entity = {
  name: "TaxCode",
  traits: [...AUDITABLE],
  fields: [
    { name: "code", type: { kind: "text", maxLength: 32 }, required: true, unique: true, indexed: true },
    { name: "name", type: { kind: "text", maxLength: 200 }, required: true },
    { name: "rate_pct", type: { kind: "decimal", precision: 6, scale: 3, min: 0, max: 100 }, required: true, default: { kind: "literal", value: 0 } },
    {
      name: "kind",
      type: { kind: "enum", values: ["sales", "purchase", "vat", "gst", "withholding", "exempt"] },
      required: true,
      default: { kind: "literal", value: "sales" },
    },
    { name: "jurisdiction", type: { kind: "text", maxLength: 120 } },
    // Optional GL liability/asset account this code's tax posts to (a LedgerAccount
    // account_code). When set, recognition posts this code's tax line to that account
    // instead of the document's default tax-payable / tax-input account.
    { name: "gl_account_code", type: { kind: "text", maxLength: 32 } },
    { name: "is_active", type: { kind: "boolean" }, required: true, default: { kind: "literal", value: true } },
  ],
  indexes: [{ fields: ["kind", "is_active"] }],
};

export const PRICE_LIST_ENTITY: Entity = {
  name: "PriceList",
  traits: [...AUDITABLE],
  fields: [
    { name: "code", type: { kind: "text", maxLength: 32 }, required: true, unique: true, indexed: true },
    { name: "name", type: { kind: "text", maxLength: 200 }, required: true },
    { name: "currency", type: { kind: "text", maxLength: 3 }, required: true, default: { kind: "literal", value: "USD" } },
    { name: "valid_from", type: { kind: "date" } },
    { name: "valid_to", type: { kind: "date" } },
    { name: "is_active", type: { kind: "boolean" }, required: true, default: { kind: "literal", value: true } },
  ],
  indexes: [{ fields: ["is_active"] }],
};

export const PRICE_LIST_ITEM_ENTITY: Entity = {
  name: "PriceListItem",
  traits: [...AUDITABLE],
  fields: [
    { name: "price_list_id", type: { kind: "reference", target: "PriceList" }, required: true, indexed: true },
    { name: "item_id", type: { kind: "reference", target: "Item" }, required: true, indexed: true },
    { name: "unit_price", type: { kind: "decimal", precision: 14, scale: 4, min: 0 }, required: true },
    { name: "min_quantity", type: { kind: "decimal", precision: 16, scale: 3, min: 0 }, required: true, default: { kind: "literal", value: 1 } },
  ],
  indexes: [{ fields: ["price_list_id", "item_id"] }],
};

export const ERP_CORE_PRICING_ENTITIES: readonly Entity[] = [
  TAX_CODE_ENTITY,
  PRICE_LIST_ENTITY,
  PRICE_LIST_ITEM_ENTITY,
];
