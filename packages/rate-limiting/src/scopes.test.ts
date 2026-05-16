import { describe, expect, it } from "vitest";
import {
  SCOPES_REQUIRING_PRINCIPAL,
  SCOPES_REQUIRING_ROUTE,
  SCOPES_REQUIRING_TENANT,
  SCOPE_KINDS,
  ScopeSpecSchema,
  computeRateLimitKey,
  matchesRoutePattern,
  requiredInputsFor,
} from "./scopes.js";

describe("constants", () => {
  it("has 10 scope kinds", () => {
    expect(SCOPE_KINDS).toHaveLength(10);
  });
  it("SCOPES_REQUIRING_TENANT covers per_tenant variants", () => {
    expect(SCOPES_REQUIRING_TENANT.has("per_tenant")).toBe(true);
    expect(SCOPES_REQUIRING_TENANT.has("per_tenant_route")).toBe(true);
    expect(SCOPES_REQUIRING_TENANT.has("per_tenant_principal")).toBe(true);
    expect(SCOPES_REQUIRING_TENANT.has("global")).toBe(false);
  });
  it("SCOPES_REQUIRING_PRINCIPAL covers principal variants", () => {
    expect(SCOPES_REQUIRING_PRINCIPAL.has("per_principal")).toBe(true);
    expect(SCOPES_REQUIRING_PRINCIPAL.has("per_tenant_principal")).toBe(true);
  });
  it("SCOPES_REQUIRING_ROUTE covers route variants", () => {
    expect(SCOPES_REQUIRING_ROUTE.has("per_route")).toBe(true);
    expect(SCOPES_REQUIRING_ROUTE.has("per_tenant_route")).toBe(true);
  });
});

describe("ScopeSpecSchema", () => {
  it("accepts a simple per_tenant scope", () => {
    expect(() =>
      ScopeSpecSchema.parse({
        kind: "per_tenant",
        routePattern: null,
        componentScopes: [],
      }),
    ).not.toThrow();
  });

  it("accepts per_route with routePattern", () => {
    expect(() =>
      ScopeSpecSchema.parse({
        kind: "per_route",
        routePattern: "/v1/tenants/:id",
        componentScopes: [],
      }),
    ).not.toThrow();
  });

  it("rejects per_route without routePattern", () => {
    expect(() =>
      ScopeSpecSchema.parse({
        kind: "per_route",
        routePattern: null,
        componentScopes: [],
      }),
    ).toThrow(/per_route scope requires routePattern/);
  });

  it("rejects composite with < 2 components", () => {
    expect(() =>
      ScopeSpecSchema.parse({
        kind: "composite",
        routePattern: null,
        componentScopes: ["per_tenant"],
      }),
    ).toThrow(/at least 2 componentScopes/);
  });

  it("rejects nested composite", () => {
    expect(() =>
      ScopeSpecSchema.parse({
        kind: "composite",
        routePattern: null,
        componentScopes: ["composite", "per_tenant"],
      }),
    ).toThrow(/cannot nest composite/);
  });

  it("rejects duplicate composite component kinds", () => {
    expect(() =>
      ScopeSpecSchema.parse({
        kind: "composite",
        routePattern: null,
        componentScopes: ["per_tenant", "per_tenant"],
      }),
    ).toThrow(/unique/);
  });
});

describe("computeRateLimitKey", () => {
  const inputs = {
    tenantId: "tenant-1",
    principalId: "principal-1",
    apiKeyPrefix: "ce_live_AbCdEfGh",
    ipAddress: "1.2.3.4",
    route: "/v1/things",
    oauthClientId: null,
  };

  it("computes per_tenant key", () => {
    const key = computeRateLimitKey(
      { kind: "per_tenant", routePattern: null, componentScopes: [] },
      inputs,
    );
    expect(key).toBe("tenant:tenant-1");
  });

  it("computes per_route key", () => {
    const key = computeRateLimitKey(
      {
        kind: "per_route",
        routePattern: "/v1/things",
        componentScopes: [],
      },
      inputs,
    );
    expect(key).toBe("route:/v1/things");
  });

  it("computes composite key joining component parts", () => {
    const key = computeRateLimitKey(
      {
        kind: "composite",
        routePattern: null,
        componentScopes: ["per_tenant", "per_principal"],
      },
      inputs,
    );
    expect(key).toBe("tenant:tenant-1|principal:principal-1");
  });

  it("returns null when required input missing", () => {
    const key = computeRateLimitKey(
      { kind: "per_tenant", routePattern: null, componentScopes: [] },
      { ...inputs, tenantId: null },
    );
    expect(key).toBeNull();
  });

  it("includes bucketSalt when set", () => {
    const key = computeRateLimitKey(
      {
        kind: "per_tenant",
        routePattern: null,
        componentScopes: [],
        bucketSalt: "experiment-a",
      },
      inputs,
    );
    expect(key).toContain("salt:experiment-a");
  });
});

describe("requiredInputsFor", () => {
  it("returns tenantId for per_tenant", () => {
    const r = requiredInputsFor({
      kind: "per_tenant",
      routePattern: null,
      componentScopes: [],
    });
    expect(r).toEqual(["tenantId"]);
  });

  it("returns tenantId + principalId for composite", () => {
    const r = requiredInputsFor({
      kind: "composite",
      routePattern: null,
      componentScopes: ["per_tenant", "per_principal"],
    });
    expect(r).toContain("tenantId");
    expect(r).toContain("principalId");
  });
});

describe("matchesRoutePattern", () => {
  it("matches exact string", () => {
    expect(matchesRoutePattern("/v1/tenants", "/v1/tenants")).toBe(true);
  });
  it("matches wildcard prefix", () => {
    expect(matchesRoutePattern("/v1/*", "/v1/tenants")).toBe(true);
    expect(matchesRoutePattern("/v1/*", "/v1/tenants/123")).toBe(true);
  });
  it("matches path parameters", () => {
    expect(matchesRoutePattern("/v1/tenants/:id", "/v1/tenants/123")).toBe(true);
  });
  it("does not match path parameter at wrong depth", () => {
    expect(matchesRoutePattern("/v1/tenants/:id", "/v1/tenants/123/users")).toBe(
      false,
    );
  });
  it("global wildcard matches anything", () => {
    expect(matchesRoutePattern("*", "/anywhere")).toBe(true);
  });
});
