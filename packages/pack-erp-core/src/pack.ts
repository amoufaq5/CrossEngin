import type { Manifest } from "@crossengin/kernel/manifest";

import { ERP_CORE_ENTITIES } from "./entities.js";
import { ERP_CORE_JOBS } from "./jobs.js";
import { ERP_CORE_PERMISSIONS } from "./permissions.js";
import { ERP_CORE_RELATIONS } from "./relations.js";
import { ERP_CORE_ROLES } from "./roles.js";
import { ERP_CORE_VIEWS } from "./views.js";
import { ERP_CORE_WORKFLOWS } from "./workflows.js";

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
        "Enterprise ERP core: CRM (Account, Contact, Invoice), Inventory (Item, Warehouse, StockLevel, StockMovement), Procurement (Vendor, PurchaseOrder, GoodsReceipt), Finance (LedgerAccount, JournalEntry, Payment, Expense, Bill), and HR (Department, Position, Employee, LeaveRequest) — with lifecycle workflows, RBAC, and scheduled jobs.",
      ...(opts.compliancePacks !== undefined
        ? { compliancePacks: [...opts.compliancePacks] }
        : {}),
    },
    entities: [...ERP_CORE_ENTITIES],
    relations: [...ERP_CORE_RELATIONS],
    roles: { ...ERP_CORE_ROLES },
    permissions: { ...ERP_CORE_PERMISSIONS },
    workflows: { ...ERP_CORE_WORKFLOWS },
    jobs: { ...ERP_CORE_JOBS },
    views: { ...ERP_CORE_VIEWS },
  };
}
