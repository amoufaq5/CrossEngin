import { ERP_CORE_PACK_SLUG } from "@crossengin/pack-erp-core";
import type { Manifest } from "@crossengin/kernel/manifest";

import { ERP_EDUCATION_DASHBOARDS } from "./dashboards.js";
import { ERP_EDUCATION_ENTITIES } from "./entities.js";
import { ERP_EDUCATION_JOBS } from "./jobs.js";
import { ERP_EDUCATION_PERMISSIONS } from "./permissions.js";
import { ERP_EDUCATION_RELATIONS } from "./relations.js";
import { ERP_EDUCATION_REPORTS } from "./reports.js";
import { ERP_EDUCATION_ROLES } from "./roles.js";
import { ERP_EDUCATION_VIEWS } from "./views.js";
import { ERP_EDUCATION_WORKFLOWS } from "./workflows.js";

export const ERP_EDUCATION_PACK_SLUG = "operate-erp/education";
export const ERP_EDUCATION_PACK_VERSION = "0.1.0";

export const DEFAULT_EDUCATION_COMPLIANCE_PACKS = ["ferpa"] as const;

export interface BuildErpEducationPackOptions {
  readonly description?: string;
  readonly compliancePacks?: readonly string[];
}

/**
 * Builds the education vertical pack as a *standalone* manifest that declares
 * `meta.extends: ["operate-erp/core"]`. It references core entities (Account,
 * Invoice) by name, so it cross-validates only once resolved against a registry
 * that supplies the core pack. The **first pack to use the `regulated`
 * classification on a non-health domain** — `Enrollment.grade` is a FERPA
 * education record (redacted by default + at-rest-encryption-hinted), alongside
 * student PII and two `entityLifecycle` workflows (Course + Enrollment).
 */
export function buildErpEducationPack(opts: BuildErpEducationPackOptions = {}): Manifest {
  return {
    manifestVersion: "1.0",
    meta: {
      name: "CrossEngin Operate — ERP Education",
      slug: ERP_EDUCATION_PACK_SLUG,
      version: ERP_EDUCATION_PACK_VERSION,
      description:
        opts.description ??
        "Education vertical (Course, Student, Enrollment, Assignment) extending ERP Core — ties enrollments to the core billing Account + Invoice, with a course-catalog + enrollment lifecycle, student PII, and a FERPA-regulated grade record redacted + encryption-hinted by classification.",
      extends: [ERP_CORE_PACK_SLUG],
      compliancePacks: [...(opts.compliancePacks ?? DEFAULT_EDUCATION_COMPLIANCE_PACKS)],
    },
    entities: [...ERP_EDUCATION_ENTITIES],
    relations: [...ERP_EDUCATION_RELATIONS],
    roles: { ...ERP_EDUCATION_ROLES },
    permissions: { ...ERP_EDUCATION_PERMISSIONS },
    workflows: { ...ERP_EDUCATION_WORKFLOWS },
    jobs: { ...ERP_EDUCATION_JOBS },
    views: { ...ERP_EDUCATION_VIEWS },
    reports: { ...ERP_EDUCATION_REPORTS },
    dashboards: { ...ERP_EDUCATION_DASHBOARDS },
  };
}
