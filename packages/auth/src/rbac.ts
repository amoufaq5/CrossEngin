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
      reason: `no permission grant for operation '${describeOp(input.operation)}' on entity '${input.entity}'`,
    };
  }

  const allowed = grant.roles.some((r) => effectiveRoles.has(r));
  if (!allowed) {
    return {
      allowed: false,
      reason: `principal's effective roles do not grant '${describeOp(input.operation)}' on '${input.entity}'`,
    };
  }

  return {
    allowed: true,
    ...(grant.abac !== undefined ? { requiresAbac: grant.abac } : {}),
  };
}

function getGrant(perms: EntityPermissions, op: Operation): RbacGrant | null {
  if (typeof op === "object") {
    return perms.transitions?.[op.name] ?? null;
  }
  return perms[op] ?? null;
}

function describeOp(op: Operation): string {
  return typeof op === "object" ? `transition:${op.name}` : op;
}
