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
import { resolvedFields } from "@crossengin/kernel/ddl";
import { buildIncomingRequest, type HandlerOutput } from "@crossengin/api-gateway-runtime";
import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import { describe, expect, it } from "vitest";

import { compileOperateServer, type CompiledOperateServer } from "./compile.js";
import { EntityAuditUnrecorded, auditUnavailable, type EntityWriteAuditor } from "./entity-audit.js";
import {
  ACTION_HANDLER_REFUSALS,
  OPENAPI_COVERAGE_KINDS,
  OPENAPI_MEDIA_TYPE,
  OPENAPI_OPERATION_ID,
  buildOpenApiDocument,
  type OpenApiCoverageGap,
  type OpenApiEmitInput,
  type OpenApiTenantStatusDeclaration,
} from "./openapi.js";
import { routeFromSpec, type RouteAction } from "./operations.js";
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

/** The entities with an `entityLifecycle` workflow — the state-conditioned set on a plain compile. */
const lifecycleEntities = (manifest: Manifest): ReadonlySet<string> =>
  new Set(
    Object.values(manifest.workflows ?? {}).flatMap((w) => (w.kind === "entityLifecycle" ? [w.entity] : [])),
  );

/** No tenant-status gate, no write audit, no write checks: the claim each field's `null` makes. */
const UNGATED = {
  tenantStatus: null,
  writeAudit: null,
  writeRefusals: { checks: false, stateConditionedEntities: new Set<string>() },
} as const satisfies Pick<OpenApiEmitInput, "tenantStatus" | "writeAudit" | "writeRefusals">;

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
      writeSurfaces: compiled.writeSurfaces,
      residency: null,
      ...UNGATED,
      writeRefusals: { checks: true, stateConditionedEntities: lifecycleEntities(manifest) },
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

/**
 * A response entry with its `$ref` followed. Every refusal is a component now (ADR-0471), so a test
 * reading an entry's content reads the component it names — and an unresolvable reference is an
 * error here rather than an `undefined` the assertion would read as "absent".
 */
const resolveResponse = (
  doc: Readonly<Record<string, unknown>>,
  entry: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (entry === undefined) return undefined;
  const target = entry["$ref"];
  if (typeof target !== "string") return entry;
  const name = target.replace("#/components/responses/", "");
  const responses = (doc["components"] as Record<string, Record<string, Record<string, unknown>>>)["responses"];
  const found = responses?.[name];
  if (found === undefined) throw new Error(`unresolvable response reference ${target}`);
  return found;
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
  writeSurfaces: new Map(),
  residency: null,
  ...UNGATED,
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
    // `mtls` left this list by being **served** rather than by the argument being withdrawn: it
    // now carries a `type: mutualTLS` entry, which is correct — a generated client configures a key
    // pair in its TLS stack and sets no header, so the entry invites no request this API refuses.
    for (const scheme of ["api_key_query", "basic"] as const) {
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
        const content = resolveResponse(DOC, r[status])?.["content"] as Record<string, unknown> | undefined;
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
    // A narrowed search is declared and optional: the handler omits it unless a field was left out.
    expect(pageProps["searchNarrowedBy"]).toMatchObject({ type: "array", items: { type: "string" } });
    expect(String(pageProps["searchNarrowedBy"]!["description"])).toContain("was not looked for");
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

// ---------------------------------------------------------------------------
// Residency (ADR-0462): declared iff a region gate is configured, from what the gate wrapped.
// ---------------------------------------------------------------------------

describe("buildOpenApiDocument — the residency gate's responses", () => {
  const compiled = compileOperateServer(CORE, {
    store: new InMemoryEntityStore(),
    principalRoles: () => ({ primaryRole: "erp_admin" }),
  });
  const routes = compiled.routes.list();
  const allIds = routes.map((r) => r.operationId);
  // One operation standing in for an exempt one: the gate's own exemption rule lives in
  // operate-server, and the emitter must answer from the set it is handed, not re-derive it.
  const EXEMPT = "meta.schema.read";
  const gated = new Set(allIds.filter((id) => id !== EXEMPT));
  const emit = (residency: OpenApiEmitInput["residency"]) =>
    buildOpenApiDocument({
      manifest: CORE,
      routes,
      routeSpecs: compiled.routeSpecs,
      title: "CrossEngin",
      version: "manifest-hash",
      coverage: [],
      writeSurfaces: compiled.writeSurfaces,
      residency,
      ...UNGATED,
    });
  const gatedDoc = (() => {
    const d = emit({ gatedOperationIds: gated, tenantHintHeader: "x-tenant-id" }).document;
    if (d === null) throw new Error("refused");
    return d;
  })();
  const ungatedDoc = (() => {
    const d = emit(null).document;
    if (d === null) throw new Error("refused");
    return d;
  })();
  const opsOf = (d: Readonly<Record<string, unknown>>) =>
    documentOperations(d["paths"] as Record<string, Record<string, unknown>>);
  const responsesOf = (op: Record<string, unknown>) => op["responses"] as Record<string, unknown>;

  it("declares no 421 and no 503 anywhere, and no residency component, without a gate", () => {
    const ops = opsOf(ungatedDoc);
    expect(ops.length).toBeGreaterThan(300);
    for (const { operation } of ops) {
      expect(responsesOf(operation)["421"]).toBeUndefined();
      expect(responsesOf(operation)["503"]).toBeUndefined();
    }
    const components = ungatedDoc["components"] as Record<string, Record<string, unknown>>;
    // The role refusal and the 401 are components on every document now, so the claim is that no
    // residency-shaped one is among them.
    expect(Object.keys(components["responses"]!).filter((n) => /Residency/.test(n))).toEqual([]);
    expect(components["schemas"]!["ResidencyProblem"]).toBeUndefined();
    expect(JSON.stringify(ungatedDoc)).not.toContain("residency-");
  });

  it("declares the 421 on every routed operation and the 503 exactly on the gated ones", () => {
    const ops = opsOf(gatedDoc);
    expect(ops).toHaveLength(opsOf(ungatedDoc).length);
    let with503 = 0;
    for (const { operation } of ops) {
      const id = operation["operationId"] as string;
      const r = responsesOf(operation);
      expect(r["421"], id).toEqual({ $ref: "#/components/responses/ResidencyMisdirected" });
      if (gated.has(id)) {
        expect(r["503"], id).toEqual({ $ref: "#/components/responses/UnavailableOrResidencyUnresolved" });
        with503 += 1;
      } else {
        expect(r["503"], id).toBeUndefined();
      }
    }
    // Non-vacuity on both arms: the exempt operation is in the document and lost its 503.
    expect(with503).toBe(ops.length - 1);
    expect(ops.some((o) => o.operation["operationId"] === EXEMPT)).toBe(true);
  });

  it("references one shared problem component, whose enumerations are the builder's own", () => {
    const components = gatedDoc["components"] as Record<string, Record<string, unknown>>;
    const responses = components["responses"] as Record<string, Record<string, unknown>>;
    const misdirected = responses["ResidencyMisdirected"]!;
    expect(misdirected["content"]).toEqual({
      "application/problem+json": { schema: { $ref: "#/components/schemas/ResidencyProblem" } },
    });
    expect((misdirected["headers"] as Record<string, unknown>)["x-crossengin-region"]).toMatchObject({
      required: true,
    });
    expect(String(misdirected["description"])).toContain("x-tenant-id");
    const schema = components["schemas"]!["ResidencyProblem"] as {
      properties: Record<string, { enum?: unknown[]; properties?: Record<string, { enum?: unknown[] }> }>;
    };
    expect(schema.properties["type"]!.enum).toEqual([
      "https://crossengin.io/errors/residency-misdirected",
      "https://crossengin.io/errors/residency-violation",
      "https://crossengin.io/errors/residency-unresolved",
    ]);
    expect(schema.properties["status"]!.enum).toEqual([421, 403, 503]);
    expect(schema.properties["extensions"]!.properties!["reason"]!.enum).toEqual([
      "residency_misdirected",
      "residency_forbidden",
      "residency_unresolved",
    ]);
  });

  it("declares the gated 503 as one producer among several, so the audit refusal still parses", () => {
    // A gated write can answer `auditUnavailable` (application/json {error, detail}), the
    // tenant-status gate's problem, or the region gate's — the 403's treatment, not a residency-only one.
    const op = opsOf(gatedDoc).find((o) => o.operation["operationId"] === "invoice.create")!.operation;
    expect(responsesOf(op)["503"]).toEqual({ $ref: "#/components/responses/UnavailableOrResidencyUnresolved" });
    const components = gatedDoc["components"] as Record<string, Record<string, unknown>>;
    const unavailable = (components["responses"] as Record<string, unknown>)["UnavailableOrResidencyUnresolved"] as {
      description: string;
      headers: Record<string, { required: boolean }>;
      content: Record<string, { schema: unknown }>;
    };
    expect(unavailable.content["application/problem+json"]!.schema).toEqual({
      anyOf: [{ $ref: "#/components/schemas/Problem" }, { $ref: "#/components/schemas/ResidencyProblem" }],
    });
    expect(unavailable.content["application/json"]!.schema).toEqual({ $ref: "#/components/schemas/HandlerError" });
    // The audit refusal's real body satisfies the declared application/json arm.
    const handlerError = components["schemas"]!["HandlerError"] as { required: string[]; properties: Record<string, unknown> };
    const out = auditUnavailable(false);
    if (out.kind !== "json") throw new Error("auditUnavailable is a json output");
    expect(out.status).toBe(503);
    const body = out.body as Record<string, unknown>;
    for (const key of handlerError.required) expect(body[key]).toBeTypeOf("string");
    expect(Object.keys(body).every((k) => k in handlerError.properties)).toBe(true);
    // The audit 503 sends no retry-after, and after a link it says the write WAS made.
    expect(unavailable.headers["retry-after"]!.required).toBe(false);
    expect(unavailable.description).not.toContain("Retryable: nothing was done");
    expect(String(body["detail"])).toContain("the write was made");
  });

  it("folds the residency 403 into the declared 403 rather than adding a status", () => {
    const op = opsOf(gatedDoc).find((o) => o.operation["operationId"] === "invoice.list")!.operation;
    expect(responsesOf(op)["403"]).toEqual({ $ref: "#/components/responses/ForbiddenOrResidencyViolation" });
    const components = gatedDoc["components"] as Record<string, Record<string, unknown>>;
    const forbidden = (components["responses"] as Record<string, unknown>)["ForbiddenOrResidencyViolation"] as {
      content: Record<string, { schema: unknown }>;
    };
    expect(forbidden.content["application/problem+json"]!.schema).toEqual({
      anyOf: [{ $ref: "#/components/schemas/Problem" }, { $ref: "#/components/schemas/ResidencyProblem" }],
    });
    expect(forbidden.content["application/json"]!.schema).toEqual({ $ref: "#/components/schemas/HandlerError" });
  });

  it("resolves every component reference it adds", () => {
    const text = JSON.stringify(gatedDoc);
    const components = gatedDoc["components"] as Record<string, Record<string, unknown>>;
    for (const [, kind, name] of text.matchAll(/#\/components\/(schemas|responses)\/([A-Za-z0-9_]+)/g)) {
      expect(components[kind!]![name!], `${kind!}/${name!}`).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// ADR-0471: the tenant-status gate, the write audit and the handler refusals are declared exactly
// where something wired on this server can answer them, and absent where nothing can.
// ---------------------------------------------------------------------------

/**
 * A tenant-status declaration as a deployment would hand one over. The real facts come from the
 * gate's own constants in `operate-server` (`tenantStatusOpenApiDeclaration`, whose test compares
 * them with the gate's bodies); this package cannot import that one, so the fixture states them.
 */
const tenantStatusFixture = (gated: ReadonlySet<string>): OpenApiTenantStatusDeclaration => ({
  gatedOperationIds: gated,
  refused: {
    type: "https://crossengin.dev/problems/tenant-lifecycle-state",
    reasons: ["tenant_writes_blocked", "tenant_reads_blocked", "tenant_not_provisioned"],
    states: ["suspended", "archived", "pending_deletion", "deleted"],
  },
  unavailable: {
    type: "https://crossengin.dev/problems/tenant-status-unavailable",
    reason: "tenant_status_unavailable",
    retryAfterSeconds: 5,
  },
});

describe("buildOpenApiDocument — every refusal declared resolves, and every component is referenced", () => {
  const compiled = compileOperateServer(CORE, {
    store: new InMemoryEntityStore(),
    principalRoles: () => ({ primaryRole: "erp_admin" }),
  });
  const routes = compiled.routes.list();
  const everyId = new Set(routes.map((r) => r.operationId));
  const doc = buildOpenApiDocument({
    manifest: CORE,
    routes,
    routeSpecs: compiled.routeSpecs,
    title: "CrossEngin",
    version: "manifest-hash",
    coverage: [],
    writeSurfaces: compiled.writeSurfaces,
    residency: { gatedOperationIds: everyId, tenantHintHeader: "x-tenant-id" },
    tenantStatus: tenantStatusFixture(everyId),
    writeAudit: { associationWriteOperationIds: new Set() },
    writeRefusals: { checks: true, stateConditionedEntities: lifecycleEntities(CORE) },
  }).document!;

  it("leaves no dead component and no unresolvable reference, with every producer declared", () => {
    // ADR-0392's validity checks over the widest document this emitter can produce: every gate on.
    const text = JSON.stringify(doc);
    const components = doc["components"] as Record<string, Record<string, unknown>>;
    const referenced = new Set<string>();
    for (const [, kind, name] of text.matchAll(/#\/components\/(schemas|responses)\/([A-Za-z0-9_.]+)/g)) {
      expect(components[kind!]![name!], `${kind!}/${name!}`).toBeDefined();
      referenced.add(`${kind!}/${name!}`);
    }
    const responseNames = Object.keys(components["responses"]!);
    expect(responseNames.length).toBeGreaterThan(8);
    expect(responseNames.filter((n) => !referenced.has(`responses/${n}`))).toEqual([]);
    // Every refusal-body schema is referenced by some response; the entity schemas by operations.
    for (const name of ["Problem", "HandlerError", "ResidencyProblem", "TenantStateProblem", "TenantStatusUnavailableProblem", "ValidationFailed"]) {
      expect(referenced.has(`schemas/${name}`), name).toBe(true);
    }
  });

  it("keeps every (name, in) parameter pair unique on every operation", () => {
    for (const { operation } of documentOperations(doc["paths"] as Record<string, Record<string, unknown>>)) {
      const params = (operation["parameters"] ?? []) as { name: string; in: string }[];
      const keys = params.map((p) => `${p.in}:${p.name}`);
      expect(new Set(keys).size, String(operation["operationId"])).toBe(keys.length);
    }
  });
});

describe("buildOpenApiDocument — the tenant-status gate's responses (ADR-0471)", () => {
  const compiled = compileOperateServer(CORE, {
    store: new InMemoryEntityStore(),
    principalRoles: () => ({ primaryRole: "erp_admin" }),
  });
  const routes = compiled.routes.list();
  // The gate's own exemption rule lives in operate-server; the emitter answers from the set it is
  // handed. One operation stands in for an exempt one.
  const EXEMPT = "meta.schema.read";
  const gated = new Set(routes.map((r) => r.operationId).filter((id) => id !== EXEMPT));
  const emit = (
    tenantStatus: OpenApiTenantStatusDeclaration | null,
    residency: OpenApiEmitInput["residency"] = null,
  ) => {
    const d = buildOpenApiDocument({
      manifest: CORE,
      routes,
      routeSpecs: compiled.routeSpecs,
      title: "CrossEngin",
      version: "manifest-hash",
      coverage: [],
      writeSurfaces: compiled.writeSurfaces,
      residency,
      ...UNGATED,
      tenantStatus,
    }).document;
    if (d === null) throw new Error("refused");
    return d;
  };
  const gatedDoc = emit(tenantStatusFixture(gated));
  const ungatedDoc = emit(null);
  const specIds = new Set(compiled.routeSpecs.map((s) => s.operationId));
  const opsOf = (d: Readonly<Record<string, unknown>>) =>
    documentOperations(d["paths"] as Record<string, Record<string, unknown>>);
  const responsesOf = (op: Record<string, unknown>) => op["responses"] as Record<string, unknown>;

  it("declares the gate's 403 and 503 on exactly the gated operations", () => {
    const ops = opsOf(gatedDoc);
    expect(ops.length).toBeGreaterThan(300);
    let gatedSeen = 0;
    for (const { operation } of ops) {
      const id = operation["operationId"] as string;
      const r = responsesOf(operation);
      if (gated.has(id)) {
        gatedSeen += 1;
        expect(r["403"], id).toEqual({ $ref: "#/components/responses/ForbiddenOrTenantStateRefused" });
        // A route that is not the entity handler answers 503s of its own (ADR-0471's review), so
        // its entry admits that shape too and is a different component.
        expect(r["503"], id).toEqual({
          $ref: `#/components/responses/UnavailableOrTenantStatusUnresolved${specIds.has(id) ? "" : "OrRouteOwn"}`,
        });
      } else {
        expect(r["403"], id).toEqual({ $ref: "#/components/responses/Forbidden" });
        expect(r["503"], id).toBeUndefined();
      }
    }
    // Non-vacuity on both arms: the exempt operation is present and kept the plain role refusal.
    expect(gatedSeen).toBe(ops.length - 1);
    expect(ops.some((o) => o.operation["operationId"] === EXEMPT)).toBe(true);
  });

  it("declares none of it, and carries no tenant-status schema, without the gate", () => {
    for (const { operation } of opsOf(ungatedDoc)) {
      const r = responsesOf(operation);
      expect(r["403"]).toEqual({ $ref: "#/components/responses/Forbidden" });
      expect(r["503"]).toBeUndefined();
    }
    const components = ungatedDoc["components"] as Record<string, Record<string, unknown>>;
    expect(components["schemas"]!["TenantStateProblem"]).toBeUndefined();
    expect(components["schemas"]!["TenantStatusUnavailableProblem"]).toBeUndefined();
    expect(JSON.stringify(ungatedDoc)).not.toContain("tenant_status_unavailable");
  });

  it("describes the gate's bodies with its own types, reasons and states, top-level as sent", () => {
    const decl = tenantStatusFixture(gated);
    const schemas = (gatedDoc["components"] as Record<string, Record<string, Record<string, unknown>>>)["schemas"]!;
    const refused = schemas["TenantStateProblem"] as {
      properties: Record<string, { enum?: unknown[]; oneOf?: { enum?: unknown[]; type?: string }[] }>;
      required: string[];
    };
    expect(refused.properties["type"]!.enum).toEqual([decl.refused.type]);
    expect(refused.properties["reason"]!.enum).toEqual(decl.refused.reasons);
    expect(refused.properties["status"]!.enum).toEqual([403]);
    expect(refused.properties["tenantStatus"]!.oneOf).toEqual([
      { type: "string", enum: decl.refused.states },
      { type: "null" },
    ]);
    // `tenantStatus` and `reason` are top-level, because that is where the gate puts them.
    expect(refused.required).toEqual(["type", "title", "status", "detail", "tenantStatus", "reason"]);
    expect(refused.properties["extensions"]).toBeUndefined();
    const unavailable = schemas["TenantStatusUnavailableProblem"] as {
      properties: Record<string, { enum?: unknown[] }>;
    };
    expect(unavailable.properties["reason"]!.enum).toEqual([decl.unavailable.reason]);
    expect(unavailable.properties["status"]!.enum).toEqual([503]);
    const responses = (gatedDoc["components"] as Record<string, Record<string, Record<string, unknown>>>)["responses"]!;
    const u = responses["UnavailableOrTenantStatusUnresolved"] as {
      headers: Record<string, { required: boolean; description: string }>;
      content: Record<string, { schema: unknown }>;
    };
    // The gate's own 503 always sends retry-after, and the gateway's own 503 does not always, so the
    // entry names the figure and does not promise the header (ADR-0471's review).
    expect(u.headers["retry-after"]!.required).toBe(false);
    expect(u.headers["retry-after"]!.description).toContain("5");
    // An entity route: the gate's body and the gateway's, and no application/json, because the
    // entity handler answers no 503 of its own when no recorder is wired.
    expect(Object.keys(u.content)).toEqual(["application/problem+json"]);
    expect(u.content["application/problem+json"]!.schema).toEqual({
      anyOf: [
        { $ref: "#/components/schemas/TenantStatusUnavailableProblem" },
        { $ref: "#/components/schemas/Problem" },
      ],
    });
    // A route with no RouteSpec admits its own application/json 503 as well: the shipped compose's
    // `POST /v1/ai/design` with no provider answers `503 {"error":"ai_unavailable"}`.
    const own = responses["UnavailableOrTenantStatusUnresolvedOrRouteOwn"] as {
      content: Record<string, { schema: unknown }>;
    };
    expect(own.content["application/json"]!.schema).toEqual({ $ref: "#/components/schemas/HandlerError" });
  });

  it("composes with the region gate into one 403 and one 503 admitting both bodies", () => {
    const both = emit(tenantStatusFixture(gated), { gatedOperationIds: gated, tenantHintHeader: "x-tenant-id" });
    const op = opsOf(both).find((o) => o.operation["operationId"] === "invoice.create")!.operation;
    expect(responsesOf(op)["403"]).toEqual({
      $ref: "#/components/responses/ForbiddenOrResidencyViolationOrTenantStateRefused",
    });
    expect(responsesOf(op)["503"]).toEqual({
      $ref: "#/components/responses/UnavailableOrResidencyUnresolvedOrTenantStatusUnresolved",
    });
    const responses = (both["components"] as Record<string, Record<string, Record<string, unknown>>>)["responses"]!;
    const forbidden = responses["ForbiddenOrResidencyViolationOrTenantStateRefused"] as {
      content: Record<string, { schema: unknown }>;
    };
    expect(forbidden.content["application/problem+json"]!.schema).toEqual({
      anyOf: [
        { $ref: "#/components/schemas/Problem" },
        { $ref: "#/components/schemas/ResidencyProblem" },
        { $ref: "#/components/schemas/TenantStateProblem" },
      ],
    });
    const unavailable = responses["UnavailableOrResidencyUnresolvedOrTenantStatusUnresolved"] as {
      headers: Record<string, { required: boolean }>;
    };
    // The residency arm does not always send retry-after, so the composed entry cannot promise it.
    expect(unavailable.headers["retry-after"]!.required).toBe(false);
    // And the exempt operation keeps only the residency 403 arm, since the region's pre-auth check
    // reaches every routed operation while the tenant gate does not reach this one.
    const exempt = opsOf(both).find((o) => o.operation["operationId"] === EXEMPT)!.operation;
    expect(responsesOf(exempt)["403"]).toEqual({ $ref: "#/components/responses/ForbiddenOrResidencyViolation" });
    expect(responsesOf(exempt)["503"]).toBeUndefined();
  });
});

describe("buildOpenApiDocument — the write audit's 503 (ADR-0471)", () => {
  const compiled = compileOperateServer(CORE, {
    store: new InMemoryEntityStore(),
    principalRoles: () => ({ primaryRole: "erp_admin" }),
  });
  // `erp-core` declares no many-to-many relation, so the association half is exercised on a
  // fixture route the registry would serve beside the entity routes.
  const LINK = fixtureRoute("rt_fixturelink1", "widget.gadgets.link", "PUT", [
    lit("v1"), lit("widgets"), param("id"), lit("gadgets"), param("relatedId"),
  ]);
  const routes = [...compiled.routes.list(), LINK];
  const actionOf = new Map(compiled.routeSpecs.map((s) => [s.operationId, s.action]));
  const emit = (writeAudit: OpenApiEmitInput["writeAudit"]) =>
    buildOpenApiDocument({
      manifest: CORE,
      routes,
      routeSpecs: compiled.routeSpecs,
      title: "CrossEngin",
      version: "manifest-hash",
      coverage: [],
      writeSurfaces: compiled.writeSurfaces,
      residency: null,
      ...UNGATED,
      writeAudit,
    }).document!;
  const AUDITED: readonly RouteAction[] = ["create", "update", "delete", "transition"];

  it("declares the 503 on exactly the entity writes and the association writes when a recorder is wired", () => {
    const d = emit({ associationWriteOperationIds: new Set([LINK.operationId]) });
    const counts = { audited: 0, other: 0 };
    for (const { operation } of documentOperations(d["paths"] as Record<string, Record<string, unknown>>)) {
      const id = operation["operationId"] as string;
      const r = operation["responses"] as Record<string, unknown>;
      const action = actionOf.get(id);
      if ((action !== undefined && AUDITED.includes(action)) || id === LINK.operationId) {
        counts.audited += 1;
        expect(r["503"], id).toEqual({ $ref: "#/components/responses/UnavailableOrAuditUnrecorded" });
      } else {
        counts.other += 1;
        expect(r["503"], id).toBeUndefined();
      }
    }
    expect(counts.audited).toBeGreaterThan(150);
    expect(counts.other).toBeGreaterThan(50);
  });

  it("declares no write-audit 503 anywhere when nothing records the write", () => {
    const d = emit(null);
    for (const { operation } of documentOperations(d["paths"] as Record<string, Record<string, unknown>>)) {
      expect((operation["responses"] as Record<string, unknown>)["503"]).toBeUndefined();
    }
    expect(JSON.stringify(d)).not.toContain("audit_unavailable");
  });

  it("describes both audit outcomes, and the real bodies satisfy the declared shape", () => {
    const d = emit({ associationWriteOperationIds: new Set() });
    const components = d["components"] as Record<string, Record<string, Record<string, unknown>>>;
    const response = components["responses"]!["UnavailableOrAuditUnrecorded"] as {
      description: string;
      headers?: unknown;
      content: Record<string, { schema: unknown }>;
    };
    // The audit's body, and the gateway's own problem beside it: a 503 is never one producer's.
    expect(response.content).toEqual({
      "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } },
      "application/json": { schema: { $ref: "#/components/schemas/HandlerError" } },
    });
    // Neither the audit 503 nor the gateway's sets retry-after unconditionally, so the entry declares none.
    expect(response.headers).toBeUndefined();
    expect(response.description).toContain("rolled back");
    expect(response.description).toContain("the write was made");
    const handlerError = components["schemas"]!["HandlerError"] as { required: string[]; properties: Record<string, unknown> };
    for (const rolledBack of [true, false]) {
      const out = auditUnavailable(rolledBack);
      if (out.kind !== "json") throw new Error("auditUnavailable is a json output");
      expect(out.status).toBe(503);
      const body = out.body as Record<string, unknown>;
      for (const key of handlerError.required) expect(body[key]).toBeTypeOf("string");
      expect(Object.keys(body).every((k) => k in handlerError.properties)).toBe(true);
    }
  });
});

describe("buildOpenApiDocument — the handler's 404, 409 and 422 (ADR-0471)", () => {
  const compiled = compileOperateServer(CORE, {
    store: new InMemoryEntityStore(),
    principalRoles: () => ({ primaryRole: "erp_admin" }),
  });
  const routes = compiled.routes.list();
  const specOf = new Map(compiled.routeSpecs.map((s) => [s.operationId, s]));
  const stateful = lifecycleEntities(CORE);
  const emit = (checks: boolean) =>
    buildOpenApiDocument({
      manifest: CORE,
      routes,
      routeSpecs: compiled.routeSpecs,
      title: "CrossEngin",
      version: "manifest-hash",
      coverage: [],
      writeSurfaces: compiled.writeSurfaces,
      residency: null,
      ...UNGATED,
      writeRefusals: { checks, stateConditionedEntities: stateful },
    }).document!;
  const checked = emit(true);
  const unchecked = emit(false);
  const statuses = (d: Readonly<Record<string, unknown>>, id: string): Record<string, unknown> => {
    const found = documentOperations(d["paths"] as Record<string, Record<string, unknown>>).find(
      (o) => o.operation["operationId"] === id,
    );
    if (found === undefined) throw new Error(id);
    return found.operation["responses"] as Record<string, unknown>;
  };

  it("declares 404 on read/update/delete/transition and nowhere else", () => {
    const wrong: string[] = [];
    for (const route of routes) {
      const spec = specOf.get(route.operationId);
      const expected = spec !== undefined && ACTION_HANDLER_REFUSALS[spec.action].notFound;
      const has = statuses(checked, route.operationId)["404"] !== undefined;
      if (has !== expected) wrong.push(`${route.operationId}:${has ? "declared" : "absent"}`);
    }
    expect(wrong).toEqual([]);
    expect(statuses(checked, "invoice.read")["404"]).toEqual({ $ref: "#/components/responses/NotFound" });
  });

  it("declares 422 on every create and update, on delete and transition only with write checks, never on read or list", () => {
    for (const [id, spec] of specOf) {
      for (const [doc, checks] of [[checked, true], [unchecked, false]] as const) {
        const has = statuses(doc, id)["422"] !== undefined;
        const expected =
          spec.action === "create" || spec.action === "update" ||
          ((spec.action === "delete" || spec.action === "transition") && checks);
        expect(has, `${id}:${String(checks)}`).toBe(expected);
      }
    }
    expect(statuses(checked, "invoice.create")["422"]).toEqual({ $ref: "#/components/responses/UnprocessableCreate" });
    // A non-spec route carries none: its handler is not the entity handler.
    expect(statuses(checked, OPENAPI_OPERATION_ID)["422"]).toBeUndefined();
  });

  it("declares 409 on create, update and transition, and on a delete only where something can refuse it", () => {
    let undeclaredDeletes = 0;
    for (const [id, spec] of specOf) {
      const has = statuses(unchecked, id)["409"] !== undefined;
      if (spec.action === "list" || spec.action === "read") expect(has, id).toBe(false);
      else if (spec.action === "delete") {
        const referenced = (CORE.entities ?? []).some((e) =>
          resolvedFields(e, CORE.traits ?? []).some((f) => f.type.kind === "reference" && f.type.target === spec.entity),
        );
        // Both directions (ADR-0471's review): with no write checks, a delete of an entity nothing
        // references and no lifecycle conditions has no 409 producer, so none is declared.
        expect(has, id).toBe(stateful.has(spec.entity) || referenced);
        if (!has) undeclaredDeletes += 1;
      } else expect(has, id).toBe(true);
    }
    // Non-vacuity of the absence arm: some erp-core delete really has no 409 producer.
    expect(undeclaredDeletes).toBeGreaterThan(0);
    // A stateful, referenced document's delete names both conditional codes in its component.
    expect(statuses(unchecked, "invoice.delete")["409"]).toEqual({
      $ref: "#/components/responses/ConflictDeleteStateConditionedReferenced",
    });
  });

  it("lets the validation body be told from a coded refusal on the 422", () => {
    const components = checked["components"] as Record<string, Record<string, Record<string, unknown>>>;
    const create = components["responses"]!["UnprocessableCreate"] as { content: Record<string, { schema: unknown }>; description: string };
    expect(create.content["application/json"]!.schema).toEqual({
      anyOf: [{ $ref: "#/components/schemas/HandlerError" }, { $ref: "#/components/schemas/ValidationFailed" }],
    });
    for (const code of ACTION_HANDLER_REFUSALS.create.unprocessable) expect(create.description).toContain(`\`${code}\``);
    // The transition 422 has no validation body: a transition takes none.
    const transition = components["responses"]!["UnprocessableTransition"] as { content: Record<string, { schema: unknown }> };
    expect(transition.content["application/json"]!.schema).toEqual({ $ref: "#/components/schemas/HandlerError" });
  });
});

// ---------------------------------------------------------------------------
// The declaration against the handlers: drive the real compiled server, and require that every
// refusal it answers is declared on that operation with a shape that admits the body.
// ---------------------------------------------------------------------------

describe("the compiled server's own document declares the refusals its handlers answer (ADR-0471)", () => {
  const TENANT = "11111111-1111-4111-8111-111111111111";
  const principal: ResolvedPrincipal = {
    principalId: "00000000-0000-4000-8000-0000000000aa",
    tenantId: TENANT,
    principalKind: "user",
    authScheme: "api_key_header",
    grantedScopes: ["erp_admin"],
    mfaProofAgeSeconds: null,
    resolvedAt: "2026-06-03T12:00:00.000Z",
  };
  const refusingAuditor: EntityWriteAuditor = {
    record: async () => {
      throw new EntityAuditUnrecorded("fixture refuses");
    },
  };
  const build = (entityAudit: EntityWriteAuditor | undefined): CompiledOperateServer =>
    compileOperateServer(CORE, {
      store: new InMemoryEntityStore(),
      principalRoles: () => ({ primaryRole: "erp_admin" }),
      ...(entityAudit !== undefined ? { entityAudit } : {}),
    });
  const invoke = async (
    server: CompiledOperateServer,
    opId: string,
    params: Record<string, string> = {},
    body: Record<string, unknown> | null = null,
  ): Promise<HandlerOutput> => {
    const spec = server.routeSpecs.find((s) => s.operationId === opId);
    const route = spec !== undefined ? routeFromSpec(spec) : server.routes.list().find((r) => r.operationId === opId)!;
    const handler = server.handlers.resolve(opId);
    if (handler === null) throw new Error(`no handler ${opId}`);
    const request = buildIncomingRequest({
      id: "req_s3openapi01",
      receivedAt: "2026-06-03T12:00:00.000Z",
      method: route.method,
      path: "/v1/x",
      headers: {},
      host: "api.example.com",
      scheme: "https",
      bodyBytes: null,
      clientIp: "203.0.113.1",
      edgeTrust: "untrusted",
    });
    return handler({ request, route, principal, params, parsedBody: body });
  };
  const documentOf = async (server: CompiledOperateServer): Promise<Readonly<Record<string, unknown>>> => {
    const out = await invoke(server, OPENAPI_OPERATION_ID);
    if (out.kind !== "json" || out.status !== 200) throw new Error(`document refused: ${JSON.stringify(out)}`);
    return out.body as Readonly<Record<string, unknown>>;
  };
  /** The declared status's schema names for the body's media type. */
  const declaredSchemas = (doc: Readonly<Record<string, unknown>>, opId: string, status: number): string[] => {
    const op = documentOperations(doc["paths"] as Record<string, Record<string, unknown>>).find(
      (o) => o.operation["operationId"] === opId,
    )!.operation;
    const entry = resolveResponse(doc, (op["responses"] as Record<string, Record<string, unknown>>)[String(status)]);
    if (entry === undefined) return [];
    const schema = (entry["content"] as Record<string, { schema: Record<string, unknown> }>)["application/json"]?.schema;
    if (schema === undefined) return [];
    const refs = (schema["anyOf"] as { $ref: string }[] | undefined) ?? [schema as { $ref: string }];
    return refs.map((r) => r.$ref.replace("#/components/schemas/", ""));
  };
  const admits = (doc: Readonly<Record<string, unknown>>, schemaName: string, body: Record<string, unknown>): boolean => {
    const schema = (doc["components"] as Record<string, Record<string, { required?: string[]; properties: Record<string, unknown> }>>)["schemas"]![schemaName]!;
    return (schema.required ?? []).every((k) => body[k] !== undefined);
  };
  const expectDeclared = (doc: Readonly<Record<string, unknown>>, opId: string, out: HandlerOutput, status: number) => {
    expect(out.kind).toBe("json");
    if (out.kind !== "json") return;
    expect(out.status, `${opId} answered ${JSON.stringify(out.body)}`).toBe(status);
    const names = declaredSchemas(doc, opId, status);
    expect(names.length, `${opId} declares no ${String(status)}`).toBeGreaterThan(0);
    expect(names.some((n) => admits(doc, n, out.body as Record<string, unknown>)), `${opId}:${String(status)}`).toBe(true);
  };

  it("declares the 404, 409 and 422 the entity handlers answer", async () => {
    const server = build(undefined);
    const doc = await documentOf(server);
    expectDeclared(doc, "lead.read", await invoke(server, "lead.read", { id: "rec_missing" }), 404);
    expectDeclared(doc, "lead.create", await invoke(server, "lead.create", {}, {}), 422);
    expectDeclared(doc, "lead.create", await invoke(server, "lead.create", {}, { full_name: "A", nonsense: 1 }), 422);
    const created = await invoke(server, "lead.create", {}, { id: "lead_fixed_1", full_name: "A" });
    expect(created.status).toBe(201);
    expectDeclared(doc, "lead.create", await invoke(server, "lead.create", {}, { id: "lead_fixed_1", full_name: "B" }), 409);
    // A transition whose from-states exclude the record's state: the 409 the arm answers itself.
    const leadInitial = server.routeSpecs.find((s) => s.entity === "Lead" && s.action === "transition")!.transition!.initialState;
    const illegal = server.routeSpecs.find(
      (s) => s.entity === "Lead" && s.action === "transition" && !s.transition!.fromStates.includes(leadInitial),
    )!;
    expectDeclared(doc, illegal.operationId, await invoke(server, illegal.operationId, { id: "lead_fixed_1" }), 409);
  });

  it("declares the write audit's 503 on the compiled server's own document only when a recorder is wired", async () => {
    const audited = build(refusingAuditor);
    const doc = await documentOf(audited);
    expectDeclared(doc, "lead.create", await invoke(audited, "lead.create", {}, { full_name: "A" }), 503);
    // The same server without a recorder: the write succeeds and the document declares no 503.
    const plain = build(undefined);
    const plainDoc = await documentOf(plain);
    expect((await invoke(plain, "lead.create", {}, { full_name: "A" })).status).toBe(201);
    expect(declaredSchemas(plainDoc, "lead.create", 503)).toEqual([]);
  });

  it("forwards a tenant-status declaration through compileOperateServer's thunk, read on the first request", async () => {
    let declaration: OpenApiTenantStatusDeclaration | null = null;
    const server = compileOperateServer(CORE, {
      store: new InMemoryEntityStore(),
      principalRoles: () => ({ primaryRole: "erp_admin" }),
      openApiTenantStatus: () => declaration,
    });
    // Set after the compile returns, as `buildOperateHttpServer` does once the gate has run.
    declaration = tenantStatusFixture(new Set(["lead.create"]));
    const doc = await documentOf(server);
    const op = documentOperations(doc["paths"] as Record<string, Record<string, unknown>>).find(
      (o) => o.operation["operationId"] === "lead.create",
    )!.operation;
    expect((op["responses"] as Record<string, unknown>)["503"]).toEqual({
      $ref: "#/components/responses/UnavailableOrTenantStatusUnresolved",
    });
  });
});

describe("buildOpenApiDocument — the 401 and 403 are components (ADR-0471, ADR-0462 open question 5)", () => {
  it("references one shared entry per status, which is smaller than inlining it per operation", () => {
    const responses = (DOC["components"] as Record<string, Record<string, unknown>>)["responses"] as Record<string, unknown>;
    const inlined = JSON.parse(JSON.stringify(DOC)) as Record<string, unknown>;
    let operations = 0;
    for (const item of Object.values(inlined["paths"] as Record<string, Record<string, Record<string, unknown>>>)) {
      for (const op of Object.values(item)) {
        operations += 1;
        const r = op["responses"] as Record<string, unknown>;
        expect(r["401"]).toEqual({ $ref: "#/components/responses/Unauthenticated" });
        expect(r["403"]).toEqual({ $ref: "#/components/responses/Forbidden" });
        r["401"] = responses["Unauthenticated"];
        r["403"] = responses["Forbidden"];
      }
    }
    const sharedBytes = JSON.stringify(DOC).length;
    const inlinedBytes = JSON.stringify(inlined).length;
    // Measured on `erp-core` (343 operations, no residency, no tenant gate): 833,214 bytes with the
    // two shared components against 1,020,835 with the same two entries inlined on every operation,
    // a drop of 187,621 bytes (18.4 % of the inlined document, ~547 bytes per operation). The floor
    // below is 500 per operation, so a sentence edit does not break it and a regression to inlining
    // does.
    expect(operations).toBeGreaterThan(300);
    expect(inlinedBytes - sharedBytes).toBeGreaterThan(operations * 500);
  });
});
