import type { PathSegment, ResolvedPrincipal, RouteDefinition } from "@crossengin/api-gateway";
import type { ExtraGatewayRoute } from "@crossengin/operate-runtime";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";
import {
  PackCompatibilitySchema,
  PackManifestSchema,
  PackSignatureSchema,
  SECURITY_REVIEW_STATUSES,
  type PackCompatibility,
  type PackManifest,
  type PackSignature,
  type SecurityReviewStatus,
  type TenantContext,
} from "@crossengin/marketplace";
import type { PersistentMarketplaceInstallEngine, PostgresInstallationStore } from "@crossengin/marketplace-runtime-pg";
import { z } from "zod";

/** One installable pack version as the catalog holds it — everything the install engine needs. */
export interface PackCatalogEntry {
  readonly pack: PackManifest;
  readonly version: string;
  readonly signature: PackSignature;
  readonly publisherPublicKeyBase64: string;
  readonly compatibility: PackCompatibility;
  readonly securityReviewStatus: SecurityReviewStatus;
}

/** The set of pack versions a deployment offers for install. */
export interface PackCatalog {
  get(packId: string, version: string): PackCatalogEntry | undefined;
  list(): readonly PackCatalogEntry[];
}

const CatalogEntrySchema = z.object({
  pack: PackManifestSchema,
  version: z.string().min(1),
  signature: PackSignatureSchema,
  publisherPublicKeyBase64: z.string().min(1),
  compatibility: PackCompatibilitySchema,
  securityReviewStatus: z.enum(SECURITY_REVIEW_STATUSES),
});

const CatalogFileSchema = z.object({ packs: z.array(CatalogEntrySchema) });

/** A static catalog keyed by `<packId>@<version>`. */
export class InMemoryPackCatalog implements PackCatalog {
  private readonly byKey = new Map<string, PackCatalogEntry>();
  private readonly entries: PackCatalogEntry[];

  constructor(entries: readonly PackCatalogEntry[]) {
    this.entries = [...entries];
    for (const e of this.entries) this.byKey.set(`${e.pack.id}@${e.version}`, e);
  }

  get(packId: string, version: string): PackCatalogEntry | undefined {
    return this.byKey.get(`${packId}@${version}`);
  }

  list(): readonly PackCatalogEntry[] {
    return this.entries;
  }
}

/** Parses + validates a catalog JSON document (`{ packs: [...] }`) into a catalog. */
export function loadPackCatalog(json: string): InMemoryPackCatalog {
  const parsed = CatalogFileSchema.parse(JSON.parse(json));
  return new InMemoryPackCatalog(parsed.packs);
}

/** The handler context for the marketplace admin routes. */
export interface MarketplaceAdminContext {
  readonly engine: PersistentMarketplaceInstallEngine;
  readonly store: PostgresInstallationStore;
  readonly catalog: PackCatalog;
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  /** Roles permitted to manage installs. Fail-closed: empty ⇒ nobody. */
  readonly adminRoles: ReadonlySet<string>;
  /** The deployment's tenant context (platform/region/plan/compliance) for compatibility checks. */
  readonly tenantContext: TenantContext;
}

function json(status: number, body: unknown): HandlerOutput {
  return { kind: "json", status, body };
}

/** Returns the tenant id when the principal is an admin, `""` when denied, `null` when unauthenticated. */
function authorize(ctx: MarketplaceAdminContext, principal: ResolvedPrincipal | null): string | null {
  const tenantId = principal?.tenantId ?? null;
  if (tenantId === null) return null;
  const { primaryRole, secondaryRoles } = ctx.principalRoles(principal);
  const roles = [primaryRole, ...(secondaryRoles ?? [])];
  return roles.some((r) => ctx.adminRoles.has(r)) ? tenantId : "";
}

const InstallBodySchema = z.object({ packId: z.string().min(1), version: z.string().min(1) });

/** `POST /v1/admin/packs/install` — installs a catalog pack for the caller's tenant via the persistent engine. */
export function buildPackInstallHandler(ctx: MarketplaceAdminContext): Handler {
  return async ({ principal, parsedBody }) => {
    const tenantId = authorize(ctx, principal);
    if (tenantId === null) return json(401, { error: "tenant_required" });
    if (tenantId === "") return json(403, { error: "forbidden", detail: "admin role required" });
    const requestedBy = principal?.principalId ?? null;
    if (requestedBy === null) return json(401, { error: "principal_required" });

    const parsed = InstallBodySchema.safeParse(parsedBody ?? {});
    if (!parsed.success) return json(400, { error: "invalid_request", detail: parsed.error.issues });

    const entry = ctx.catalog.get(parsed.data.packId, parsed.data.version);
    if (entry === undefined) return json(404, { error: "pack_not_found", detail: `${parsed.data.packId}@${parsed.data.version}` });

    const decision = await ctx.engine.install({
      tenantId,
      requestedBy,
      pack: entry.pack,
      version: entry.version,
      compatibility: entry.compatibility,
      signature: entry.signature,
      publisherPublicKeyBase64: entry.publisherPublicKeyBase64,
      securityReviewStatus: entry.securityReviewStatus,
      tenantContext: ctx.tenantContext,
    });

    if (decision.outcome === "rejected") {
      return json(409, { status: "rejected", reason: decision.reason });
    }
    const status = decision.outcome === "admitted" ? 201 : 200;
    return json(status, { status: decision.outcome, installation: decision.installation });
  };
}

/** `GET /v1/admin/packs` — the caller tenant's installations. */
export function buildPackListHandler(ctx: MarketplaceAdminContext): Handler {
  return async ({ principal }) => {
    const tenantId = authorize(ctx, principal);
    if (tenantId === null) return json(401, { error: "tenant_required" });
    if (tenantId === "") return json(403, { error: "forbidden", detail: "admin role required" });
    return json(200, { data: await ctx.store.listForTenant(tenantId) });
  };
}

/** `POST /v1/admin/packs/{id}/uninstall` — uninstalls one of the tenant's installations. */
export function buildPackUninstallHandler(ctx: MarketplaceAdminContext): Handler {
  return async ({ principal, params }) => {
    const tenantId = authorize(ctx, principal);
    if (tenantId === null) return json(401, { error: "tenant_required" });
    if (tenantId === "") return json(403, { error: "forbidden", detail: "admin role required" });
    const uninstalledBy = principal?.principalId ?? null;
    if (uninstalledBy === null) return json(401, { error: "principal_required" });

    const id = params["id"] ?? "";
    const installation = await ctx.store.get(tenantId, id);
    if (installation === null) return json(404, { error: "installation_not_found", detail: id });

    try {
      const uninstalling = await ctx.engine.beginUninstall(installation);
      const gone = await ctx.engine.completeUninstall(uninstalling, uninstalledBy);
      return json(200, { status: gone.status, installation: gone });
    } catch (err) {
      return json(409, { error: "invalid_transition", detail: err instanceof Error ? err.message : String(err) });
    }
  };
}

function route(operationId: string, method: RouteDefinition["method"], segments: ReadonlyArray<string | { param: string }>): RouteDefinition {
  const pathSegments: PathSegment[] = segments.map((s) =>
    typeof s === "string" ? { kind: "literal", value: s } : { kind: "parameter", name: s.param, pattern: null },
  );
  return {
    id: `rt_${operationId.replace(/[^a-z0-9]+/gi, "_")}`,
    operationId,
    method,
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

/** The marketplace admin routes to inject via the gateway's `extraRoutes` hook. */
export function buildMarketplaceAdminRoutes(ctx: MarketplaceAdminContext): readonly ExtraGatewayRoute[] {
  return [
    { route: route("admin.packs.list", "GET", ["v1", "admin", "packs"]), handler: buildPackListHandler(ctx) },
    { route: route("admin.packs.install", "POST", ["v1", "admin", "packs", "install"]), handler: buildPackInstallHandler(ctx) },
    {
      route: route("admin.packs.uninstall", "POST", ["v1", "admin", "packs", { param: "id" }, "uninstall"]),
      handler: buildPackUninstallHandler(ctx),
    },
  ];
}
