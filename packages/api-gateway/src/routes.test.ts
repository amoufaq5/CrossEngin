import { describe, expect, it } from "vitest";
import { HTTP_METHODS } from "./requests.js";
import {
  OPENAPI_PATH_ITEM_FIELD,
  PATH_SEGMENT_RENDER,
  PATH_TEMPLATE_GRAMMARS,
  ROUTE_MATCH_OUTCOMES,
  RouteDefinitionSchema,
  VERSION_NEGOTIATION_STRATEGIES,
  compilePathPattern,
  matchRoute,
  negotiateVersion,
  pathParameterSchemaPattern,
  pathTemplateCollisions,
  renderPathTemplate,
  type PathSegment,
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

describe("renderPathTemplate", () => {
  it("renders a literal + parameter path in both grammars", () => {
    const segs = route.pathSegments;
    expect(renderPathTemplate(segs, "openapi")).toEqual({
      template: "/v1/tenants/{id}",
      refused: null,
    });
    expect(renderPathTemplate(segs, "express")).toEqual({
      template: "/v1/tenants/:id",
      refused: null,
    });
  });

  it("round-trips through compilePathPattern, its inverse, for the express grammar", () => {
    // The property that makes the renderer trustworthy rather than merely plausible: the module
    // already held the parse, so the render can be checked against it instead of against a
    // hand-written expectation. Covers all three segment kinds including the wildcard.
    for (const template of [
      "/v1/tenants/:id",
      "/v1/tenants/:id/transitions/:name",
      "/v1/files/:id/*",
      "/v1/tenants/:id([0-9a-f-]+)",
      "/health",
    ]) {
      const segments = compilePathPattern(template);
      const rendered = renderPathTemplate(segments, "express");
      // A declared pattern is deliberately NOT rendered back into the express template — it goes
      // into the parameter's schema — so the round trip is on the segment *shape*, and the pattern
      // is asserted separately below.
      expect(compilePathPattern(rendered.template ?? "")).toEqual(
        segments.map((s) => (s.kind === "parameter" ? { ...s, pattern: null } : s)),
      );
    }
  });

  it("refuses a wildcard under the openapi grammar, naming its position", () => {
    // Shape, not wiring: OAS 3.1 has no multi-segment path variable, so rendering `{suffix}` would
    // describe a path matching one segment where the route matches any number.
    const segs: readonly PathSegment[] = [
      { kind: "literal", value: "v1" },
      { kind: "literal", value: "files" },
      { kind: "wildcard" },
    ];
    expect(renderPathTemplate(segs, "openapi")).toEqual({
      template: null,
      refused: "wildcard_not_expressible",
      at: 2,
    });
    // …and the express grammar renders the same segments, which is what makes the map two-valued
    // rather than a blanket refusal.
    expect(renderPathTemplate(segs, "express").template).toBe("/v1/files/*");
  });

  it("renders an empty segment list as the root path", () => {
    expect(renderPathTemplate([], "openapi").template).toBe("/");
  });

  it("declares a render for every (grammar, segment kind) pair", () => {
    // Totality is the fence: a fourth segment kind must be a compile error at both grammars rather
    // than a segment one renderer drops, because a dropped segment does not shorten a path, it
    // changes which requests it matches.
    expect(PATH_TEMPLATE_GRAMMARS).toHaveLength(2);
    const kinds: readonly PathSegment["kind"][] = ["literal", "parameter", "wildcard"];
    for (const grammar of PATH_TEMPLATE_GRAMMARS) {
      for (const kind of kinds) {
        expect(PATH_SEGMENT_RENDER[grammar][kind], `${grammar}.${kind}`).toMatch(
          /^(rendered|refused)$/,
        );
      }
    }
    // Exactly one cell is refused, and it is the one the prose argues for.
    const refused = PATH_TEMPLATE_GRAMMARS.flatMap((g) =>
      kinds.filter((k) => PATH_SEGMENT_RENDER[g][k] === "refused").map((k) => `${g}.${k}`),
    );
    expect(refused).toEqual(["openapi.wildcard"]);
  });
});

describe("pathParameterSchemaPattern", () => {
  it("anchors a declared pattern and answers null for none", () => {
    // Anchored because `tryMatchSegments` anchors it too, so an unanchored copy would describe a
    // parameter the matcher refuses.
    expect(
      pathParameterSchemaPattern({ kind: "parameter", name: "id", pattern: "[0-9a-f]{8}" }),
    ).toBe("^[0-9a-f]{8}$");
    expect(pathParameterSchemaPattern({ kind: "parameter", name: "id", pattern: null })).toBeNull();
  });
});

describe("OPENAPI_PATH_ITEM_FIELD", () => {
  it("answers for every HTTP method, and only CONNECT has no field", () => {
    // A total map rather than a lookup over the eight OAS fields: a miss reads as a method somebody
    // forgot, where `null` states that the Path Item Object has no field for it.
    for (const method of HTTP_METHODS) {
      expect(method in OPENAPI_PATH_ITEM_FIELD, method).toBe(true);
    }
    const undescribable = HTTP_METHODS.filter((m) => OPENAPI_PATH_ITEM_FIELD[m] === null);
    expect(undescribable).toEqual(["CONNECT"]);
    expect(OPENAPI_PATH_ITEM_FIELD.GET).toBe("get");
    expect(OPENAPI_PATH_ITEM_FIELD.DELETE).toBe("delete");
  });
});

describe("pathTemplateCollisions", () => {
  const at = (operationId: string, method: RouteDefinition["method"], segs: readonly PathSegment[]): RouteDefinition => ({
    ...route,
    operationId,
    method,
    pathSegments: segs,
  });

  it("finds none when every rendered template is distinct", () => {
    expect(
      pathTemplateCollisions([
        at("a.read", "GET", [{ kind: "literal", value: "a" }, { kind: "parameter", name: "id", pattern: null }]),
        at("b.read", "GET", [{ kind: "literal", value: "b" }, { kind: "parameter", name: "id", pattern: null }]),
      ]),
    ).toEqual([]);
  });

  it("collides two routes whose templates differ only in the parameter's NAME", () => {
    // The OAS equivalence test, and the reason the comparison is on the anonymised template: two
    // distinct `RouteDefinition`s the matcher separates by registration order are ONE path to a
    // Paths Object, which cannot hold both.
    const found = pathTemplateCollisions([
      at("notification.read", "POST", [
        { kind: "literal", value: "v1" },
        { kind: "literal", value: "notifications" },
        { kind: "parameter", name: "id", pattern: null },
        { kind: "literal", value: "read" },
      ]),
      at("notifications.read_state.mark", "POST", [
        { kind: "literal", value: "v1" },
        { kind: "literal", value: "notifications" },
        { kind: "parameter", name: "dispatchId", pattern: null },
        { kind: "literal", value: "read" },
      ]),
    ]);
    expect(found).toEqual([
      {
        method: "POST",
        template: "/v1/notifications/{}/read",
        operationIds: ["notification.read", "notifications.read_state.mark"],
      },
    ]);
  });

  it("does not collide the same path under different methods", () => {
    const segs: readonly PathSegment[] = [
      { kind: "literal", value: "v1" },
      { kind: "literal", value: "admin" },
      { kind: "literal", value: "settings" },
    ];
    expect(pathTemplateCollisions([at("s.read", "GET", segs), at("s.update", "PUT", segs)])).toEqual(
      [],
    );
  });

  it("skips a wildcard route rather than counting it as a collision", () => {
    // It renders to no openapi template at all, so it can neither collide nor be described — the
    // honest answer is that the document omits it, which is the caller's finding to report.
    expect(
      pathTemplateCollisions([
        at("w.one", "GET", [{ kind: "literal", value: "f" }, { kind: "wildcard" }]),
        at("w.two", "GET", [{ kind: "literal", value: "f" }, { kind: "wildcard" }]),
      ]),
    ).toEqual([]);
  });
});
