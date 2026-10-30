import { readFileSync } from "node:fs";

import {
  AUTH_SCHEMES,
  AUTH_SCHEME_SECURITY_DOC,
  AUTH_SCHEME_SUPPORT,
  OPENAPI_PATH_ITEM_FIELD,
  RouteDefinitionSchema,
  renderPathTemplate,
  securityDocMatchesTreatment,
  type RouteDefinition,
} from "@crossengin/api-gateway";
import { ERP_CORE_PACK_SLUG, buildErpCorePack } from "@crossengin/pack-erp-core";
import {
  ManifestSchema,
  resolveManifest,
  type Manifest,
  type ManifestRegistry,
} from "@crossengin/kernel/manifest";
import { buildErpRetailPack } from "@crossengin/pack-erp-retail";
import { describe, expect, it } from "vitest";

import { compileOperateServer } from "./compile.js";
import {
  OPENAPI_COVERAGE_KINDS,
  OPENAPI_MEDIA_TYPE,
  buildOpenApiDocument,
  type OpenApiCoverageGap,
  type OpenApiEmitInput,
} from "./openapi.js";
import { InMemoryEntityStore } from "./store.js";

// ---------------------------------------------------------------------------
// The real surface: `erp-core` compiled with the registry's own route list.
//
// `compiled.routes.list()` and not `routeSpecs`, which is a strict subset — measured, 338 routes
// against 334 specs, the four without one being `meta.schema.read`, `meta.openapi.read`,
// `meta.aging.read` and `meta.whtReconciliation.read`. Driving the fence off the specs would make
// it blind to exactly the routes a spec cannot describe, which is the half of the registry a
// document is most likely to omit.
// ---------------------------------------------------------------------------

const CORE = buildErpCorePack();

const emitFor = (manifest: Manifest, role: string, coverage: readonly OpenApiCoverageGap[] = []) => {
  const compiled = compileOperateServer(manifest, {
    store: new InMemoryEntityStore(),
    principalRoles: () => ({ primaryRole: role }),
  });
  const routes = compiled.routes.list();
  return {
    compiled,
    routes,
    emit: buildOpenApiDocument({
      manifest,
      routes,
      routeSpecs: compiled.routeSpecs,
      title: "CrossEngin",
      version: "manifest-hash",
      coverage,
    }),
  };
};

const CORE_EMIT = emitFor(CORE, "erp_admin");
const DOC = (() => {
  const d = CORE_EMIT.emit.document;
  if (d === null) throw new Error(`erp-core was refused: ${JSON.stringify(CORE_EMIT.emit.refused)}`);
  return d;
})();
const PATHS = DOC["paths"] as Record<string, Record<string, unknown>>;
const COMPONENTS = DOC["components"] as {
  schemas: Record<string, unknown>;
  securitySchemes: Record<string, Record<string, unknown>>;
};

/** Every `(template, field, operation)` triple the document holds, flattened. */
const documentOperations = (
  paths: Record<string, Record<string, unknown>>,
): readonly { template: string; field: string; operation: Record<string, unknown> }[] => {
  const out: { template: string; field: string; operation: Record<string, unknown> }[] = [];
  for (const [template, item] of Object.entries(paths)) {
    for (const [field, operation] of Object.entries(item)) {
      out.push({ template, field, operation: operation as Record<string, unknown> });
    }
  }
  return out;
};

const operationFor = (operationId: string): Record<string, unknown> => {
  const found = documentOperations(PATHS).find((o) => o.operation["operationId"] === operationId);
  if (found === undefined) throw new Error(`no operation ${operationId} in the document`);
  return found.operation;
};

const BASE_ROUTE = {
  apiVersion: "v1" as const,
  isDeprecated: false,
  deprecatedSince: null,
  sunsetAt: null,
  successorOperationId: null,
  requiredScopes: [] as readonly string[],
  rateLimitPolicyId: null,
  idempotencyRequired: false,
  requestSchemaSha256: null,
  responseSchemaSha256: null,
};

/**
 * A hand-made route, **parsed through `RouteDefinitionSchema`** rather than cast.
 *
 * The parse is the fixture's own non-vacuity check: a refusal demonstrated on a route shape the
 * schema would never admit proves nothing about the served surface, and the schema has real
 * opinions here (at most one wildcard, and it must be last). So a fixture that stops being a
 * possible route fails at construction instead of passing as evidence.
 */
const fixtureRoute = (
  id: string,
  operationId: string,
  method: RouteDefinition["method"],
  pathSegments: readonly unknown[],
): RouteDefinition =>
  RouteDefinitionSchema.parse({ ...BASE_ROUTE, id, operationId, method, pathSegments });

const lit = (value: string) => ({ kind: "literal" as const, value });
const param = (name: string, pattern: string | null = null) => ({
  kind: "parameter" as const,
  name,
  pattern,
});

/**
 * An entity-free manifest, parsed and not cast, for the same reason `fixtureRoute` parses: a cast
 * is a type annotation standing in for a check (ADR-0362), and the whole subject here is a document
 * that must describe what the server really serves. It declares no entity, so the fixtures exercise
 * the path/refusal half with no schema loop running.
 */
const FIXTURE_MANIFEST: Manifest = ManifestSchema.parse({
  manifestVersion: "1.0",
  meta: { slug: "fixture/f", name: "F", version: "1.0.0" },
});

const fixtureInput = (routes: readonly RouteDefinition[]): OpenApiEmitInput => ({
  manifest: FIXTURE_MANIFEST,
  routes,
  routeSpecs: [],
  title: "F",
  version: "v",
  coverage: [],
});

// ---------------------------------------------------------------------------
// 1. Route coverage, both directions.
// ---------------------------------------------------------------------------

describe("buildOpenApiDocument — the document describes the registry's surface, both ways", () => {
  it("emits an operation for every registry route whose method the Path Item Object has a field for", () => {
    const describable = CORE_EMIT.routes.filter((r) => OPENAPI_PATH_ITEM_FIELD[r.method] !== null);
    // A floor, so the comparison cannot be satisfied by an empty document against an empty
    // registry. Deliberately well below the measured 338: the figure moves with every route a
    // sibling increment mounts — it was 337 when this increment was briefed and 338 when it was
    // written, the difference being `meta.openapi.read` — so what is asserted exactly is the
    // *correspondence*, which no new route can invalidate.
    expect(describable.length).toBeGreaterThan(300);

    const inDocument = new Set(
      documentOperations(PATHS).map((o) => String(o.operation["operationId"])),
    );
    const missing = describable
      .map((r) => r.operationId)
      .filter((id) => !inDocument.has(id))
      .sort();
    expect(missing).toEqual([]);
  });

  it("emits no operation that is not a route the registry holds", () => {
    const registered = new Set(CORE_EMIT.routes.map((r) => r.operationId));
    const ops = documentOperations(PATHS);
    expect(ops.length).toBeGreaterThan(300);
    const phantom = ops
      .map((o) => String(o.operation["operationId"]))
      .filter((id) => !registered.has(id))
      .sort();
    expect(phantom).toEqual([]);
  });

  it("places each operation at the path and field its own route renders to", () => {
    // The two directions above compare *membership*. This compares *position*: an operation listed
    // under the wrong path item, or under `get` when its route is a POST, is in the document and
    // describes a request the server does not serve — which a set comparison cannot see.
    const byId = new Map(CORE_EMIT.routes.map((r) => [r.operationId, r]));
    const misplaced: string[] = [];
    for (const { template, field, operation } of documentOperations(PATHS)) {
      const route = byId.get(String(operation["operationId"]));
      if (route === undefined) continue; // the phantom test owns this case.
      const expected = renderPathTemplate(route.pathSegments, "openapi").template;
      if (expected !== template || OPENAPI_PATH_ITEM_FIELD[route.method] !== field) {
        misplaced.push(`${route.operationId} at ${field} ${template}`);
      }
    }
    expect(misplaced).toEqual([]);
  });

  it("loses no route to a path item collapse: one operation per describable route", () => {
    // `paths[template][field] = operation` overwrites, so two routes rendering to one pair would
    // leave the document one operation short with nothing refused. The collision gate is what
    // makes that unreachable; this counts the result rather than trusting it.
    const describable = CORE_EMIT.routes.filter((r) => OPENAPI_PATH_ITEM_FIELD[r.method] !== null);
    expect(documentOperations(PATHS).length).toBe(describable.length);
    expect(Object.keys(PATHS).length).toBeGreaterThan(100);
    expect(Object.keys(PATHS).length).toBeLessThan(describable.length);
  });
});

// ---------------------------------------------------------------------------
// 2. Both refusals fire.
// ---------------------------------------------------------------------------

describe("buildOpenApiDocument — refusals", () => {
  it("refuses a served wildcard route rather than describing it as a parameter", () => {
    const emit = buildOpenApiDocument(
      fixtureInput([
        fixtureRoute("rt_fixturewild01", "files.download", "GET", [
          lit("v1"),
          lit("files"),
          { kind: "wildcard" },
        ]),
      ]),
    );
    expect(emit.document).toBeNull();
    expect(emit.refused?.kind).toBe("wildcard_path");
    expect(emit.refused?.operationIds).toEqual(["files.download"]);
  });

  it("refuses a served CONNECT route rather than dropping it from paths", () => {
    // The refusal this module argued for and did not implement. `OPENAPI_PATH_ITEM_FIELD[CONNECT]`
    // is `null` because a Path Item Object has no field for the method, and the loop used to drop
    // such a route with a bare `continue` — so the document answered `refused: null` over 341
    // routes and emitted 340 operations, with the path and the operationId nowhere in it and no
    // coverage gap. Verified against the real registry, which accepts a schema-valid CONNECT route.
    //
    // The asymmetry was the finding rather than the drop: `wildcard_path` above has the same reach,
    // the same zero population and the same single construction site, and was refused.
    const emit = buildOpenApiDocument(
      fixtureInput([
        fixtureRoute("rt_fixtureconn1", "tunnel.open", "CONNECT", [lit("v1"), lit("tunnel")]),
      ]),
    );
    expect(emit.document).toBeNull();
    expect(emit.refused?.kind).toBe("method_not_describable");
    expect(emit.refused?.operationIds).toEqual(["tunnel.open"]);
    expect(emit.refused?.detail).toContain("CONNECT");
  });

  it("refuses the CONNECT route even beside a describable one, rather than emitting the rest", () => {
    // The non-vacuity control, and the shape the defect took: with one ordinary route beside it the
    // old code emitted a perfectly well-formed document that was short by exactly one operation.
    const emit = buildOpenApiDocument(
      fixtureInput([
        fixtureRoute("rt_fixtureokget1", "widget.read", "GET", [lit("v1"), lit("widgets")]),
        fixtureRoute("rt_fixtureconn2", "tunnel.open", "CONNECT", [lit("v1"), lit("tunnel")]),
      ]),
    );
    expect(emit.document).toBeNull();
    expect(emit.refused?.kind).toBe("method_not_describable");
  });

  it("refuses two routes whose templates differ only in a variable's name", () => {
    // The case an exact-template comparison misses and OAS 3.1 forbids: `{id}` and `{slug}` in the
    // same position are the same path, while being two `RouteDefinition`s the matcher separates by
    // registration order — so a document would describe one and silently omit the other.
    const emit = buildOpenApiDocument(
      fixtureInput([
        fixtureRoute("rt_fixturecoll1", "widget.read", "GET", [
          lit("v1"),
          lit("widgets"),
          param("id"),
        ]),
        fixtureRoute("rt_fixturecoll2", "widget.bySlug", "GET", [
          lit("v1"),
          lit("widgets"),
          param("slug"),
        ]),
      ]),
    );
    expect(emit.document).toBeNull();
    expect(emit.refused?.kind).toBe("path_collision");
    expect([...(emit.refused?.operationIds ?? [])].sort()).toEqual(["widget.bySlug", "widget.read"]);
    expect(emit.refused?.detail).toContain("/v1/widgets/{}");
  });

  it("does not refuse the same two paths under different methods, which is one path item", () => {
    // The control for the collision check: a GET and a POST on one template are what every
    // collection route pair is, so a rule firing on the template alone would refuse every pack.
    const emit = buildOpenApiDocument(
      fixtureInput([
        fixtureRoute("rt_fixturectl01", "widget.list", "GET", [lit("v1"), lit("widgets")]),
        fixtureRoute("rt_fixturectl02", "widget.create", "POST", [lit("v1"), lit("widgets")]),
      ]),
    );
    expect(emit.refused).toBeNull();
    expect(Object.keys(emit.document?.["paths"] as Record<string, unknown>)).toEqual([
      "/v1/widgets",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. Both refusals are measured empty on every pack reachable from here.
// ---------------------------------------------------------------------------

describe("buildOpenApiDocument — the refusals have no member on a real pack", () => {
  /**
   * The claim that makes refusing safe rather than a boot hazard (ADR-0338's rule): refusing breaks
   * nothing that worked, because nothing in the shipped packs produces either refusal.
   *
   * **Two packs, not seven, and the narrowing is a dependency fact rather than a choice.**
   * `@crossengin/operate-runtime` devDepends on `pack-erp-core` and `pack-erp-retail` and on
   * neither of the other five, so `pack-erp-healthcare` and its siblings are `MODULE_NOT_FOUND`
   * from this file — measured. The seven-pack form of this assertion belongs where all seven are
   * importable, which is `apps/operate-server` (it declares all seven), or in a
   * `packages/testing/src/strategy/` rule, which reads pack source as text for exactly this reason
   * (kernel and all seven packs devDepend on `@crossengin/testing`, so importing one is a cycle).
   *
   * The reachable set is asserted against `package.json` below rather than listed here, so a
   * `devDependencies` edge added later fails this suite and names the loop to widen instead of
   * leaving a narrowed measurement reading as a complete one.
   */
  const packRegistry: ManifestRegistry = {
    async getManifest(id: string): Promise<Manifest | null> {
      return id === ERP_CORE_PACK_SLUG ? buildErpCorePack() : null;
    },
  };

  it("declares which packs this package can reach, so the measurement states its own bound", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { devDependencies?: Record<string, string>; dependencies?: Record<string, string> };
    const reachable = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
      .filter((d) => d.startsWith("@crossengin/pack-erp-"))
      .sort();
    expect(reachable).toEqual(["@crossengin/pack-erp-core", "@crossengin/pack-erp-retail"]);
  });

  it("refuses neither erp-core standalone nor erp-retail resolved against it", async () => {
    // Retail declares `meta.extends: [operate-erp/core]` and does not cross-validate alone, so it
    // is resolved through the kernel's own lineage resolver first — the shape every pack test here
    // uses. Resolution matters to the measurement rather than being ceremony: it is what brings the
    // other 51 entities' routes into the registry, 352 routes against core's 338.
    const retail = await resolveManifest(buildErpRetailPack(), { registry: packRegistry });
    const cases: readonly { name: string; manifest: Manifest; role: string }[] = [
      { name: "erp-core", manifest: CORE, role: "erp_admin" },
      { name: "erp-retail+core", manifest: retail, role: "cashier" },
    ];
    expect(cases.length).toBe(2);
    for (const c of cases) {
      const { routes, emit } = emitFor(c.manifest, c.role);
      expect(routes.length).toBeGreaterThan(300);
      // Named, not just `toBeNull()`, so a failure says which pack and which refusal.
      expect({ pack: c.name, refused: emit.refused }).toEqual({ pack: c.name, refused: null });
    }
  });
});

// ---------------------------------------------------------------------------
// 4 + 5. Security schemes are derived, and the requirement is an OR.
// ---------------------------------------------------------------------------

describe("buildOpenApiDocument — security is derived from the gateway's own map", () => {
  const served = AUTH_SCHEMES.filter((s) => AUTH_SCHEME_SECURITY_DOC[s] !== null);

  it("publishes exactly the non-null entries of AUTH_SCHEME_SECURITY_DOC", () => {
    expect(served.length).toBeGreaterThan(0);
    const expected = served.map((s) => AUTH_SCHEME_SECURITY_DOC[s]!.key).sort();
    expect(Object.keys(COMPONENTS.securitySchemes).sort()).toEqual(expected);
    // Field for field, `key` excluded: the emitter copies OpenAPI's own field names and must not
    // translate or drop one — a `type: "apiKey"` entry with no `name` describes no header.
    for (const scheme of served) {
      const { key, ...object } = AUTH_SCHEME_SECURITY_DOC[scheme]!;
      expect(COMPONENTS.securitySchemes[key]).toEqual(object);
    }
  });

  it("publishes no scheme this build refuses, and none that reads a credential from the URL", () => {
    // A `securitySchemes` entry is a *definition*: a generator reads it as supported and emits a
    // client method for it. So an entry for a refused scheme would invite precisely the request
    // ADR-0384 exists to refuse, which is the dangerous direction and the one a mutation adding an
    // entry takes. Checked two ways — by name, and by the shape that would carry `?api_key=`,
    // because a key named anything at all with `in: "query"` is the same disclosure.
    for (const scheme of ["api_key_query", "basic", "mtls"] as const) {
      expect(AUTH_SCHEME_SUPPORT[scheme].treatment).toBe("refused");
      expect(AUTH_SCHEME_SECURITY_DOC[scheme]).toBeNull();
    }
    const refusedKeys = AUTH_SCHEMES.filter(
      (s) => AUTH_SCHEME_SUPPORT[s].treatment !== "served",
    ).map((s) => AUTH_SCHEME_SECURITY_DOC[s]?.key);
    expect(refusedKeys.filter((k) => k !== undefined)).toEqual([]);
    expect(securityDocMatchesTreatment()).toEqual([]);
    for (const object of Object.values(COMPONENTS.securitySchemes)) {
      expect(object["in"]).not.toBe("query");
    }
  });

  it("requires ONE scheme per requirement object, which is OR and not AND", () => {
    // Two keys in one object is AND — "present a JWT *and* an api key" — which no route demands,
    // and a generated client would then send both or refuse to call the API at all.
    const security = DOC["security"] as readonly Record<string, readonly string[]>[];
    expect(security.length).toBe(served.length);
    for (const requirement of security) {
      expect(Object.keys(requirement).length).toBe(1);
    }
    expect(security.flatMap((r) => Object.keys(r)).sort()).toEqual(
      served.map((s) => AUTH_SCHEME_SECURITY_DOC[s]!.key).sort(),
    );
    // Empty scope arrays, because `requiredScopes` is `[]` on every route in the workspace — which
    // is why "which role may call this" is a declared coverage gap and not a `security` entry.
    for (const requirement of security) {
      expect(Object.values(requirement)[0]).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Path parameters.
// ---------------------------------------------------------------------------

describe("buildOpenApiDocument — path parameters", () => {
  it("declares every path parameter `in: path` and `required: true`", () => {
    // `required: true` is not a choice the emitter makes: OpenAPI permits no other value for a path
    // parameter. Asserted over every operation rather than one, since the flatMap runs per route.
    const offenders: string[] = [];
    let seen = 0;
    for (const { template, operation } of documentOperations(PATHS)) {
      const params = (operation["parameters"] ?? []) as readonly Record<string, unknown>[];
      for (const p of params.filter((q) => q["in"] === "path")) {
        seen += 1;
        if (p["required"] !== true) offenders.push(`${template} ${String(p["name"])}`);
      }
    }
    expect(seen).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });

  it("names one path parameter per parameter segment, in segment order", () => {
    const byId = new Map(CORE_EMIT.routes.map((r) => [r.operationId, r]));
    const mismatched: string[] = [];
    for (const { operation } of documentOperations(PATHS)) {
      const route = byId.get(String(operation["operationId"]));
      if (route === undefined) continue;
      const declared = route.pathSegments
        .filter((s) => s.kind === "parameter")
        .map((s) => (s as { name: string }).name);
      const described = ((operation["parameters"] ?? []) as readonly Record<string, unknown>[])
        .filter((p) => p["in"] === "path")
        .map((p) => String(p["name"]));
      if (JSON.stringify(declared) !== JSON.stringify(described)) {
        mismatched.push(`${route.operationId}: ${JSON.stringify(declared)} vs ${JSON.stringify(described)}`);
      }
    }
    expect(mismatched).toEqual([]);
  });

  it("carries the segment's pattern, anchored, and omits one where the segment declares none", () => {
    // Measured: zero routes in `erp-core`'s registry declare a pattern — the one that does,
    // `platform.users.get` carrying `UUID_SEGMENT_PATTERN`, is mounted in `apps/operate-server` —
    // so the pattern arm is exercised on a fixture and the no-pattern arm on the real pack.
    expect(
      CORE_EMIT.routes.filter((r) =>
        r.pathSegments.some((s) => s.kind === "parameter" && s.pattern !== null),
      ),
    ).toEqual([]);
    const readParams = (operationFor("payment.read")["parameters"] ?? []) as readonly Record<
      string,
      unknown
    >[];
    expect(readParams.find((p) => p["name"] === "id")).toEqual({
      name: "id",
      in: "path",
      required: true,
      schema: { type: "string" },
    });

    const emit = buildOpenApiDocument(
      fixtureInput([
        fixtureRoute("rt_fixturepat01", "widget.byUuid", "GET", [
          lit("v1"),
          lit("widgets"),
          param("id", "[0-9a-fA-F-]{36}"),
        ]),
      ]),
    );
    const op = (emit.document?.["paths"] as Record<string, Record<string, unknown>>)[
      "/v1/widgets/{id}"
    ]!["get"] as Record<string, unknown>;
    expect((op["parameters"] as readonly Record<string, unknown>[])[0]).toEqual({
      name: "id",
      in: "path",
      required: true,
      // Anchored, because `tryMatchSegments` anchors it too — an unanchored copy would describe a
      // parameter the matcher refuses.
      schema: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" },
    });
  });
});

// ---------------------------------------------------------------------------
// 7. Per-action request shape.
// ---------------------------------------------------------------------------

describe("buildOpenApiDocument — what each action takes", () => {
  it("gives a list operation its query parameters and no request body", () => {
    const op = operationFor("payment.list");
    const params = op["parameters"] as readonly Record<string, unknown>[];
    const query = params.filter((p) => p["in"] === "query");
    // 87 on `payment.list` when measured; a floor, since a filterable field added to the pack
    // raises it by nine.
    expect(query.length).toBeGreaterThan(20);
    expect(query.map((p) => p["name"])).toContain("limit");
    expect(query.map((p) => p["name"])).toContain("cursor");
    expect(op["requestBody"]).toBeUndefined();
    // The complement note, because a parameter list cannot say that an unlisted name is *refused*.
    expect(String(op["description"])).toContain("filter_not_served");
  });

  it("gives a create operation a required body referencing <Entity>Create", () => {
    const op = operationFor("payment.create");
    expect(op["requestBody"]).toEqual({
      required: true,
      content: {
        "application/json": { schema: { $ref: "#/components/schemas/PaymentCreate" } },
      },
    });
    expect(COMPONENTS.schemas["PaymentCreate"]).toBeDefined();
  });

  it("gives an update operation a body referencing <Entity>Update, not <Entity>", () => {
    // Separate schemas because a request and a response are different sets — a decimal is a string
    // in the response and either a string or a number in the request — so one ref would be a lie
    // in one direction.
    const op = operationFor("payment.update");
    expect(op["requestBody"]).toEqual({
      required: true,
      content: {
        "application/json": { schema: { $ref: "#/components/schemas/PaymentUpdate" } },
      },
    });
  });

  it("gives a transition NO request body, on every transition the pack declares", () => {
    // The server discards one: a transition's patch is the state the manifest's workflow names, so
    // describing a body would invite a payload that is thrown away. Asserted over all of them
    // rather than one, because the arm runs per route.
    const transitions = CORE_EMIT.compiled.routeSpecs.filter((s) => s.action === "transition");
    expect(transitions.length).toBeGreaterThan(20);
    const withBody = transitions
      .map((s) => s.operationId)
      .filter((id) => operationFor(id)["requestBody"] !== undefined);
    expect(withBody).toEqual([]);
    // And it still describes what comes back, which is the record after the transition.
    expect(operationFor("invoice.send")["responses"]).toMatchObject({
      "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Invoice" } } } },
    });
  });

  it("answers a delete with 204 and no content, and describes no 200", () => {
    const responses = operationFor("payment.delete")["responses"] as Record<
      string,
      Record<string, unknown>
    >;
    expect(Object.keys(responses["204"]!)).toEqual(["description"]);
    expect(responses["200"]).toBeUndefined();
    expect(responses["201"]).toBeUndefined();
    expect(operationFor("payment.delete")["requestBody"]).toBeUndefined();
  });

  it("describes a 401 and a 403 on every operation, each with BOTH producers' media types", () => {
    const wrong: string[] = [];
    for (const o of documentOperations(PATHS)) {
      const r = o.operation["responses"] as Record<string, Record<string, unknown>>;
      for (const status of ["401", "403"]) {
        const content = r[status]?.["content"] as Record<string, unknown> | undefined;
        // Two producers answer these statuses with two shapes: a gateway denial goes through
        // `problems.ts` as `application/problem+json`, and a handler refusal is preserved verbatim
        // as `application/json` with `{error, detail}`. This used to declare `problem+json` alone
        // and that was wrong on the LIVE producer — measured, an anonymous `invoice.list` answers
        // `401 {"error":"tenant_required",…}` and an ungranted role `403 {"error":"forbidden",…}`,
        // both `application/json`. Declaring only the handler's shape would have been the same
        // defect reversed, because the gateway's 401 is reachable from eleven sites.
        if (content?.["application/problem+json"] === undefined) wrong.push(`${o.operation["operationId"]}:${status}:problem`);
        if (content?.["application/json"] === undefined) wrong.push(`${o.operation["operationId"]}:${status}:json`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("describes a 400 on the list operations and on nothing else", () => {
    // This test asserted a 400 on EVERY operation, which was the defect: all four of its producers
    // in `handlers.ts` sit inside `case "list":` and the association module emits none, so the
    // declaration carried a false sentence on 287 of 338 operations — its description names a
    // query-surface mechanism a read, a create or a transition does not have. Measured, a read
    // with junk query parameters answers 200, a delete of a missing id 404, a failed create 422.
    // ADR-0372's class: the defect written down as the specification.
    const listIds = new Set(
      CORE_EMIT.compiled.routeSpecs.filter((s) => s.action === "list").map((s) => s.operationId),
    );
    expect(listIds.size).toBeGreaterThan(40);
    const wrong: string[] = [];
    for (const o of documentOperations(PATHS)) {
      const id = String(o.operation["operationId"]);
      const has = (o.operation["responses"] as Record<string, unknown>)["400"] !== undefined;
      if (has !== listIds.has(id)) wrong.push(`${id}:${has ? "declared" : "absent"}`);
    }
    expect(wrong).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 8. Per-action response shape.
// ---------------------------------------------------------------------------

describe("buildOpenApiDocument — a page is not described as a record", () => {
  const schemaOf = (operationId: string, status: string): Record<string, unknown> =>
    ((operationFor(operationId)["responses"] as Record<string, Record<string, unknown>>)[status]![
      "content"
    ] as Record<string, Record<string, unknown>>)["application/json"]!["schema"] as Record<
      string,
      unknown
    >;

  it("describes a list 200 as {data, page} with data an array of the entity", () => {
    const schema = schemaOf("payment.list", "200");
    expect(schema["type"]).toBe("object");
    const props = schema["properties"] as Record<string, Record<string, unknown>>;
    expect(Object.keys(props).sort()).toEqual(["data", "page"]);
    expect(props["data"]).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/Payment" },
    });
    // `page` is required, because it is always present — a client branching on `page === undefined`
    // would be writing a branch the server never takes.
    expect(schema["required"]).toEqual(["data", "page"]);
    // The walk's termination rule rides on the page object, because a short or empty page with a
    // non-null cursor is legal under row filtering (ADR-0345).
    const page = props["page"] as Record<string, unknown>;
    expect(String(page["description"])).toContain("nextCursor === null");
    const pageProps = page["properties"] as Record<string, Record<string, unknown>>;
    expect(pageProps["nextCursor"]!["type"]).toEqual(["string", "null"]);
    // `limit` is the page size that was applied. The real response carries it — measured,
    // `page: {"limit":100,"nextCursor":null}` — and this declaration omitted it, so both keys are
    // asserted present and required.
    expect(pageProps["limit"]!["type"]).toBe("integer");
    expect(page["required"]).toEqual(["limit", "nextCursor"]);
  });

  it("describes a read 200 as the bare entity, and never as a page", () => {
    expect(schemaOf("payment.read", "200")).toEqual({ $ref: "#/components/schemas/Payment" });
    const create = schemaOf("payment.create", "201");
    expect(create).toEqual({ $ref: "#/components/schemas/Payment" });
  });

  it("describes every list operation as a page and every read as a record", () => {
    // Per action over the whole pack, so one action's shape cannot be right on the probed entity
    // and wrong on the other fifty.
    const wrong: string[] = [];
    for (const spec of CORE_EMIT.compiled.routeSpecs) {
      if (spec.action !== "list" && spec.action !== "read") continue;
      const status = "200";
      const schema = schemaOf(spec.operationId, status);
      const isPage = schema["properties"] !== undefined;
      if ((spec.action === "list") !== isPage) wrong.push(`${spec.operationId}/${spec.action}`);
    }
    expect(CORE_EMIT.compiled.routeSpecs.filter((s) => s.action === "list").length).toBeGreaterThan(
      40,
    );
    expect(wrong).toEqual([]);
  });

  it("names a schema per entity in all three request/response flavours", () => {
    const entities = CORE.entities ?? [];
    expect(entities.length).toBeGreaterThan(40);
    const missing = entities
      .map((e) => e.name)
      .flatMap((n) => [n, `${n}Create`, `${n}Update`])
      .filter((n) => COMPONENTS.schemas[n] === undefined);
    expect(missing).toEqual([]);
    expect(COMPONENTS.schemas["Problem"]).toBeDefined();
    expect(COMPONENTS.schemas["HandlerError"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 9. Declared coverage.
// ---------------------------------------------------------------------------

describe("buildOpenApiDocument — x-crossengin-coverage", () => {
  it("carries the emitter's own generic gaps even when the caller declares none", () => {
    // The input was `coverage: []`, so anything here is the emitter's. These two are the gaps its
    // own doc comment claims; a floor rather than an exact set, because a sibling increment adding
    // a third (`surface_outside_registry` landed while this was written) must not fail the claim.
    const gaps = DOC["x-crossengin-coverage"] as readonly OpenApiCoverageGap[];
    expect(gaps.length).toBeGreaterThanOrEqual(2);
    expect(gaps.map((g) => g.kind)).toContain("undeclared_authorization");
    expect(gaps.map((g) => g.kind)).toContain("undeclared_parameters");
  });

  it("gives every gap a declared kind and a reach of ordering or shape", () => {
    // `reach` is the field that decides what the next reader does — `ordering` closes by wiring,
    // `shape` by a format change or not at all — so a third value, or a kind outside the enum,
    // would make the distinction unreadable.
    const gaps = DOC["x-crossengin-coverage"] as readonly OpenApiCoverageGap[];
    for (const gap of gaps) {
      expect(OPENAPI_COVERAGE_KINDS).toContain(gap.kind);
      expect(["ordering", "shape"]).toContain(gap.reach);
      expect(gap.detail.length).toBeGreaterThan(40);
    }
  });

  it("appends the caller's declared gaps after its own", () => {
    const supplied: OpenApiCoverageGap = {
      kind: "per_tenant_surface",
      reach: "ordering",
      detail: "A tenant serving its own activated manifest has a surface this document omits.",
    };
    const { emit } = emitFor(CORE, "erp_admin", [supplied]);
    const gaps = emit.document?.["x-crossengin-coverage"] as readonly OpenApiCoverageGap[];
    const generic = DOC["x-crossengin-coverage"] as readonly OpenApiCoverageGap[];
    expect(gaps.length).toBe(generic.length + 1);
    expect(gaps[gaps.length - 1]).toEqual(supplied);
  });

  it("omits the undescribable-fields key when every field is describable", () => {
    // Measured zero across the pack — the only undescribable kind is `duration`, which no pack
    // declares — so the key's absence is the honest state and its *presence* would be the finding.
    expect(DOC["x-crossengin-undescribable-fields"]).toBeUndefined();
  });

  it("declares the operations described with only their denials, and names them", () => {
    // Falsely-INcomplete rather than falsely-complete, which is why it is a gap and not a refusal:
    // a generated client gets no success type for the route and the document says it can only
    // fail. What makes it a gap rather than a silence is that the set is named — these are the
    // registry routes with no `RouteSpec`, so no entity's schema can be referenced for a body.
    const gaps = DOC["x-crossengin-coverage"] as readonly OpenApiCoverageGap[];
    const gap = gaps.find((g) => g.kind === "undeclared_success_response");
    expect(gap).toBeDefined();
    expect(gap?.reach).toBe("ordering");

    // The set is exactly the spec-less routes, minus this document's own route, which IS described.
    const specIds = new Set(CORE_EMIT.compiled.routeSpecs.map((s) => s.operationId));
    const expected = CORE_EMIT.routes.filter(
      (r) => !specIds.has(r.operationId) && r.operationId !== "meta.openapi.read",
    );
    expect(expected.length).toBeGreaterThan(0);
    for (const route of expected) {
      const template = renderPathTemplate(route.pathSegments, "openapi").template;
      expect(gap?.detail, route.operationId).toContain(`${route.method} ${String(template)}`);
    }

    // And each of them really does carry no 2xx, which is the fact the gap reports.
    for (const route of expected) {
      const op = operationFor(route.operationId);
      const codes = Object.keys(op["responses"] as Record<string, unknown>);
      expect(codes.filter((c) => c.startsWith("2")), route.operationId).toEqual([]);
    }
  });

  it("describes its own success response, media type included", () => {
    // The sharpest member of the gap above, and the one this module can close: the document could
    // not describe its own 200, which also hid the non-default media type it is served with — so a
    // generated client had no way to learn that from the document at all.
    const op = operationFor("meta.openapi.read");
    const ok = (op["responses"] as Record<string, Record<string, unknown>>)["200"];
    expect(ok).toBeDefined();
    expect(Object.keys(ok?.["content"] as Record<string, unknown>)).toEqual([OPENAPI_MEDIA_TYPE]);
    expect(OPENAPI_MEDIA_TYPE).toContain("3.1.0");
  });
});

// ---------------------------------------------------------------------------
// The document's own frame.
// ---------------------------------------------------------------------------

describe("buildOpenApiDocument — the document frame", () => {
  it("declares 3.1.0 and carries the supplied title and version", () => {
    expect(DOC["openapi"]).toBe("3.1.0");
    expect((DOC["info"] as Record<string, unknown>)["title"]).toBe("CrossEngin");
    expect((DOC["info"] as Record<string, unknown>)["version"]).toBe("manifest-hash");
  });

  it("carries no OpenAPI 3.0 `nullable`, which a 3.1 document expresses as a type union", () => {
    expect(JSON.stringify(DOC)).not.toContain("\"nullable\"");
  });

  it("resolves every internal $ref it emits", () => {
    // A `$ref` naming an absent schema is a document a generator cannot compile, and the emitter
    // builds refs from entity names while the schemas come from a separate loop.
    const refs = [...JSON.stringify(DOC).matchAll(/#\/components\/schemas\/([A-Za-z0-9_]+)/g)].map(
      (m) => m[1]!,
    );
    expect(new Set(refs).size).toBeGreaterThan(40);
    expect([...new Set(refs)].filter((r) => COMPONENTS.schemas[r] === undefined)).toEqual([]);
  });
});
