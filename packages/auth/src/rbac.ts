import { ABAC_OUTCOME_ALLOWS, describeOperation, dischargeAbac } from "./abac.js";
import type { AbacEvaluator } from "./abac.js";
import { resolveEffectiveRoles } from "./roles.js";
import type {
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
   * The stored record this act is about, present when the caller has loaded it.
   *
   * Absent is what makes a record-bearing obligation answer `deferred`, which is `allowed: false`
   * with `abac.outcome === "deferred"` — a refusal the caller resolves by loading the record and
   * asking again, never by ignoring it. `ABAC_RECORD_AVAILABILITY` says which positions can supply
   * one at all.
   */
  readonly record?: Readonly<Record<string, unknown>>;
}

export function rbacCheck(input: RbacCheckInput): AuthorizationDecision {
  const effectiveRoles = resolveEffectiveRoles(input.principal, input.roles);

  const entityPerms = input.permissions[input.entity];
  if (entityPerms === undefined) {
    return {
      allowed: false,
      reason: `no permissions declared for entity '${input.entity}'`,
    };
  }

  const grant = getGrant(entityPerms, input.operation);
  if (grant === null) {
    return {
      allowed: false,
      reason: `no permission grant for operation '${describeOperation(input.operation)}' on entity '${input.entity}'`,
    };
  }

  const allowed = grant.roles.some((r) => effectiveRoles.has(r));
  if (!allowed) {
    return {
      allowed: false,
      reason: `principal's effective roles do not grant '${describeOperation(input.operation)}' on '${input.entity}'`,
    };
  }

  // Order is load-bearing: the evaluator is consulted only after the role check passes, so a
  // principal with no role grant never reaches a policy. There is nothing to learn from an
  // evaluation that a 403 was already owed, and asking would hand the deployment's policy layer a
  // principal it has no business seeing.
  //
  // One question, so there is nothing for `AbacBatchEvaluator` to group: this reader decides a
  // single grant for a single act, and `RbacCheckInput` therefore gains no batch field.
  const discharge = dischargeAbac(
    grant.abac,
    {
      principal: input.principal,
      entity: input.entity,
      operation: input.operation,
      ...(input.record !== undefined ? { record: input.record } : {}),
    },
    input.abacEvaluator,
  );
  if (discharge === null) return { allowed: true };

  // Attached on both arms: a satisfied obligation is a fact worth reporting, not only a refused one.
  if (ABAC_OUTCOME_ALLOWS[discharge.outcome]) return { allowed: true, abac: discharge };

  return {
    allowed: false,
    reason: `abac policy '${discharge.policyKey}' did not admit '${describeOperation(input.operation)}' on '${input.entity}' (${discharge.outcome})`,
    abac: discharge,
  };
}

function getGrant(perms: EntityPermissions, op: Operation): RbacGrant | null {
  if (typeof op === "object") {
    return perms.transitions?.[op.name] ?? null;
  }
  return perms[op] ?? null;
}
