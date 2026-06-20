import type { EntityPermissions } from "@crossengin/auth";

import { ERP_EXT_TRANSITIONS } from "./workflows-ext.js";

const ADMIN_ONLY = ["erp_admin"];

const SALES_READERS = ["erp_admin", "erp_viewer", "sales_manager", "sales_rep", "erp_accountant"];
const SALES_WRITERS = ["erp_admin", "sales_manager", "sales_rep"];
const SHIP_READERS = [...SALES_READERS, "warehouse_clerk", "inventory_manager"];
const SHIP_WRITERS = ["erp_admin", "sales_manager", "warehouse_clerk"];

const MFG_READERS = ["erp_admin", "erp_viewer", "production_manager", "inventory_manager"];
const MFG_WRITERS = ["erp_admin", "production_manager"];

const PROJ_READERS = ["erp_admin", "erp_viewer", "project_manager", "hr_manager"];
const PROJ_WRITERS = ["erp_admin", "project_manager"];

const ASSET_READERS = ["erp_admin", "erp_viewer", "asset_manager", "controller"];
const ASSET_WRITERS = ["erp_admin", "asset_manager"];

const PRICING_READERS = ["erp_admin", "erp_viewer", "controller", "sales_manager", "procurement_manager"];
const PRICING_WRITERS = ["erp_admin", "controller"];

const GL_READERS = ["erp_admin", "erp_viewer", "controller", "erp_accountant"];
const GL_WRITERS = ["erp_admin", "controller"];

const TAX_READERS = ["erp_admin", "erp_viewer", "controller", "tax_manager", "erp_accountant"];
const TAX_WRITERS = ["erp_admin", "controller", "tax_manager"];

interface CrudOpts {
  readonly admins?: readonly string[];
  /** Entity name whose ERP_EXT_TRANSITIONS are granted to the writer set. */
  readonly transitionsFor?: string;
  readonly transitionRoles?: readonly string[];
}

function crud(readers: readonly string[], writers: readonly string[], opts: CrudOpts = {}): EntityPermissions {
  const perms: EntityPermissions = {
    list: { roles: [...readers] },
    read: { roles: [...readers] },
    create: { roles: [...writers] },
    update: { roles: [...writers] },
    delete: { roles: [...(opts.admins ?? ADMIN_ONLY)] },
  };
  if (opts.transitionsFor !== undefined) {
    const names = ERP_EXT_TRANSITIONS[opts.transitionsFor] ?? [];
    const roles = [...(opts.transitionRoles ?? writers)];
    const transitions: Record<string, { roles: string[] }> = {};
    for (const name of names) transitions[name] = { roles };
    return { ...perms, transitions };
  }
  return perms;
}

export const ERP_EXT_PERMISSIONS: Readonly<Record<string, EntityPermissions>> = {
  // Sales (Order-to-Cash)
  Lead: crud(SALES_READERS, SALES_WRITERS, { transitionsFor: "Lead" }),
  Opportunity: crud(SALES_READERS, SALES_WRITERS, { transitionsFor: "Opportunity" }),
  Quote: crud(SALES_READERS, SALES_WRITERS, { transitionsFor: "Quote" }),
  QuoteLine: crud(SALES_READERS, SALES_WRITERS),
  SalesOrder: crud(SALES_READERS, SALES_WRITERS, { transitionsFor: "SalesOrder" }),
  SalesOrderLine: crud(SALES_READERS, SALES_WRITERS),
  Shipment: crud(SHIP_READERS, SHIP_WRITERS, { transitionsFor: "Shipment" }),
  // Manufacturing
  BillOfMaterials: crud(MFG_READERS, MFG_WRITERS),
  BomLine: crud(MFG_READERS, MFG_WRITERS),
  WorkOrder: crud(MFG_READERS, MFG_WRITERS, { transitionsFor: "WorkOrder" }),
  // Projects / Services
  Project: crud(PROJ_READERS, PROJ_WRITERS, { transitionsFor: "Project" }),
  ProjectTask: crud(PROJ_READERS, PROJ_WRITERS, { transitionsFor: "ProjectTask" }),
  Timesheet: crud(PROJ_READERS, PROJ_WRITERS, { transitionsFor: "Timesheet" }),
  // Assets
  FixedAsset: crud(ASSET_READERS, ASSET_WRITERS, { transitionsFor: "FixedAsset" }),
  MaintenanceOrder: crud(ASSET_READERS, ASSET_WRITERS, { transitionsFor: "MaintenanceOrder" }),
  // Pricing / Tax
  TaxCode: crud(PRICING_READERS, PRICING_WRITERS),
  PriceList: crud(PRICING_READERS, PRICING_WRITERS),
  PriceListItem: crud(PRICING_READERS, PRICING_WRITERS),
  // Accounting depth — multi-currency, fiscal calendar, parallel books, dimensions
  Currency: crud(GL_READERS, GL_WRITERS),
  ExchangeRate: crud(GL_READERS, GL_WRITERS),
  FiscalYear: crud(GL_READERS, GL_WRITERS),
  FiscalPeriod: crud(GL_READERS, GL_WRITERS),
  AccountingBook: crud(GL_READERS, GL_WRITERS),
  CostCenter: crud(GL_READERS, GL_WRITERS),
  // Country tax rules + filing
  TaxJurisdiction: crud(TAX_READERS, TAX_WRITERS),
  TaxRule: crud(TAX_READERS, TAX_WRITERS),
  TaxReturn: crud(TAX_READERS, TAX_WRITERS, { transitionsFor: "TaxReturn" }),
};
