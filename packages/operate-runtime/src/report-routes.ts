import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { PathSegment, RouteDefinition } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput } from "@crossengin/api-gateway-runtime";

import { routeId } from "./slugs.js";

/**
 * The arguments a `ReportRunner` receives for one request: the authenticated
 * tenant (the gateway has already resolved + cross-checked it), the resolved
 * principal (so the runner can derive the caller's roles for field-level
 * redaction), and the parsed query string. The runner owns RBAC + redaction —
 * exactly as the per-route handlers do — so `operate-runtime` stays free of any
 * report-execution / classification logic (which lives in `@crossengin/operate-web`
 * + `@crossengin/operate-runtime-pg`).
 */
export interface ReportRunArgs {
  readonly tenantId: string;
  readonly principal: ResolvedPrincipal | null;
  readonly query: Readonly<Record<string, string | string[]>>;
}

/**
 * Runs a named manifest report for a caller, returning the computed report data
 * (any serializable shape) or `null` when the report is unknown, of an
 * unsupported kind, or references a field the caller can't read (fail-closed).
 */
export interface ReportRunner {
  run(name: string, args: ReportRunArgs): Promise<unknown | null>;
}

/** The single operationId all report requests dispatch to. */
export const REPORT_RUN_OPERATION_ID = "report.run";

function lit(value: string): PathSegment {
  return { kind: "literal", value };
}

const REPORT_PARAM: PathSegment = { kind: "parameter", name: "report", pattern: null };

/**
 * The one parametric gateway route serving every report: `GET /v1/reports/:report`.
 * A single route (not one per report name) keeps the registry small and lets new
 * reports be served without re-registration.
 */
export function reportRouteDefinition(): RouteDefinition {
  return {
    id: routeId(REPORT_RUN_OPERATION_ID),
    operationId: REPORT_RUN_OPERATION_ID,
    method: "GET",
    pathSegments: [lit("v1"), lit("reports"), REPORT_PARAM],
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

function json(status: number, body: unknown): HandlerOutput {
  return { kind: "json", status, body };
}

/**
 * Builds the gateway `Handler` for the report route: requires a tenant (401
 * otherwise), reads the `:report` path parameter, and delegates to the injected
 * runner. A `null` result is a fail-closed 404 (`report_unavailable`) — the
 * caller is never told whether the report is unknown vs. unreadable. The runner
 * has already applied per-field redaction, so the gateway's `transform_response`
 * stage (keyed by entity read operationIds) correctly leaves report data alone.
 */
export function buildReportHandler(runner: ReportRunner): Handler {
  return async ({ request, principal, params }) => {
    const tenantId = principal?.tenantId ?? null;
    if (tenantId === null) {
      return json(401, { error: "tenant_required", detail: "request principal has no tenant" });
    }
    const name = params["report"] ?? "";
    const data = await runner.run(name, { tenantId, principal: principal ?? null, query: request.query });
    if (data === null) {
      return json(404, { error: "report_unavailable", detail: `no readable report '${name}'` });
    }
    return json(200, data);
  };
}
