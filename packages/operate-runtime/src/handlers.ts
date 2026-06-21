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
import { applyLiteralDefaults, type LiteralDefaultPlan } from "./defaults.js";
import { applySequenceDefaults, type SequenceAllocator, type SequenceFieldPlan } from "./sequences.js";
import { applySettingsDefaults, type SettingsDefaultPlan } from "./settings-defaults.js";
import { sequenceSpecResolver, type SettingsStore, type TenantSettings } from "./settings.js";
import { runWriteGuards, type WriteGuard } from "./write-guards.js";
import { runWriteEffects, type WriteEffect } from "./write-effects.js";
import { isTransactional, projectRecord, type EntityStore } from "./store.js";
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
  /** Per-entity literal-default plans (lifecycle state, enums, flags), keyed by entity name. */
  readonly defaultPlans?: ReadonlyMap<string, readonly LiteralDefaultPlan[]>;
  /** Per-entity settings-driven default plans (currency, payment terms), keyed by entity name. */
  readonly settingsDefaultPlans?: ReadonlyMap<string, SettingsDefaultPlan>;
  /** Runtime data invariants (e.g. balanced journal postings) checked before each write. */
  readonly writeGuards?: readonly WriteGuard[];
  /** Side effects run after a successful write (e.g. auto-generating a reversal entry). */
  readonly writeEffects?: readonly WriteEffect[];
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
        const settings =
          ctx.settingsStore !== undefined ? await ctx.settingsStore.get(tenantId) : undefined;
        let body = parsedBody ?? {};
        const settingsPlan = ctx.settingsDefaultPlans?.get(spec.entity);
        if (settingsPlan !== undefined && settings !== undefined) {
          body = applySettingsDefaults(body, settingsPlan, settings, ctx.clock?.now());
        }
        body = applyLiteralDefaults(body, ctx.defaultPlans?.get(spec.entity) ?? []);
        body = await applyEntitySequences(ctx, spec.entity, tenantId, body, settings);
        const createdAt = nowIso(ctx);
        body = { created_at: createdAt, ...body, updated_at: createdAt };
        return writeTxn(ctx, tenantId, async (store) => {
          const block = await guard(ctx, {
            operation: "create",
            entity: spec.entity,
            tenantId,
            id: null,
            before: null,
            after: body,
            store,
          });
          if (block !== null) return block;
          const created = await store.create(tenantId, spec.entity, body);
          await runEffects(ctx, {
            operation: "create",
            entity: spec.entity,
            tenantId,
            id: typeof created["id"] === "string" ? (created["id"] as string) : null,
            before: null,
            after: created,
            store,
          });
          return json(201, created);
        });
      }
      case "update": {
        const patch = { ...(parsedBody ?? {}), updated_at: nowIso(ctx) };
        return writeTxn(ctx, tenantId, async (store) => {
          const needsBefore = hasGuards(ctx) || hasEffects(ctx);
          const before = needsBefore ? await store.get(tenantId, spec.entity, id) : null;
          if (needsBefore && before === null) return json(404, { error: "not_found" });
          const block = await guard(ctx, {
            operation: "update",
            entity: spec.entity,
            tenantId,
            id,
            before,
            after: { ...(before ?? {}), ...patch },
            store,
          });
          if (block !== null) return block;
          const record = await store.update(tenantId, spec.entity, id, patch);
          if (record === null) return json(404, { error: "not_found" });
          await runEffects(ctx, {
            operation: "update",
            entity: spec.entity,
            tenantId,
            id,
            before,
            after: record,
            store,
          });
          return json(200, record);
        });
      }
      case "delete": {
        return writeTxn(ctx, tenantId, async (store) => {
          const needsBefore = hasGuards(ctx) || hasEffects(ctx);
          const before = needsBefore ? await store.get(tenantId, spec.entity, id) : null;
          if (needsBefore && before === null) return json(404, { error: "not_found" });
          const block = await guard(ctx, {
            operation: "delete",
            entity: spec.entity,
            tenantId,
            id,
            before,
            after: before ?? {},
            store,
          });
          if (block !== null) return block;
          const removed = await store.remove(tenantId, spec.entity, id);
          if (!removed) return json(404, { error: "not_found" });
          await runEffects(ctx, {
            operation: "delete",
            entity: spec.entity,
            tenantId,
            id,
            before,
            after: before ?? {},
            store,
          });
          return { kind: "empty", status: 204 };
        });
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
  prefetchedSettings?: TenantSettings,
): Promise<Record<string, unknown>> {
  const plans = ctx.sequencePlans?.get(entity);
  if (ctx.allocator === undefined || plans === undefined || plans.length === 0) {
    return body;
  }
  const settings =
    prefetchedSettings ??
    (ctx.settingsStore !== undefined ? await ctx.settingsStore.get(tenantId) : undefined);
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
  return writeTxn(ctx, tenantId, async (store) => {
    const record = await store.get(tenantId, spec.entity, id);
    if (record === null) return json(404, { error: "not_found" });
    const current = record[t.stateField];
    if (typeof current === "string" && !t.fromStates.includes(current)) {
      return json(409, {
        error: "invalid_transition",
        detail: `'${t.name}' cannot fire from '${current}'`,
        allowedFrom: t.fromStates,
      });
    }
    const patch = { [t.stateField]: t.toState, updated_at: nowIso(ctx) };
    const block = await guard(ctx, {
      operation: "transition",
      entity: spec.entity,
      tenantId,
      id,
      before: record,
      after: { ...record, ...patch },
      store,
    });
    if (block !== null) return block;
    const updated = await store.update(tenantId, spec.entity, id, patch);
    const after = updated ?? record;
    await runEffects(ctx, {
      operation: "transition",
      entity: spec.entity,
      tenantId,
      id,
      before: record,
      after,
      store,
    });
    return json(200, after);
  });
}

/** Current time as an ISO string, honoring an injected clock for deterministic tests. */
function nowIso(ctx: HandlerContext): string {
  return (ctx.clock?.now() ?? new Date()).toISOString();
}

function hasGuards(ctx: HandlerContext): boolean {
  return ctx.writeGuards !== undefined && ctx.writeGuards.length > 0;
}

function hasEffects(ctx: HandlerContext): boolean {
  return ctx.writeEffects !== undefined && ctx.writeEffects.length > 0;
}

/**
 * Runs a write unit (guard → store write → effects) atomically when the store
 * supports transactions: the body runs against a transaction-bound store and an
 * effect that throws rolls the whole unit back. On a non-transactional store the
 * body runs directly (best-effort). Either way a thrown error maps to 500.
 */
async function writeTxn(
  ctx: HandlerContext,
  tenantId: string,
  body: (store: EntityStore) => Promise<HandlerOutput>,
): Promise<HandlerOutput> {
  try {
    if (isTransactional(ctx.store)) {
      return await ctx.store.withTransaction(tenantId, (tx) => body(tx));
    }
    return await body(ctx.store);
  } catch (e) {
    return json(500, { error: "write_failed", detail: e instanceof Error ? e.message : String(e) });
  }
}

/** Runs post-write effects; a throw propagates so `writeTxn` rolls back + maps to 500. */
async function runEffects(ctx: HandlerContext, input: Parameters<WriteEffect>[0]): Promise<void> {
  if (!hasEffects(ctx)) return;
  await runWriteEffects(ctx.writeEffects!, input);
}

/** Runs the configured write guards; returns a problem HandlerOutput on the first block, else null. */
async function guard(
  ctx: HandlerContext,
  input: Parameters<WriteGuard>[0],
): Promise<HandlerOutput | null> {
  if (ctx.writeGuards === undefined || ctx.writeGuards.length === 0) return null;
  const block = await runWriteGuards(ctx.writeGuards, input);
  if (block === null) return null;
  return json(block.status, { error: block.error, ...(block.detail !== undefined ? { detail: block.detail } : {}) });
}
