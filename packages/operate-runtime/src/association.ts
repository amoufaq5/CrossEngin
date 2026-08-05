import { rbacCheck, type PermissionMap, type Principal, type RoleDefinition, type RoleName } from "@crossengin/auth";
import type { PathSegment, ResolvedPrincipal, RouteDefinition } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";
import type { Manifest } from "@crossengin/kernel/manifest";

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./list-query.js";
import { entityCamel, resourceSlug, routeId } from "./slugs.js";
import type { EntityRecord, EntityStore } from "./store.js";

/**
 * Parses an association list's `?limit` — the cap on how many linked records to
 * fetch. Clamped to `MAX_PAGE_SIZE`, defaulting to `DEFAULT_PAGE_SIZE`. A caller
 * that wants the exact total uses the sibling `…/count` route (unbounded).
 */
function parseAssocLimit(query: Readonly<Record<string, string | readonly string[]>> | undefined): number {
  const raw = query?.["limit"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(n, MAX_PAGE_SIZE);
}

/**
 * The read side of the `many_to_many` association API — lists the join-table link pairs for a
 * relation, optionally narrowed to one side. A store gains association support by implementing this
 * (the column-mapped store does); other stores don't, and the route reports it unsupported rather than
 * lying. Kept structural so `operate-runtime` needs no `-pg` dependency.
 */
export interface AssociationReader {
  listLinks(
    tenantId: string,
    leftEntity: string,
    rightEntity: string,
    opts: { readonly leftId?: string; readonly rightId?: string },
  ): Promise<ReadonlyArray<{ readonly leftId: string; readonly rightId: string }>>;
}

/** Structural check: does the entity store also read associations? */
export function isAssociationReader(store: unknown): store is AssociationReader {
  return typeof (store as { listLinks?: unknown } | null)?.listLinks === "function";
}

/**
 * The count side of the `many_to_many` association API — counts the join-table link pairs for a
 * relation, optionally narrowed to one side. A store gains count support by implementing this (the
 * column-mapped store does); the route reports it unsupported rather than lying. Kept structural so
 * `operate-runtime` needs no `-pg` dependency.
 */
export interface AssociationCounter {
  countLinks(
    tenantId: string,
    leftEntity: string,
    rightEntity: string,
    opts: { readonly leftId?: string; readonly rightId?: string },
  ): Promise<number>;
}

/** Structural check: does the entity store also count associations? */
export function isAssociationCounter(store: unknown): store is AssociationCounter {
  return typeof (store as { countLinks?: unknown } | null)?.countLinks === "function";
}

/**
 * A derived association-list route: `GET /v1/<owner>/{id}/<related>` — the `related` records linked to
 * the `owner` record via a `many_to_many` relation. `ownerIsLeft` records which side of the relation
 * the path id belongs to, so the handler narrows `listLinks` correctly.
 */
export interface AssociationRouteSpec {
  readonly operationId: string;
  readonly method: "GET";
  readonly pathSegments: readonly PathSegment[];
  readonly ownerEntity: string;
  readonly relatedEntity: string;
  readonly left: string;
  readonly right: string;
  readonly ownerIsLeft: boolean;
}

const ID_PARAM: PathSegment = { kind: "parameter", name: "id", pattern: null };
function lit(value: string): PathSegment {
  return { kind: "literal", value };
}

interface RelationLike {
  readonly kind: string;
  readonly left?: string;
  readonly right?: string;
}

function assocSpec(owner: string, related: string, left: string, right: string, ownerIsLeft: boolean): AssociationRouteSpec {
  return {
    operationId: `${entityCamel(owner)}.${entityCamel(related)}.list`,
    method: "GET",
    pathSegments: [lit("v1"), lit(resourceSlug(owner)), ID_PARAM, lit(resourceSlug(related))],
    ownerEntity: owner,
    relatedEntity: related,
    left,
    right,
    ownerIsLeft,
  };
}

/**
 * The association-list routes derived from a manifest's `many_to_many` relations: two per relation
 * (each side lists the other), or one for a self-relation (both sides are the same entity, so a single
 * `/v1/<entity>/{id}/<entity>` route). Duplicate owner→related pairs (two relations between the same
 * entities) are de-duped by operationId.
 */
export function manifestAssociationRoutes(manifest: Manifest): readonly AssociationRouteSpec[] {
  const relations = (manifest.relations ?? []) as ReadonlyArray<RelationLike>;
  const out: AssociationRouteSpec[] = [];
  const seen = new Set<string>();
  const add = (spec: AssociationRouteSpec): void => {
    if (seen.has(spec.operationId)) return;
    seen.add(spec.operationId);
    out.push(spec);
  };
  for (const rel of relations) {
    if (rel.kind !== "many_to_many" || rel.left === undefined || rel.right === undefined) continue;
    add(assocSpec(rel.left, rel.right, rel.left, rel.right, true));
    if (rel.left !== rel.right) add(assocSpec(rel.right, rel.left, rel.left, rel.right, false));
  }
  return out;
}

export function associationRouteFromSpec(spec: AssociationRouteSpec): RouteDefinition {
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

/** The handler context an association list route needs: the store + RBAC inputs. */
export interface AssociationHandlerContext {
  readonly store: EntityStore;
  readonly permissions: PermissionMap;
  readonly roles: ReadonlyMap<RoleName, RoleDefinition>;
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
}

function json(status: number, body: unknown): HandlerOutput {
  return { kind: "json", status, body };
}

function authPrincipal(resolved: ResolvedPrincipal | null, principalRoles: AssociationHandlerContext["principalRoles"]): Principal {
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
 * `GET /v1/<owner>/{id}/<related>` — RBAC-checks `list` on the *related* entity, resolves the owner's
 * association links (`listLinks` narrowed to the owner side), fetches each linked related record, and
 * returns `{data}` (full records; the gateway redacts per-caller at the edge, exactly like the list
 * endpoint). A store without association support returns `501 associations_unsupported` rather than an
 * empty list, so the caller can tell "no support" from "no links".
 */
export function buildAssociationListHandler(spec: AssociationRouteSpec, ctx: AssociationHandlerContext): Handler {
  return async ({ request, principal, params }) => {
    const tenantId = principal?.tenantId ?? null;
    if (tenantId === null) return json(401, { error: "tenant_required" });

    const decision = rbacCheck({
      principal: authPrincipal(principal, ctx.principalRoles),
      permissions: ctx.permissions,
      roles: ctx.roles,
      entity: spec.relatedEntity,
      operation: "list",
    });
    if (!decision.allowed) return json(403, { error: "forbidden", detail: decision.reason });

    if (!isAssociationReader(ctx.store)) {
      return json(501, { error: "associations_unsupported", detail: "the entity store does not support associations" });
    }

    const ownerId = params["id"] ?? "";
    const links = await ctx.store.listLinks(
      tenantId,
      spec.left,
      spec.right,
      spec.ownerIsLeft ? { leftId: ownerId } : { rightId: ownerId },
    );
    // Cap how many linked records we fetch — the panel previews the first page; the exact
    // total comes from the sibling `…/count` route. Prevents an unbounded fan-out of `get`s.
    const limit = parseAssocLimit(request.query as Readonly<Record<string, string | readonly string[]>> | undefined);
    const relatedIds = links.map((l) => (spec.ownerIsLeft ? l.rightId : l.leftId)).slice(0, limit);
    const records = await Promise.all(relatedIds.map((id) => ctx.store.get(tenantId, spec.relatedEntity, id)));
    const data = records.filter((r): r is EntityRecord => r !== null);
    return json(200, { data });
  };
}

/**
 * A derived association-count route: `GET /v1/<owner>/{id}/<related>/count` — the number of `related`
 * records linked to the `owner` record via a `many_to_many` relation. `ownerIsLeft` records which side
 * of the relation the path id belongs to, so the handler narrows `countLinks` correctly.
 */
export interface AssociationCountRouteSpec {
  readonly operationId: string;
  readonly method: "GET";
  readonly pathSegments: readonly PathSegment[];
  readonly ownerEntity: string;
  readonly relatedEntity: string;
  readonly left: string;
  readonly right: string;
  readonly ownerIsLeft: boolean;
}

function countSpec(owner: string, related: string, left: string, right: string, ownerIsLeft: boolean): AssociationCountRouteSpec {
  return {
    operationId: `${entityCamel(owner)}.${entityCamel(related)}.count`,
    method: "GET",
    pathSegments: [lit("v1"), lit(resourceSlug(owner)), ID_PARAM, lit(resourceSlug(related)), lit("count")],
    ownerEntity: owner,
    relatedEntity: related,
    left,
    right,
    ownerIsLeft,
  };
}

/**
 * The association-count routes derived from a manifest's `many_to_many` relations: two per relation
 * (each side counts the other), or one for a self-relation. Duplicate owner→related pairs are de-duped
 * by operationId, mirroring `manifestAssociationRoutes`.
 */
export function manifestAssociationCountRoutes(manifest: Manifest): readonly AssociationCountRouteSpec[] {
  const relations = (manifest.relations ?? []) as ReadonlyArray<RelationLike>;
  const out: AssociationCountRouteSpec[] = [];
  const seen = new Set<string>();
  const add = (spec: AssociationCountRouteSpec): void => {
    if (seen.has(spec.operationId)) return;
    seen.add(spec.operationId);
    out.push(spec);
  };
  for (const rel of relations) {
    if (rel.kind !== "many_to_many" || rel.left === undefined || rel.right === undefined) continue;
    add(countSpec(rel.left, rel.right, rel.left, rel.right, true));
    if (rel.left !== rel.right) add(countSpec(rel.right, rel.left, rel.left, rel.right, false));
  }
  return out;
}

export function associationCountRouteFromSpec(spec: AssociationCountRouteSpec): RouteDefinition {
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

/**
 * `GET /v1/<owner>/{id}/<related>/count` — RBAC-checks `list` on the *related* entity, then returns
 * `{count}`: the number of the owner's association links (`countLinks` narrowed to the owner side). A
 * store without count support returns `501 associations_unsupported` rather than a fabricated zero.
 */
export function buildAssociationCountHandler(spec: AssociationCountRouteSpec, ctx: AssociationHandlerContext): Handler {
  return async ({ principal, params }) => {
    const tenantId = principal?.tenantId ?? null;
    if (tenantId === null) return json(401, { error: "tenant_required" });

    const decision = rbacCheck({
      principal: authPrincipal(principal, ctx.principalRoles),
      permissions: ctx.permissions,
      roles: ctx.roles,
      entity: spec.relatedEntity,
      operation: "list",
    });
    if (!decision.allowed) return json(403, { error: "forbidden", detail: decision.reason });

    if (!isAssociationCounter(ctx.store)) {
      return json(501, { error: "associations_unsupported", detail: "the entity store does not support associations" });
    }

    const ownerId = params["id"] ?? "";
    const count = await ctx.store.countLinks(
      tenantId,
      spec.left,
      spec.right,
      spec.ownerIsLeft ? { leftId: ownerId } : { rightId: ownerId },
    );
    return json(200, { count });
  };
}

/** The write side of the association API — link / unlink two rows across a `many_to_many` relation. */
export interface AssociationWriter {
  link(tenantId: string, leftEntity: string, rightEntity: string, leftId: string, rightId: string): Promise<void>;
  unlink(
    tenantId: string,
    leftEntity: string,
    rightEntity: string,
    leftId: string,
    rightId: string,
  ): Promise<boolean>;
}

/** Structural check: does the entity store also write associations? */
export function isAssociationWriter(store: unknown): store is AssociationWriter {
  const s = store as { link?: unknown; unlink?: unknown } | null;
  return typeof s?.link === "function" && typeof s?.unlink === "function";
}

/**
 * A derived association write route: `PUT` (link) / `DELETE` (unlink)
 * `/v1/<owner>/{id}/<related>/{relatedId}`. Authorized by `update` on the *owner* (modifying a
 * record's associations is part of updating it).
 */
export interface AssociationWriteRouteSpec {
  readonly operationId: string;
  readonly action: "link" | "unlink";
  readonly method: "PUT" | "DELETE";
  readonly pathSegments: readonly PathSegment[];
  readonly ownerEntity: string;
  readonly relatedEntity: string;
  readonly left: string;
  readonly right: string;
  readonly ownerIsLeft: boolean;
}

const RELATED_ID_PARAM: PathSegment = { kind: "parameter", name: "relatedId", pattern: null };

function writeSpec(
  owner: string,
  related: string,
  left: string,
  right: string,
  ownerIsLeft: boolean,
  action: "link" | "unlink",
): AssociationWriteRouteSpec {
  return {
    operationId: `${entityCamel(owner)}.${entityCamel(related)}.${action}`,
    action,
    method: action === "link" ? "PUT" : "DELETE",
    pathSegments: [lit("v1"), lit(resourceSlug(owner)), ID_PARAM, lit(resourceSlug(related)), RELATED_ID_PARAM],
    ownerEntity: owner,
    relatedEntity: related,
    left,
    right,
    ownerIsLeft,
  };
}

/** The link + unlink routes derived from a manifest's `many_to_many` relations (both directions). */
export function manifestAssociationWriteRoutes(manifest: Manifest): readonly AssociationWriteRouteSpec[] {
  const relations = (manifest.relations ?? []) as ReadonlyArray<RelationLike>;
  const out: AssociationWriteRouteSpec[] = [];
  const seen = new Set<string>();
  const add = (spec: AssociationWriteRouteSpec): void => {
    if (seen.has(spec.operationId)) return;
    seen.add(spec.operationId);
    out.push(spec);
  };
  for (const rel of relations) {
    if (rel.kind !== "many_to_many" || rel.left === undefined || rel.right === undefined) continue;
    for (const action of ["link", "unlink"] as const) {
      add(writeSpec(rel.left, rel.right, rel.left, rel.right, true, action));
      if (rel.left !== rel.right) add(writeSpec(rel.right, rel.left, rel.left, rel.right, false, action));
    }
  }
  return out;
}

export function associationWriteRouteFromSpec(spec: AssociationWriteRouteSpec): RouteDefinition {
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

/**
 * `PUT` / `DELETE /v1/<owner>/{id}/<related>/{relatedId}` — links or unlinks the two rows across the
 * relation. RBAC-checks `update` on the *owner* entity (associations are part of the owner's state).
 * Idempotent: `link` is a no-op if already linked, `unlink` returns `204` whether or not a link
 * existed. Maps the `{id}` (owner) + `{relatedId}` to the relation's (left, right) via `ownerIsLeft`.
 * `501 associations_unsupported` when the store can't write associations.
 */
export function buildAssociationWriteHandler(spec: AssociationWriteRouteSpec, ctx: AssociationHandlerContext): Handler {
  return async ({ principal, params }) => {
    const tenantId = principal?.tenantId ?? null;
    if (tenantId === null) return json(401, { error: "tenant_required" });

    const decision = rbacCheck({
      principal: authPrincipal(principal, ctx.principalRoles),
      permissions: ctx.permissions,
      roles: ctx.roles,
      entity: spec.ownerEntity,
      operation: "update",
    });
    if (!decision.allowed) return json(403, { error: "forbidden", detail: decision.reason });

    if (!isAssociationWriter(ctx.store)) {
      return json(501, { error: "associations_unsupported", detail: "the entity store does not support associations" });
    }

    const ownerId = params["id"] ?? "";
    const relatedId = params["relatedId"] ?? "";
    const leftId = spec.ownerIsLeft ? ownerId : relatedId;
    const rightId = spec.ownerIsLeft ? relatedId : ownerId;
    if (spec.action === "link") {
      await ctx.store.link(tenantId, spec.left, spec.right, leftId, rightId);
    } else {
      await ctx.store.unlink(tenantId, spec.left, spec.right, leftId, rightId);
    }
    return { kind: "empty", status: 204 };
  };
}
