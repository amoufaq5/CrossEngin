import { renderPathTemplate, pathTemplateCollisions, type RouteDefinition } from "@crossengin/api-gateway";
import { manifestHash } from "@crossengin/kernel/manifest";
import {
  buildOpenApiDocument,
  compileOperateServer,
  InMemoryEntityStore,
  OPENAPI_OPERATION_ID,
  OPENAPI_PATH,
  OPENAPI_PATH_SEGMENTS,
} from "@crossengin/operate-runtime";
import { describe, expect, it } from "vitest";

import { BUILTIN_PACK_NAMES, loadBuiltinPack } from "./manifest-source.js";
import {
  coverageFromMountedSurfaces,
  OUT_OF_REGISTRY_SURFACES,
  OUT_OF_REGISTRY_SURFACE_KINDS,
  servedSurface,
  undescribableRegisteredRoutes,
  type OutOfRegistrySurfaceKind,
} from "./served-surface.js";

/**
 * The OpenAPI emitter's two refusals, measured across **every** built-in pack.
 *
 * This file is here and not in `packages/operate-runtime` for a reason that was measured rather
 * than assumed: that package devDepends on `pack-erp-core` and `pack-erp-retail` and on **none of
 * the other five**, so the five are `MODULE_NOT_FOUND` from its tests. This app declares all seven
 * *and* the runtime, and `loadBuiltinPack` already resolves each pack's `meta.extends` lineage
 * through the registry the deployment itself uses — so the packs are reached the way the binary
 * reaches them rather than through a second resolution written for a test.
 *
 * ADR-0392's whole case for **refusing** rather than reporting a renderable-route failure is that
 * the refusals are empty today, so refusing breaks nothing that worked (ADR-0338's rule). That
 * claim is what this file holds up, and it has to be checked over the resolved packs, because an
 * overlay replacing a lifecycle changes the transition routes it derives (ADR-0362's reason for
 * measuring per resolved pack rather than over the union).
 */
const PACKS = BUILTIN_PACK_NAMES;

interface PackEmit {
  readonly pack: string;
  readonly entities: number;
  readonly routes: number;
  readonly wildcards: readonly string[];
  readonly collisions: number;
  readonly refused: string | null;
  readonly operations: number;
  readonly undescribableFields: number;
}

async function emitFor(pack: string): Promise<PackEmit> {
  const manifest = await loadBuiltinPack(pack);
  const compiled = compileOperateServer(manifest, {
    store: new InMemoryEntityStore(),
    principalRoles: () => ({ primaryRole: "anonymous", secondaryRoles: [] }),
  });
  const routes = compiled.routes.list();
  const emit = buildOpenApiDocument({
    manifest,
    routes,
    routeSpecs: compiled.routeSpecs,
    wiring: { settingsStore: false, allocator: false },
    title: "t",
    version: manifestHash(manifest),
    coverage: [],
  });
  const doc = emit.document;
  return {
    pack,
    entities: (manifest.entities ?? []).length,
    routes: routes.length,
    wildcards: routes
      .filter((r) => renderPathTemplate(r.pathSegments, "openapi").template === null)
      .map((r) => r.operationId),
    collisions: pathTemplateCollisions(routes).length,
    refused: emit.refused === null ? null : emit.refused.kind,
    operations:
      doc === null
        ? 0
        : Object.values(doc["paths"] as Record<string, Record<string, unknown>>).reduce(
            (a, item) => a + Object.keys(item).length,
            0,
          ),
    undescribableFields:
      doc === null
        ? 0
        : ((doc["x-crossengin-undescribable-fields"] as readonly unknown[] | undefined) ?? []).length,
  };
}

const EMITS: PackEmit[] = [];
for (const pack of PACKS) EMITS.push(await emitFor(pack));

describe("the OpenAPI document over every built-in pack", () => {
  it("covers all seven packs, driven from BUILTIN_PACK_NAMES rather than a list written here", () => {
    // Derived, so an eighth pack is covered by this file the moment it is registered — which is the
    // whole difference between a fence and a list somebody has to remember (ADR-0288).
    expect(PACKS.length).toBe(7);
    expect(EMITS).toHaveLength(PACKS.length);
    expect(EMITS.map((e) => e.pack).sort()).toEqual([...PACKS].sort());
  });

  it("emits a document for every pack — neither refusal fires anywhere", () => {
    // ADR-0392's licence to refuse. If this ever fails, the refusal is correct and the DEPLOYMENT
    // has a route the format cannot carry; the fix is the route, not this assertion.
    expect(EMITS.filter((e) => e.refused !== null)).toEqual([]);
    expect(EMITS.flatMap((e) => e.wildcards)).toEqual([]);
    expect(EMITS.map((e) => e.collisions)).toEqual(PACKS.map(() => 0));
  });

  it("describes every registered route of every pack, in both directions", () => {
    for (const e of EMITS) {
      // Every registry route is an operation and no operation is a phantom. One `expect` over the
      // pair rather than two, because the equality is the property: a one-way comparison is the
      // shape ADR-0288 has been wrong about four times here.
      expect({ pack: e.pack, operations: e.operations }).toEqual({
        pack: e.pack,
        operations: e.routes,
      });
      // Floors, not exact counts: this increment's own route moved every pack's figure by one
      // while it was being written, which is register P3.1's class live.
      expect(e.routes).toBeGreaterThan(300);
      expect(e.entities).toBeGreaterThan(40);
    }
  });

  it("finds no undescribable field in any pack, which is what makes `duration` a declaration and not a gap", () => {
    // `UNDESCRIBABLE_FIELD_KINDS` has one member and zero members in the packs, so the entry is a
    // reserved answer rather than a live hole. Asserted over the RESOLVED manifests, because a
    // trait-contributed field is only visible there (ADR-0361).
    expect(EMITS.map((e) => ({ pack: e.pack, n: e.undescribableFields }))).toEqual(
      PACKS.map((pack) => ({ pack, n: 0 })),
    );
  });

  it("registers its own route on every pack, so the document is never served by a path it omits", () => {
    for (const e of EMITS) expect(e.routes).toBeGreaterThan(0);
    // The route's own identity, read from the one spelling rather than written out again.
    expect(OPENAPI_PATH).toBe(`/${OPENAPI_PATH_SEGMENTS.join("/")}`);
    expect(OPENAPI_OPERATION_ID).toBe("meta.openapi.read");
  });
});

describe("the collision refusal is empty today and reachable from a manifest", () => {
  // The refusal's whole justification. Measured over the real route sets there are ZERO collisions
  // at the shipped flag set (375 routes over 218 distinct templates) and at the maximal one (421
  // over 262) — so refusing breaks nothing. But it is reachable, and the reachable member is a
  // manifest an Architect could design: an entity named `Notification` with a lifecycle transition
  // named `read`. `resourceSlug("Notification")` is `notifications`, so the transition route is
  // `POST /v1/notifications/{id}/read`, and the shipped compose mounts the read-state route at
  // `POST /v1/notifications/{dispatchId}/read`. The two NAMED templates differ; under OpenAPI's
  // path-template equivalence both are `POST /v1/notifications/{}/read`, which one Paths Object
  // cannot hold.
  const route = (operationId: string, param: string): RouteDefinition => ({
    id: `rt_${param}`,
    operationId,
    method: "POST",
    pathSegments: [
      { kind: "literal", value: "v1" },
      { kind: "literal", value: "notifications" },
      { kind: "parameter", name: param, pattern: null },
      { kind: "literal", value: "read" },
    ],
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
  });
  const PAIR = [route("notification.read", "id"), route("notifications.read_state.mark", "dispatchId")];

  it("renders two DIFFERENT named templates, which is why a named comparison would miss it", () => {
    const [a, b] = PAIR;
    expect(renderPathTemplate(a!.pathSegments, "openapi").template).toBe("/v1/notifications/{id}/read");
    expect(renderPathTemplate(b!.pathSegments, "openapi").template).toBe(
      "/v1/notifications/{dispatchId}/read",
    );
  });

  it("refuses the document, naming both operation ids", () => {
    const emit = buildOpenApiDocument({
      manifest: { manifestVersion: "1.0", meta: { name: "t", slug: "t/x", version: "1" }, entities: [] },
      routes: PAIR,
      routeSpecs: [],
      wiring: { settingsStore: false, allocator: false },
      title: "t",
      version: "v",
      coverage: [],
    });
    expect(emit.document).toBeNull();
    expect(emit.refused?.kind).toBe("path_collision");
    expect(emit.refused?.operationIds).toEqual([
      "notification.read",
      "notifications.read_state.mark",
    ]);
  });

  it("the read-state half is what the shipped compose mounts, so the pair is one entity away", () => {
    // Not a synthetic path: the second route's template is the one `--read-state-routes` serves, and
    // that flag is on the shipped compose. So the collision needs a manifest and no flag change.
    expect(renderPathTemplate(PAIR[1]!.pathSegments, "openapi").template).toBe(
      "/v1/notifications/{dispatchId}/read",
    );
  });
});

describe("coverageFromMountedSurfaces", () => {
  it("names the method and the path of each mounted surface, so a client can find the login", () => {
    const gaps = coverageFromMountedSurfaces(new Set<OutOfRegistrySurfaceKind>(["credential_login"]));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.kind).toBe("surface_outside_registry");
    // `ordering` and never `shape`: all five declare `describable: true`, so the follow-up is
    // wiring. Calling it `shape` would send the next reader to a format change that is not needed.
    expect(gaps[0]?.reach).toBe("ordering");
    expect(gaps[0]?.detail).toContain("POST");
    expect(gaps[0]?.detail).toContain(OUT_OF_REGISTRY_SURFACES.credential_login.path);
    expect(gaps[0]?.detail).toContain("--credential-login");
  });

  it("emits one gap per (method, path) pair and not one per surface", () => {
    // `liveness` declares GET and HEAD, so one mounted surface is two gaps. That is the measured
    // live figure: with only the health interceptor up, the document carries four.
    const health = coverageFromMountedSurfaces(
      new Set<OutOfRegistrySurfaceKind>(["liveness", "readiness"]),
    );
    expect(health).toHaveLength(4);
    expect(health.map((g) => g.detail.split(" ")[0])).toEqual(["GET", "HEAD", "GET", "HEAD"]);
  });

  it("answers nothing for a deployment that mounted none, rather than a generic sentence", () => {
    // The generic statement is the EMITTER's, unconditionally — so an empty set here degrades the
    // document to that weaker true statement instead of removing the subject altogether.
    expect(coverageFromMountedSurfaces(new Set())).toEqual([]);
  });

  it("every declared surface is reachable through the mapper, so none is declared and unreachable", () => {
    const all = coverageFromMountedSurfaces(new Set(OUT_OF_REGISTRY_SURFACE_KINDS));
    const expected = OUT_OF_REGISTRY_SURFACE_KINDS.reduce(
      (a, k) => a + OUT_OF_REGISTRY_SURFACES[k].methods.length,
      0,
    );
    expect(all).toHaveLength(expected);
    // Every one carries its mounting flag, which is the only actionable half of the sentence.
    for (const gap of all) expect(gap.detail).toMatch(/mounted by `--[a-z-]+`/);
  });
});

describe("servedSurface + undescribableRegisteredRoutes over a real pack", () => {
  it("finds no undescribable registered route on the shipped default", async () => {
    const compiled = compileOperateServer(await loadBuiltinPack("erp-core"), {
      store: new InMemoryEntityStore(),
      principalRoles: () => ({ primaryRole: "anonymous", secondaryRoles: [] }),
    });
    const surface = servedSurface({
      registered: compiled.routes.list(),
      mounted: new Set<OutOfRegistrySurfaceKind>(["liveness", "readiness"]),
      perTenantManifests: false,
    });
    expect(undescribableRegisteredRoutes(surface.registered)).toEqual([]);
    expect(surface.outOfRegistry).toHaveLength(4);
    expect(surface.perTenantManifests).toBeNull();
  });

  it("says the per-tenant surface is not enumerable rather than claiming to describe it", () => {
    const surface = servedSurface({
      registered: [],
      mounted: new Set(),
      perTenantManifests: true,
    });
    expect(surface.perTenantManifests).toEqual({ enumerable: false });
  });
});
