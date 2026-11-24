import type { PathSegment, ResolvedPrincipal, RouteDefinition } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";
import { STARTER_CHART_VERSION, type ExtraGatewayRoute, type StarterChartReport } from "@crossengin/operate-runtime";
import { z } from "zod";

import type { TenantRecord } from "./platform-tenants.js";

/**
 * The starter chart of accounts, as a platform act on one tenant (ADR-0465).
 *
 * An approved access request creates the chart right after it commits; this route is the same
 * provisioning for every other way a workspace comes to lack one — a tenant created from the console
 * or by `deploy/onboard-tenant.sh`, a workspace approved before the chart existed, and an approval
 * whose chart was refused part-way. It is idempotent, so running it on a tenant that already has the
 * chart changes nothing and says so.
 */

/**
 * Provisions the starter chart for one tenant. The accounts are **written as `--job-actor-role`**,
 * not as the operator: a platform operator holds no grant inside a tenant (`platform_admin` reaches
 * no entity operation), so a write in the operator's name would be refused. That is a bounded
 * escalation and stated as one (ADR-0465): an operator holding only the platform-admin grant causes
 * writes authorised as that role, but chooses none of their content — a fixed set of accounts and
 * only finance settings nobody had set — and both the provisioning record and the approval's carry
 * the acting roles, so the trail says under whose authority the accounts were written. The operator
 * is `principalId`: the settings row's `updated_by` and the provisioning record's actor.
 */
export type StarterChartProvisioner = (
  tenantId: string,
  by: {
    readonly provisioningId: string;
    readonly principalId: string;
    /**
     * True only for an approved access request's new workspace: it alone may be switched to posting
     * tax remittances (ADR-0467). This route runs on existing tenants, which may be journalling
     * remittances by hand, so it passes false and the switch stays the tenant admin's.
     */
    readonly newWorkspace: boolean;
  },
) => Promise<StarterChartReport>;

export const STARTER_CHART_PROVISIONED_OPERATION = "platform.starter_chart_provisioned";

/** The record written before the accounts are: who asked for the chart, for which tenant, and the id the accounts' own audit rows carry. */
export interface StarterChartProvisioningEvent {
  readonly tenantId: string;
  readonly provisioningId: string;
  readonly principalId: string;
  /** The operator's roles: what authorised the act. */
  readonly roles: readonly string[];
  /** The roles the accounts are written as: what authorised each write. */
  readonly actingRoles: readonly string[];
  readonly chartVersion: string;
  readonly at: string;
}

export interface StarterChartRoutesContext {
  readonly tenants: { getById(id: string): Promise<TenantRecord | null> };
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  /** The platform-admin grant. Fail-closed: empty ⇒ nobody. */
  readonly adminRoles: ReadonlySet<string>;
  readonly provision: StarterChartProvisioner;
  /** `--job-actor-role`, recorded beside the operator's own roles. */
  readonly actingRoles: readonly string[];
  /** Written before any account is: an unrecordable provisioning is not performed (ADR-0313). */
  readonly record: (event: StarterChartProvisioningEvent) => Promise<void>;
  readonly newProvisioningId: () => string;
  readonly clock?: () => Date;
}

/** No options: what the chart contains is the platform's, and a tenant renames accounts afterwards. */
const ProvisionBodySchema = z.object({}).strict();

function json(status: number, body: unknown): HandlerOutput {
  return { kind: "json", status, body };
}

function buildProvisionHandler(ctx: StarterChartRoutesContext): Handler {
  return async ({ principal, params, parsedBody }) => {
    if (principal === null) return json(401, { error: "authentication_required" });
    const { primaryRole, secondaryRoles } = ctx.principalRoles(principal);
    const roles = [primaryRole, ...(secondaryRoles ?? [])];
    if (!roles.some((r) => ctx.adminRoles.has(r))) {
      return json(403, { error: "forbidden", detail: "insufficient role" });
    }
    const parsed = ProvisionBodySchema.safeParse(parsedBody ?? {});
    if (!parsed.success) return json(400, { error: "invalid_request", detail: "this route takes no options" });

    const id = params["id"] ?? "";
    const tenant = await ctx.tenants.getById(id);
    if (tenant === null) return json(404, { error: "tenant_not_found", detail: id });
    // Named here rather than left to the tenant-status gate, which would refuse every account with
    // the same 403 and leave the operator reading twenty-one identical refusals. Checked once: a
    // tenant suspended in the milliseconds between this read and the writes still receives the
    // accounts, which is the same window every job write has.
    if (tenant.status !== "active") {
      return json(409, {
        error: "tenant_not_active",
        detail: `tenant is ${tenant.status}; reactivate it before provisioning its chart of accounts`,
      });
    }

    const provisioningId = ctx.newProvisioningId();
    try {
      await ctx.record({
        tenantId: tenant.id,
        provisioningId,
        principalId: principal.principalId,
        roles,
        actingRoles: ctx.actingRoles,
        chartVersion: STARTER_CHART_VERSION,
        at: (ctx.clock ?? ((): Date => new Date()))().toISOString(),
      });
    } catch (err) {
      console.error("[starter-chart] provisioning not recorded, so not performed:", err);
      return json(503, {
        error: "audit_unavailable",
        detail: "a chart of accounts cannot be provisioned while the act cannot be recorded",
      });
    }
    try {
      const report = await ctx.provision(tenant.id, {
        provisioningId,
        principalId: principal.principalId,
        newWorkspace: false,
      });
      return json(200, { tenantId: tenant.id, provisioningId, starterChart: report });
    } catch (err) {
      const error = err instanceof Error ? err.name : "unknown";
      console.error(`[starter-chart] provisioning ${provisioningId} for tenant ${tenant.id} failed: ${error}`);
      return json(500, {
        error: "starter_chart_failed",
        provisioningId,
        detail: `${error}; accounts already created are kept, and running this again once the cause is fixed finishes the chart`,
      });
    }
  };
}

function route(operationId: string, segments: ReadonlyArray<string | { param: string }>): RouteDefinition {
  const pathSegments: PathSegment[] = segments.map((s) =>
    typeof s === "string" ? { kind: "literal", value: s } : { kind: "parameter", name: s.param, pattern: null },
  );
  return {
    id: `rt_${operationId.replace(/[^a-z0-9]+/gi, "_")}`,
    operationId,
    method: "POST",
    pathSegments,
    apiVersion: "v1",
    isDeprecated: false,
    deprecatedSince: null,
    sunsetAt: null,
    successorOperationId: null,
    requiredScopes: [],
    rateLimitPolicyId: null,
    idempotencyRequired: false,
    requestSchemaSha256: null,
    responseSchemaSha256: null,
  };
}

export function buildStarterChartRoutes(ctx: StarterChartRoutesContext): readonly ExtraGatewayRoute[] {
  return [
    {
      route: route("platform.tenants.starter_chart", ["v1", "platform", "tenants", { param: "id" }, "starter-chart"]),
      handler: buildProvisionHandler(ctx),
    },
  ];
}
