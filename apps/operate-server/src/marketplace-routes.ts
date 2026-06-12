import type { PathSegment, RouteDefinition } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput } from "@crossengin/api-gateway-runtime";
import type { InstallationStatus, UpdatePolicy } from "@crossengin/marketplace";
import {
  PostgresPackInstallationStore,
  beginInstall,
  completeInstall,
  completeUninstall,
  newInstallationRequest,
  requestUninstall,
} from "@crossengin/marketplace-pg";
import type { Manifest } from "@crossengin/kernel/manifest";
import { routeId, type ExtraRoute } from "@crossengin/operate-runtime";

import { resolveInstalledManifests, surfaceFromResolved, type PackManifestResolver } from "./tenant-surface.js";
import { tenantRouteSummaries } from "./tenant-compile.js";

const MARKETPLACE_LIST_OP = "marketplace.list";
const MARKETPLACE_INSTALL_OP = "marketplace.install";
const MARKETPLACE_UNINSTALL_OP = "marketplace.uninstall";
const MARKETPLACE_SURFACE_OP = "marketplace.surface";

const VALID_STATUSES: ReadonlySet<string> = new Set([
  "requested",
  "permission_pending",
  "installing",
  "installed",
  "updating",
  "failed",
  "uninstalling",
  "uninstalled",
]);
const VALID_POLICIES: ReadonlySet<string> = new Set(["manual", "patch_auto", "minor_auto", "track_latest"]);

function lit(value: string): PathSegment {
  return { kind: "literal", value };
}
const PACK_PARAM: PathSegment = { kind: "parameter", name: "packId", pattern: null };

function routeDef(operationId: string, method: RouteDefinition["method"], segments: readonly PathSegment[]): RouteDefinition {
  return {
    id: routeId(operationId),
    operationId,
    method,
    pathSegments: [...segments],
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

function firstQuery(query: Readonly<Record<string, string | string[]>>, key: string): string | null {
  const v = query[key];
  if (v === undefined) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

export interface MarketplaceRouteDeps {
  readonly now: () => Date;
  readonly newId: () => string;
  /**
   * Optional pack-manifest resolver. When set, a `GET /v1/marketplace/surface`
   * route composes the tenant's installed packs into their effective entity/view
   * surface (resolving each pack's manifest via the seam).
   */
  readonly resolver?: PackManifestResolver;
  /**
   * The base served manifest. When supplied with a `resolver`, the surface also
   * reports the per-tenant REST `routes` the composed (base + installs) manifest
   * would serve — derived from the same `manifestRouteSpecs` the gateway compiles.
   */
  readonly baseManifest?: Manifest;
  /**
   * Notified with the affected tenant after a successful install/uninstall write.
   * The per-tenant dispatcher wires this to `TenantDispatcher.invalidate` so a
   * write is reflected on the next request instead of after the cache TTL.
   */
  readonly onInstallChange?: (tenantId: string) => void;
  /**
   * Notified (and **awaited**) with the installed pack id + version after a
   * successful install write, before the 201 response. Under `--store pg-columns`
   * this provisions the installed pack's typed per-entity tables (an idempotent
   * `ensureSchema` over the composed manifest), so the per-tenant column-store
   * CRUD that the 201's caller is about to drive can't race ahead of the DDL.
   * Not fired on the 409/422 rejection paths.
   */
  readonly onPackInstalled?: (packId: string, version: string) => Promise<void> | void;
}

/**
 * The tenant-facing marketplace install HTTP surface (P5.1 follow-up) — the
 * gateway counterpart of the `marketplace` CLI. Three routes ride the full
 * pipeline (auth → principal → tenant); the tenant is the **authenticated
 * principal's** tenant (never a request parameter), and the actor is the
 * principal's id, so a caller can only manage their own tenant's installs. Each
 * write drives the guarded install-lifecycle engine and persists via the
 * RLS-scoped store.
 */
export function buildMarketplaceRoutes(
  store: PostgresPackInstallationStore,
  deps: MarketplaceRouteDeps,
): readonly ExtraRoute[] {
  const listHandler: Handler = async ({ request, principal }) => {
    const tenantId = principal?.tenantId ?? null;
    if (tenantId === null) return json(401, { error: "tenant_required", detail: "request principal has no tenant" });
    const statusRaw = firstQuery(request.query, "status");
    const status = statusRaw !== null && VALID_STATUSES.has(statusRaw) ? (statusRaw as InstallationStatus) : undefined;
    const installations = await store.listForTenant(tenantId, status !== undefined ? { status } : {});
    return json(200, { installations });
  };

  const installHandler: Handler = async ({ principal, parsedBody }) => {
    const tenantId = principal?.tenantId ?? null;
    const by = principal?.principalId ?? null;
    if (tenantId === null || by === null) return json(401, { error: "tenant_required", detail: "request principal has no tenant" });
    const body = parsedBody ?? {};
    const packId = typeof body["packId"] === "string" ? (body["packId"] as string) : null;
    const version = typeof body["version"] === "string" ? (body["version"] as string) : null;
    if (packId === null || version === null) {
      return json(422, { error: "invalid_request", detail: "packId + version are required" });
    }
    const policyRaw = body["updatePolicy"];
    const updatePolicy = typeof policyRaw === "string" && VALID_POLICIES.has(policyRaw) ? (policyRaw as UpdatePolicy) : undefined;

    const existing = await store.activeForPack(tenantId, packId);
    if (existing !== null) {
      return json(409, { error: "already_installed", detail: `${packId} already has an active installation (${existing.status})` });
    }
    const now = deps.now().toISOString();
    let requested;
    try {
      requested = newInstallationRequest({
        id: deps.newId(),
        tenantId,
        packId,
        requestedBy: by,
        requestedAt: now,
        ...(updatePolicy !== undefined ? { updatePolicy } : {}),
      });
    } catch {
      return json(422, { error: "invalid_request", detail: `invalid packId '${packId}'` });
    }
    const installed = completeInstall(beginInstall(requested), { version, installedBy: by, at: now });
    await store.record(installed);
    deps.onInstallChange?.(tenantId);
    // Provision the installed pack's typed per-entity tables (column store only) —
    // awaited so the tables exist before the 201, ahead of the caller's next CRUD.
    await deps.onPackInstalled?.(packId, version);
    return json(201, { installation: installed });
  };

  const uninstallHandler: Handler = async ({ principal, params }) => {
    const tenantId = principal?.tenantId ?? null;
    const by = principal?.principalId ?? null;
    if (tenantId === null || by === null) return json(401, { error: "tenant_required", detail: "request principal has no tenant" });
    const packId = params["packId"] ?? "";
    const active = await store.activeForPack(tenantId, packId);
    if (active === null || active.status !== "installed") {
      return json(404, { error: "not_installed", detail: `${packId} is not installed` });
    }
    const uninstalled = completeUninstall(requestUninstall(active), { uninstalledBy: by, at: deps.now().toISOString() });
    await store.record(uninstalled);
    deps.onInstallChange?.(tenantId);
    return json(200, { installation: uninstalled });
  };

  const routes: ExtraRoute[] = [
    {
      definition: routeDef(MARKETPLACE_LIST_OP, "GET", [lit("v1"), lit("marketplace"), lit("installations")]),
      operationId: MARKETPLACE_LIST_OP,
      handler: listHandler,
    },
    {
      definition: routeDef(MARKETPLACE_INSTALL_OP, "POST", [lit("v1"), lit("marketplace"), lit("installations")]),
      operationId: MARKETPLACE_INSTALL_OP,
      handler: installHandler,
    },
    {
      definition: routeDef(MARKETPLACE_UNINSTALL_OP, "DELETE", [lit("v1"), lit("marketplace"), lit("installations"), PACK_PARAM]),
      operationId: MARKETPLACE_UNINSTALL_OP,
      handler: uninstallHandler,
    },
  ];

  // P5.3/P5.4: resolve the tenant's installed packs into their effective surface
  // (entities/views) + the per-tenant REST routes the composed manifest would serve.
  if (deps.resolver !== undefined) {
    const resolver = deps.resolver;
    const baseManifest = deps.baseManifest;
    const surfaceHandler: Handler = async ({ principal }) => {
      const tenantId = principal?.tenantId ?? null;
      if (tenantId === null) return json(401, { error: "tenant_required", detail: "request principal has no tenant" });
      const installed = await store.listForTenant(tenantId, { status: "installed" });
      const resolved = await resolveInstalledManifests(installed, resolver);
      const surface = surfaceFromResolved(resolved);
      const routes =
        baseManifest !== undefined
          ? tenantRouteSummaries(
              baseManifest,
              resolved.flatMap((r) => (r.manifest !== null ? [r.manifest] : [])),
            )
          : [];
      return json(200, { surface: { ...surface, routes } });
    };
    routes.push({
      definition: routeDef(MARKETPLACE_SURFACE_OP, "GET", [lit("v1"), lit("marketplace"), lit("surface")]),
      operationId: MARKETPLACE_SURFACE_OP,
      handler: surfaceHandler,
    });
  }

  return routes;
}
