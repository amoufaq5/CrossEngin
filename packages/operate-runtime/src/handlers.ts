import {
  rbacCheck,
  type PermissionMap,
  type Principal,
  type RoleDefinition,
  type RoleName,
} from "@crossengin/auth";
import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, parseFields, parseListQuery, type ListConfig } from "./list-query.js";
import { applySequenceDefaults, type SequenceAllocator, type SequenceFieldPlan } from "./sequences.js";
import { sequenceSpecResolver, type SettingsStore } from "./settings.js";
import { projectRecord, type EntityStore } from "./store.js";
import type { RouteSpec } from "./operations.js";

const FALLBACK_LIST_CONFIG: ListConfig = {
  defaultLimit: DEFAULT_PAGE_SIZE,
  maxLimit: MAX_PAGE_SIZE,
  defaultSort: [],
  sortableFields: [],
  filterableFields: [],
};

export interface HandlerContext {
  readonly store: EntityStore;
  readonly permissions: PermissionMap;
  readonly roles: ReadonlyMap<RoleName, RoleDefinition>;
  readonly principalRoles: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  /** Allocates document numbers for `default.kind === "sequence"` fields on create. */
  readonly allocator?: SequenceAllocator;
  /** Per-entity sequence-field plans, keyed by entity name. */
  readonly sequencePlans?: ReadonlyMap<string, readonly SequenceFieldPlan[]>;
  /** Lets tenant settings override a sequence's format/start/resetPeriod at runtime. */
  readonly settingsStore?: SettingsStore;
  readonly clock?: { now(): Date };
}

function authPrincipal(
  resolved: ResolvedPrincipal | null,
  principalRoles: HandlerContext["principalRoles"],
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

function json(status: number, body: unknown): HandlerOutput {
  return { kind: "json", status, body };
}

/**
 * Builds the gateway `Handler` for one route spec: enforces the manifest's RBAC
 * (403 on an unauthorized role), executes the CRUD/transition against the store,
 * and returns the full record. Field-level redaction happens at the gateway's
 * `transform_response` stage, per-caller — handlers return everything.
 */
export function buildSpecHandler(spec: RouteSpec, ctx: HandlerContext): Handler {
  return async ({ request, principal, params, parsedBody }) => {
    const tenantId = principal?.tenantId ?? null;
    if (tenantId === null) {
      return json(401, { error: "tenant_required", detail: "request principal has no tenant" });
    }

    const decision = rbacCheck({
      principal: authPrincipal(principal, ctx.principalRoles),
      permissions: ctx.permissions,
      roles: ctx.roles,
      entity: spec.entity,
      operation: spec.authOperation,
    });
    if (!decision.allowed) {
      return json(403, { error: "forbidden", detail: decision.reason });
    }

    const id = params["id"] ?? "";
    switch (spec.action) {
      case "list": {
        const config = spec.listConfig ?? FALLBACK_LIST_CONFIG;
        const fields = parseFields(request.query);
        const query = { ...parseListQuery(request.query, config), ...(fields !== null ? { fields } : {}) };
        const page = await ctx.store.listPage(tenantId, spec.entity, query);
        const data = fields === null ? page.records : page.records.map((r) => projectRecord(r, fields));
        return json(200, {
          data,
          page: { limit: query.limit, nextCursor: page.nextCursor },
        });
      }
      case "read": {
        const record = await ctx.store.get(tenantId, spec.entity, id);
        if (record === null) return json(404, { error: "not_found" });
        const fields = parseFields(request.query);
        return json(200, fields === null ? record : projectRecord(record, fields));
      }
      case "create": {
        const body = await applyEntitySequences(ctx, spec.entity, tenantId, parsedBody ?? {});
        return json(201, await ctx.store.create(tenantId, spec.entity, body));
      }
      case "update": {
        const record = await ctx.store.update(tenantId, spec.entity, id, parsedBody ?? {});
        return record === null ? json(404, { error: "not_found" }) : json(200, record);
      }
      case "delete": {
        const removed = await ctx.store.remove(tenantId, spec.entity, id);
        return removed ? { kind: "empty", status: 204 } : json(404, { error: "not_found" });
      }
      case "transition":
        return applyTransition(spec, ctx, tenantId, id);
    }
  };
}

async function applyEntitySequences(
  ctx: HandlerContext,
  entity: string,
  tenantId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const plans = ctx.sequencePlans?.get(entity);
  if (ctx.allocator === undefined || plans === undefined || plans.length === 0) {
    return body;
  }
  const settings = ctx.settingsStore !== undefined ? await ctx.settingsStore.get(tenantId) : undefined;
  return applySequenceDefaults({
    record: body,
    plans,
    allocator: ctx.allocator,
    tenantId,
    now: ctx.clock?.now() ?? new Date(),
    ...(settings !== undefined ? { resolveSpec: sequenceSpecResolver(settings) } : {}),
  });
}

async function applyTransition(
  spec: RouteSpec,
  ctx: HandlerContext,
  tenantId: string,
  id: string,
): Promise<HandlerOutput> {
  const t = spec.transition;
  if (t === undefined) return json(500, { error: "missing_transition_spec" });
  const record = await ctx.store.get(tenantId, spec.entity, id);
  if (record === null) return json(404, { error: "not_found" });
  const current = record[t.stateField];
  if (typeof current === "string" && !t.fromStates.includes(current)) {
    return json(409, {
      error: "invalid_transition",
      detail: `'${t.name}' cannot fire from '${current}'`,
      allowedFrom: t.fromStates,
    });
  }
  const updated = await ctx.store.update(tenantId, spec.entity, id, { [t.stateField]: t.toState });
  return json(200, updated ?? record);
}
