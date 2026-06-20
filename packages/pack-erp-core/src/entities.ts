import type { Entity } from "@crossengin/types/meta-schema";

import { ERP_CORE_ASSET_ENTITIES } from "./entities-assets.js";
import { ERP_CORE_FINANCE_ENTITIES } from "./entities-finance.js";
import { ERP_CORE_HR_ENTITIES } from "./entities-hr.js";
import { ERP_CORE_INVENTORY_ENTITIES } from "./entities-inventory.js";
import { ERP_CORE_MANUFACTURING_ENTITIES } from "./entities-manufacturing.js";
import { ERP_CORE_PRICING_ENTITIES } from "./entities-pricing.js";
import { ERP_CORE_PROCUREMENT_ENTITIES } from "./entities-procurement.js";
import { ERP_CORE_PROJECT_ENTITIES } from "./entities-projects.js";
import { ERP_CORE_SALES_ENTITIES } from "./entities-sales.js";

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
      default: {
        kind: "sequence",
        sequence: "erp.invoice",
        format: "INV-{YYYY}-{SEQ:5}",
        resetPeriod: "yearly",
      },
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

export const ERP_CORE_CRM_ENTITIES: readonly Entity[] = [
  ACCOUNT_ENTITY,
  CONTACT_ENTITY,
  INVOICE_ENTITY,
  INVOICE_LINE_ENTITY,
];

/** Department/module each core entity belongs to (drives the grouped console UI). */
export const ERP_CORE_MODULE_BY_ENTITY: Readonly<Record<string, string>> = {
  // Sales & CRM
  Account: "Sales & CRM",
  Contact: "Sales & CRM",
  Lead: "Sales & CRM",
  Opportunity: "Sales & CRM",
  Quote: "Sales & CRM",
  QuoteLine: "Sales & CRM",
  SalesOrder: "Sales & CRM",
  SalesOrderLine: "Sales & CRM",
  Shipment: "Sales & CRM",
  // Finance (AR/AP/Treasury)
  Invoice: "Finance",
  InvoiceLine: "Finance",
  Payment: "Finance",
  Bill: "Finance",
  BillLine: "Finance",
  Expense: "Finance",
  // Accounting & GL
  LedgerAccount: "Accounting & GL",
  JournalEntry: "Accounting & GL",
  JournalLine: "Accounting & GL",
  // Procurement
  Vendor: "Procurement",
  PurchaseOrder: "Procurement",
  PurchaseOrderLine: "Procurement",
  GoodsReceipt: "Procurement",
  // Supply Chain & Inventory
  Item: "Supply Chain & Inventory",
  Warehouse: "Supply Chain & Inventory",
  StockLevel: "Supply Chain & Inventory",
  StockMovement: "Supply Chain & Inventory",
  // Manufacturing
  BillOfMaterials: "Manufacturing",
  BomLine: "Manufacturing",
  WorkOrder: "Manufacturing",
  // Projects & Services
  Project: "Projects & Services",
  ProjectTask: "Projects & Services",
  Timesheet: "Projects & Services",
  // Assets & Maintenance
  FixedAsset: "Assets & Maintenance",
  MaintenanceOrder: "Assets & Maintenance",
  // Pricing & Tax
  TaxCode: "Pricing & Tax",
  PriceList: "Pricing & Tax",
  PriceListItem: "Pricing & Tax",
  // Human Resources
  Department: "Human Resources",
  Position: "Human Resources",
  Employee: "Human Resources",
  LeaveRequest: "Human Resources",
};

/** Tags an entity with its `module` from a name→department map (UI grouping only). */
export function withModules(
  entities: readonly Entity[],
  moduleByEntity: Readonly<Record<string, string>>,
): readonly Entity[] {
  return entities.map((e) => {
    const module = moduleByEntity[e.name] ?? e.module;
    return module !== undefined ? { ...e, module } : e;
  });
}

const ERP_CORE_ENTITIES_RAW: readonly Entity[] = [
  ...ERP_CORE_CRM_ENTITIES,
  ...ERP_CORE_INVENTORY_ENTITIES,
  ...ERP_CORE_PROCUREMENT_ENTITIES,
  ...ERP_CORE_FINANCE_ENTITIES,
  ...ERP_CORE_HR_ENTITIES,
  ...ERP_CORE_SALES_ENTITIES,
  ...ERP_CORE_MANUFACTURING_ENTITIES,
  ...ERP_CORE_PROJECT_ENTITIES,
  ...ERP_CORE_ASSET_ENTITIES,
  ...ERP_CORE_PRICING_ENTITIES,
];

export const ERP_CORE_ENTITIES: readonly Entity[] = withModules(
  ERP_CORE_ENTITIES_RAW,
  ERP_CORE_MODULE_BY_ENTITY,
);
