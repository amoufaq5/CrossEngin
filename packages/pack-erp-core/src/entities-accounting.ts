import type { Entity } from "@crossengin/types/meta-schema";

const AUDITABLE = ["auditable"] as const;

// ---- Multi-currency (IAS 21) -------------------------------------------------

export const CURRENCY_ENTITY: Entity = {
  name: "Currency",
  traits: [...AUDITABLE],
  fields: [
    { name: "code", type: { kind: "text", maxLength: 3 }, required: true, unique: true, indexed: true },
    { name: "name", type: { kind: "text", maxLength: 80 }, required: true },
    { name: "symbol", type: { kind: "text", maxLength: 8 } },
    { name: "decimal_places", type: { kind: "integer", min: 0, max: 6 }, required: true, default: { kind: "literal", value: 2 } },
    { name: "is_active", type: { kind: "boolean" }, required: true, default: { kind: "literal", value: true } },
  ],
  indexes: [{ fields: ["is_active"] }],
};

export const EXCHANGE_RATE_ENTITY: Entity = {
  name: "ExchangeRate",
  traits: [...AUDITABLE],
  fields: [
    { name: "from_currency_id", type: { kind: "reference", target: "Currency" }, required: true, indexed: true },
    { name: "to_currency_id", type: { kind: "reference", target: "Currency" }, required: true, indexed: true },
    {
      name: "rate_type",
      type: { kind: "enum", values: ["spot", "average", "closing", "historical"] },
      required: true,
      default: { kind: "literal", value: "spot" },
      indexed: true,
    },
    { name: "rate_date", type: { kind: "date" }, required: true, indexed: true },
    { name: "rate", type: { kind: "decimal", precision: 20, scale: 10, min: 0 }, required: true },
    {
      name: "source",
      type: { kind: "enum", values: ["manual", "ecb", "central_bank", "provider"] },
      required: true,
      default: { kind: "literal", value: "manual" },
    },
  ],
  indexes: [{ fields: ["from_currency_id", "to_currency_id", "rate_type", "rate_date"] }],
};

// ---- Fiscal calendar + period close -----------------------------------------

export const FISCAL_YEAR_ENTITY: Entity = {
  name: "FiscalYear",
  traits: [...AUDITABLE],
  fields: [
    { name: "code", type: { kind: "text", maxLength: 16 }, required: true, unique: true, indexed: true },
    { name: "name", type: { kind: "text", maxLength: 80 }, required: true },
    { name: "start_date", type: { kind: "date" }, required: true },
    { name: "end_date", type: { kind: "date" }, required: true },
    {
      name: "status",
      type: { kind: "enum", values: ["open", "closed", "permanently_closed"] },
      required: true,
      default: { kind: "literal", value: "open" },
      indexed: true,
    },
  ],
  indexes: [{ fields: ["status"] }],
};

export const FISCAL_PERIOD_ENTITY: Entity = {
  name: "FiscalPeriod",
  traits: [...AUDITABLE],
  fields: [
    { name: "fiscal_year_id", type: { kind: "reference", target: "FiscalYear" }, required: true, indexed: true },
    { name: "period_number", type: { kind: "integer", min: 0, max: 13 }, required: true },
    { name: "name", type: { kind: "text", maxLength: 40 }, required: true },
    { name: "start_date", type: { kind: "date" }, required: true },
    { name: "end_date", type: { kind: "date" }, required: true },
    {
      name: "status",
      type: { kind: "enum", values: ["open", "closing", "closed", "locked"] },
      required: true,
      default: { kind: "literal", value: "open" },
      indexed: true,
    },
    { name: "is_adjustment", type: { kind: "boolean" }, required: true, default: { kind: "literal", value: false } },
    { name: "closed_at", type: { kind: "datetime" } },
  ],
  indexes: [{ fields: ["fiscal_year_id", "period_number"] }, { fields: ["status"] }],
};

// ---- Parallel accounting (IFRS / local GAAP / tax books) ---------------------

export const ACCOUNTING_BOOK_ENTITY: Entity = {
  name: "AccountingBook",
  traits: [...AUDITABLE],
  fields: [
    { name: "code", type: { kind: "text", maxLength: 16 }, required: true, unique: true, indexed: true },
    { name: "name", type: { kind: "text", maxLength: 120 }, required: true },
    {
      name: "accounting_standard",
      type: { kind: "enum", values: ["ifrs", "us_gaap", "local_gaap", "tax", "management"] },
      required: true,
      default: { kind: "literal", value: "ifrs" },
      indexed: true,
    },
    { name: "functional_currency", type: { kind: "text", maxLength: 3 }, required: true, default: { kind: "literal", value: "USD" } },
    { name: "country", type: { kind: "country_code" } },
    { name: "is_primary", type: { kind: "boolean" }, required: true, default: { kind: "literal", value: false } },
    { name: "is_active", type: { kind: "boolean" }, required: true, default: { kind: "literal", value: true } },
  ],
  indexes: [{ fields: ["accounting_standard", "is_active"] }],
};

export const COST_CENTER_ENTITY: Entity = {
  name: "CostCenter",
  traits: [...AUDITABLE],
  fields: [
    { name: "code", type: { kind: "text", maxLength: 32 }, required: true, unique: true, indexed: true },
    { name: "name", type: { kind: "text", maxLength: 160 }, required: true },
    { name: "parent_id", type: { kind: "reference", target: "CostCenter" }, indexed: true },
    { name: "manager_id", type: { kind: "reference", target: "Employee" }, indexed: true },
    {
      name: "segment",
      type: { kind: "enum", values: ["operating", "geographic", "product", "service", "other"] },
      required: true,
      default: { kind: "literal", value: "operating" },
    },
    { name: "is_active", type: { kind: "boolean" }, required: true, default: { kind: "literal", value: true } },
  ],
  indexes: [{ fields: ["is_active"] }],
};

// ---- Country tax rules + filing ----------------------------------------------

export const TAX_JURISDICTION_ENTITY: Entity = {
  name: "TaxJurisdiction",
  traits: [...AUDITABLE],
  fields: [
    { name: "code", type: { kind: "text", maxLength: 32 }, required: true, unique: true, indexed: true },
    { name: "name", type: { kind: "text", maxLength: 160 }, required: true },
    { name: "country", type: { kind: "country_code" }, required: true, indexed: true },
    { name: "region", type: { kind: "text", maxLength: 80 } },
    {
      name: "tax_regime",
      type: { kind: "enum", values: ["vat", "gst", "sales_tax", "consumption_tax", "none"] },
      required: true,
      default: { kind: "literal", value: "vat" },
      indexed: true,
    },
    { name: "registration_number", type: { kind: "text", maxLength: 64 }, classification: "commercial_sensitive" },
    { name: "filing_currency", type: { kind: "text", maxLength: 3 }, required: true, default: { kind: "literal", value: "USD" } },
    { name: "is_active", type: { kind: "boolean" }, required: true, default: { kind: "literal", value: true } },
  ],
  indexes: [{ fields: ["country", "is_active"] }],
};

export const TAX_RULE_ENTITY: Entity = {
  name: "TaxRule",
  traits: [...AUDITABLE],
  fields: [
    { name: "jurisdiction_id", type: { kind: "reference", target: "TaxJurisdiction" }, required: true, indexed: true },
    { name: "tax_code_id", type: { kind: "reference", target: "TaxCode" }, required: true, indexed: true },
    { name: "name", type: { kind: "text", maxLength: 160 }, required: true },
    {
      name: "applies_to",
      type: { kind: "enum", values: ["sales", "purchase", "both"] },
      required: true,
      default: { kind: "literal", value: "sales" },
      indexed: true,
    },
    {
      name: "rate_category",
      type: { kind: "enum", values: ["standard", "reduced", "super_reduced", "zero", "exempt"] },
      required: true,
      default: { kind: "literal", value: "standard" },
    },
    { name: "rate_pct", type: { kind: "decimal", precision: 6, scale: 3, min: 0, max: 100 }, required: true, default: { kind: "literal", value: 0 } },
    { name: "is_compound", type: { kind: "boolean" }, required: true, default: { kind: "literal", value: false } },
    { name: "reverse_charge", type: { kind: "boolean" }, required: true, default: { kind: "literal", value: false } },
    { name: "priority", type: { kind: "integer", min: 0, max: 1000 }, required: true, default: { kind: "literal", value: 100 } },
    { name: "effective_from", type: { kind: "date" }, required: true, indexed: true },
    { name: "effective_to", type: { kind: "date" } },
  ],
  indexes: [{ fields: ["jurisdiction_id", "applies_to", "effective_from"] }],
};

export const TAX_RETURN_ENTITY: Entity = {
  name: "TaxReturn",
  traits: [...AUDITABLE],
  fields: [
    {
      name: "return_number",
      type: { kind: "text", maxLength: 50 },
      required: true,
      unique: true,
      default: { kind: "sequence", sequence: "erp.tax_return", format: "TAX-{YYYY}-{SEQ:5}", resetPeriod: "yearly" },
    },
    { name: "jurisdiction_id", type: { kind: "reference", target: "TaxJurisdiction" }, required: true, indexed: true },
    { name: "fiscal_period_id", type: { kind: "reference", target: "FiscalPeriod" }, required: true, indexed: true },
    {
      name: "return_type",
      type: { kind: "enum", values: ["vat", "gst", "sales_tax", "withholding", "consumption_tax"] },
      required: true,
      default: { kind: "literal", value: "vat" },
    },
    { name: "period_start", type: { kind: "date" }, required: true },
    { name: "period_end", type: { kind: "date" }, required: true },
    { name: "output_tax", type: { kind: "decimal", precision: 16, scale: 2, min: 0 }, required: true, default: { kind: "literal", value: 0 } },
    { name: "input_tax", type: { kind: "decimal", precision: 16, scale: 2, min: 0 }, required: true, default: { kind: "literal", value: 0 } },
    { name: "net_payable", type: { kind: "decimal", precision: 16, scale: 2 }, required: true, default: { kind: "literal", value: 0 } },
    { name: "currency", type: { kind: "text", maxLength: 3 }, required: true, default: { kind: "literal", value: "USD" } },
    {
      name: "state",
      type: { kind: "enum", values: ["draft", "ready", "filed", "paid", "amended"] },
      required: true,
      default: { kind: "literal", value: "draft" },
      indexed: true,
    },
    { name: "filed_at", type: { kind: "datetime" } },
    { name: "filing_reference", type: { kind: "text", maxLength: 120 } },
  ],
  indexes: [{ fields: ["jurisdiction_id", "state"] }, { fields: ["fiscal_period_id"] }],
};

export const ERP_CORE_ACCOUNTING_ENTITIES: readonly Entity[] = [
  CURRENCY_ENTITY,
  EXCHANGE_RATE_ENTITY,
  FISCAL_YEAR_ENTITY,
  FISCAL_PERIOD_ENTITY,
  ACCOUNTING_BOOK_ENTITY,
  COST_CENTER_ENTITY,
  TAX_JURISDICTION_ENTITY,
  TAX_RULE_ENTITY,
  TAX_RETURN_ENTITY,
];
