import type { PathSegment, ResolvedPrincipal, RouteDefinition } from "@crossengin/api-gateway";
import type { ExtraGatewayRoute } from "@crossengin/operate-runtime";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";
import { ed25519PublicKeyFingerprint } from "@crossengin/crypto";
import {
  PackCompatibilitySchema,
  PackManifestSchema,
  PackSignatureSchema,
  SECURITY_REVIEW_STATUSES,
  verifyPackPublisher,
  type PackCompatibility,
  type PackManifest,
  type PackPublisherRegistry,
  type PackSignature,
  type PublisherRefusal,
  type SecurityReviewStatus,
  type TenantContext,
} from "@crossengin/marketplace";
import type { PersistentMarketplaceInstallEngine, PostgresInstallationStore } from "@crossengin/marketplace-runtime-pg";
import { z } from "zod";

/**
 * One installable pack version as the catalog holds it. It carries no key: the signature names its
 * signer by fingerprint and the platform's publisher registry decides whether that signer may sign
 * this pack, because a key written beside the bundle it vouches for vouches for nothing.
 */
export interface PackCatalogEntry {
  readonly pack: PackManifest;
  readonly version: string;
  /** The version's bundle digest, which the signed release must name as it must the version. */
  readonly bundleSha256: string;
  readonly signature: PackSignature;
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
  bundleSha256: z.string().regex(/^[0-9a-f]{64}$/),
  signature: PackSignatureSchema,
  // Accepted so a catalog written before the registry still loads, and compared rather than
  // silently stripped: a stated key that disagrees with the signature it sits beside is a catalog
  // naming a different signer than it thinks, which is worth refusing at boot.
  publisherPublicKeyBase64: z.string().min(1).optional(),
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
  return new InMemoryPackCatalog(
    parsed.packs.map((entry) => {
      const { publisherPublicKeyBase64, ...rest } = entry;
      if (
        publisherPublicKeyBase64 !== undefined &&
        ed25519PublicKeyFingerprint(publisherPublicKeyBase64) !== entry.signature.publicKeyFingerprint
      ) {
        throw new Error(
          `catalog entry ${entry.pack.id}@${entry.version} states a publisher key that did not produce its signature`,
        );
      }
      return rest;
    }),
  );
}

export interface PackCatalogFinding {
  readonly packId: string;
  readonly version: string;
  readonly refusal: PublisherRefusal;
  readonly detail: string;
}

/** The catalog entries the registry would refuse at install, so an operator hears it at boot. */
export function surveyPackCatalog(catalog: PackCatalog, publishers: PackPublisherRegistry): readonly PackCatalogFinding[] {
  const out: PackCatalogFinding[] = [];
  for (const e of catalog.list()) {
    const v = verifyPackPublisher({
      manifest: e.pack,
      signature: e.signature,
      registry: publishers,
      submitted: { version: e.version, bundleSha256: e.bundleSha256 },
    });
    if (!v.ok) out.push({ packId: e.pack.id, version: e.version, refusal: v.refusal, detail: v.detail });
  }
  return out;
}

/**
 * The boot headline for the catalog. It counts entries the install path would admit as catalogued,
 * and deliberately does not call them "signed by a registered publisher": a release-mismatch finding
 * carries a signature that does verify against a registered key, so that label would undercount the
 * signed entries and assert something false about exactly the ones the findings name.
 */
export function formatPackCatalogSurvey(total: number, findings: readonly PackCatalogFinding[]): string {
  return `[marketplace] pack catalog: ${total.toString()} version(s), ${(total - findings.length).toString()} installable as catalogued, ${findings.length.toString()} refused at install`;
}

/**
 * What an install does in this deployment, sent with every admitted install so the response cannot
 * be read as more than it is. Nothing in this repository loads a pack bundle, and nothing consults
 * an installation's permission grants, so an install is a record of a tenant's request — it is
 * admitted against the publisher registry and the compatibility envelope, and that is all.
 */
export const PACK_INSTALL_EFFECT = Object.freeze({
  executesPack: false,
  grantsConsulted: false,
  detail:
    "recorded only: this deployment runs no pack installer and reads no installation's permission grants, " +
    "so an install is a record of the request and an uninstall removes the record",
});

/** The handler context for the marketplace admin routes. */
export interface MarketplaceAdminContext {
  readonly engine: PersistentMarketplaceInstallEngine;
  readonly store: PostgresInstallationStore;
  readonly catalog: PackCatalog;
  readonly publishers: PackPublisherRegistry;
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  /** Roles permitted to manage installs. Fail-closed: empty ⇒ nobody. */
  readonly adminRoles: ReadonlySet<string>;
  /**
   * What this deployment knows about one tenant, asked per install. A fact it does not know is
   * `null`, which refuses only a pack that constrains it (`checkCompatibility`).
   */
  readonly tenantContext: (tenantId: string) => Promise<TenantContext>;
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
      bundleSha256: entry.bundleSha256,
      compatibility: entry.compatibility,
      signature: entry.signature,
      publishers: ctx.publishers,
      securityReviewStatus: entry.securityReviewStatus,
      tenantContext: await ctx.tenantContext(tenantId),
    });

    if (decision.outcome === "rejected") {
      return json(409, { status: "rejected", reason: decision.reason, reasons: decision.reasons });
    }
    const status = decision.outcome === "admitted" ? 201 : 200;
    return json(status, { status: decision.outcome, installation: decision.installation, effect: PACK_INSTALL_EFFECT });
  };
}

/** `GET /v1/admin/packs` — the caller tenant's installations. */
export function buildPackListHandler(ctx: MarketplaceAdminContext): Handler {
  return async ({ principal }) => {
    const tenantId = authorize(ctx, principal);
    if (tenantId === null) return json(401, { error: "tenant_required" });
    if (tenantId === "") return json(403, { error: "forbidden", detail: "admin role required" });
    // `listForTenant` answers the pair, so the body carries the records and the refused rows are
    // reported rather than silently shortening the page. Not put in the body: this route has no
    // `page` object to hang a count on — `{ data }` is the whole shape — so an added key would be a
    // second response shape for one route, and `UnreadableRow`'s own contents are for an operator.
    const read = await ctx.store.listForTenant(tenantId);
    if (read.unreadable.length > 0) {
      console.error(
        `[marketplace] ${read.unreadable.length.toString()} unreadable installation row(s) ` +
          `for tenant ${tenantId}: ` +
          read.unreadable.map((u) => `${u.identity ?? "<unidentified>"} (${u.detail})`).join("; "),
      );
    }
    return json(200, { data: read.records });
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
      const gone = await ctx.engine.uninstall(installation, uninstalledBy);
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
