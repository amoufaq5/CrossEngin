import {
  ABAC_OUTCOME_ALLOWS,
  describeOperation,
  dischargeAbac,
  dischargeAbacBatch,
} from "./abac.js";
import type { AbacBatchEvaluator, AbacBatchRequest, AbacEvaluator } from "./abac.js";
import { resolveEffectiveRoles } from "./roles.js";
import type {
  AbacDischarge,
  AuthorizationDecision,
  EntityPermissions,
  Operation,
  PermissionMap,
  Principal,
  RbacGrant,
  RoleDefinition,
  RoleName,
} from "./types.js";

export interface RbacCheckInput {
  readonly principal: Principal;
  readonly permissions: PermissionMap;
  readonly roles: ReadonlyMap<RoleName, RoleDefinition>;
  readonly entity: string;
  readonly operation: Operation;
  readonly abacEvaluator?: AbacEvaluator;
  /**
   * The batch arm, read by {@link rbacCheckForRecords} and **ignored by {@link rbacCheck}**: that
   * function asks one question, so there is nothing to pool and a batch of one would only move the
   * call.
   *
   * It lives on the shared input rather than as a parameter of the plural form so a caller cannot
   * hand the single evaluator to one function and the batch to the other. Both arms are then one
   * object that travels together, and `dischargeAbacBatch` refuses a batch supplied without its
   * single sibling — a half-wired seam rather than a working one.
   */
  readonly abacBatchEvaluator?: AbacBatchEvaluator;
  /**
   * The stored record this act is about, present when the caller has loaded it.
   *
   * Absent is what makes a record-bearing obligation answer `deferred`, which is `allowed: false`
   * with `abac.outcome === "deferred"` — a refusal the caller resolves by loading the record and
   * asking again, never by ignoring it. `ABAC_RECORD_AVAILABILITY` says which positions can supply
   * one at all.
   */
  readonly record?: Readonly<Record<string, unknown>>;
}

/** Everything the role and grant arms read — which is `RbacCheckInput` minus anything per record. */
type GrantLookupInput = Pick<
  RbacCheckInput,
  "principal" | "permissions" | "roles" | "entity" | "operation"
>;

type GrantLookup =
  | { readonly ok: true; readonly grant: RbacGrant }
  | { readonly ok: false; readonly decision: AuthorizationDecision };

/**
 * The entity, grant and role arms, shared by both readers rather than copied into each.
 *
 * None of the three depends on the record, which is what makes the sharing correct and not merely
 * tidy: the plural form resolves them **once** for a whole page and hands every element the same
 * refusal. Extracted rather than duplicated because three copied refusal branches are three places
 * for the two readers to drift apart on the wording a caller logs.
 *
 * Running to completion before either caller discharges anything is also what keeps ADR-0340's
 * ordering: the evaluator is consulted only after the role check passes, so a principal with no role
 * grant never reaches a policy. There is nothing to learn from an evaluation that a 403 was already
 * owed, and asking would hand the deployment's policy layer a principal it has no business seeing.
 */
function lookupGrant(input: GrantLookupInput): GrantLookup {
  const effectiveRoles = resolveEffectiveRoles(input.principal, input.roles);

  const entityPerms = input.permissions[input.entity];
  if (entityPerms === undefined) {
    return {
      ok: false,
      decision: {
        allowed: false,
        reason: `no permissions declared for entity '${input.entity}'`,
      },
    };
  }

  const grant = getGrant(entityPerms, input.operation);
  if (grant === null) {
    return {
      ok: false,
      decision: {
        allowed: false,
        reason: `no permission grant for operation '${describeOperation(input.operation)}' on entity '${input.entity}'`,
      },
    };
  }

  const allowed = grant.roles.some((r) => effectiveRoles.has(r));
  if (!allowed) {
    return {
      ok: false,
      decision: {
        allowed: false,
        reason: `principal's effective roles do not grant '${describeOperation(input.operation)}' on '${input.entity}'`,
      },
    };
  }

  return { ok: true, grant };
}

/**
 * One discharge rendered as a decision, shared for the same reason `lookupGrant` is: the plural form
 * must be elementwise indistinguishable from N singular calls, and a second copy of this reason
 * string is how that stops being true.
 */
function decideFromDischarge(
  input: GrantLookupInput,
  discharge: AbacDischarge,
): AuthorizationDecision {
  // Attached on both arms: a satisfied obligation is a fact worth reporting, not only a refused one.
  if (ABAC_OUTCOME_ALLOWS[discharge.outcome]) return { allowed: true, abac: discharge };

  return {
    allowed: false,
    reason: `abac policy '${discharge.policyKey}' did not admit '${describeOperation(input.operation)}' on '${input.entity}' (${discharge.outcome})`,
    abac: discharge,
  };
}

export function rbacCheck(input: RbacCheckInput): AuthorizationDecision {
  const lookup = lookupGrant(input);
  if (!lookup.ok) return lookup.decision;

  // One question, so there is nothing for `AbacBatchEvaluator` to group here: this reader decides a
  // single grant for a single act, and a batch of one would only move the call. The fan-out is
  // `rbacCheckForRecords` beside it, where `list` decides one grant for a whole page — which is why
  // `abacBatchEvaluator` is on the shared input and ignored here rather than absent from the type.
  const discharge = dischargeAbac(
    lookup.grant.abac,
    {
      principal: input.principal,
      entity: input.entity,
      operation: input.operation,
      ...(input.record !== undefined ? { record: input.record } : {}),
    },
    input.abacEvaluator,
  );
  if (discharge === null) return { allowed: true };

  return decideFromDischarge(input, discharge);
}

/**
 * {@link rbacCheck} for several records at once, one decision per record and **positionally aligned**
 * to `records`. `[]` for `[]`.
 *
 * The reader row filtering needs: an entity `list` decides one grant for a whole page, so the entity,
 * grant and role arms are resolved **once** — none of them depends on the record — and only the
 * obligation is asked per row, pooled into exactly one `dischargeAbacBatch` call. A refusal in any of
 * those three arms is the same decision for every element, because it was never about the records.
 *
 * Each element is **identical to what `rbacCheck` would return for that record**, reason and `abac`
 * included. That is a property the handler depends on — a page is filtered by asking this and keeping
 * the rows that pass — and it is held by construction rather than by two functions agreeing: both go
 * through `lookupGrant` and `decideFromDischarge`.
 *
 * The input is `Omit<RbacCheckInput, "record">` **deliberately**, for
 * `computeClassifiedFieldRedactionForRecords`' reason: the records travel in the array, so supplying
 * one twice is structurally impossible rather than resolved by a silent precedence rule or by a
 * refusal for a mistake the type can simply prevent.
 */
export function rbacCheckForRecords(
  input: Omit<RbacCheckInput, "record">,
  records: readonly Readonly<Record<string, unknown>>[],
): readonly AuthorizationDecision[] {
  const lookup = lookupGrant(input);
  if (!lookup.ok) return records.map(() => lookup.decision);

  const policyKey = lookup.grant.abac;
  // No obligation, so no evaluator is consulted for any row — `rbacCheck`'s `null` discharge, once
  // for the whole page rather than once per record.
  if (policyKey === undefined) return records.map(() => ({ allowed: true }));

  const requests: readonly AbacBatchRequest[] = records.map((record) => ({
    policyKey,
    context: {
      principal: input.principal,
      entity: input.entity,
      operation: input.operation,
      record,
    },
  }));
  const discharges = dischargeAbacBatch(requests, input.abacEvaluator, input.abacBatchEvaluator);

  return requests.map((request, index) => {
    const discharge = discharges[index];
    // `dischargeAbacBatch` returns one discharge per request, so this cannot be missing — but the
    // fallback is a refusal rather than an assertion, because the one thing a gap here must not do
    // is admit a row nothing decided.
    return decideFromDischarge(
      input,
      discharge ?? { policyKey: request.policyKey, outcome: "undischargeable" },
    );
  });
}

function getGrant(perms: EntityPermissions, op: Operation): RbacGrant | null {
  if (typeof op === "object") {
    return perms.transitions?.[op.name] ?? null;
  }
  return perms[op] ?? null;
}
