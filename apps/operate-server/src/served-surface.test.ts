import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { RouteDefinition } from "@crossengin/api-gateway";

import {
  OUT_OF_REGISTRY_AUDIT_KINDS,
  OUT_OF_REGISTRY_SURFACES,
  OUT_OF_REGISTRY_SURFACE_KINDS,
  STRIPE_WEBHOOK_PATH,
  auditOutOfRegistrySurfaces,
  mountedOutOfRegistryPaths,
  servedSurface,
  undescribableRegisteredRoutes,
} from "./served-surface.js";

const NODE_TS = readFileSync(new URL("./node.ts", import.meta.url), "utf8");
const SERVER_TS = readFileSync(new URL("./server.ts", import.meta.url), "utf8");

const route = (operationId: string, segs: RouteDefinition["pathSegments"]): RouteDefinition => ({
  id: "rt_abcdefgh",
  operationId,
  method: "GET",
  pathSegments: segs,
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

describe("OUT_OF_REGISTRY_SURFACES", () => {
  it("declares all five kinds, with a method, a path and a mount symbol each", () => {
    expect(OUT_OF_REGISTRY_SURFACE_KINDS).toHaveLength(5);
    for (const kind of OUT_OF_REGISTRY_SURFACE_KINDS) {
      const s = OUT_OF_REGISTRY_SURFACES[kind];
      expect(s.methods.length, kind).toBeGreaterThan(0);
      expect(s.path.startsWith("/"), kind).toBe(true);
      expect(s.mountSymbol.length, kind).toBeGreaterThan(0);
      expect(s.note.length, kind).toBeGreaterThan(20);
    }
  });

  it("yields seven (method, path) pairs when every surface is mounted", () => {
    // Five surfaces, seven pairs: the two health probes answer GET and HEAD alike.
    const all = mountedOutOfRegistryPaths(new Set(OUT_OF_REGISTRY_SURFACE_KINDS));
    expect(all).toHaveLength(7);
    expect(all.filter((p) => p.method === "HEAD")).toHaveLength(2);
    expect(all.map((p) => p.path)).toContain(STRIPE_WEBHOOK_PATH);
  });

  it("yields only what the deployment mounted", () => {
    expect(mountedOutOfRegistryPaths(new Set())).toEqual([]);
    expect(mountedOutOfRegistryPaths(new Set(["credential_login"]))).toEqual([
      { method: "POST", path: "/v1/auth/token", kind: "credential_login" },
    ]);
  });
});

describe("auditOutOfRegistrySurfaces", () => {
  it("finds nothing against the real node.ts and server.ts", () => {
    expect(auditOutOfRegistrySurfaces({ nodeTs: NODE_TS, serverTs: SERVER_TS })).toEqual([]);
  });

  it("is not vacuous: the discriminators it counts are present in the real source", () => {
    // If the spelling it counts ever stopped being the spelling, every count would read 0 and the
    // fence would fire — which is the safe direction, but the floor makes the reason legible rather
    // than leaving a reader to wonder whether three findings mean three new interceptors.
    expect(NODE_TS.split("inner.dispatch(raw, body)").length - 1).toBe(3);
    expect(NODE_TS.split("webhookRoute = {").length - 1).toBe(1);
  });

  it("reports a fourth interceptor, which is a path no registry holds", () => {
    const withAnother = `${NODE_TS}\n// (await x(raw, body)) ?? (await inner.dispatch(raw, body))\n`;
    const found = auditOutOfRegistrySurfaces({ nodeTs: withAnother, serverTs: SERVER_TS });
    expect(found.map((f) => f.kind)).toEqual(["interceptor_count_changed"]);
    expect(found[0]?.detail).toContain("4 times");
  });

  it("reports a second webhook route, which bypasses auth as well as the document", () => {
    const withAnother = `${NODE_TS}\nwebhookRoute = { method: "POST", path: "/x" };\n`;
    const found = auditOutOfRegistrySurfaces({ nodeTs: withAnother, serverTs: SERVER_TS });
    expect(found.map((f) => f.kind)).toEqual(["webhook_route_count_changed"]);
  });

  it("reports a declared surface whose mount symbol node.ts no longer references", () => {
    const withoutHealth = NODE_TS.split("buildHealthInterceptor").join("buildSomethingElse");
    const found = auditOutOfRegistrySurfaces({ nodeTs: withoutHealth, serverTs: SERVER_TS });
    // Both health kinds share the symbol, so both are reported — which is right: two declarations
    // describe nothing, not one.
    expect(found.map((f) => f.kind)).toEqual([
      "mount_symbol_absent_from_source",
      "mount_symbol_absent_from_source",
    ]);
    expect(found[0]?.detail).toContain("buildHealthInterceptor");
  });

  it("declares three audit kinds and no more", () => {
    expect(OUT_OF_REGISTRY_AUDIT_KINDS).toHaveLength(3);
  });
});

describe("the measurement that decides the fence's shape", () => {
  it("four of the five declared paths appear nowhere as a literal in the mounting source", () => {
    // This is why the forward check is the mount SYMBOL and not the path. Each surface reaches its
    // mount through its own exported constant, so "the declared path appears in node.ts" is testing
    // a coincidence: it would have fired on four surfaces before this module existed and on all
    // five after it replaced the one inline literal with STRIPE_WEBHOOK_PATH. A fence that reports
    // its own subject improving is worse than no fence (ADR-0334).
    const asLiteral = OUT_OF_REGISTRY_SURFACE_KINDS.filter((kind) => {
      const needle = `"${OUT_OF_REGISTRY_SURFACES[kind].path}"`;
      return NODE_TS.includes(needle) || SERVER_TS.includes(needle);
    });
    expect(asLiteral).toEqual([]);
  });

  it("the stripe path has exactly one spelling in non-test source, this module's", () => {
    expect(NODE_TS).not.toContain(`"${STRIPE_WEBHOOK_PATH}"`);
    expect(NODE_TS).toContain("STRIPE_WEBHOOK_PATH");
  });
});

describe("servedSurface", () => {
  it("carries the registry and the out-of-registry paths as two lists, never summed", () => {
    const registered = [route("a.read", [{ kind: "literal", value: "a" }])];
    const surface = servedSurface({
      registered,
      mounted: new Set(["credential_login", "liveness"]),
      perTenantManifests: false,
    });
    expect(surface.registered).toHaveLength(1);
    expect(surface.outOfRegistry).toHaveLength(3); // login POST + liveness GET/HEAD
    expect(surface.perTenantManifests).toBeNull();
  });

  it("says the per-tenant surface is not enumerable rather than guessing an N", () => {
    // `TenantGatewayCache.serverFor` compiles a registry per tenant from that tenant's own
    // manifest, so the surface is 1 + N and nothing enumerates the N. A document describes the boot
    // manifest and must say so; claiming to describe the deployment would be ADR-0314's "their data
    // is in a different place than they think" pointed at the contract.
    const surface = servedSurface({ registered: [], mounted: new Set(), perTenantManifests: true });
    expect(surface.perTenantManifests).toEqual({ enumerable: false });
  });
});

describe("undescribableRegisteredRoutes", () => {
  it("names a wildcard route and nothing else", () => {
    const found = undescribableRegisteredRoutes([
      route("ok.read", [{ kind: "literal", value: "a" }, { kind: "parameter", name: "id", pattern: null }]),
      route("files.get", [{ kind: "literal", value: "f" }, { kind: "wildcard" }]),
    ]);
    expect(found).toEqual([{ operationId: "files.get", reason: "wildcard_path" }]);
  });
});
