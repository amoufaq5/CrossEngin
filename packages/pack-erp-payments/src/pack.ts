import type { Manifest } from "@crossengin/kernel/manifest";
import { ERP_CORE_PACK_SLUG } from "@crossengin/pack-erp-core";

import { ERP_PAYMENTS_ENTITIES } from "./entities.js";
import { ERP_PAYMENTS_JOBS } from "./jobs.js";
import { ERP_PAYMENTS_PERMISSIONS } from "./permissions.js";
import { ERP_PAYMENTS_RELATIONS } from "./relations.js";
import { ERP_PAYMENTS_VIEWS } from "./views.js";
import { ERP_PAYMENTS_WORKFLOWS } from "./workflows.js";

export const ERP_PAYMENTS_PACK_SLUG = "operate-erp/payments";
export const ERP_PAYMENTS_PACK_VERSION = "0.1.0";

export interface BuildErpPaymentsPackOptions {
  readonly description?: string;
  readonly compliancePacks?: readonly string[];
}

export function buildErpPaymentsPack(
  opts: BuildErpPaymentsPackOptions = {},
): Manifest {
  return {
    manifestVersion: "1.0",
    meta: {
      name: "CrossEngin Operate — ERP Payments",
      slug: ERP_PAYMENTS_PACK_SLUG,
      version: ERP_PAYMENTS_PACK_VERSION,
      description:
        opts.description ??
        "Payment entity + lifecycle workflow on top of operate-erp/core. Bridges payment-provider webhooks (Stripe / Adyen / Braintree) into workflow signals so captured / settled / refunded state transitions ride through the M6 workflow-signal-bridge.",
      extends: [ERP_CORE_PACK_SLUG],
      ...(opts.compliancePacks !== undefined
        ? { compliancePacks: [...opts.compliancePacks] }
        : {}),
    },
    entities: [...ERP_PAYMENTS_ENTITIES],
    relations: [...ERP_PAYMENTS_RELATIONS],
    permissions: { ...ERP_PAYMENTS_PERMISSIONS },
    workflows: { ...ERP_PAYMENTS_WORKFLOWS },
    jobs: { ...ERP_PAYMENTS_JOBS },
    views: { ...ERP_PAYMENTS_VIEWS },
  };
}
