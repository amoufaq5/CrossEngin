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
import { routeId } from "./slugs.js";

/**
 * A minimal but valid OpenAPI 3.1 document projected from the `ApiDescriptor`.
 * It carries the path/operation surface (operationIds, methods, path parameters,
 * tags) — enough for SDK generators + API explorers to discover every endpoint —
 * without per-operation request/response component schemas (those are a deferred
 * enrichment). The report catalog rides under the `x-reports` extension.
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

export interface OpenApiOperationObject {
  readonly operationId: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly parameters?: readonly OpenApiParameter[];
  readonly responses: Readonly<Record<string, { readonly description: string }>>;
}

export interface OpenApiDocument {
  readonly openapi: "3.1.0";
  readonly info: OpenApiInfo;
  readonly paths: Readonly<Record<string, Readonly<Record<string, OpenApiOperationObject>>>>;
  readonly "x-reports": ApiDescriptor["reports"];
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

function operationObject(op: ApiOperation): OpenApiOperationObject {
  const params = pathParams(op.path).map<OpenApiParameter>((name) => ({
    name,
    in: "path",
    required: true,
    schema: { type: "string" },
  }));
  const responses: Record<string, { description: string }> =
    op.kind === "report"
      ? { "200": { description: "Report data" }, "404": { description: "Unknown or unreadable report" } }
      : { "200": { description: "OK" } };
  return {
    operationId: op.operationId,
    summary: summaryFor(op),
    tags: [op.kind === "report" ? "reports" : (op.entity ?? "default")],
    ...(params.length > 0 ? { parameters: params } : {}),
    responses,
  };
}

/** Projects an `ApiDescriptor` to a minimal OpenAPI 3.1 document. */
export function toOpenApiDocument(descriptor: ApiDescriptor, info: OpenApiInfo): OpenApiDocument {
  const paths: Record<string, Record<string, OpenApiOperationObject>> = {};
  for (const op of descriptor.operations) {
    const methodKey = HTTP_METHOD_KEYS[op.method];
    if (methodKey === undefined) continue;
    const bucket = paths[op.path] ?? (paths[op.path] = {});
    bucket[methodKey] = operationObject(op);
  }
  return { openapi: "3.1.0", info, paths, "x-reports": descriptor.reports };
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
): Handler {
  return ({ principal }) =>
    json(200, toOpenApiDocument(filterDescriptorForPrincipal(descriptor, principal, rbac), info));
}
