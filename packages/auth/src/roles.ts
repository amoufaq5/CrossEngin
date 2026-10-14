import { RoleInheritanceCycleError, UnknownRoleError } from "./errors.js";
import type { Principal, RoleDefinition, RoleName } from "./types.js";

/**
 * What an undeclared role name means to the walker, which is **two different things** depending on
 * who is asking.
 *
 * `refuse` is the authoring question — *is this role graph coherent?* — where a name with no
 * definition is a typo in a manifest a reviewer is about to approve, and throwing is how it gets
 * caught before it ships.
 *
 * `skip` is the serving question — *what may this session do?* — where an undeclared name is not an
 * error at all but an ordinary fact about a principal: `--platform-admin-role platform_admin` is a
 * platform role on purpose, and `erp-core` declares fifteen roles of which it is not one, so every
 * session that administers tenants carries a role the served manifest has never heard of. Such a
 * role grants nothing, which is both fail-closed and simply true, and the walker says so by
 * contributing nothing rather than by raising.
 */
export const UNKNOWN_ROLE_DISPOSITIONS = ["refuse", "skip"] as const;
export type UnknownRoleDisposition = (typeof UNKNOWN_ROLE_DISPOSITIONS)[number];

function visitRole(
  name: RoleName,
  defs: ReadonlyMap<RoleName, RoleDefinition>,
  effective: Set<RoleName>,
  visiting: Set<RoleName>,
  path: readonly RoleName[],
  unknown: UnknownRoleDisposition,
): void {
  if (effective.has(name)) return;
  if (visiting.has(name)) {
    const start = path.indexOf(name);
    throw new RoleInheritanceCycleError([...path.slice(start), name]);
  }
  const def = defs.get(name);
  if (def === undefined) {
    // A cycle still throws under BOTH dispositions, and the asymmetry is deliberate: an undeclared
    // name has a safe reading (it grants nothing) while a cycle has none -- there is no set of
    // effective roles that honours it, so answering any set would be inventing one. It is also
    // reachable only from a manifest `validateRoleGraph` would have refused, where an undeclared
    // principal role is reachable from an ordinary deployment.
    if (unknown === "skip") return;
    throw new UnknownRoleError(name);
  }
  visiting.add(name);
  for (const parent of def.inherits ?? []) {
    visitRole(parent, defs, effective, visiting, [...path, name], unknown);
  }
  visiting.delete(name);
  effective.add(name);
}

/**
 * The roles a principal effectively holds, for an authorization decision.
 *
 * **Skips** a name this manifest does not declare rather than throwing, which is a correction: it
 * threw `UnknownRoleError`, and because all seven of its request-path callers -- `rbacCheck` and the
 * five field predicates -- resolve roles *before* deciding anything, that throw reached the handler
 * and became a **500** on every entity route for any session whose role the served manifest does
 * not define.
 *
 * That is live on the shipped deployment rather than hypothetical. `--platform-admin-role
 * platform_admin` is a platform role by design and `erp-core` declares fifteen roles of which it is
 * not one, so an operator who signs in to administer tenants and then opens an entity page gets a
 * 500 with a body that names nothing and a log that says nothing. The answer owed is **403** -- an
 * undeclared role holds no grants -- and a 500 is not a stricter version of that, it is a different
 * claim: that the server failed.
 *
 * `apps/operate-server/src/node.ts` has carried a comment since ADR-0339 saying this function
 * *"throws `UnknownRoleError` for an undeclared name, **and answers false** -- fail-closed"*. Both
 * halves are in one sentence and they are incompatible; a function that throws answers nothing. The
 * comment described the behaviour this change implements, so the code now matches what it was
 * already documented to do.
 */
export function resolveEffectiveRoles(
  principal: Principal,
  roleDefinitions: ReadonlyMap<RoleName, RoleDefinition>,
): ReadonlySet<RoleName> {
  const effective = new Set<RoleName>();
  const visiting = new Set<RoleName>();

  visitRole(principal.primaryRole, roleDefinitions, effective, visiting, [], "skip");
  for (const role of principal.secondaryRoles) {
    visitRole(role, roleDefinitions, effective, visiting, [], "skip");
  }

  return effective;
}

export function validateRoleGraph(
  roleDefinitions: ReadonlyMap<RoleName, RoleDefinition>,
): void {
  const effective = new Set<RoleName>();
  const visiting = new Set<RoleName>();

  // `refuse`, because this IS the question the throw exists for: a declared role inheriting a name
  // nothing defines is a typo a reviewer should meet here rather than as a silently narrower grant.
  for (const name of roleDefinitions.keys()) {
    visitRole(name, roleDefinitions, effective, visiting, [], "refuse");
  }
}
