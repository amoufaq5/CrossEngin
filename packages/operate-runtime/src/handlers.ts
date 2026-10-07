import {
  ABAC_RECORD_AVAILABILITY,
  ABAC_RECORD_AVAILABILITY_REASONS,
  isAbacDeferred,
  rbacCheck,
  rbacCheckForRecords,
  type AbacBatchEvaluator,
  type AbacEvaluator,
  type AbacGrantPosition,
  type AuthorizationDecision,
  type ClassifiedField,
  type FieldWriteOperation,
  type PermissionMap,
  type Principal,
  type RbacCheckInput,
  type RoleDefinition,
  type RoleName,
  type SensitiveFieldPolicy,
} from "@crossengin/auth";
import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import { principalAbacAttributes } from "@crossengin/api-gateway";
import type { Handler, HandlerOutput, PrincipalRoles } from "@crossengin/api-gateway-runtime";

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  parseFields,
  parseListQuery,
  withheldAddressing,
  type ListConfig,
  type WithheldAddressing,
} from "./list-query.js";
import { applyLiteralDefaults, type LiteralDefaultPlan } from "./defaults.js";
import { applySequenceDefaults, type SequenceAllocator, type SequenceFieldPlan } from "./sequences.js";
import { applySettingsDefaults, type SettingsDefaultPlan } from "./settings-defaults.js";
import { sequenceSpecResolver, type SettingsStore, type TenantSettings } from "./settings.js";
import { runWriteGuards, type WriteGuard } from "./write-guards.js";
import { runWriteEffects, type WriteEffect } from "./write-effects.js";
import { validateBody, type EntityValidationPlan } from "./validation.js";
import { isTransactional, projectRecord, type EntityRecord, type EntityStore } from "./store.js";
import { maskWrite, type WriteMaskMode, type WriteMaskRefusal } from "./write-mask.js";
import type { CursorRefusal, CursorSealer } from "./cursor-seal.js";
import type { RouteAction, RouteSpec } from "./operations.js";

const FALLBACK_LIST_CONFIG: ListConfig = {
  defaultLimit: DEFAULT_PAGE_SIZE,
  maxLimit: MAX_PAGE_SIZE,
  defaultSort: [],
  sortableFields: [],
  filterableFields: [],
  searchableFields: [],
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
  /** Per-entity field-validation plans (required / type / enum / maxLength), keyed by entity name. */
  readonly validationPlans?: ReadonlyMap<string, EntityValidationPlan>;
  /** Lets tenant settings override a sequence's format/start/resetPeriod at runtime. */
  readonly settingsStore?: SettingsStore;
  /**
   * Per-entity sensitive-field policy (privileged roles, per class). The *same* seam the
   * gateway's response redaction reads, deliberately: ADR-0329 put one function behind both
   * halves so a role cannot end up able to write a class it may not read, and two policy
   * sources would reintroduce exactly that divergence.
   */
  readonly policyForEntity?: (entity: string) => SensitiveFieldPolicy | undefined;
  /** Entity → its classified fields, from `buildClassifiedFieldIndex`. */
  readonly classifiedFields?: ReadonlyMap<string, readonly ClassifiedField[]>;
  /** Which half of the field-level write rule is in force. Defaults to `explicit_only`. */
  readonly writeMaskMode?: WriteMaskMode;
  /**
   * Discharges the `abac` policy key a manifest grant may carry, for the entity check *and* the
   * write mask — one seam for both, like `policyForEntity`, so the two halves of one grant cannot
   * be answered by two evaluators. Absent is the fail-closed reading rather than "no obligation":
   * `rbacCheck` and `validateClassifiedWriteMask` resolve an obligation they cannot discharge
   * `undischargeable` and refuse, which is what makes an abac-qualified grant conditional at all.
   */
  readonly abacEvaluator?: AbacEvaluator;
  /**
   * The batch arm beside `abacEvaluator`, read only where one grant is decided for a whole page:
   * the `list` arm's row filter. A deployment that supplies neither pays nothing; one that supplies
   * only this gets every obligation refused, because `dischargeAbacBatch` will not use a batch
   * without its single sibling.
   */
  readonly abacBatchEvaluator?: AbacBatchEvaluator;
  /**
   * Seals the keyset cursor at this boundary — opened on the way in, sealed on the way out — so the
   * token a client holds is opaque to the client and still the plaintext keyset to every store.
   *
   * **Absent means cursors are served plaintext**, which is the pre-ADR-0346 behaviour and is what
   * every deployment without a cursor secret gets; the arm then takes exactly the path it took
   * before. The boot refusal that makes that a deliberate choice rather than an oversight lives in
   * `apps/operate-server`, which is the layer that knows whether a secret was configured.
   */
  readonly cursorSealer?: CursorSealer;
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
    // Resolved in the auth stage, not here: `null` when the deployment configured no attribute
    // directory, or when this credential names no person. `{}` would assert the principal has no
    // attributes, which is a different fact and the one that lets a policy be answered.
    abacAttributes: principalAbacAttributes(resolved),
    mfaProofAgeSeconds: resolved?.mfaProofAgeSeconds ?? null,
  };
}

function json(status: number, body: unknown): HandlerOutput {
  return { kind: "json", status, body };
}

/**
 * Which ABAC grant position each route action's entity-level check evaluates in, as a **total map**
 * so a seventh action is a compile error rather than a member inheriting whichever answer a
 * condition happened to give it — and the answer it would inherit is the one that refuses a
 * record-bearing obligation nobody declared unanswerable.
 *
 * Whether the action can supply the record is read *through* this map off
 * `ABAC_RECORD_AVAILABILITY`, not restated here: that map is the contract a boot check refuses a
 * manifest against, so a handler that re-asked where the contract says it cannot — or gave up where
 * the contract says it can — would make the boot refusal and the request path disagree about the
 * same position.
 */
const ACTION_GRANT_POSITION: Readonly<Record<RouteAction, AbacGrantPosition>> = {
  list: "entity_list",
  read: "entity_read",
  create: "entity_create",
  update: "entity_update",
  delete: "entity_delete",
  transition: "entity_transition",
};

/** Whether this action's handler can load the stored record and ask the obligation again. */
function actionCanSupplyRecord(action: RouteAction): boolean {
  return ABAC_RECORD_AVAILABILITY[ACTION_GRANT_POSITION[action]] === "always";
}

/** Re-asks an entity-level obligation with the record in hand; a 403 output, or null to proceed. */
type ObligationReAsk = (record: EntityRecord) => HandlerOutput | null;

/**
 * The entity-level 403.
 *
 * A `deferred` refusal at a position that can **never** hold a record carries the structural reason
 * as well as `rbacCheck`'s own: the bare reason names the policy and the outcome and says nothing
 * about the position, and "deferred" on its own reads like a retry when a create has no record to
 * retry with and a list decides for a set. The prose is `@crossengin/auth`'s, so the 403 an operator
 * reads and the boot refusal that could have warned them cannot word one fact two ways.
 */
function entityForbidden(action: RouteAction, decision: AuthorizationDecision): HandlerOutput {
  // The obligation is surfaced because the refusals need different actions: `denied` is "your
  // attributes do not match", `undischargeable` is "this deployment cannot evaluate this policy",
  // and `deferred` is "this policy needs the stored record". Two flat fields rather than a nested
  // object, so this and the write mask's 403 are one shape. The policy key is an opaque name the
  // deployment chose, never a value.
  const structural =
    isAbacDeferred(decision.abac) && !actionCanSupplyRecord(action)
      ? ABAC_RECORD_AVAILABILITY_REASONS[ACTION_GRANT_POSITION[action]]
      : null;
  return json(403, {
    error: "forbidden",
    detail: structural === null ? decision.reason : `${decision.reason ?? "refused"}: ${structural}`,
    ...(decision.abac !== undefined
      ? { abacPolicyKey: decision.abac.policyKey, abacOutcome: decision.abac.outcome }
      : {}),
  });
}

/**
 * Builds the gateway `Handler` for one route spec: enforces the manifest's RBAC
 * (403 on an unauthorized role), executes the CRUD/transition against the store,
 * and returns the full record. Field-level redaction happens at the gateway's
 * `transform_response` stage, per-caller — handlers return every field.
 *
 * Every *row*, too, with one exception: a record-bearing obligation on the entity's `list` grant is
 * answered per row and the refused rows are dropped from the page. That is row filtering and it
 * cannot move to the gateway, because the gateway sees a response and not the records the page was
 * a slice of.
 */
export function buildSpecHandler(spec: RouteSpec, ctx: HandlerContext): Handler {
  return async ({ request, principal, params, parsedBody }) => {
    const tenantId = principal?.tenantId ?? null;
    if (tenantId === null) {
      return json(401, { error: "tenant_required", detail: "request principal has no tenant" });
    }

    // Hoisted rather than re-derived per call site: the write mask asks the same question of the
    // same principal, and two independent constructions could answer it from two role sets.
    const auth = authPrincipal(principal, ctx.principalRoles);
    // Built once and used three ways — asked with no record, re-asked with one, and handed to
    // `rbacCheckForRecords` for a whole page — because every one of those must differ in **nothing
    // but the record**: separate construction sites could drift in the principal, the operation or
    // the evaluator, and then "the record admitted it" would be an answer to a different question
    // from the one that deferred.
    const entityCheck: Omit<RbacCheckInput, "record"> = {
      principal: auth,
      permissions: ctx.permissions,
      roles: ctx.roles,
      entity: spec.entity,
      operation: spec.authOperation,
      ...(ctx.abacEvaluator !== undefined ? { abacEvaluator: ctx.abacEvaluator } : {}),
      ...(ctx.abacBatchEvaluator !== undefined ? { abacBatchEvaluator: ctx.abacBatchEvaluator } : {}),
    };
    const askEntity = (record?: Readonly<Record<string, unknown>>): AuthorizationDecision =>
      rbacCheck({ ...entityCheck, ...(record !== undefined ? { record } : {}) });
    const decision = askEntity();
    // A `deferred` refusal is "the policy needs the stored record and this call site had none", and
    // it stays a **refusal** — `ABAC_OUTCOME_ALLOWS.deferred` is false — until the action loads the
    // record and asks again. So this flag records an outstanding obligation and grants nothing: an
    // action that forgets to re-ask refuses, which is ADR-0340's defect (an obligation handed back
    // and dropped) failing in the safe direction one level up.
    //
    // `list` re-asks differently from the other four and that is the one thing to know about it: it
    // asks once per row of the page it loaded and **drops** the rows that are refused, because a
    // list decides for a set and there is no single record a 403 could be about. See the arm.
    const obligationOutstanding =
      !decision.allowed && isAbacDeferred(decision.abac) && actionCanSupplyRecord(spec.action);
    if (!decision.allowed && !obligationOutstanding) return entityForbidden(spec.action, decision);

    /**
     * Discharges an outstanding obligation now that the record is loaded. Nothing may be written
     * between the deferral and this call: the only step permitted in between is the load itself.
     * A second `deferred` answer with the record supplied is an evaluator that cannot be satisfied
     * on this path, and refuses like any other non-allowing outcome.
     */
    const resolveObligation: ObligationReAsk = (record) => {
      const again = askEntity(record);
      return again.allowed ? null : entityForbidden(spec.action, again);
    };

    const id = params["id"] ?? "";
    switch (spec.action) {
      case "list": {
        const config = spec.listConfig ?? FALLBACK_LIST_CONFIG;
        const fields = parseFields(request.query);
        const asked = { ...parseListQuery(request.query, config), ...(fields !== null ? { fields } : {}) };
        // The sealer's context is built **once** and used for both the open and the seal below. An
        // open that succeeded against one context and a seal issued under another would hand the
        // caller a cursor their very next request cannot use — a walk that dies on page two — so the
        // two halves read one object rather than constructing it twice.
        //
        // `asked.sort` is the *effective* sort, the view's default where the request named none, and
        // that is the right thing to bind: it is the ordering the store's keyset is aligned to, so a
        // cursor is confined to the ordering it was derived under whether or not the caller spelled
        // it out. Null with no sealer, so that path allocates nothing and `query` below is `asked`
        // itself.
        const sealing =
          ctx.cursorSealer === undefined
            ? null
            : {
                sealer: ctx.cursorSealer,
                context: { tenantId, entity: spec.entity, sort: asked.sort },
              };
        // Before the store call and before the addressing guard: a cursor that is not for this
        // request is answered without reading anything.
        const opened =
          sealing !== null && asked.cursor !== null ? sealing.sealer.open(asked.cursor, sealing.context) : null;
        if (opened?.kind === "refused") return cursorRefused(opened.reason);
        const query = opened === null ? asked : { ...asked, cursor: opened.value };
        if (obligationOutstanding) {
          // Before the store call: a query that may not be answered must not be run, and the
          // refusal is about what the caller asked to be *told* rather than about anything the
          // store holds. The withheld set is the entity's classified fields and not this caller's
          // own redaction set, which is computed at the gateway after the handler has returned —
          // so it is wider than strictly necessary, wrong only in the refusing direction, and only
          // while a record policy is dropping rows at all.
          const addressing = withheldAddressing(
            query,
            new Set((ctx.classifiedFields?.get(spec.entity) ?? []).map((f) => f.name)),
          );
          if (addressing !== null) return addressingRefused(spec.entity, addressing);
        }
        const page = await ctx.store.listPage(tenantId, spec.entity, query);
        // Deliberately **not** `resolveObligation`: that helper turns a refusal into a 403, which is
        // right where the act decides about one named record and wrong here — the whole point of
        // this position is that a denial is not an error, it is a row the caller is not shown.
        const visible = obligationOutstanding ? admittedRecords(entityCheck, page.records) : page.records;
        const data = fields === null ? visible : visible.map((r) => projectRecord(r, fields));
        return json(200, {
          data,
          // **`nextCursor` is the store's position and not the visible rows', and a short page is
          // the correct answer.** It is
          // derived in the store from the last row of *its* slice and is non-null iff the store had
          // more rows, so termination is `nextCursor === null` and nothing else. Re-deriving it from
          // the last *visible* row would make a fully-denied page carry no cursor, and the walk
          // would then stop early — silently truncating a result the caller is entitled to — or, on
          // a cursor taken from a row that was dropped, repeat. So a page may come back with fewer
          // than `limit` rows, or with none, while the cursor is non-null; the next reader's
          // instinct will be to "fix" that, and the fix is the bug.
          //
          // Nor is the page re-filled by fetching until `limit` rows survive: that makes the work
          // per request depend on the policy's selectivity — a caller who may see 1% of rows would
          // cost ~100 store calls for one page — which is a denial of service reachable from a
          // manifest declaration. One store call per request, exactly as before.
          //
          // The seal is an envelope *around* that rule and does not touch it: `null` stays `null`,
          // because an absent cursor is the end of the walk and a sealed empty string is a position.
          page: {
            limit: query.limit,
            nextCursor:
              sealing === null || page.nextCursor === null
                ? page.nextCursor
                : sealing.sealer.seal(page.nextCursor, sealing.context),
          },
        });
      }
      case "read": {
        const record = await ctx.store.get(tenantId, spec.entity, id);
        if (record === null) return json(404, { error: "not_found" });
        if (obligationOutstanding) {
          // **403, not 404.** Answering 404 for a record that exists would make a record-predicate
          // refusal indistinguishable from a missing record — the conflation ADR-0331 refuses
          // between `null` and `{}`, here between "not yours" and "not there" — so an operator
          // reading the log could not tell which happened, and a wrong answer is worse than a
          // refusal (ADR-0336's `IdempotencyStore.get` rule). The cost is that the caller learns
          // the id exists; the population able to learn it is already the population holding the
          // entity-level `read` grant, which this caller passed to get here.
          const refused = resolveObligation(record);
          if (refused !== null) return refused;
        }
        const fields = parseFields(request.query);
        return json(200, fields === null ? record : projectRecord(record, fields));
      }
      case "create": {
        // Field-level write authorization, on the **caller's own keys** and nothing else. It runs
        // here, before the settings read and before any default is applied, for two reasons:
        //
        // 1. A sequence / literal / settings default and the `created_at`/`updated_at` stamp are
        //    the *server* writing a field, not the caller writing it. Masking those would refuse
        //    an entity whose classified field carries a server default for every role on earth.
        // 2. The 403 must precede `validateEntity`'s 422. A 422 enumerates the fields the body is
        //    missing, so answering it first would hand an unauthorized caller a map of what to
        //    send next. The authorization answer comes first.
        //
        // No record is passed, and none ever can be: the record a field's policy is about does not
        // exist until this write commits. So a record-bearing obligation answers `deferred` here
        // and that is **final**, carrying the structural reason — `deferred` on its own reads like
        // a retry, and there is nothing to retry with.
        const createMask = evaluateMask(
          ctx,
          spec.entity,
          auth,
          "create",
          Object.keys(parsedBody ?? {}),
        );
        if (createMask !== null) {
          return maskForbidden(
            spec.entity,
            createMask.refusal,
            createMask.kind === "deferred" ? ABAC_RECORD_AVAILABILITY_REASONS.field_update : undefined,
          );
        }
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
        // Validate AFTER defaults are applied, so a required field filled by a literal/sequence
        // default passes. A schema violation is a 422 before anything is written.
        const createErrors = validateEntity(ctx, spec.entity, body, "create");
        if (createErrors !== null) return createErrors;
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
        // Optimistic concurrency: a client MAY send the `updated_at` it last read as a reserved
        // `expectedUpdatedAt`; it's stripped from the stored patch and, on mismatch, the write is
        // rejected 409 (a lost-update guard for the generic editor). Absent → unconditional.
        const raw = { ...(parsedBody ?? {}) };
        const expectedUpdatedAt = typeof raw["expectedUpdatedAt"] === "string" ? (raw["expectedUpdatedAt"] as string) : null;
        delete raw["expectedUpdatedAt"];
        // `raw` with the concurrency token removed is exactly the caller's field set, and
        // `updated_at` is merged below rather than above for that reason. Before `validateEntity`,
        // so a 403 for a field you may not write is never preceded by a 422 naming the others.
        //
        // The mask runs with **no record** here and is re-run with `before` inside the transaction
        // if it deferred. The cost of that is an ordering change worth writing down: the mask
        // short-circuits on the *first* refusing field and a deferral is a refusal, so when a
        // written field's `update` grant carries a record-bearing obligation the fields after it
        // are not checked before the 422 — a caller with both a role violation on a later field and
        // an invalid body now gets the 422 first. That is bounded, and ADR-0339's ordering argument
        // says why: the 422-first concern is an *unauthorized* caller harvesting the entity's shape,
        // and this caller has already passed the entity-level `update` role check, so they could
        // learn the same shape from a valid write on a record they do own. A mode flag on the mask
        // to recover the ordering would be worse than the ordering: a boolean that changes
        // fail-closed semantics is the thing this seam exists to not have.
        const updateMask = evaluateMask(ctx, spec.entity, auth, "update", Object.keys(raw));
        if (updateMask?.kind === "refused") return maskForbidden(spec.entity, updateMask.refusal);
        const maskDeferred = updateMask?.kind === "deferred";
        const updateErrors = validateEntity(ctx, spec.entity, raw, "update");
        if (updateErrors !== null) return updateErrors;
        const patch = { ...raw, updated_at: nowIso(ctx) };
        return writeTxn(ctx, tenantId, async (store) => {
          // An outstanding obligation — entity-level or field-level — forces the load, on top of
          // the three reasons that already did. Without it the record is never fetched for a plain
          // patch and the obligation could only refuse.
          const needsBefore =
            hasGuards(ctx) ||
            hasEffects(ctx) ||
            expectedUpdatedAt !== null ||
            obligationOutstanding ||
            maskDeferred;
          const before = needsBefore ? await store.get(tenantId, spec.entity, id) : null;
          if (needsBefore && before === null) return json(404, { error: "not_found" });
          // Authorization precedes business logic: both obligations are discharged here, after the
          // load and the 404 and **before** the 409, the guard and every write. A 409 is a
          // lost-update report about a record this caller may turn out not to be allowed to touch,
          // so answering it first would disclose that the record had been modified.
          if (obligationOutstanding && before !== null) {
            const refused = resolveObligation(before);
            if (refused !== null) return refused;
          }
          if (maskDeferred && before !== null) {
            // A second `deferred` with the record supplied is an evaluator that cannot be satisfied
            // on this path, so it is refused like any other non-allowing outcome — and with no
            // structural reason appended, because the position *can* supply a record and did.
            const again = evaluateMask(ctx, spec.entity, auth, "update", Object.keys(raw), before);
            if (again !== null) return maskForbidden(spec.entity, again.refusal);
          }
          if (expectedUpdatedAt !== null && before !== null) {
            const current = typeof before["updated_at"] === "string" ? (before["updated_at"] as string) : null;
            if (current !== null && current !== expectedUpdatedAt) {
              return json(409, {
                error: "conflict",
                detail: "the record was modified since you loaded it",
                currentUpdatedAt: current,
              });
            }
          }
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
        // No write mask: a delete carries no body, so there is no caller-supplied field to mask.
        // Whether this principal may destroy the record is the entity-level `delete` grant,
        // already checked above.
        return writeTxn(ctx, tenantId, async (store) => {
          // An outstanding obligation forces the load: the record is what the policy is about.
          const needsBefore = hasGuards(ctx) || hasEffects(ctx) || obligationOutstanding;
          const before = needsBefore ? await store.get(tenantId, spec.entity, id) : null;
          if (needsBefore && before === null) return json(404, { error: "not_found" });
          // Before the guard and before `remove`: a destroyed record is not recoverable by a later
          // refusal, which is the whole of the "nothing is written before the obligation is
          // discharged" invariant on this action.
          if (obligationOutstanding && before !== null) {
            const refused = resolveObligation(before);
            if (refused !== null) return refused;
          }
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
        // No write mask: a transition takes no body and writes `{[stateField]: toState,
        // updated_at}` — both values chosen by the manifest's workflow and the clock, neither
        // supplied by the caller. Masking a server-chosen patch would refuse a transition whose
        // state field happens to be classified, for every role, on behalf of nobody. Which
        // principals may fire it is the per-transition grant, already checked above — and if that
        // grant's policy needs the record, the re-ask is threaded in as one nullable function
        // rather than as a flag plus a resolver, so the two facts ("an obligation is outstanding"
        // and "here is how to discharge it") cannot be passed out of step with each other.
        return applyTransition(spec, ctx, tenantId, id, obligationOutstanding ? resolveObligation : null);
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
  resolveObligation: ObligationReAsk | null,
): Promise<HandlerOutput> {
  const t = spec.transition;
  if (t === undefined) return json(500, { error: "missing_transition_spec" });
  return writeTxn(ctx, tenantId, async (store) => {
    const record = await store.get(tenantId, spec.entity, id);
    if (record === null) return json(404, { error: "not_found" });
    // Right after the load and the 404, and **before** the from-state 409: authorization precedes
    // business logic. The record is already loaded unconditionally on this action, so there is
    // nothing to force — only a place to ask. A 409 names the state the record is in, which is a
    // fact about a record this caller may turn out not to be allowed to move at all.
    if (resolveObligation !== null) {
      const refused = resolveObligation(record);
      if (refused !== null) return refused;
    }
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
      transitionTo: t.toState,
    });
    return json(200, after);
  });
}

/**
 * The rows of a page this principal's record-level policy admits, in order.
 *
 * **One `rbacCheckForRecords` and never a loop of `rbacCheck`.** The entity, grant and role arms do
 * not depend on the record, so the plural form resolves them once for the whole page and pools the
 * obligations into exactly one batch — which is what keeps a page of 500 rows from becoming 500
 * round trips to a deployment's policy service. Each element is what `rbacCheck` would have
 * returned for that record, so filtering on `allowed` decides nothing the single form would not.
 *
 * It reports **nothing** about what it dropped, and that is the decision rather than an omission: a
 * withheld count is an inference channel the caller narrows with filters, and unlike ADR-0342's
 * 403 — where the caller had *named* the record and so already knew it might exist — a list caller
 * named nothing.
 */
function admittedRecords(
  entityCheck: Omit<RbacCheckInput, "record">,
  records: readonly EntityRecord[],
): readonly EntityRecord[] {
  const decisions = rbacCheckForRecords(entityCheck, records);
  // `?? false` rather than `!`: a decisions array shorter than the page would otherwise admit its
  // tail, and a gap where an authorization answer should be has to drop the row, not keep it.
  return records.filter((_, index) => decisions[index]?.allowed ?? false);
}

/**
 * Why each addressing surface is refused and under which error code, as a **total map** so a fourth
 * surface is a compile error rather than a refusal with no explanation attached to it.
 */
const WITHHELD_ADDRESSING: Readonly<
  Record<WithheldAddressing["surface"], { readonly error: string; readonly reason: string }>
> = {
  sort: {
    error: "sort_addresses_withheld_field",
    reason:
      "the page cursor is built from the last row the store returned, which may be a row you are not shown, so ordering by a field you may not read would hand you that row's value",
  },
  filter: {
    error: "filter_addresses_withheld_field",
    reason:
      "the response distinguishes a match from no match, so filtering on a field you may not read would let the contents of a row you are not shown be tested one value at a time",
  },
  search: {
    error: "search_addresses_withheld_field",
    reason:
      "free-text search spans a field you may not read, so the response would let the contents of a row you are not shown be tested one term at a time",
  },
};

/**
 * **400 and not 403.** This caller may list the entity — they passed the entity-level role check to
 * reach here — and it is the *query* that cannot be answered. A 403 would say the act was refused
 * and send an operator to the permission map, where there is nothing to fix.
 *
 * The field is named and no value ever is: the sort and filter spellings came from the caller, but
 * `search`'s field list is the manifest's, and a refusal that echoed the term would report what was
 * being probed back to the prober.
 */
function addressingRefused(entity: string, addressing: WithheldAddressing): HandlerOutput {
  const { error, reason } = WITHHELD_ADDRESSING[addressing.surface];
  return json(400, {
    error,
    detail: `'${addressing.field}' on '${entity}' may not address rows while rows are being withheld: ${reason}`,
    field: addressing.field,
  });
}

/**
 * Why each cursor refusal is answered and under which error code, as a **total map** for
 * `WITHHELD_ADDRESSING`'s reason: a second refusal reason becomes a compile error rather than a 400
 * with no explanation. There is one today, and `CURSOR_REFUSALS` says why that is a property of the
 * cryptography and not a gap.
 */
const CURSOR_REFUSAL_OUTPUTS: Readonly<
  Record<CursorRefusal, { readonly error: string; readonly detail: string }>
> = {
  not_for_this_request: {
    error: "cursor_not_for_this_request",
    detail:
      "the page cursor was not issued for this request: a cursor is bound to the tenant, the entity and the sort it was issued under, and replaying it under any other is refused. Start the walk again with no cursor.",
  },
};

/**
 * **400, and neither a 403 nor a silent restart.**
 *
 * Not a 403, because nothing about this caller's authorization changed — they passed the entity-level
 * check to reach here — and a 403 would send an operator to the permission map, where there is
 * nothing to fix. Not a restart from the beginning, because answering 200 with page one for a cursor
 * that failed to authenticate reads as the walk working; a bad request is what this is.
 *
 * The detail names the three bindings and nothing else — no field, no value, and above all not which
 * of the bindings failed, because GCM cannot say.
 */
function cursorRefused(reason: CursorRefusal): HandlerOutput {
  const { error, detail } = CURSOR_REFUSAL_OUTPUTS[reason];
  return json(400, { error, detail });
}

/** Current time as an ISO string, honoring an injected clock for deterministic tests. */
function nowIso(ctx: HandlerContext): string {
  return (ctx.clock?.now() ?? new Date()).toISOString();
}

/** Runs the entity's validation plan, returning a 422 output on any error (else null). */
function validateEntity(
  ctx: HandlerContext,
  entity: string,
  body: Record<string, unknown>,
  mode: "create" | "update",
): HandlerOutput | null {
  const plan = ctx.validationPlans?.get(entity);
  if (plan === undefined) return null;
  const errors = validateBody(plan, body, mode);
  return errors.length > 0 ? json(422, { error: "validation_failed", fields: errors }) : null;
}

/**
 * A field-level write refusal, plus **which kind** it is, because the caller acts differently on
 * each: a `deferred` obligation is a refusal pending the stored record, so an update loads `before`
 * and re-runs the mask, while a create has no record and returns it as it stands.
 *
 * It carries the `WriteMaskRefusal` and not a built `HandlerOutput`, deliberately: the create path
 * has to append the structural reason to the detail, and handing back a finished output would force
 * either a second construction of the same 403 body (two spellings to keep in step — this repo's
 * recurring defect) or a detail that cannot carry the reason at all.
 */
interface MaskOutcome {
  /** `deferred` iff the refusal is an obligation that needs a stored record this call site lacked. */
  readonly kind: "refused" | "deferred";
  readonly refusal: WriteMaskRefusal;
}

/**
 * Field-level write authorization: the first field the caller may not write, else null.
 * `writtenKeys` must be the caller's own keys — see the call sites.
 *
 * `record` is the stored record the write lands on, when the caller has it. Omitted is not the same
 * as empty: a policy needing a record and handed none answers `deferred`, which refuses, and the
 * caller resolves it by loading the record and asking again.
 */
function evaluateMask(
  ctx: HandlerContext,
  entity: string,
  principal: Principal,
  writeOp: FieldWriteOperation,
  writtenKeys: readonly string[],
  record?: Readonly<Record<string, unknown>>,
): MaskOutcome | null {
  if (writtenKeys.length === 0) return null;
  const policy = ctx.policyForEntity?.(entity);
  const refusal = maskWrite({
    mode: ctx.writeMaskMode ?? "explicit_only",
    entity,
    principal,
    // Unreachable: `rbacCheck` already 403'd an entity with no declared permissions. `{}` is also
    // the fail-closed reading — no explicit grant satisfies anyone, and under `classified` a
    // sensitive field still needs a privileged role.
    entityPerms: ctx.permissions[entity] ?? {},
    roles: ctx.roles,
    classifiedFields: ctx.classifiedFields?.get(entity) ?? [],
    writtenKeys,
    writeOp,
    ...(policy !== undefined ? { policy } : {}),
    ...(ctx.abacEvaluator !== undefined ? { abacEvaluator: ctx.abacEvaluator } : {}),
    ...(record !== undefined ? { record } : {}),
  });
  if (refusal === null) return null;
  // Both conjuncts: the outcome field is set only on an `abac_obligation` refusal, and reading the
  // outcome alone would make a future refusal kind that happened to carry one re-askable.
  const deferred = refusal.rule === "abac_obligation" && refusal.abacOutcome === "deferred";
  return { kind: deferred ? "deferred" : "refused", refusal };
}

/**
 * The field-level 403.
 *
 * The detail names the field and the rule that refused and **never a value**: this runs on a body
 * the caller just sent, so echoing one back would be harmless here and a template for a handler
 * that echoes a value the caller did *not* send.
 *
 * `structuralReason` is appended by a call site at which a `deferred` obligation can never be
 * discharged — the create path — so one body shape serves both, and the reason prose is
 * `@crossengin/auth`'s rather than a second wording of the same fact.
 */
function maskForbidden(
  entity: string,
  refusal: WriteMaskRefusal,
  structuralReason?: string,
): HandlerOutput {
  const base = `field '${refusal.field}' on '${entity}' is not writable by this principal`;
  return json(403, {
    error: "forbidden",
    detail: structuralReason === undefined ? base : `${base}: ${structuralReason}`,
    field: refusal.field,
    rule: refusal.rule,
    ...(refusal.abacPolicyKey !== undefined
      ? { abacPolicyKey: refusal.abacPolicyKey, abacOutcome: refusal.abacOutcome }
      : {}),
  });
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
