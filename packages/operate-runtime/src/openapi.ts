import type { RouteDefinition } from "@crossengin/api-gateway";
import {
  AUTH_SCHEMES,
  AUTH_SCHEME_SECURITY_DOC,
  OPENAPI_PATH_ITEM_FIELD,
  pathParameterSchemaPattern,
  pathTemplateCollisions,
  renderPathTemplate,
} from "@crossengin/api-gateway";
import type { Manifest } from "@crossengin/kernel/manifest";
import type { Entity, Trait } from "@crossengin/types/meta-schema";

import { listQueryParameters, LIST_PARAMETER_COMPLEMENT_NOTE } from "./openapi-list-params.js";
import { entitySchemas, type CreateWiring, type JsonSchema } from "./openapi-schema.js";
import { entityCamel } from "./slugs.js";
import type { RouteSpec } from "./operations.js";

/**
 * A fact about this API the document provably cannot carry.
 *
 * `reach` borrows `pg-unreachable-stores.ts`'s distinction, because it is the one that decides what
 * the next reader should do: **`ordering`** means the facts exist and the emitter is not given them,
 * so the gap closes by wiring; **`shape`** means the format cannot express it, so it closes by a
 * format change or not at all. Calling both "not described" is what sends somebody to build the
 * thing that cannot be built honestly.
 */
export const OPENAPI_COVERAGE_KINDS = [
  "undeclared_authorization",
  "undeclared_parameters",
  "surface_outside_registry",
  "per_tenant_surface",
] as const;
export type OpenApiCoverageKind = (typeof OPENAPI_COVERAGE_KINDS)[number];

export interface OpenApiCoverageGap {
  readonly kind: OpenApiCoverageKind;
  readonly reach: "ordering" | "shape";
  readonly detail: string;
}

export const OPENAPI_REFUSALS = ["wildcard_path", "path_collision"] as const;
export type OpenApiRefusalKind = (typeof OPENAPI_REFUSALS)[number];

export interface OpenApiRefusal {
  readonly kind: OpenApiRefusalKind;
  readonly detail: string;
  readonly operationIds: readonly string[];
}

export interface OpenApiEmitInput {
  readonly manifest: Manifest;
  /** Every route the serving registry holds — `InMemoryRouteRegistry.list()`, read at request time. */
  readonly routes: readonly RouteDefinition[];
  /** The manifest-derived specs, which carry the entity attribution and the list config. */
  readonly routeSpecs: readonly RouteSpec[];
  readonly wiring: CreateWiring;
  readonly title: string;
  /** Identifies the described contract. The manifest hash, so the version moves iff the API does. */
  readonly version: string;
  /** Declared absences the caller knows about and the emitter cannot see. */
  readonly coverage: readonly OpenApiCoverageGap[];
}

export type OpenApiEmit =
  | { readonly document: Readonly<Record<string, unknown>>; readonly refused: null }
  | { readonly document: null; readonly refused: OpenApiRefusal };

/**
 * The `components.securitySchemes` object and the `security` requirement that names it, both
 * **derived** from `AUTH_SCHEME_SECURITY_DOC` — the gateway's own total map over every auth scheme,
 * `null` for each one this build does not serve.
 *
 * Derived rather than written here for two reasons that pull the same way. A hand-written pair
 * would be ADR-0288's maintained list in the one place a stale copy is read as a *capability*: a
 * `securitySchemes` entry is a **definition**, so a generator reads it as supported and emits a
 * client method for it, which means publishing one for `api_key_query` would invite exactly the
 * request ADR-0384 exists to refuse. And a sixth served scheme would then be described by nobody,
 * where the map makes it a compile error at the declaration site.
 *
 * `key` is the only field that is not part of the object; everything else is OpenAPI's own field
 * name, so this copies and never translates.
 */
const securityFromServedSchemes = (): {
  readonly schemes: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly requirement: readonly Readonly<Record<string, readonly string[]>>[];
} => {
  const schemes: Record<string, Readonly<Record<string, unknown>>> = {};
  const requirement: Readonly<Record<string, readonly string[]>>[] = [];
  for (const scheme of AUTH_SCHEMES) {
    const doc = AUTH_SCHEME_SECURITY_DOC[scheme];
    if (doc === null) continue;
    const { key, ...object } = doc;
    schemes[key] = object;
    // One requirement object per scheme, which is OpenAPI's OR. A single object carrying both keys
    // would be AND — "present a JWT *and* an api key" — which no route demands.
    requirement.push({ [key]: [] });
  }
  return { schemes, requirement };
};

const problemSchema: JsonSchema = {
  type: "object",
  description:
    "An RFC 9457 problem document. Note that it is the MINORITY error shape on this API: the " +
    "gateway's own denials (401, 403, 404, 429) carry `application/problem+json`, while a handler's " +
    "refusals carry `application/json` with an `{error, detail}` body.",
  properties: {
    type: { type: "string", format: "uri" },
    title: { type: "string" },
    status: { type: "integer" },
    detail: { type: "string" },
  },
};

const handlerErrorSchema: JsonSchema = {
  type: "object",
  description: "A handler refusal. `error` is a stable code; `detail` names the subject.",
  properties: { error: { type: "string" }, detail: { type: "string" } },
  required: ["error"],
};

const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });

const errorResponses = (): Readonly<Record<string, unknown>> => ({
  "400": {
    description: "The request names a surface this deployment does not serve.",
    content: { "application/json": { schema: ref("HandlerError") } },
  },
  "401": {
    description:
      "No usable credential. A credential presented in a scheme this build does not serve is " +
      "refused here by name rather than treated as anonymous (ADR-0384) — including `?api_key=`, " +
      "which is recognised and refused.",
    content: { "application/problem+json": { schema: ref("Problem") } },
  },
  "403": {
    description: "The principal's roles do not grant this operation on this entity.",
    content: { "application/problem+json": { schema: ref("Problem") } },
  },
});

/** The response body shape each action produces, so a page is not described as a record. */
const listResponseSchema = (entityRef: string): JsonSchema => ({
  type: "object",
  properties: {
    data: { type: "array", items: ref(entityRef) },
    page: {
      type: "object",
      description:
        "Terminate the walk on `nextCursor === null` and nothing else: a page may be short or " +
        "even empty while the cursor is non-null, because rows a record-level policy withholds are " +
        "dropped after the store's slice (ADR-0345).",
      properties: { nextCursor: { type: ["string", "null"] } },
    },
  },
  required: ["data"],
});

/**
 * Builds an OpenAPI 3.1 document for the surface a route registry holds.
 *
 * The input is the **registry's own list**, not `CompiledOperateServer.routeSpecs`: the register's
 * P1.17 names the latter and it is a strict subset, describing 334 of the 375 routes the shipped
 * compose serves. `routeSpecs` is still taken, for the two things only it carries — which entity a
 * route is about, and its `ListConfig`.
 *
 * It **refuses** rather than reports when a *served* route cannot be rendered, and that split is
 * the design's one load-bearing asymmetry. A declared structural absence (nobody can express which
 * role may call a route) is a named gap a reader can act on; a route silently missing from `paths`
 * is a document that describes a different API, which is the falsely-complete direction (ADR-0337).
 * Both refusals are measured empty today — zero wildcard routes and zero collisions across all
 * seven packs at both flag sets — so refusing breaks nothing that worked (ADR-0338's rule).
 */
export const buildOpenApiDocument = (input: OpenApiEmitInput): OpenApiEmit => {
  const collisions = pathTemplateCollisions(input.routes);
  if (collisions.length > 0) {
    const first = collisions[0]!;
    return {
      document: null,
      refused: {
        kind: "path_collision",
        detail:
          `${first.method} ${first.template} is served by ${String(first.operationIds.length)} ` +
          `routes, which one Paths Object cannot hold — OpenAPI treats templated paths differing ` +
          `only in a variable's name as the same path. The matcher separates them by registration ` +
          `order, so a document would describe one and omit the other.`,
        operationIds: first.operationIds,
      },
    };
  }
  const wildcards = input.routes.filter(
    (r) => renderPathTemplate(r.pathSegments, "openapi").template === null,
  );
  if (wildcards.length > 0) {
    return {
      document: null,
      refused: {
        kind: "wildcard_path",
        detail:
          "A served route carries a wildcard path segment, which OpenAPI 3.1 cannot express: a " +
          "path variable matches one segment and a wildcard matches any number. Describing it as a " +
          "parameter would send generated clients to a path the server does not serve.",
        operationIds: wildcards.map((r) => r.operationId),
      },
    };
  }

  const traits: readonly Trait[] = input.manifest.traits ?? [];
  const entities: readonly Entity[] = input.manifest.entities ?? [];
  const specByOperation = new Map(input.routeSpecs.map((s) => [s.operationId, s]));
  const schemas: Record<string, JsonSchema> = {
    Problem: problemSchema,
    HandlerError: handlerErrorSchema,
  };
  const undescribableFields: { entity: string; field: string; reason: string }[] = [];

  for (const entity of entities) {
    const built = entitySchemas(entity, traits, input.wiring);
    const base = entityCamel(entity.name);
    const name = `${base.charAt(0).toUpperCase()}${base.slice(1)}`;
    schemas[name] = built.response;
    schemas[`${name}Create`] = built.create;
    schemas[`${name}Update`] = built.update;
    for (const u of built.undescribable) {
      undescribableFields.push({ entity: entity.name, field: u.field, reason: u.reason });
    }
  }

  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of input.routes) {
    const rendered = renderPathTemplate(route.pathSegments, "openapi");
    const template = rendered.template;
    if (template === null) continue; // unreachable: refused above.
    const field = OPENAPI_PATH_ITEM_FIELD[route.method];
    if (field === null) continue; // CONNECT, which the Path Item Object has no field for.

    const spec = specByOperation.get(route.operationId);
    const entityName =
      spec === undefined ? null : `${entityCamel(spec.entity).charAt(0).toUpperCase()}${entityCamel(spec.entity).slice(1)}`;

    // A path parameter is `required: true` by the specification — OpenAPI permits no other value —
    // and carries the matcher's own pattern where the segment declares one, anchored, so a
    // generated client refuses a value the router would not have matched. `pattern: null` is not a
    // laxer claim than the server makes: the segment then matches any single non-empty segment.
    const pathParams = route.pathSegments.flatMap((segment) => {
      if (segment.kind !== "parameter") return [];
      const pattern = pathParameterSchemaPattern(segment);
      return [
        {
          name: segment.name,
          in: "path" as const,
          required: true,
          schema: pattern === null ? { type: "string" } : { type: "string", pattern },
        },
      ];
    });

    const queryParams =
      spec?.action === "list" && spec.listConfig !== undefined
        ? listQueryParameters(spec.listConfig)
        : [];

    const operation: Record<string, unknown> = {
      operationId: route.operationId,
      ...(pathParams.length + queryParams.length > 0
        ? { parameters: [...pathParams, ...queryParams] }
        : {}),
      responses: { ...errorResponses() },
    };

    if (spec !== undefined && entityName !== null) {
      const responses = operation["responses"] as Record<string, unknown>;
      if (spec.action === "list") {
        responses["200"] = {
          description: `A page of ${spec.entity} records.`,
          content: { "application/json": { schema: listResponseSchema(entityName) } },
        };
        operation["description"] = LIST_PARAMETER_COMPLEMENT_NOTE;
      } else if (spec.action === "create") {
        operation["requestBody"] = {
          required: true,
          content: { "application/json": { schema: ref(`${entityName}Create`) } },
        };
        responses["201"] = {
          description: `The created ${spec.entity}.`,
          content: { "application/json": { schema: ref(entityName) } },
        };
      } else if (spec.action === "update") {
        operation["requestBody"] = {
          required: true,
          content: { "application/json": { schema: ref(`${entityName}Update`) } },
        };
        responses["200"] = {
          description: `The updated ${spec.entity}.`,
          content: { "application/json": { schema: ref(entityName) } },
        };
      } else if (spec.action === "delete") {
        responses["204"] = { description: `The ${spec.entity} was deleted.` };
      } else if (spec.action === "transition") {
        // A transition takes NO body and silently discards one, measured: `invoke` with
        // `{state:"HACKED"}` answered 200 with the state the workflow declares. So the document
        // emits no `requestBody` — describing one would invite a payload the server throws away.
        responses["200"] = {
          description: `The ${spec.entity} after the \`${spec.transition?.name ?? "transition"}\` transition.`,
          content: { "application/json": { schema: ref(entityName) } },
        };
      } else {
        responses["200"] = {
          description: `A ${spec.entity} record.`,
          content: { "application/json": { schema: ref(entityName) } },
        };
      }
    }

    paths[template] ??= {};
    paths[template][field] = operation;
  }

  const coverage: OpenApiCoverageGap[] = [
    {
      kind: "undeclared_authorization",
      reach: "ordering",
      detail:
        "Which role may call an operation is not described. `RouteDefinition` carries no role or " +
        "permission field and `requiredScopes` is `[]` on every route in this workspace, so the " +
        "registry sees none of it; authorization lives in the manifest's `permissions` and is read " +
        "by `rbacCheck` inside each handler. The facts exist and this emitter is not given them.",
    },
    {
      kind: "undeclared_parameters",
      reach: "ordering",
      detail:
        "Only the entity-list operations declare query parameters, because only their route specs " +
        "carry a `ListConfig`. An operation with no `parameters` key is NOT a claim that it takes " +
        "none — the association and platform routes have their own readers this emitter cannot see.",
    },
    {
      kind: "surface_outside_registry",
      reach: "ordering",
      detail:
        "A deployment may serve paths this document cannot reach. Health probes, a login route and " +
        "webhook receivers are mounted as interceptors *ahead* of route matching, so they are in " +
        "no route registry and `paths` is silent about them. `paths` is therefore a complete " +
        "account of the routed surface and a lower bound on the served one.",
    },
    ...input.coverage,
  ];

  const security = securityFromServedSchemes();
  const document: Record<string, unknown> = {
    openapi: "3.1.0",
    info: {
      title: input.title,
      version: input.version,
      description:
        "Derived from this deployment's own route registry and manifest. `info.version` is the " +
        "manifest hash, so it moves exactly when the described contract does.",
    },
    components: { schemas, securitySchemes: security.schemes },
    // Every gateway route needs a credential — measured, an anonymous request is 401 — and either
    // scheme satisfies it. What is NOT expressible is which ROLE, which `undeclared_authorization`
    // names: a `security` requirement carries scopes, and `requiredScopes` is empty on every route.
    security: security.requirement,
    paths,
    "x-crossengin-coverage": coverage,
    ...(undescribableFields.length > 0 ? { "x-crossengin-undescribable-fields": undescribableFields } : {}),
  };
  return { document, refused: null };
};
