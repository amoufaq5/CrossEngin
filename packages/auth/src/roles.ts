import { RoleInheritanceCycleError, UnknownRoleError } from "./errors.js";
import type { Principal, RoleDefinition, RoleName } from "./types.js";

export function resolveEffectiveRoles(
  principal: Principal,
  roleDefinitions: ReadonlyMap<RoleName, RoleDefinition>,
): ReadonlySet<RoleName> {
  const effective = new Set<RoleName>();
  const visiting = new Set<RoleName>();

  function visit(name: RoleName, path: readonly RoleName[]): void {
    if (effective.has(name)) return;
    if (visiting.has(name)) {
      const start = path.indexOf(name);
      throw new RoleInheritanceCycleError([...path.slice(start), name]);
    }
    const def = roleDefinitions.get(name);
    if (def === undefined) {
      throw new UnknownRoleError(name);
    }

    visiting.add(name);
    for (const parent of def.inherits ?? []) {
      visit(parent, [...path, name]);
    }
    visiting.delete(name);
    effective.add(name);
  }

  visit(principal.primaryRole, []);
  for (const role of principal.secondaryRoles) {
    visit(role, []);
  }

  return effective;
}
