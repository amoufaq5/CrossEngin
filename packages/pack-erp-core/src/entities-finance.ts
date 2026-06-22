import type { Entity } from "@crossengin/types/meta-schema";

const AUDITABLE = ["auditable"] as const;

export const LEDGER_ACCOUNT_ENTITY: Entity = {
  name: "LedgerAccount",
  traits: [...AUDITABLE],
  fields: [
    { name: "account_code", type: { kind: "text", maxLength: 32 }, required: true, unique: true },
    { name: "name", type: { kind: "text", maxLength: 200 }, required: true, indexed: true },
    {
      name: "account_type",
      type: { kind: "enum", values: ["asset", "liability", "equity", "revenue", "expense"] },
      required: true,
      indexed: true,
    },
    { name: "currency", type: { kind: "text", maxLength: 3 }, required: true, default: { kind: "literal", value: "USD" } },
    { name: "is_postable", type: { kind: "boolean" }, required: true, default: { kind: "literal", value: true } },
    {
      name: "status",
      type: { kind: "enum", values: ["active", "archived"] },
      required: true,
      default: { kind: "literal", value: "active" },
    },
  ],
  indexes: [{ fields: ["account_type", "status"] }],
};

export const JOURNAL_ENTRY_ENTITY: Entity = {
  name: "JournalEntry",
  traits: [...AUDITABLE],
  fields: [
    {
      name: "entry_number",
      type: { kind: "text", maxLength: 50 },
      required: true,
      unique: true,
      default: { kind: "sequence", sequence: "erp.journal_entry", format: "JE-{YYYY}-{SEQ:5}", resetPeriod: "yearly" },
    },
    { name: "entry_date", type: { kind: "date" }, required: true, indexed: true },
    { name: "book_id", type: { kind: "reference", target: "AccountingBook" }, indexed: true },
    { name: "fiscal_period_id", type: { kind: "reference", target: "FiscalPeriod" }, indexed: true },
    {
      name: "source",
      type: { kind: "enum", values: ["manual", "invoice", "bill", "payment", "payroll", "fx_revaluation", "depreciation", "system"] },
      required: true,
      default: { kind: "literal", value: "manual" },
    },
    {
      name: "state",
      type: { kind: "enum", values: ["draft", "posted", "reversed"] },
      required: true,
      default: { kind: "literal", value: "draft" },
      indexed: true,
    },
    { name: "memo", type: { kind: "long_text" } },
    { name: "posted_at", type: { kind: "datetime" } },
  ],
  indexes: [{ fields: ["state", "entry_date"] }],
};

export const JOURNAL_LINE_ENTITY: Entity = {
  name: "JournalLine",
  traits: [...AUDITABLE],
  fields: [
    { name: "journal_entry_id", type: { kind: "reference", target: "JournalEntry" }, required: true, indexed: true },
    { name: "ledger_account_id", type: { kind: "reference", target: "LedgerAccount" }, required: true, indexed: true },
    { name: "cost_center_id", type: { kind: "reference", target: "CostCenter" }, indexed: true },
    { name: "description", type: { kind: "text", maxLength: 300 } },
    { name: "debit", type: { kind: "decimal", precision: 16, scale: 2, min: 0 }, required: true, default: { kind: "literal", value: 0 } },
    { name: "credit", type: { kind: "decimal", precision: 16, scale: 2, min: 0 }, required: true, default: { kind: "literal", value: 0 } },
    { name: "currency", type: { kind: "text", maxLength: 3 }, required: true, default: { kind: "literal", value: "USD" } },
    { name: "fx_rate", type: { kind: "decimal", precision: 20, scale: 10, min: 0 }, required: true, default: { kind: "literal", value: 1 } },
    { name: "functional_debit", type: { kind: "decimal", precision: 16, scale: 2, min: 0 }, required: true, default: { kind: "literal", value: 0 } },
    { name: "functional_credit", type: { kind: "decimal", precision: 16, scale: 2, min: 0 }, required: true, default: { kind: "literal", value: 0 } },
  ],
  indexes: [{ fields: ["journal_entry_id"] }, { fields: ["cost_center_id"] }],
};

export const PAYMENT_ENTITY: Entity = {
  name: "Payment",
  traits: [...AUDITABLE],
  fields: [
    {
      name: "payment_number",
      type: { kind: "text", maxLength: 50 },
      required: true,
      unique: true,
      default: { kind: "sequence", sequence: "erp.payment", format: "PAY-{YYYY}-{SEQ:5}", resetPeriod: "yearly" },
    },
    {
      name: "direction",
      type: { kind: "enum", values: ["inbound", "outbound"] },
      required: true,
      indexed: true,
    },
    {
      name: "method",
      type: { kind: "enum", values: ["bank_transfer", "card", "cash", "cheque", "ach", "wire"] },
      required: true,
      default: { kind: "literal", value: "bank_transfer" },
    },
    { name: "account_id", type: { kind: "reference", target: "Account" }, indexed: true },
    // The document this payment applies to (one of, by direction). Lets partial
    // payments accumulate against a specific invoice/bill and auto-settle it.
    { name: "invoice_id", type: { kind: "reference", target: "Invoice" }, indexed: true },
    { name: "bill_id", type: { kind: "reference", target: "Bill" }, indexed: true },
    { name: "amount", type: { kind: "decimal", precision: 16, scale: 2, min: 0 }, required: true },
    // Cash actually moved (reporting currency). When it differs from `amount`, the
    // gap is booked as realized FX gain/loss on settlement.
    { name: "cash_amount", type: { kind: "decimal", precision: 16, scale: 2, min: 0 } },
    { name: "currency", type: { kind: "text", maxLength: 3 }, required: true, default: { kind: "literal", value: "USD" } },
    {
      name: "state",
      type: { kind: "enum", values: ["draft", "pending", "completed", "failed", "refunded"] },
      required: true,
      default: { kind: "literal", value: "draft" },
      indexed: true,
    },
    { name: "paid_at", type: { kind: "datetime" } },
    { name: "reference", type: { kind: "text", maxLength: 120 } },
    { name: "bank_reference", type: { kind: "text", maxLength: 120 }, classification: "commercial_sensitive" },
  ],
  indexes: [{ fields: ["direction", "state"] }, { fields: ["account_id"] }],
};

export const EXPENSE_ENTITY: Entity = {
  name: "Expense",
  traits: [...AUDITABLE],
  fields: [
    {
      name: "expense_number",
      type: { kind: "text", maxLength: 50 },
      required: true,
      unique: true,
      default: { kind: "sequence", sequence: "erp.expense", format: "EXP-{YYYY}-{SEQ:5}", resetPeriod: "yearly" },
    },
    { name: "employee_id", type: { kind: "reference", target: "Employee" }, required: true, indexed: true },
    {
      name: "category",
      type: { kind: "enum", values: ["travel", "meals", "lodging", "supplies", "software", "training", "other"] },
      required: true,
      default: { kind: "literal", value: "other" },
    },
    { name: "amount", type: { kind: "decimal", precision: 14, scale: 2, min: 0 }, required: true },
    { name: "currency", type: { kind: "text", maxLength: 3 }, required: true, default: { kind: "literal", value: "USD" } },
    {
      name: "state",
      type: { kind: "enum", values: ["draft", "submitted", "approved", "reimbursed", "rejected"] },
      required: true,
      default: { kind: "literal", value: "draft" },
      indexed: true,
    },
    { name: "incurred_on", type: { kind: "date" }, required: true, indexed: true },
    { name: "description", type: { kind: "long_text" } },
    { name: "receipt", type: { kind: "file" } },
  ],
  indexes: [{ fields: ["employee_id", "state"] }],
};

export const BILL_ENTITY: Entity = {
  name: "Bill",
  traits: [...AUDITABLE],
  fields: [
    {
      name: "bill_number",
      type: { kind: "text", maxLength: 50 },
      required: true,
      unique: true,
      default: { kind: "sequence", sequence: "erp.bill", format: "BILL-{YYYY}-{SEQ:5}", resetPeriod: "yearly" },
    },
    { name: "vendor_id", type: { kind: "reference", target: "Vendor" }, required: true, indexed: true },
    { name: "purchase_order_id", type: { kind: "reference", target: "PurchaseOrder" }, indexed: true },
    { name: "bill_date", type: { kind: "date" }, required: true, indexed: true },
    { name: "due_date", type: { kind: "date" }, required: true, indexed: true },
    {
      name: "state",
      type: { kind: "enum", values: ["draft", "approved", "paid", "overdue", "void"] },
      required: true,
      default: { kind: "literal", value: "draft" },
      indexed: true,
    },
    { name: "subtotal", type: { kind: "decimal", precision: 16, scale: 2, min: 0 }, required: true, default: { kind: "literal", value: 0 } },
    { name: "tax_total", type: { kind: "decimal", precision: 16, scale: 2, min: 0 }, required: true, default: { kind: "literal", value: 0 } },
    { name: "total", type: { kind: "decimal", precision: 16, scale: 2, min: 0 }, required: true, default: { kind: "literal", value: 0 } },
    { name: "currency", type: { kind: "text", maxLength: 3 }, required: true, default: { kind: "literal", value: "USD" } },
    // Foreign→functional rate captured at approval; period-close revaluation compares the
    // period-end rate against this (absent → treated as 1).
    { name: "booking_rate", type: { kind: "decimal", precision: 20, scale: 10, min: 0 } },
  ],
  indexes: [{ fields: ["state", "due_date"] }, { fields: ["vendor_id", "state"] }],
};

export const BILL_LINE_ENTITY: Entity = {
  name: "BillLine",
  traits: [...AUDITABLE],
  fields: [
    { name: "bill_id", type: { kind: "reference", target: "Bill" }, required: true, indexed: true },
    { name: "item_id", type: { kind: "reference", target: "Item" }, indexed: true },
    { name: "description", type: { kind: "text", maxLength: 300 }, required: true },
    { name: "quantity", type: { kind: "decimal", precision: 16, scale: 3, min: 0 }, required: true, default: { kind: "literal", value: 1 } },
    { name: "unit_price", type: { kind: "decimal", precision: 14, scale: 4, min: 0 }, required: true },
    { name: "amount", type: { kind: "decimal", precision: 16, scale: 2, min: 0 }, required: true, default: { kind: "literal", value: 0 } },
  ],
  indexes: [{ fields: ["bill_id"] }],
};

export const ERP_CORE_FINANCE_ENTITIES: readonly Entity[] = [
  LEDGER_ACCOUNT_ENTITY,
  JOURNAL_ENTRY_ENTITY,
  JOURNAL_LINE_ENTITY,
  PAYMENT_ENTITY,
  EXPENSE_ENTITY,
  BILL_ENTITY,
  BILL_LINE_ENTITY,
];
