import { ERP_CORE_PACK_SLUG } from "@crossengin/pack-erp-core";
import type { Manifest } from "@crossengin/kernel/manifest";

import { ERP_GOVERNMENT_ENTITIES } from "./entities.js";
import { ERP_GOVERNMENT_JOBS } from "./jobs.js";
import { ERP_GOVERNMENT_PERMISSIONS } from "./permissions.js";
import { ERP_GOVERNMENT_RELATIONS } from "./relations.js";
import { ERP_GOVERNMENT_ROLES } from "./roles.js";
import { ERP_GOVERNMENT_VIEWS } from "./views.js";
import { ERP_GOVERNMENT_WORKFLOWS } from "./workflows.js";

export const ERP_GOVERNMENT_PACK_SLUG = "operate-erp/government";
export const ERP_GOVERNMENT_PACK_VERSION = "0.1.0";

export const DEFAULT_GOVERNMENT_COMPLIANCE_PACKS = ["nist-800-53"] as const;

export interface BuildErpGovernmentPackOptions {
  readonly description?: string;
  readonly compliancePacks?: readonly string[];
}

/**
 * Builds the government vertical pack as a *standalone* manifest that declares
 * `meta.extends: ["operate-erp/core"]`. It references the core `Account` entity
 * by name, so it cross-validates only once resolved against a registry that
 * supplies the core pack.
 */
export function buildErpGovernmentPack(
  opts: BuildErpGovernmentPackOptions = {},
): Manifest {
  return {
    manifestVersion: "1.0",
    meta: {
      name: "CrossEngin Operate — ERP Government",
      slug: ERP_GOVERNMENT_PACK_SLUG,
      version: ERP_GOVERNMENT_PACK_VERSION,
      description:
        opts.description ??
        "Government vertical (Citizen, Case, Permit) extending ERP Core — ties constituent case management and permit licensing to the core Account, with regulated national identifiers and PII contact fields redacted by classification.",
      extends: [ERP_CORE_PACK_SLUG],
      compliancePacks: [
        ...(opts.compliancePacks ?? DEFAULT_GOVERNMENT_COMPLIANCE_PACKS),
      ],
    },
    entities: [...ERP_GOVERNMENT_ENTITIES],
    relations: [...ERP_GOVERNMENT_RELATIONS],
    roles: { ...ERP_GOVERNMENT_ROLES },
    permissions: { ...ERP_GOVERNMENT_PERMISSIONS },
    workflows: { ...ERP_GOVERNMENT_WORKFLOWS },
    jobs: { ...ERP_GOVERNMENT_JOBS },
    views: { ...ERP_GOVERNMENT_VIEWS },
  };
}
