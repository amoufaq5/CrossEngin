import type { Manifest } from "@crossengin/kernel/manifest";
import { ERP_CORE_PACK_SLUG } from "@crossengin/pack-erp-core";

import { ERP_HEALTHCARE_ENTITIES } from "./entities.js";
import { ERP_HEALTHCARE_JOBS } from "./jobs.js";
import { ERP_HEALTHCARE_PERMISSIONS } from "./permissions.js";
import { ERP_HEALTHCARE_RELATIONS } from "./relations.js";
import { ERP_HEALTHCARE_ROLES } from "./roles.js";
import { ERP_HEALTHCARE_VIEWS } from "./views.js";
import { ERP_HEALTHCARE_WORKFLOWS } from "./workflows.js";

export const ERP_HEALTHCARE_PACK_SLUG = "operate-erp/healthcare";
export const ERP_HEALTHCARE_PACK_VERSION = "0.1.0";

export const ERP_HEALTHCARE_DEFAULT_COMPLIANCE_PACKS: readonly string[] = ["hipaa", "21_cfr_11"];

export interface BuildErpHealthcarePackOptions {
  readonly description?: string;
  readonly compliancePacks?: readonly string[];
}

export function buildErpHealthcarePack(opts: BuildErpHealthcarePackOptions = {}): Manifest {
  const compliancePacks =
    opts.compliancePacks !== undefined
      ? [...opts.compliancePacks]
      : [...ERP_HEALTHCARE_DEFAULT_COMPLIANCE_PACKS];
  return {
    manifestVersion: "1.0",
    meta: {
      name: "CrossEngin Operate — ERP Healthcare",
      slug: ERP_HEALTHCARE_PACK_SLUG,
      version: ERP_HEALTHCARE_PACK_VERSION,
      description:
        opts.description ??
        "Patient + Encounter + Observation entities on top of operate-erp/core. FHIR-shaped fields (LOINC / SNOMED / ICD-10 codes), encounter_lifecycle workflow (scheduled → checked_in → in_progress → completed | cancelled | no_show), HIPAA + 21 CFR 11 compliance packs default. Pairs with @crossengin/notifications for appointment reminders and the FHIR R4 export job for downstream EHR integration.",
      extends: [ERP_CORE_PACK_SLUG],
      compliancePacks,
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
