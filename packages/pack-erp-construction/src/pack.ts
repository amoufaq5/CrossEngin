import { ERP_CORE_PACK_SLUG } from "@crossengin/pack-erp-core";
import type { Manifest } from "@crossengin/kernel/manifest";

import { ERP_CONSTRUCTION_DASHBOARDS } from "./dashboards.js";
import { ERP_CONSTRUCTION_ENTITIES } from "./entities.js";
import { ERP_CONSTRUCTION_JOBS } from "./jobs.js";
import { ERP_CONSTRUCTION_PERMISSIONS } from "./permissions.js";
import { ERP_CONSTRUCTION_RELATIONS } from "./relations.js";
import { ERP_CONSTRUCTION_REPORTS } from "./reports.js";
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
 * Builds the construction vertical pack as a *standalone* manifest that declares
 * `meta.extends: ["operate-erp/core"]`. It references core entities (Account,
 * Invoice) by name, so it cross-validates only once resolved against a registry
 * that supplies the core pack. Two `entityLifecycle` workflows (Project +
 * ChangeOrder), a commercial-sensitive contract value redacted by classification,
 * and a PII daily-log email — exercising the full pack surface on a non-PHI domain.
 */
export function buildErpConstructionPack(opts: BuildErpConstructionPackOptions = {}): Manifest {
  return {
    manifestVersion: "1.0",
    meta: {
      name: "CrossEngin Operate — ERP Construction",
      slug: ERP_CONSTRUCTION_PACK_SLUG,
      version: ERP_CONSTRUCTION_PACK_VERSION,
      description:
        opts.description ??
        "Construction vertical (Project, CostCode, ChangeOrder, DailyLog) extending ERP Core — ties projects + change orders to the core billing Account + Invoice, with a commercial-sensitive contract value redacted by classification and a project + change-order approval lifecycle.",
      extends: [ERP_CORE_PACK_SLUG],
      compliancePacks: [...(opts.compliancePacks ?? DEFAULT_CONSTRUCTION_COMPLIANCE_PACKS)],
    },
    entities: [...ERP_CONSTRUCTION_ENTITIES],
    relations: [...ERP_CONSTRUCTION_RELATIONS],
    roles: { ...ERP_CONSTRUCTION_ROLES },
    permissions: { ...ERP_CONSTRUCTION_PERMISSIONS },
    workflows: { ...ERP_CONSTRUCTION_WORKFLOWS },
    jobs: { ...ERP_CONSTRUCTION_JOBS },
    views: { ...ERP_CONSTRUCTION_VIEWS },
    reports: { ...ERP_CONSTRUCTION_REPORTS },
    dashboards: { ...ERP_CONSTRUCTION_DASHBOARDS },
  };
}
