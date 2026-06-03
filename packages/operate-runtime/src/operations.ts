import type { Operation } from "@crossengin/auth";
import type { Manifest } from "@crossengin/kernel/manifest";
import type { PathSegment, RouteDefinition } from "@crossengin/api-gateway";
import type { Entity } from "@crossengin/types/meta-schema";

import { operationId, resourceSlug, routeId } from "./slugs.js";

export type RouteAction = "list" | "read" | "create" | "update" | "delete" | "transition";

export interface TransitionSpec {
  readonly name: string;
  readonly stateField: string;
  readonly toState: string;
  readonly fromStates: readonly string[];
}

export interface RouteSpec {
  readonly entity: string;
  readonly action: RouteAction;
  readonly operationId: string;
  readonly method: RouteDefinition["method"];
  readonly pathSegments: readonly PathSegment[];
  readonly authOperation: Operation;
  readonly transition?: TransitionSpec;
}

function lit(value: string): PathSegment {
  return { kind: "literal", value };
}

const ID_PARAM: PathSegment = { kind: "parameter", name: "id", pattern: null };

function transitionsForEntity(
  manifest: Manifest,
  entityName: string,
): readonly TransitionSpec[] {
  const out: TransitionSpec[] = [];
  for (const workflow of Object.values(manifest.workflows ?? {})) {
    if (workflow.kind !== "entityLifecycle" || workflow.entity !== entityName) continue;
    for (const t of workflow.transitions) {
      out.push({
        name: t.name,
        stateField: workflow.stateField,
        toState: t.to,
        fromStates: Array.isArray(t.from) ? [...t.from] : [t.from],
      });
    }
  }
  return out;
}

export function entityRouteSpecs(
  entity: Entity,
  transitions: readonly TransitionSpec[],
): readonly RouteSpec[] {
  const slug = resourceSlug(entity.name);
  const collection = [lit("v1"), lit(slug)];
  const item = [...collection, ID_PARAM];
  const specs: RouteSpec[] = [
    { entity: entity.name, action: "list", operationId: operationId(entity.name, "list"), method: "GET", pathSegments: collection, authOperation: "list" },
    { entity: entity.name, action: "create", operationId: operationId(entity.name, "create"), method: "POST", pathSegments: collection, authOperation: "create" },
    { entity: entity.name, action: "read", operationId: operationId(entity.name, "read"), method: "GET", pathSegments: item, authOperation: "read" },
    { entity: entity.name, action: "update", operationId: operationId(entity.name, "update"), method: "PATCH", pathSegments: item, authOperation: "update" },
    { entity: entity.name, action: "delete", operationId: operationId(entity.name, "delete"), method: "DELETE", pathSegments: item, authOperation: "delete" },
  ];
  for (const t of transitions) {
    specs.push({
      entity: entity.name,
      action: "transition",
      operationId: operationId(entity.name, t.name),
      method: "POST",
      pathSegments: [...item, lit(t.name)],
      authOperation: { kind: "transition", name: t.name },
      transition: t,
    });
  }
  return specs;
}

export function manifestRouteSpecs(manifest: Manifest): readonly RouteSpec[] {
  const specs: RouteSpec[] = [];
  for (const entity of manifest.entities ?? []) {
    specs.push(...entityRouteSpecs(entity, transitionsForEntity(manifest, entity.name)));
  }
  return specs;
}

export function routeFromSpec(spec: RouteSpec): RouteDefinition {
  return {
    id: routeId(spec.operationId),
    operationId: spec.operationId,
    method: spec.method,
    pathSegments: [...spec.pathSegments],
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
