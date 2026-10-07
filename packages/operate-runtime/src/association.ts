import {
  ABAC_RECORD_AVAILABILITY,
  isAbacDeferred,
  rbacCheck,
  rbacCheckForRecords,
  type AbacBatchEvaluator,
  type AbacEvaluator,
  type AuthorizationDecision,
  type PermissionMap,
  type Principal,
  type RbacCheckInput,
  type RoleDefinition,
  type RoleName,
} from "@crossengin/auth";
import type { PathSegment, ResolvedPrincipal, RouteDefinition } from "@crossengin/api-gateway";
import { principalAbacAttributes } from "@crossengin/api-gateway";
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
 * Parses an association list's `?cursor` — a zero-based offset into the owner's
 * link list, produced by the previous page's `nextCursor`. Non-numeric or
 * negative values reset to 0, so a stale/forged cursor is safe (it just starts
 * over rather than erroring).
 */
function parseAssocCursor(query: Readonly<Record<string, string | readonly string[]>> | undefined): number {
  const raw = query?.["cursor"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return 0;
  return n;
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
  /**
   * Discharges the `abac` policy key a manifest grant may carry. Absent is the fail-closed reading
   * rather than "no obligation": `rbacCheck` resolves one it cannot discharge `undischargeable`
   * and refuses. The same seam `HandlerContext` carries, so an association route and the entity
   * route behind it answer one grant the same way.
   */
  readonly abacEvaluator?: AbacEvaluator;
  /**
   * The batch arm beside `abacEvaluator`, read only by the list family's row filter. The same seam
   * `HandlerContext` carries, and registered from the same object, so an association list and the
   * entity list behind it pool one grant's obligations the same way.
   */
  readonly abacBatchEvaluator?: AbacBatchEvaluator;
}

function json(status: number, body: unknown): HandlerOutput {
  return { kind: "json", status, body };
}

/**
 * The one 403 all three association families return. Shared rather than copied because the
 * obligation has to appear on every one of them — three routes that answer the same grant and
 * report it three ways would be a list to keep in step, which is this repo's recurring defect.
 * `denied` and `undischargeable` are different actions for an operator, so the outcome is named.
 *
 * `structuralReason` is appended by a family at which a `deferred` obligation can never be
 * discharged, following `handlers.ts`' `entityForbidden`: `deferred` on its own reads like a retry,
 * and a family with nothing to retry with has to say why.
 */
function forbidden(decision: AuthorizationDecision, structuralReason?: string): HandlerOutput {
  return json(403, {
    error: "forbidden",
    detail:
      structuralReason === undefined
        ? decision.reason
        : `${decision.reason ?? "refused"}: ${structuralReason}`,
    ...(decision.abac !== undefined
      ? { abacPolicyKey: decision.abac.policyKey, abacOutcome: decision.abac.outcome }
      : {}),
  });
}

function authPrincipal(resolved: ResolvedPrincipal | null, principalRoles: AssociationHandlerContext["principalRoles"]): Principal {
  const { primaryRole, secondaryRoles } = principalRoles(resolved);
  return {
    kind: "user",
    tenantId: (resolved?.tenantId ?? "") as Principal["tenantId"],
    userId: (resolved?.principalId ?? null) as Principal["userId"],
    primaryRole,
    secondaryRoles: secondaryRoles ?? [],
    // Resolved in the auth stage — see `handlers.ts`' `authPrincipal` for why `null` and `{}` are
    // different answers here.
    abacAttributes: principalAbacAttributes(resolved),
    mfaProofAgeSeconds: resolved?.mfaProofAgeSeconds ?? null,
  };
}

/**
 * The related records this principal's record-level policy admits, in order, reporting **nothing**
 * about the ones it dropped — see `handlers.ts`' `admittedRecords` for why a withheld count is an
 * inference channel and not a courtesy.
 */
function admitted(
  check: Omit<RbacCheckInput, "record">,
  records: readonly EntityRecord[],
): readonly EntityRecord[] {
  const decisions = rbacCheckForRecords(check, records);
  return records.filter((_, index) => decisions[index]?.allowed ?? false);
}

/**
 * `GET /v1/<owner>/{id}/<related>` — RBAC-checks `list` on the *related* entity, resolves the owner's
 * association links (`listLinks` narrowed to the owner side), fetches each linked related record, and
 * returns `{data}` (every field; the gateway redacts per-caller at the edge, exactly like the list
 * endpoint). A store without association support returns `501 associations_unsupported` rather than an
 * empty list, so the caller can tell "no support" from "no links".
 *
 * A record-bearing obligation on that `list` grant **filters the page**, exactly as the entity list
 * arm does: the related records are loaded here anyway, so each one can be asked about and the
 * refused ones dropped. Its cursor needs no addressing guard and cannot be unsettled by the
 * filtering — see the two comments inside.
 */
export function buildAssociationListHandler(spec: AssociationRouteSpec, ctx: AssociationHandlerContext): Handler {
  return async ({ request, principal, params }) => {
    const tenantId = principal?.tenantId ?? null;
    if (tenantId === null) return json(401, { error: "tenant_required" });

    // The record-free ask, one question for the whole page. A record-bearing policy answers
    // `deferred`, which `ABAC_OUTCOME_ALLOWS` refuses — so the flag below records an outstanding
    // obligation and grants nothing, and the records are filtered by it once they are loaded. The
    // availability is read from `ABAC_RECORD_AVAILABILITY` rather than assumed, because that map is
    // the contract a boot check refuses a manifest against: a route deciding for itself that it can
    // re-ask would make the refusal and the request path disagree about one position.
    const check: Omit<RbacCheckInput, "record"> = {
      principal: authPrincipal(principal, ctx.principalRoles),
      permissions: ctx.permissions,
      roles: ctx.roles,
      entity: spec.relatedEntity,
      operation: "list",
      ...(ctx.abacEvaluator !== undefined ? { abacEvaluator: ctx.abacEvaluator } : {}),
      ...(ctx.abacBatchEvaluator !== undefined ? { abacBatchEvaluator: ctx.abacBatchEvaluator } : {}),
    };
    const decision = rbacCheck(check);
    const obligationOutstanding =
      !decision.allowed &&
      isAbacDeferred(decision.abac) &&
      ABAC_RECORD_AVAILABILITY.entity_list === "always";
    if (!decision.allowed && !obligationOutstanding) return forbidden(decision);

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
    // Page the linked records: `?limit` caps the fetch, `?cursor` is a zero-based offset into
    // the owner's links. The exact total comes from the sibling `…/count` route. Prevents an
    // unbounded fan-out of `get`s and lets the panel "load more" without refetching the page.
    const query = request.query as Readonly<Record<string, string | readonly string[]>> | undefined;
    const limit = parseAssocLimit(query);
    const offset = parseAssocCursor(query);
    const allIds = links.map((l) => (spec.ownerIsLeft ? l.rightId : l.leftId));
    const pageIds = allIds.slice(offset, offset + limit);
    const records = await Promise.all(pageIds.map((id) => ctx.store.get(tenantId, spec.relatedEntity, id)));
    const loaded = records.filter((r): r is EntityRecord => r !== null);
    // One `rbacCheckForRecords` over the loaded related records, never a loop of `rbacCheck`: the
    // entity, grant and role arms do not depend on the record, so they are resolved once for the
    // page and the obligations pool into a single batch. `?? false` and not `!`, so a decisions
    // array shorter than the page drops its tail rather than admitting it.
    //
    // **No addressing guard here, and none is possible to need.** `handlers.ts` refuses a `?sort`,
    // `?filter` or `?q` on a withheld field because the entity list's keyset cursor carries the
    // sort *values* of the store's last row, which under filtering may be a row the caller never
    // sees. This route has no such surface: there is no `?sort`, `?filter` or `?q` on it at all,
    // and its cursor is a plain offset into the owner's links.
    const data = obligationOutstanding ? admitted(check, loaded) : loaded;
    // Computed from `allIds`, so the filtering cannot disturb it: the offset addresses the owner's
    // *links* and not the rows that survived, which is the same property the entity list arm holds
    // by leaving the store's `nextCursor` alone. A page may come back short, or empty, with a
    // non-null cursor — termination is `nextCursor === null` and nothing else, and re-filling the
    // page would make the work per request depend on the policy's selectivity.
    const nextCursor = offset + limit < allIds.length ? String(offset + limit) : null;
    return json(200, { data, page: { limit, nextCursor } });
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

/** Why a record-bearing obligation is refused outright here while its sibling list route filters. */
const COUNT_HAS_NO_ROWS_TO_FILTER =
  "a count answers for the whole set with one number, so there are no rows to drop and no record to answer against, and fetching every linked record to count the admitted ones would be unbounded";

/**
 * `GET /v1/<owner>/{id}/<related>/count` — RBAC-checks `list` on the *related* entity, then returns
 * `{count}`: the number of the owner's association links (`countLinks` narrowed to the owner side). A
 * store without count support returns `501 associations_unsupported` rather than a fabricated zero.
 */
export function buildAssociationCountHandler(spec: AssociationCountRouteSpec, ctx: AssociationHandlerContext): Handler {
  return async ({ principal, params }) => {
    const tenantId = principal?.tenantId ?? null;
    if (tenantId === null) return json(401, { error: "tenant_required" });

    // No `record`, and this family is where that is still structural. Its sibling list route now
    // filters — a record-bearing policy on this very grant drops rows there — but a count answers
    // for the whole set with one number, so there is nothing to filter and no row to be answered
    // against. A record-bearing policy therefore answers `deferred`, which `ABAC_OUTCOME_ALLOWS`
    // refuses, and the refusal lands on the `!decision.allowed` arm with no special case.
    //
    // The reason is **carried in the 403** rather than inherited from
    // `ABAC_RECORD_AVAILABILITY_REASONS`: that map now says the list position has every row in
    // hand, which is true of the route this one counts for and not of this one.
    const decision = rbacCheck({
      principal: authPrincipal(principal, ctx.principalRoles),
      permissions: ctx.permissions,
      roles: ctx.roles,
      entity: spec.relatedEntity,
      operation: "list",
      ...(ctx.abacEvaluator !== undefined ? { abacEvaluator: ctx.abacEvaluator } : {}),
    });
    if (!decision.allowed) {
      return forbidden(
        decision,
        isAbacDeferred(decision.abac) ? COUNT_HAS_NO_ROWS_TO_FILTER : undefined,
      );
    }

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

    // No `record`, so a record-bearing policy on the owner's `update` grant answers `deferred` and
    // refuses below — and unlike the count family, this one is an **unclosed position rather than
    // a structural impossibility**. The grant is `update` on the owner entity, the owner's id is in
    // the path, and the store could load that record and the decision be re-asked with it, exactly
    // as the entity `update` handler does. It is not loaded today: link and unlink
    // are store calls on the join table and never read the owner at all, so supplying the record
    // means adding a fetch to a route that has none. Until then a record-bearing policy makes the
    // owner's associations unwritable, which is the fail-closed direction and is what this refusal
    // says.
    const decision = rbacCheck({
      principal: authPrincipal(principal, ctx.principalRoles),
      permissions: ctx.permissions,
      roles: ctx.roles,
      entity: spec.ownerEntity,
      operation: "update",
      ...(ctx.abacEvaluator !== undefined ? { abacEvaluator: ctx.abacEvaluator } : {}),
    });
    if (!decision.allowed) return forbidden(decision);

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
