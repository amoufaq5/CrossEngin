import type { RouteDefinition } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput } from "@crossengin/api-gateway-runtime";

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
