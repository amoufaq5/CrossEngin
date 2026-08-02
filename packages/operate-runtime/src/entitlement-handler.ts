import type { Handler, HandlerOutput } from "@crossengin/api-gateway-runtime";

import type { EntitlementResolver, EntitlementStatus } from "./entitlement.js";

export interface EntitlementHandlerContext {
  readonly resolver: EntitlementResolver;
}

/** The caller tenant's own subscription state, flattened for the billing screen. */
export interface EntitlementView {
  readonly status: EntitlementStatus | null;
  readonly planId: string | null;
  readonly maxRecordsPerEntity: number | null;
  readonly features: readonly string[];
}

function json(status: number, body: unknown): HandlerOutput {
  return { kind: "json", status, body };
}

/**
 * `GET /v1/meta/entitlement` — the caller tenant's own subscription/plan state. No
 * finance-role gate: a principal may always read their OWN tenant's plan (so a lapsed
 * tenant can still load their billing screen — this route is registered ungated). A null
 * entitlement (no subscription) yields an all-null/empty view rather than an error.
 */
export function buildEntitlementHandler(ctx: EntitlementHandlerContext): Handler {
  return async ({ principal }) => {
    const tenantId = principal?.tenantId ?? null;
    if (tenantId === null) return json(401, { error: "tenant_required" });
    const entitlement = await ctx.resolver.resolve(tenantId);
    const view: EntitlementView =
      entitlement === null
        ? { status: null, planId: null, maxRecordsPerEntity: null, features: [] }
        : {
            status: entitlement.status,
            planId: entitlement.planId ?? null,
            maxRecordsPerEntity: entitlement.maxRecordsPerEntity ?? null,
            features: entitlement.features ?? [],
          };
    return json(200, view);
  };
}
