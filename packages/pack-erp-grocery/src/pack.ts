import { ERP_RETAIL_PACK_SLUG } from "@crossengin/pack-erp-retail";
import type { Manifest } from "@crossengin/kernel/manifest";

import { ERP_GROCERY_ENTITIES } from "./entities.js";
import { ERP_GROCERY_JOBS } from "./jobs.js";
import { ERP_GROCERY_PERMISSIONS } from "./permissions.js";
import { ERP_GROCERY_RELATIONS } from "./relations.js";
import { ERP_GROCERY_ROLES } from "./roles.js";
import { ERP_GROCERY_VIEWS } from "./views.js";
import { ERP_GROCERY_WORKFLOWS } from "./workflows.js";

export const ERP_GROCERY_PACK_SLUG = "operate-erp/grocery";
export const ERP_GROCERY_PACK_VERSION = "0.1.0";

export const DEFAULT_GROCERY_COMPLIANCE_PACKS = ["haccp"] as const;

export interface BuildErpGroceryPackOptions {
  readonly description?: string;
  readonly compliancePacks?: readonly string[];
}

/**
 * Builds the grocery vertical pack — a *standalone* manifest that declares
 * `meta.extends: ["operate-erp/retail"]`, forming a three-level lineage
 * grocery → retail → core. It references the retail `Product` and the core
 * `Account`, so it cross-validates only once `resolveManifest` transitively
 * merges retail (and, through retail, core).
 */
export function buildErpGroceryPack(opts: BuildErpGroceryPackOptions = {}): Manifest {
  return {
    manifestVersion: "1.0",
    meta: {
      name: "CrossEngin Operate — ERP Grocery",
      slug: ERP_GROCERY_PACK_SLUG,
      version: ERP_GROCERY_PACK_VERSION,
      description:
        opts.description ??
        "Grocery vertical (Supplier, PerishableLot) extending ERP Retail — adds expiration-tracked lots tied to retail Products and core Accounts, with HACCP food-safety posture.",
      extends: [ERP_RETAIL_PACK_SLUG],
      compliancePacks: [...(opts.compliancePacks ?? DEFAULT_GROCERY_COMPLIANCE_PACKS)],
    },
    entities: [...ERP_GROCERY_ENTITIES],
    relations: [...ERP_GROCERY_RELATIONS],
    roles: { ...ERP_GROCERY_ROLES },
    permissions: { ...ERP_GROCERY_PERMISSIONS },
    workflows: { ...ERP_GROCERY_WORKFLOWS },
    jobs: { ...ERP_GROCERY_JOBS },
    views: { ...ERP_GROCERY_VIEWS },
  };
}
