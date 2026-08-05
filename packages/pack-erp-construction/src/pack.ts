import { ERP_CORE_PACK_SLUG } from "@crossengin/pack-erp-core";
import type { Manifest } from "@crossengin/kernel/manifest";

import { ERP_CONSTRUCTION_ENTITIES } from "./entities.js";
import { ERP_CONSTRUCTION_JOBS } from "./jobs.js";
import { ERP_CONSTRUCTION_PERMISSIONS } from "./permissions.js";
import { ERP_CONSTRUCTION_RELATIONS } from "./relations.js";
import { ERP_CONSTRUCTION_ROLES } from "./roles.js";
import { ERP_CONSTRUCTION_VIEWS } from "./views.js";
import { ERP_CONSTRUCTION_WORKFLOWS } from "./workflows.js";

export const ERP_CONSTRUCTION_PACK_SLUG = "operate-erp/construction";
export const ERP_CONSTRUCTION_PACK_VERSION = "0.1.0";

export const DEFAULT_CONSTRUCTION_COMPLIANCE_PACKS = ["osha"] as const;

export interface BuildErpConstructionPackOptions {
  readonly description?: string;
  readonly compliancePacks?: readonly string[];
}

/**
 * Builds the construction vertical pack as a *standalone* manifest that
 * declares `meta.extends: ["operate-erp/core"]`. It references the core
 * `Account` entity by name, so it cross-validates only once resolved against a
 * registry that supplies the core pack.
 */
export function buildErpConstructionPack(
  opts: BuildErpConstructionPackOptions = {},
): Manifest {
  return {
    manifestVersion: "1.0",
    meta: {
      name: "CrossEngin Operate — ERP Construction",
      slug: ERP_CONSTRUCTION_PACK_SLUG,
      version: ERP_CONSTRUCTION_PACK_VERSION,
      description:
        opts.description ??
        "Construction vertical (Project, Subcontractor, WorkOrder) extending ERP Core — ties jobsite projects and their work orders to the core billing Account, with commercial-sensitive budget/cost + PII subcontractor-contact fields redacted by classification.",
      extends: [ERP_CORE_PACK_SLUG],
      compliancePacks: [
        ...(opts.compliancePacks ?? DEFAULT_CONSTRUCTION_COMPLIANCE_PACKS),
      ],
    },
    entities: [...ERP_CONSTRUCTION_ENTITIES],
    relations: [...ERP_CONSTRUCTION_RELATIONS],
    roles: { ...ERP_CONSTRUCTION_ROLES },
    permissions: { ...ERP_CONSTRUCTION_PERMISSIONS },
    workflows: { ...ERP_CONSTRUCTION_WORKFLOWS },
    jobs: { ...ERP_CONSTRUCTION_JOBS },
    views: { ...ERP_CONSTRUCTION_VIEWS },
  };
}
