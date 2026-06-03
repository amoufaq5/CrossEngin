import { ERP_CORE_PACK_SLUG } from "@crossengin/pack-erp-core";
import type { Manifest } from "@crossengin/kernel/manifest";

import { ERP_HEALTHCARE_ENTITIES } from "./entities.js";
import { ERP_HEALTHCARE_JOBS } from "./jobs.js";
import { ERP_HEALTHCARE_PERMISSIONS } from "./permissions.js";
import { ERP_HEALTHCARE_RELATIONS } from "./relations.js";
import { ERP_HEALTHCARE_ROLES } from "./roles.js";
import { ERP_HEALTHCARE_VIEWS } from "./views.js";
import { ERP_HEALTHCARE_WORKFLOWS } from "./workflows.js";

export const ERP_HEALTHCARE_PACK_SLUG = "operate-erp/healthcare";
export const ERP_HEALTHCARE_PACK_VERSION = "0.1.0";

export const DEFAULT_HEALTHCARE_COMPLIANCE_PACKS = ["hipaa"] as const;

export interface BuildErpHealthcarePackOptions {
  readonly description?: string;
  readonly compliancePacks?: readonly string[];
}

/**
 * Builds the healthcare vertical pack as a *standalone* manifest that
 * declares `meta.extends: ["operate-erp/core"]`. It references core
 * entities (Account, Invoice) by name, so it cross-validates only once
 * resolved against a registry that supplies the core pack.
 */
export function buildErpHealthcarePack(
  opts: BuildErpHealthcarePackOptions = {},
): Manifest {
  return {
    manifestVersion: "1.0",
    meta: {
      name: "CrossEngin Operate — ERP Healthcare",
      slug: ERP_HEALTHCARE_PACK_SLUG,
      version: ERP_HEALTHCARE_PACK_VERSION,
      description:
        opts.description ??
        "Healthcare vertical (Patient, Encounter, Observation) extending ERP Core — ties clinical encounters to the core billing Account + Invoice, with a HIPAA compliance posture.",
      extends: [ERP_CORE_PACK_SLUG],
      compliancePacks: [...(opts.compliancePacks ?? DEFAULT_HEALTHCARE_COMPLIANCE_PACKS)],
    },
    entities: [...ERP_HEALTHCARE_ENTITIES],
    relations: [...ERP_HEALTHCARE_RELATIONS],
    roles: { ...ERP_HEALTHCARE_ROLES },
    permissions: { ...ERP_HEALTHCARE_PERMISSIONS },
    workflows: { ...ERP_HEALTHCARE_WORKFLOWS },
    jobs: { ...ERP_HEALTHCARE_JOBS },
    views: { ...ERP_HEALTHCARE_VIEWS },
  };
}
