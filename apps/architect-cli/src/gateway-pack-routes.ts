import { createHash } from "node:crypto";

import type { HttpMethod, RouteDefinition } from "@crossengin/api-gateway";
import type { Manifest } from "@crossengin/kernel/manifest";

export const DEFAULT_PACK_ROUTE_API_VERSION = "v1";

export interface GeneratePackRoutesInput {
  readonly manifest: Manifest;
  readonly packSlug: string;
  readonly apiVersion?: string;
}

export interface PackRouteRecord {
  readonly route: RouteDefinition;
  readonly entity: string;
  readonly operationKind: PackOperationKind;
  readonly transitionName?: string;
}

export const CRUD_OPERATION_KINDS = [
  "list",
  "read",
  "create",
  "update",
  "delete",
] as const;
export type CrudOperationKind = (typeof CRUD_OPERATION_KINDS)[number];
export type PackOperationKind = CrudOperationKind | "transition";

export function generatePackRoutes(
  input: GeneratePackRoutesInput,
): readonly PackRouteRecord[] {
  const apiVersion = input.apiVersion ?? DEFAULT_PACK_ROUTE_API_VERSION;
  const out: PackRouteRecord[] = [];
  const entities = input.manifest.entities ?? [];
  const workflows = input.manifest.workflows ?? {};
  for (const entity of entities) {
    for (const kind of CRUD_OPERATION_KINDS) {
      out.push({
        route: buildCrudRoute({
          packSlug: input.packSlug,
          entityName: entity.name,
          kind,
          apiVersion,
        }),
        entity: entity.name,
        operationKind: kind,
      });
    }
  }
  for (const wf of Object.values(workflows)) {
    if (wf.kind !== "entityLifecycle") continue;
    for (const transition of wf.transitions) {
      out.push({
        route: buildTransitionRoute({
          packSlug: input.packSlug,
          entityName: wf.entity,
          transitionName: transition.name,
          apiVersion,
        }),
        entity: wf.entity,
        operationKind: "transition",
        transitionName: transition.name,
      });
    }
  }
  return out;
}

interface BuildCrudRouteInput {
  readonly packSlug: string;
  readonly entityName: string;
  readonly kind: CrudOperationKind;
  readonly apiVersion: string;
}

function buildCrudRoute(input: BuildCrudRouteInput): RouteDefinition {
  const method = methodForCrud(input.kind);
  const pathSegments = [
    { kind: "literal" as const, value: input.apiVersion },
    { kind: "literal" as const, value: pluralizePathSegment(input.entityName) },
  ];
  if (input.kind === "read" || input.kind === "update" || input.kind === "delete") {
    pathSegments.push({
      kind: "parameter" as const,
      name: "id",
      pattern: null,
    } as unknown as { kind: "literal"; value: string });
  }
  const operationId = `${entityKey(input.entityName)}.${input.kind}`;
  return {
    id: routeIdFor({ packSlug: input.packSlug, operationId }),
    operationId,
    method,
    pathSegments: pathSegments as unknown as RouteDefinition["pathSegments"],
    apiVersion: input.apiVersion,
    isDeprecated: false,
    deprecatedSince: null,
    sunsetAt: null,
    successorOperationId: null,
    requiredScopes: [`${entityKey(input.entityName)}:${input.kind}`],
    rateLimitPolicyId: null,
    idempotencyRequired: idempotencyRequiredForMethod(method),
    requestSchemaSha256: null,
    responseSchemaSha256: null,
  };
}

interface BuildTransitionRouteInput {
  readonly packSlug: string;
  readonly entityName: string;
  readonly transitionName: string;
  readonly apiVersion: string;
}

function buildTransitionRoute(input: BuildTransitionRouteInput): RouteDefinition {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(input.transitionName)) {
    throw new Error(
      `gateway routes register-pack: transition name '${input.transitionName}' contains characters that can't be embedded in a URL path segment`,
    );
  }
  const operationId = `${entityKey(input.entityName)}.transition.${input.transitionName}`;
  return {
    id: routeIdFor({ packSlug: input.packSlug, operationId }),
    operationId,
    method: "POST",
    pathSegments: [
      { kind: "literal", value: input.apiVersion },
      { kind: "literal", value: pluralizePathSegment(input.entityName) },
      { kind: "parameter", name: "id", pattern: null },
      { kind: "literal", value: "transitions" },
      { kind: "literal", value: input.transitionName },
    ],
    apiVersion: input.apiVersion,
    isDeprecated: false,
    deprecatedSince: null,
    sunsetAt: null,
    successorOperationId: null,
    requiredScopes: [`${entityKey(input.entityName)}:transition.${input.transitionName}`],
    rateLimitPolicyId: null,
    idempotencyRequired: true,
    requestSchemaSha256: null,
    responseSchemaSha256: null,
  };
}

function methodForCrud(kind: CrudOperationKind): HttpMethod {
  if (kind === "list" || kind === "read") return "GET";
  if (kind === "create") return "POST";
  if (kind === "update") return "PATCH";
  return "DELETE";
}

function idempotencyRequiredForMethod(method: HttpMethod): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

export function entityKey(entityName: string): string {
  return entityName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase()
    .replace(/^_+|_+$/g, "");
}

export function pluralizePathSegment(entityName: string): string {
  const kebab = entityName
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");
  if (kebab.endsWith("s")) return kebab;
  if (/[^aeiou]y$/.test(kebab)) return kebab.slice(0, -1) + "ies";
  return kebab + "s";
}

export interface RouteIdInput {
  readonly packSlug: string;
  readonly operationId: string;
}

export function routeIdFor(input: RouteIdInput): string {
  const digest = createHash("sha256")
    .update(`${input.packSlug}:${input.operationId}`, "utf8")
    .digest("hex");
  return `rt_${digest.slice(0, 16)}`;
}
