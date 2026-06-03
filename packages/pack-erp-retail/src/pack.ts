import { ERP_CORE_PACK_SLUG } from "@crossengin/pack-erp-core";
import type { Manifest } from "@crossengin/kernel/manifest";

import { ERP_RETAIL_ENTITIES } from "./entities.js";
import { ERP_RETAIL_JOBS } from "./jobs.js";
import { ERP_RETAIL_PERMISSIONS } from "./permissions.js";
import { ERP_RETAIL_RELATIONS } from "./relations.js";
import { ERP_RETAIL_ROLES } from "./roles.js";
import { ERP_RETAIL_VIEWS } from "./views.js";
import { ERP_RETAIL_WORKFLOWS } from "./workflows.js";

export const ERP_RETAIL_PACK_SLUG = "operate-erp/retail";
export const ERP_RETAIL_PACK_VERSION = "0.1.0";

export const DEFAULT_RETAIL_COMPLIANCE_PACKS = ["pci"] as const;

export interface BuildErpRetailPackOptions {
  readonly description?: string;
  readonly compliancePacks?: readonly string[];
}

/**
 * Builds the retail vertical pack as a *standalone* manifest that declares
 * `meta.extends: ["operate-erp/core"]`. It references core entities
 * (Account, Invoice) by name, so it cross-validates only once resolved
 * against a registry that supplies the core pack.
 */
export function buildErpRetailPack(opts: BuildErpRetailPackOptions = {}): Manifest {
  return {
    manifestVersion: "1.0",
    meta: {
      name: "CrossEngin Operate — ERP Retail",
      slug: ERP_RETAIL_PACK_SLUG,
      version: ERP_RETAIL_PACK_VERSION,
      description:
        opts.description ??
        "Retail vertical (Product, Store, SalesOrder, OrderLine) extending ERP Core — ties point-of-sale orders to the core billing Account + Invoice, with commercial-sensitive cost + PII customer fields redacted by classification.",
      extends: [ERP_CORE_PACK_SLUG],
      compliancePacks: [...(opts.compliancePacks ?? DEFAULT_RETAIL_COMPLIANCE_PACKS)],
    },
    entities: [...ERP_RETAIL_ENTITIES],
    relations: [...ERP_RETAIL_RELATIONS],
    roles: { ...ERP_RETAIL_ROLES },
    permissions: { ...ERP_RETAIL_PERMISSIONS },
    workflows: { ...ERP_RETAIL_WORKFLOWS },
    jobs: { ...ERP_RETAIL_JOBS },
    views: { ...ERP_RETAIL_VIEWS },
  };
}
