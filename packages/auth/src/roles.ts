import { RoleInheritanceCycleError, UnknownRoleError } from "./errors.js";
import type { Principal, RoleDefinition, RoleName } from "./types.js";

function visitRole(
  name: RoleName,
  defs: ReadonlyMap<RoleName, RoleDefinition>,
  effective: Set<RoleName>,
  visiting: Set<RoleName>,
  path: readonly RoleName[],
): void {
  if (effective.has(name)) return;
  if (visiting.has(name)) {
    const start = path.indexOf(name);
    throw new RoleInheritanceCycleError([...path.slice(start), name]);
  }
  const def = defs.get(name);
  if (def === undefined) {
    throw new UnknownRoleError(name);
  }
  visiting.add(name);
  for (const parent of def.inherits ?? []) {
    visitRole(parent, defs, effective, visiting, [...path, name]);
  }
  visiting.delete(name);
  effective.add(name);
}

export function resolveEffectiveRoles(
  principal: Principal,
  roleDefinitions: ReadonlyMap<RoleName, RoleDefinition>,
): ReadonlySet<RoleName> {
  const effective = new Set<RoleName>();
  const visiting = new Set<RoleName>();

  visitRole(principal.primaryRole, roleDefinitions, effective, visiting, []);
  for (const role of principal.secondaryRoles) {
    visitRole(role, roleDefinitions, effective, visiting, []);
  }

  return effective;
}

export function validateRoleGraph(
  roleDefinitions: ReadonlyMap<RoleName, RoleDefinition>,
): void {
  const effective = new Set<RoleName>();
  const visiting = new Set<RoleName>();

  for (const name of roleDefinitions.keys()) {
    visitRole(name, roleDefinitions, effective, visiting, []);
  }
}
