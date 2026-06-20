import type { Manifest } from "@crossengin/kernel/manifest";

import { ERP_CORE_ENTITIES } from "./entities.js";
import { ERP_CORE_JOBS } from "./jobs.js";
import { ERP_EXT_JOBS } from "./jobs-ext.js";
import { ERP_CORE_PERMISSIONS } from "./permissions.js";
import { ERP_EXT_PERMISSIONS } from "./permissions-ext.js";
import { ERP_CORE_RELATIONS } from "./relations.js";
import { ERP_EXT_RELATIONS } from "./relations-ext.js";
import { ERP_CORE_ROLES } from "./roles.js";
import { ERP_CORE_VIEWS } from "./views.js";
import { ERP_CORE_WORKFLOWS } from "./workflows.js";
import { ERP_EXT_WORKFLOWS } from "./workflows-ext.js";

export const ERP_CORE_PACK_SLUG = "operate-erp/core";
export const ERP_CORE_PACK_VERSION = "0.1.0";

export interface BuildErpCorePackOptions {
  readonly description?: string;
  readonly compliancePacks?: readonly string[];
}

export function buildErpCorePack(opts: BuildErpCorePackOptions = {}): Manifest {
  return {
    manifestVersion: "1.0",
    meta: {
      name: "CrossEngin Operate — ERP Core",
      slug: ERP_CORE_PACK_SLUG,
      version: ERP_CORE_PACK_VERSION,
      description:
        opts.description ??
        "Enterprise ERP core (41 entities): CRM (Account, Contact, Invoice), Sales/O2C (Lead, Opportunity, Quote, SalesOrder, Shipment), Inventory (Item, Warehouse, StockLevel, StockMovement), Manufacturing (BillOfMaterials, WorkOrder), Procurement (Vendor, PurchaseOrder, GoodsReceipt), Finance (LedgerAccount, JournalEntry, Payment, Expense, Bill), Projects/Services (Project, ProjectTask, Timesheet), Assets (FixedAsset, MaintenanceOrder), Pricing/Tax (TaxCode, PriceList), and HR (Department, Position, Employee, LeaveRequest) — with 18 lifecycle workflows, RBAC across 14 roles, document auto-numbering, and 14 integration/automation jobs (payment-gateway sync, e-invoicing, tax engine, MRP reorder, depreciation, payroll disbursement, carrier tracking).",
      ...(opts.compliancePacks !== undefined
        ? { compliancePacks: [...opts.compliancePacks] }
        : {}),
    },
    entities: [...ERP_CORE_ENTITIES],
    relations: [...ERP_CORE_RELATIONS, ...ERP_EXT_RELATIONS],
    roles: { ...ERP_CORE_ROLES },
    permissions: { ...ERP_CORE_PERMISSIONS, ...ERP_EXT_PERMISSIONS },
    workflows: { ...ERP_CORE_WORKFLOWS, ...ERP_EXT_WORKFLOWS },
    jobs: { ...ERP_CORE_JOBS, ...ERP_EXT_JOBS },
    views: { ...ERP_CORE_VIEWS },
  };
}
