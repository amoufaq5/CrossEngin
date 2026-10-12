import type { EntityPermissions, FieldPermission } from "@crossengin/auth";

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
const ASSET_COST_READERS = ["erp_admin", "asset_manager", "controller"];

const PRICING_READERS = ["erp_admin", "erp_viewer", "controller", "sales_manager", "procurement_manager"];
const PRICING_WRITERS = ["erp_admin", "controller"];

const GL_READERS = ["erp_admin", "erp_viewer", "controller", "erp_accountant"];
const GL_WRITERS = ["erp_admin", "controller"];

const TAX_READERS = ["erp_admin", "erp_viewer", "controller", "tax_manager", "erp_accountant"];
const TAX_WRITERS = ["erp_admin", "controller", "tax_manager"];

/**
 * Per-field grants for this file's sensitive-classified fields.
 *
 * `erp_viewer` — the pack's general observer, which every entity grant above admits to `read` —
 * is dropped from every one of them. The narrowings past that are noted where they are a
 * judgement about who the figure belongs to rather than a mechanical consequence.
 */
const LEAD_FIELDS: Readonly<Record<string, FieldPermission>> = {
  full_name: { read: { roles: SALES_WRITERS }, update: { roles: SALES_WRITERS } },
  email: { read: { roles: SALES_WRITERS }, update: { roles: SALES_WRITERS } },
  phone: { read: { roles: SALES_WRITERS }, update: { roles: SALES_WRITERS } },
  // Accounting forecasts off the pipeline figure and so reads it; a rep sizing their own lead
  // does not set the number that forecast is built from.
  estimated_value: {
    read: { roles: ["erp_admin", "sales_manager", "erp_accountant"] },
    update: { roles: ["erp_admin", "sales_manager"] },
  },
};

const OPPORTUNITY_FIELDS: Readonly<Record<string, FieldPermission>> = {
  amount: {
    read: { roles: ["erp_admin", "sales_manager", "sales_rep", "erp_accountant"] },
    update: { roles: SALES_WRITERS },
  },
};

const PROJECT_FIELDS: Readonly<Record<string, FieldPermission>> = {
  // `hr_manager` reads a project to staff it; the budget is not part of that question.
  budget: { read: { roles: PROJ_WRITERS }, update: { roles: PROJ_WRITERS } },
};

const FIXED_ASSET_FIELDS: Readonly<Record<string, FieldPermission>> = {
  acquisition_cost: { read: { roles: ASSET_COST_READERS }, update: { roles: ASSET_WRITERS } },
  salvage_value: { read: { roles: ASSET_COST_READERS }, update: { roles: ASSET_WRITERS } },
};

const MAINTENANCE_ORDER_FIELDS: Readonly<Record<string, FieldPermission>> = {
  cost: { read: { roles: ASSET_COST_READERS }, update: { roles: ASSET_WRITERS } },
};

const TAX_JURISDICTION_FIELDS: Readonly<Record<string, FieldPermission>> = {
  // Accounting cites the registration number on a filing and so reads it; changing the
  // identity the platform files under belongs to the tax owners.
  registration_number: {
    read: { roles: ["erp_admin", "controller", "tax_manager", "erp_accountant"] },
    update: { roles: TAX_WRITERS },
  },
};

interface CrudOpts {
  readonly admins?: readonly string[];
  /** Entity name whose ERP_EXT_TRANSITIONS are granted to the writer set. */
  readonly transitionsFor?: string;
  readonly transitionRoles?: readonly string[];
  readonly fields?: Readonly<Record<string, FieldPermission>>;
}

function crud(readers: readonly string[], writers: readonly string[], opts: CrudOpts = {}): EntityPermissions {
  const perms: EntityPermissions = {
    list: { roles: [...readers] },
    read: { roles: [...readers] },
    create: { roles: [...writers] },
    update: { roles: [...writers] },
    delete: { roles: [...(opts.admins ?? ADMIN_ONLY)] },
    ...(opts.fields !== undefined ? { fields: { ...opts.fields } } : {}),
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
  Lead: crud(SALES_READERS, SALES_WRITERS, { transitionsFor: "Lead", fields: LEAD_FIELDS }),
  Opportunity: crud(SALES_READERS, SALES_WRITERS, {
    transitionsFor: "Opportunity",
    fields: OPPORTUNITY_FIELDS,
  }),
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
  Project: crud(PROJ_READERS, PROJ_WRITERS, { transitionsFor: "Project", fields: PROJECT_FIELDS }),
  ProjectTask: crud(PROJ_READERS, PROJ_WRITERS, { transitionsFor: "ProjectTask" }),
  Timesheet: crud(PROJ_READERS, PROJ_WRITERS, { transitionsFor: "Timesheet" }),
  // Assets
  FixedAsset: crud(ASSET_READERS, ASSET_WRITERS, {
    transitionsFor: "FixedAsset",
    fields: FIXED_ASSET_FIELDS,
  }),
  MaintenanceOrder: crud(ASSET_READERS, ASSET_WRITERS, {
    transitionsFor: "MaintenanceOrder",
    fields: MAINTENANCE_ORDER_FIELDS,
  }),
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
  TaxJurisdiction: crud(TAX_READERS, TAX_WRITERS, { fields: TAX_JURISDICTION_FIELDS }),
  TaxRule: crud(TAX_READERS, TAX_WRITERS),
  TaxReturn: crud(TAX_READERS, TAX_WRITERS, { transitionsFor: "TaxReturn" }),
};
