import { describe, expect, it } from "vitest";
import {
  ROUTE_MATCH_OUTCOMES,
  RouteDefinitionSchema,
  VERSION_NEGOTIATION_STRATEGIES,
  compilePathPattern,
  matchRoute,
  negotiateVersion,
  type RouteDefinition,
} from "./routes.js";

const route: RouteDefinition = {
  id: "rt_tenants01",
  operationId: "tenants.get",
  method: "GET",
  pathSegments: [
    { kind: "literal", value: "v1" },
    { kind: "literal", value: "tenants" },
    { kind: "parameter", name: "id", pattern: null },
  ],
  apiVersion: "v1",
  isDeprecated: false,
  deprecatedSince: null,
  sunsetAt: null,
  successorOperationId: null,
  requiredScopes: ["tenants:read"],
  rateLimitPolicyId: "rlp_apistd001",
  idempotencyRequired: false,
  requestSchemaSha256: null,
  responseSchemaSha256: "a".repeat(64),
};

describe("constants", () => {
  it("has 4 version negotiation strategies", () => {
    expect(VERSION_NEGOTIATION_STRATEGIES).toHaveLength(4);
  });
  it("has 6 route match outcomes", () => {
    expect(ROUTE_MATCH_OUTCOMES).toHaveLength(6);
  });
});

describe("RouteDefinitionSchema", () => {
  it("accepts a valid route", () => {
    expect(() => RouteDefinitionSchema.parse(route)).not.toThrow();
  });

  it("rejects deprecated without deprecatedSince", () => {
    expect(() =>
      RouteDefinitionSchema.parse({ ...route, isDeprecated: true }),
    ).toThrow(/deprecatedSince/);
  });

  it("rejects sunsetAt without deprecation", () => {
    expect(() =>
      RouteDefinitionSchema.parse({
        ...route,
        sunsetAt: "2027-05-16T00:00:00.000Z",
      }),
    ).toThrow(/sunsetAt requires isDeprecated=true/);
  });

  it("rejects sunsetAt before deprecatedSince", () => {
    expect(() =>
      RouteDefinitionSchema.parse({
        ...route,
        isDeprecated: true,
        deprecatedSince: "2026-06-01T00:00:00.000Z",
        sunsetAt: "2026-05-01T00:00:00.000Z",
      }),
    ).toThrow(/sunsetAt must be after deprecatedSince/);
  });

  it("rejects multiple wildcards", () => {
    expect(() =>
      RouteDefinitionSchema.parse({
        ...route,
        pathSegments: [
          { kind: "literal", value: "v1" },
          { kind: "wildcard" },
          { kind: "wildcard" },
        ],
      }),
    ).toThrow(/at most one wildcard/);
  });

  it("rejects wildcard not at end", () => {
    expect(() =>
      RouteDefinitionSchema.parse({
        ...route,
        pathSegments: [
          { kind: "wildcard" },
          { kind: "literal", value: "tail" },
        ],
      }),
    ).toThrow(/wildcard segment must be the last/);
  });

  it("rejects duplicate parameter names", () => {
    expect(() =>
      RouteDefinitionSchema.parse({
        ...route,
        pathSegments: [
          { kind: "literal", value: "v1" },
          { kind: "parameter", name: "id", pattern: null },
          { kind: "parameter", name: "id", pattern: null },
        ],
      }),
    ).toThrow(/duplicate path parameter/);
  });
});

describe("matchRoute", () => {
  const now = new Date("2026-05-16T10:00:00Z");

  it("matches GET /v1/tenants/abc", () => {
    const r = matchRoute([route], "GET", "/v1/tenants/abc", "v1", now);
    expect(r.outcome).toBe("matched");
    expect(r.pathParameters.id).toBe("abc");
  });

  it("returns method_not_allowed when path matches but method does not", () => {
    const r = matchRoute([route], "DELETE", "/v1/tenants/abc", "v1", now);
    expect(r.outcome).toBe("method_not_allowed");
  });

  it("returns no_route when path does not match", () => {
    const r = matchRoute([route], "GET", "/v1/other", "v1", now);
    expect(r.outcome).toBe("no_route");
  });

  it("returns version_not_supported when only method+path match different version", () => {
    const v1Route: RouteDefinition = { ...route, apiVersion: "v1" };
    const r = matchRoute([v1Route], "GET", "/v1/tenants/abc", "v2", now);
    expect(r.outcome).toBe("version_not_supported");
  });

  it("flags deprecated_version when route is deprecated", () => {
    const deprecated: RouteDefinition = {
      ...route,
      isDeprecated: true,
      deprecatedSince: "2026-01-01T00:00:00.000Z",
    };
    const r = matchRoute([deprecated], "GET", "/v1/tenants/abc", "v1", now);
    expect(r.outcome).toBe("deprecated_version");
  });

  it("flags sunset_version when route is past sunsetAt", () => {
    const sunset: RouteDefinition = {
      ...route,
      isDeprecated: true,
      deprecatedSince: "2025-01-01T00:00:00.000Z",
      sunsetAt: "2026-01-01T00:00:00.000Z",
    };
    const r = matchRoute([sunset], "GET", "/v1/tenants/abc", "v1", now);
    expect(r.outcome).toBe("sunset_version");
  });
});

describe("negotiateVersion", () => {
  it("uses X-Api-Version header", () => {
    expect(
      negotiateVersion({
        strategy: "header_x_api_version",
        header: "v3",
        acceptHeader: null,
        pathFirstSegment: null,
        queryVersion: null,
        defaultVersion: "v1",
      }),
    ).toBe("v3");
  });

  it("falls back to default when header invalid", () => {
    expect(
      negotiateVersion({
        strategy: "header_x_api_version",
        header: "abc",
        acceptHeader: null,
        pathFirstSegment: null,
        queryVersion: null,
        defaultVersion: "v1",
      }),
    ).toBe("v1");
  });

  it("extracts version from accept media type", () => {
    expect(
      negotiateVersion({
        strategy: "accept_media_type_version",
        header: null,
        acceptHeader: "application/vnd.crossengin+json; version=v2",
        pathFirstSegment: null,
        queryVersion: null,
        defaultVersion: "v1",
      }),
    ).toBe("v2");
  });

  it("uses path prefix segment", () => {
    expect(
      negotiateVersion({
        strategy: "path_prefix",
        header: null,
        acceptHeader: null,
        pathFirstSegment: "v3",
        queryVersion: null,
        defaultVersion: "v1",
      }),
    ).toBe("v3");
  });

  it("uses query param", () => {
    expect(
      negotiateVersion({
        strategy: "query_param",
        header: null,
        acceptHeader: null,
        pathFirstSegment: null,
        queryVersion: "v4",
        defaultVersion: "v1",
      }),
    ).toBe("v4");
  });
});

describe("compilePathPattern", () => {
  it("compiles literal + param + wildcard", () => {
    const segments = compilePathPattern("/v1/tenants/:id/*");
    expect(segments[0]).toEqual({ kind: "literal", value: "v1" });
    expect(segments[1]).toEqual({ kind: "literal", value: "tenants" });
    expect(segments[2]).toEqual({
      kind: "parameter",
      name: "id",
      pattern: null,
    });
    expect(segments[3]).toEqual({ kind: "wildcard" });
  });

  it("compiles param with regex pattern", () => {
    const segments = compilePathPattern("/v1/tenants/:id([a-z0-9]+)");
    expect(segments[2]).toEqual({
      kind: "parameter",
      name: "id",
      pattern: "[a-z0-9]+",
    });
  });
});
