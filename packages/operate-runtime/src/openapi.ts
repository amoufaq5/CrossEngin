import {
  rbacCheck,
  type Operation,
  type PermissionMap,
  type Principal,
  type RoleDefinition,
  type RoleName,
} from "@crossengin/auth";
import type { ResolvedPrincipal, RouteDefinition } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";

import type { ApiDescriptor, ApiOperation } from "./api-descriptor.js";
import {
  PROBLEM_SCHEMA,
  PROBLEM_SCHEMA_NAME,
  REPORT_DATA_SCHEMA,
  REPORT_DATA_SCHEMA_NAME,
  type OpenApiSchema,
} from "./schemas.js";
import { routeId } from "./slugs.js";

/**
 * A minimal but valid OpenAPI 3.1 document projected from the `ApiDescriptor`.
 * It carries the path/operation surface (operationIds, methods, path parameters,
 * tags) plus — when entity schemas are supplied (P3.32) — `components.schemas`
 * (a typed schema per entity + the `ReportData` union) referenced from each
 * operation's request/response bodies. The report catalog rides under the
 * `x-reports` extension.
 */
export interface OpenApiInfo {
  readonly title: string;
  readonly version: string;
}

export interface OpenApiParameter {
  readonly name: string;
  readonly in: "path";
  readonly required: true;
  readonly schema: { readonly type: "string" };
}

export interface OpenApiMediaType {
  readonly schema: OpenApiSchema;
}

export interface OpenApiRequestBody {
  readonly required: boolean;
  readonly content: Readonly<Record<string, OpenApiMediaType>>;
}

export interface OpenApiResponse {
  readonly description: string;
  readonly content?: Readonly<Record<string, OpenApiMediaType>>;
}

export interface OpenApiOperationObject {
  readonly operationId: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly parameters?: readonly OpenApiParameter[];
  readonly requestBody?: OpenApiRequestBody;
  readonly responses: Readonly<Record<string, OpenApiResponse>>;
}

export interface OpenApiComponents {
  readonly schemas: Readonly<Record<string, OpenApiSchema>>;
}

export interface OpenApiDocument {
  readonly openapi: "3.1.0";
  readonly info: OpenApiInfo;
  readonly paths: Readonly<Record<string, Readonly<Record<string, OpenApiOperationObject>>>>;
  readonly components?: OpenApiComponents;
  readonly "x-reports": ApiDescriptor["reports"];
}

/** Options for `toOpenApiDocument`: the entity schemas to embed + reference. */
export interface ToOpenApiOptions {
  readonly entitySchemas?: Readonly<Record<string, OpenApiSchema>>;
}

const HTTP_METHOD_KEYS: Readonly<Record<string, string>> = {
  GET: "get",
  POST: "post",
  PUT: "put",
  PATCH: "patch",
  DELETE: "delete",
  HEAD: "head",
  OPTIONS: "options",
};

/** Extracts the `{param}` placeholders from a path template, in order. */
function pathParams(path: string): readonly string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
}

function summaryFor(op: ApiOperation): string {
  if (op.kind === "report") return "Run a manifest report";
  if (op.kind === "transition") return `${op.entity ?? ""} — ${op.transition ?? "transition"}`;
  return `${op.kind} ${op.entity ?? ""}`.trim();
}

function jsonContent(schema: OpenApiSchema): Readonly<Record<string, OpenApiMediaType>> {
  return { "application/json": { schema } };
}

function ref(name: string): OpenApiSchema {
  return { $ref: `#/components/schemas/${name}` };
}

/** The transition request body schema (`{ transition: string }`). */
const TRANSITION_REQUEST: OpenApiSchema = {
  type: "object",
  properties: { transition: { type: "string" } },
  required: ["transition"],
};

/** A `application/problem+json` error response referencing the ProblemDetails schema. */
function problemResponse(description: string): OpenApiResponse {
  return { description, content: { "application/problem+json": { schema: ref(PROBLEM_SCHEMA_NAME) } } };
}

/**
 * The RFC 9457 error responses an operation can emit (P3.33): every operation can
 * 401 (unauthenticated); entity ops add 403 (RBAC); ops with a record id
 * (read/update/delete/transition) add 404; transitions add 409 (invalid
 * from-state). The report op documents its own 404 in `operationObject`.
 */
function errorResponses(op: ApiOperation): Record<string, OpenApiResponse> {
  const out: Record<string, OpenApiResponse> = { "401": problemResponse("Unauthenticated") };
  if (op.kind === "report") return out;
  out["403"] = problemResponse("Forbidden");
  const hasId = op.kind === "read" || op.kind === "update" || op.kind === "delete" || op.kind === "transition";
  if (hasId) out["404"] = problemResponse("Not found");
  if (op.kind === "transition") out["409"] = problemResponse("Invalid transition for the current state");
  return out;
}

/**
 * Builds an operation object. When an entity schema is available (its name is in
 * `schemaNames`), the request/response bodies reference it (or the `ReportData`
 * union for report ops); otherwise it falls back to description-only responses.
 */
function operationObject(op: ApiOperation, schemaNames: ReadonlySet<string>): OpenApiOperationObject {
  const params = pathParams(op.path).map<OpenApiParameter>((name) => ({
    name,
    in: "path",
    required: true,
    schema: { type: "string" },
  }));
  const hasEntitySchema = op.entity !== undefined && schemaNames.has(op.entity);
  const entityRef = hasEntitySchema ? ref(op.entity!) : null;

  let requestBody: OpenApiRequestBody | undefined;
  const responses: Record<string, OpenApiResponse> = {};

  switch (op.kind) {
    case "report":
      responses["200"] = schemaNames.has(REPORT_DATA_SCHEMA_NAME)
        ? { description: "Report data", content: jsonContent(ref(REPORT_DATA_SCHEMA_NAME)) }
        : { description: "Report data" };
      responses["404"] = { description: "Unknown or unreadable report" };
      break;
    case "list":
      responses["200"] = {
        description: "OK",
        content: jsonContent({
          type: "object",
          properties: {
            data: { type: "array", items: entityRef ?? { type: "object", additionalProperties: true } },
            page: {
              type: "object",
              properties: { limit: { type: "integer" }, nextCursor: { type: ["string", "null"] } },
            },
          },
        }),
      };
      break;
    case "read":
      responses["200"] = entityRef !== null ? { description: "OK", content: jsonContent(entityRef) } : { description: "OK" };
      break;
    case "create":
      if (entityRef !== null) requestBody = { required: true, content: jsonContent(entityRef) };
      responses["201"] = entityRef !== null ? { description: "Created", content: jsonContent(entityRef) } : { description: "Created" };
      break;
    case "update":
      if (entityRef !== null) requestBody = { required: true, content: jsonContent(entityRef) };
      responses["200"] = entityRef !== null ? { description: "OK", content: jsonContent(entityRef) } : { description: "OK" };
      break;
    case "delete":
      responses["204"] = { description: "Deleted" };
      break;
    case "transition":
      requestBody = { required: true, content: jsonContent(TRANSITION_REQUEST) };
      responses["200"] = entityRef !== null ? { description: "OK", content: jsonContent(entityRef) } : { description: "OK" };
      break;
    default:
      responses["200"] = { description: "OK" };
  }

  return {
    operationId: op.operationId,
    summary: summaryFor(op),
    tags: [op.kind === "report" ? "reports" : (op.entity ?? "default")],
    ...(params.length > 0 ? { parameters: params } : {}),
    ...(requestBody !== undefined ? { requestBody } : {}),
    responses: { ...responses, ...errorResponses(op) },
  };
}

/**
 * Projects an `ApiDescriptor` to a minimal OpenAPI 3.1 document. When
 * `options.entitySchemas` is supplied, they are embedded under
 * `components.schemas` (+ the `ReportData` union when a report op is present) and
 * referenced from each operation's request/response bodies.
 */
export function toOpenApiDocument(
  descriptor: ApiDescriptor,
  info: OpenApiInfo,
  options: ToOpenApiOptions = {},
): OpenApiDocument {
  const entitySchemas = options.entitySchemas ?? {};
  const hasReportOp = descriptor.operations.some((op) => op.kind === "report");
  const schemas: Record<string, OpenApiSchema> = { ...entitySchemas };
  if (hasReportOp) schemas[REPORT_DATA_SCHEMA_NAME] = REPORT_DATA_SCHEMA;
  // P3.33: the RFC 9457 error body is referenced from every operation's error
  // responses, so the schema is always present.
  if (descriptor.operations.length > 0) schemas[PROBLEM_SCHEMA_NAME] = PROBLEM_SCHEMA;
  const schemaNames = new Set(Object.keys(schemas));

  const paths: Record<string, Record<string, OpenApiOperationObject>> = {};
  for (const op of descriptor.operations) {
    const methodKey = HTTP_METHOD_KEYS[op.method];
    if (methodKey === undefined) continue;
    const bucket = paths[op.path] ?? (paths[op.path] = {});
    bucket[methodKey] = operationObject(op, schemaNames);
  }

  const hasComponents = Object.keys(schemas).length > 0;
  return {
    openapi: "3.1.0",
    info,
    paths,
    ...(hasComponents ? { components: { schemas } } : {}),
    "x-reports": descriptor.reports,
  };
}

/** The operationId the OpenAPI document route dispatches to. */
export const OPENAPI_OPERATION_ID = "api.openapi";

/** The `GET /v1/openapi.json` route serving the OpenAPI document. */
export function openApiRouteDefinition(): RouteDefinition {
  return {
    id: routeId(OPENAPI_OPERATION_ID),
    operationId: OPENAPI_OPERATION_ID,
    method: "GET",
    pathSegments: [
      { kind: "literal", value: "v1" },
      { kind: "literal", value: "openapi.json" },
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
  };
}

function json(status: number, body: unknown): HandlerOutput {
  return { kind: "json", status, body };
}

/**
 * Builds the gateway `Handler` serving the (static) OpenAPI document. The
 * document is the published API *shape* — not tenant data — so it is returned to
 * any caller the gateway authenticates (auth still runs ahead of dispatch).
 */
export function buildOpenApiHandler(document: OpenApiDocument): Handler {
  return () => json(200, document);
}

/** The RBAC context a per-caller OpenAPI handler needs to filter operations. */
export interface OpenApiRbacContext {
  readonly permissions: PermissionMap;
  readonly roles: ReadonlyMap<RoleName, RoleDefinition>;
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
}

/** The RBAC `Operation` an entity-bound API operation requires, or null (no entity gate). */
function authOperationFor(op: ApiOperation): Operation | null {
  switch (op.kind) {
    case "list":
    case "read":
    case "create":
    case "update":
    case "delete":
      return op.kind;
    case "transition":
      return op.transition !== undefined ? { kind: "transition", name: op.transition } : null;
    default:
      return null;
  }
}

function authPrincipalFrom(
  resolved: ResolvedPrincipal | null,
  principalRoles: OpenApiRbacContext["principalRoles"],
): Principal {
  const { primaryRole, secondaryRoles } = principalRoles(resolved);
  return {
    kind: "user",
    tenantId: (resolved?.tenantId ?? "") as Principal["tenantId"],
    userId: (resolved?.principalId ?? null) as Principal["userId"],
    primaryRole,
    secondaryRoles: secondaryRoles ?? [],
    abacAttributes: {},
    mfaProofAgeSeconds: resolved?.mfaProofAgeSeconds ?? null,
  };
}

/**
 * Filters a descriptor's operations to those the principal is RBAC-granted
 * (P3.28): entity-bound operations are kept only when `rbacCheck` allows the
 * caller's role for that entity + operation; operations with no entity (the
 * report route) are always kept. So a caller who can't create/update/delete an
 * entity won't see those operations in their OpenAPI document — it reflects what
 * they can actually do.
 */
export function filterDescriptorForPrincipal(
  descriptor: ApiDescriptor,
  principal: ResolvedPrincipal | null,
  rbac: OpenApiRbacContext,
): ApiDescriptor {
  const authPrincipal = authPrincipalFrom(principal, rbac.principalRoles);
  const operations = descriptor.operations.filter((op) => {
    if (op.entity === undefined) return true;
    const operation = authOperationFor(op);
    if (operation === null) return true;
    return rbacCheck({
      principal: authPrincipal,
      permissions: rbac.permissions,
      roles: rbac.roles,
      entity: op.entity,
      operation,
    }).allowed;
  });
  return { ...descriptor, operations };
}

/**
 * Builds a **per-caller** OpenAPI handler: each request's document lists only the
 * operations the caller is RBAC-granted (via `filterDescriptorForPrincipal`),
 * projected fresh per request. The full (unfiltered) `openApiDocument` stays on
 * the compiled server for programmatic use.
 */
export function buildPerCallerOpenApiHandler(
  descriptor: ApiDescriptor,
  info: OpenApiInfo,
  rbac: OpenApiRbacContext,
  options: ToOpenApiOptions = {},
): Handler {
  return ({ principal }) =>
    json(200, toOpenApiDocument(filterDescriptorForPrincipal(descriptor, principal, rbac), info, options));
}
