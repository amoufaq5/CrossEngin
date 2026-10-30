import type { HttpMethod, RouteDefinition } from "@crossengin/api-gateway";
import { renderPathTemplate } from "@crossengin/api-gateway";
import type { OpenApiCoverageGap } from "@crossengin/operate-runtime";

import { AUTH_TOKEN_PATH } from "./auth-token-route.js";
import { BOUNCE_WEBHOOK_PATH_PREFIX } from "./bounce-webhook-routes.js";
import { HEALTH_PATHS } from "./health.js";

/**
 * `POST /v1/webhooks/stripe`.
 *
 * The one of the five out-of-registry paths whose spelling had no constant: it was an inline
 * literal in `node.ts`'s `webhookRoute` assignment with two more copies in `cli.ts`'s `--help`
 * text, so moving the path would have left the help describing a route that no longer existed.
 * The other four already export theirs, which is why this module imports rather than restates them.
 */
export const STRIPE_WEBHOOK_PATH = "/v1/webhooks/stripe";

export const OUT_OF_REGISTRY_SURFACE_KINDS = [
  "liveness",
  "readiness",
  "credential_login",
  "bounce_webhook",
  "stripe_webhook",
] as const;
export type OutOfRegistrySurfaceKind = (typeof OUT_OF_REGISTRY_SURFACE_KINDS)[number];

export interface OutOfRegistrySurface {
  readonly methods: readonly HttpMethod[];
  /** The path, or its prefix where `pathKind` says so. */
  readonly path: string;
  readonly pathKind: "exact" | "prefix";
  /** What mounts it, in the words an operator reads in the boot log. */
  readonly mountedBy: string;
  /**
   * The symbol `node.ts` must still reference for this surface to be mounted at all — a builder
   * for the three interceptors, the assignment target for the webhook route.
   *
   * It is the fence's forward direction, and it is a *dependency* rather than a coincidence. The
   * obvious check — "the declared path appears in the mounting source" — is testing the wrong
   * thing, measured: **four of the five paths appear nowhere as a literal in `node.ts` or
   * `server.ts`**, because each reaches the mount through its own constant, and the fifth was the
   * inline literal this module replaces. So that check would have fired on four surfaces today and
   * on all five after the cleanup, which is a fence that reports its own subject improving.
   */
  readonly mountSymbol: string;
  /**
   * Whether an OpenAPI document can carry this surface honestly. `false` is a *shape* answer and
   * not a wiring one — see each entry's `note`.
   */
  readonly describable: boolean;
  readonly note: string;
}

/**
 * The five paths this binary serves that **no route registry holds**, so nothing derived from
 * `routes.list()` can see them.
 *
 * Four mechanisms produce them, and two of those sit in front of the gateway rather than inside it:
 * three `dispatchTarget` interceptor wrappers in `node.ts`, each
 * `(await intercept(raw, body)) ?? (await inner.dispatch(raw, body))`, plus `WebhookRoute`, matched
 * by exact method+path inside `OperateHttpServer.dispatch` under the comment
 * *"Signature-authenticated webhook ingress bypasses the gateway auth pipeline"*. So they are
 * invisible to `InMemoryRouteRegistry.list()`, to `matchRoute` and to
 * `HandlerRegistry.operationIds()` alike — which matters because the register's P1.17 names
 * `CompiledOperateServer.routeSpecs` as the document's source, and even the registry one layer out
 * from it is short by these five. One of them is the login, the first route any client calls.
 *
 * Declared here rather than derived, because only this app knows them: the mechanism is a closure
 * over a dispatch target, and there is no object to enumerate. The cost of a declaration is drift,
 * which `auditOutOfRegistrySurfaces` pays off by comparing it against the source **in both
 * directions** (ADR-0288: a one-way comparison is what the `needsAuditEmitter` list was, wrong four
 * times).
 */
export const OUT_OF_REGISTRY_SURFACES: Readonly<
  Record<OutOfRegistrySurfaceKind, OutOfRegistrySurface>
> = {
  liveness: {
    methods: ["GET", "HEAD"],
    path: HEALTH_PATHS.liveness,
    pathKind: "exact",
    mountedBy: "--health-routes",
    mountSymbol: "buildHealthInterceptor",
    describable: true,
    note: "Touches nothing and takes no credential (ADR-0357), so it is describable with an empty `security`.",
  },
  readiness: {
    methods: ["GET", "HEAD"],
    path: HEALTH_PATHS.readiness,
    pathKind: "exact",
    mountedBy: "--health-routes",
    mountSymbol: "buildHealthInterceptor",
    describable: true,
    note: "Checks the store and takes no credential; same shape as liveness with a different body.",
  },
  credential_login: {
    methods: ["POST"],
    path: AUTH_TOKEN_PATH,
    pathKind: "exact",
    mountedBy: "--credential-login",
    mountSymbol: "buildAuthTokenInterceptor",
    describable: true,
    note:
      "Takes no credential by construction — it issues one — so it is the one operation whose " +
      "`security: []` is the whole point rather than an omission. Every other method on this path " +
      "is a 405.",
  },
  bounce_webhook: {
    methods: ["POST"],
    path: BOUNCE_WEBHOOK_PATH_PREFIX,
    pathKind: "prefix",
    mountedBy: "--bounce-webhook",
    mountSymbol: "buildBounceWebhookInterceptor",
    describable: true,
    note:
      "`{tenantId}/{source}` follow the prefix, matched by `startsWith` rather than by a segment " +
      "array, so the template is written out rather than rendered. Authenticated by an HMAC over " +
      "the raw bytes under `crossengin-signature` — which is the payload-rather-than-principal " +
      "signature `AUTH_SCHEME_SUPPORT.hmac_signature` is `indistinguishable` for, so the scheme " +
      "has no `Authorization` position and this route still has an HMAC to describe.",
  },
  stripe_webhook: {
    methods: ["POST"],
    path: STRIPE_WEBHOOK_PATH,
    pathKind: "exact",
    mountedBy: "--stripe-webhook-secret",
    mountSymbol: "webhookRoute",
    describable: true,
    note:
      "Signature-authenticated the same way, under Stripe's own `stripe-signature` header rather " +
      "than ours.",
  },
};

/** Every out-of-registry surface the deployment mounted, as `(method, path)` pairs. */
export const mountedOutOfRegistryPaths = (
  mounted: ReadonlySet<OutOfRegistrySurfaceKind>,
): readonly { readonly method: HttpMethod; readonly path: string; readonly kind: OutOfRegistrySurfaceKind }[] => {
  const out: { method: HttpMethod; path: string; kind: OutOfRegistrySurfaceKind }[] = [];
  for (const kind of OUT_OF_REGISTRY_SURFACE_KINDS) {
    if (!mounted.has(kind)) continue;
    const surface = OUT_OF_REGISTRY_SURFACES[kind];
    for (const method of surface.methods) out.push({ method, path: surface.path, kind });
  }
  return out;
};

export const OUT_OF_REGISTRY_AUDIT_KINDS = [
  "interceptor_count_changed",
  "webhook_route_count_changed",
  "mount_symbol_absent_from_source",
] as const;
export type OutOfRegistryAuditKind = (typeof OUT_OF_REGISTRY_AUDIT_KINDS)[number];

export interface OutOfRegistryAuditFinding {
  readonly kind: OutOfRegistryAuditKind;
  readonly detail: string;
}

/**
 * The both-directions fence over the declaration above.
 *
 * Forward: every declared surface's `mountSymbol` must still be referenced by `node.ts`, so a
 * surface that was removed is a finding rather than an entry describing nothing. The symbol and not
 * the path, for the reason `mountSymbol`'s own comment measures.
 *
 * Backward — and this is the direction a declaration cannot give itself: the **count** of each
 * mechanism in the source must match what is declared, so a *sixth* interceptor somebody adds is a
 * finding rather than a path the document silently omits. The discriminators are measured rather
 * than guessed: `inner.dispatch(raw, body)` appears exactly 3 times, once per interceptor, and
 * `buildPerTenantDispatch` — the fourth `dispatchTarget` reassignment — does **not** match it,
 * because it replaces the dispatch rather than wrapping it. `webhookRoute = {` appears once.
 *
 * Text rather than types, because the mechanism is a closure assigned to a local: there is no
 * object for a type to enumerate, which is the same reason `compile.test.ts` reads its forwarding
 * literal as text (ADR-0386).
 */
export const auditOutOfRegistrySurfaces = (sources: {
  readonly nodeTs: string;
  readonly serverTs: string;
}): readonly OutOfRegistryAuditFinding[] => {
  const findings: OutOfRegistryAuditFinding[] = [];

  const interceptors = sources.nodeTs.split("inner.dispatch(raw, body)").length - 1;
  if (interceptors !== EXPECTED_INTERCEPTORS) {
    findings.push({
      kind: "interceptor_count_changed",
      detail:
        `node.ts wraps the dispatch target ${interceptors.toString()} times and ` +
        `${EXPECTED_INTERCEPTORS.toString()} interceptor surfaces are declared ` +
        `(${INTERCEPTOR_KINDS.join(", ")}). A wrapper the declaration does not name is a path no ` +
        `registry holds and no document describes.`,
    });
  }

  const webhookRoutes = sources.nodeTs.split("webhookRoute = {").length - 1;
  if (webhookRoutes !== EXPECTED_WEBHOOK_ROUTES) {
    findings.push({
      kind: "webhook_route_count_changed",
      detail:
        `node.ts assigns webhookRoute ${webhookRoutes.toString()} time(s) and ` +
        `${EXPECTED_WEBHOOK_ROUTES.toString()} is declared. OperateHttpServer matches it ahead of ` +
        `the gateway, so an undeclared one bypasses auth and the document alike.`,
    });
  }

  for (const kind of OUT_OF_REGISTRY_SURFACE_KINDS) {
    const { mountSymbol, path } = OUT_OF_REGISTRY_SURFACES[kind];
    if (!sources.nodeTs.includes(mountSymbol)) {
      findings.push({
        kind: "mount_symbol_absent_from_source",
        detail:
          `${kind} declares ${path}, mounted by \`${mountSymbol}\`, which node.ts no longer ` +
          `references — so either the surface is gone and the declaration describes nothing, or ` +
          `it moved and nothing here can find it.`,
      });
    }
  }
  return findings;
};

/** The three interceptor-mounted kinds, which is what `EXPECTED_INTERCEPTORS` counts. */
const INTERCEPTOR_KINDS: readonly OutOfRegistrySurfaceKind[] = [
  "bounce_webhook",
  "credential_login",
  "liveness",
];
const EXPECTED_INTERCEPTORS = 3;
const EXPECTED_WEBHOOK_ROUTES = 1;

export interface ServedSurface {
  /** Every route the registry holds, in registration order. */
  readonly registered: readonly RouteDefinition[];
  /** The mounted out-of-registry paths, which no registry holds. */
  readonly outOfRegistry: readonly {
    readonly method: HttpMethod;
    readonly path: string;
    readonly kind: OutOfRegistrySurfaceKind;
  }[];
  /**
   * `null` when this deployment serves one manifest. Under `--per-tenant-manifests` the surface is
   * **1 + N** registries — `TenantGatewayCache.serverFor` compiles one per tenant from that
   * tenant's own manifest — and nothing enumerates the N, so a document describes the boot
   * manifest and says so rather than claiming to describe the deployment.
   */
  readonly perTenantManifests: { readonly enumerable: false } | null;
}

/**
 * The deployment's whole served surface: the registry plus the five paths outside it.
 *
 * It exists because `routes.list()` reads as the complete answer and is not — which is a sharper
 * version of the same mistake the register's P1.17 makes one layer in, naming `routeSpecs` where
 * the registry was already the wider source. Both are subsets, and a document derived from either
 * without this declaration is falsely complete (ADR-0337) by three to five routes.
 */
export const servedSurface = (input: {
  readonly registered: readonly RouteDefinition[];
  readonly mounted: ReadonlySet<OutOfRegistrySurfaceKind>;
  readonly perTenantManifests: boolean;
}): ServedSurface => ({
  registered: input.registered,
  outOfRegistry: mountedOutOfRegistryPaths(input.mounted),
  perTenantManifests: input.perTenantManifests ? { enumerable: false } : null,
});

/**
 * The out-of-registry surfaces this deployment mounted, as the coverage gaps an API description
 * carries — one per `(method, path)` pair, so a reader learns the path and the method rather than
 * only that something is missing.
 *
 * Which matters most for exactly one of the five: `POST /v1/auth/token` is the **login**, the first
 * route any client calls, and a document that merely said "some paths are not described" would
 * leave a client unable to discover how to authenticate against the API it is reading.
 *
 * `reach` is **`ordering`** for every entry and not `shape`, because all five declare
 * `describable: true` — the bodies exist and this emitter is not given them. That is the honest
 * word and it is the one that tells the next person the follow-up is wiring rather than a format
 * change (`pg-unreachable-stores.ts`'s distinction, which is why `describable` is a field here).
 *
 * The caller passes a set each mount site has added itself to, rather than one derived from the
 * flags a second time: three of the four mounts run after the gateway is built and two of their
 * conditions are compound, so a re-derivation is where the declaration and the mount drift.
 */
export const coverageFromMountedSurfaces = (
  mounted: ReadonlySet<OutOfRegistrySurfaceKind>,
): readonly OpenApiCoverageGap[] =>
  mountedOutOfRegistryPaths(mounted).map(({ method, path, kind }) => {
    const surface = OUT_OF_REGISTRY_SURFACES[kind];
    const where = surface.pathKind === "prefix" ? `${path}…` : path;
    return {
      kind: "surface_outside_registry" as const,
      reach: "ordering" as const,
      detail:
        `${method} ${where} is served and is not described here. It is mounted by ` +
        `\`${surface.mountedBy}\` ahead of route matching, so no route registry holds it. ` +
        surface.note,
    };
  });

/** The registered routes an OpenAPI document cannot carry, with the reason per route. */
export const undescribableRegisteredRoutes = (
  registered: readonly RouteDefinition[],
): readonly { readonly operationId: string; readonly reason: "wildcard_path" }[] => {
  const out: { operationId: string; reason: "wildcard_path" }[] = [];
  for (const route of registered) {
    if (renderPathTemplate(route.pathSegments, "openapi").template === null) {
      out.push({ operationId: route.operationId, reason: "wildcard_path" });
    }
  }
  return out;
};
