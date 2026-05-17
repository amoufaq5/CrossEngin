import { resolveEffectiveRoles } from "./roles.js";
import type {
  EntityPermissions,
  FieldRedactionResult,
  Principal,
  RoleDefinition,
  RoleName,
  WriteMaskResult,
} from "./types.js";

export function computeFieldRedaction(
  principal: Principal,
  entityPerms: EntityPermissions,
  roles: ReadonlyMap<RoleName, RoleDefinition>,
  fieldNames: readonly string[],
): FieldRedactionResult {
  const effective = resolveEffectiveRoles(principal, roles);
  const fields = entityPerms.fields;
  const readable: string[] = [];
  const redacted: string[] = [];

  for (const name of fieldNames) {
    const rule = fields?.[name]?.read;
    if (rule === undefined) {
      readable.push(name);
      continue;
    }
    if (rule.roles.some((r) => effective.has(r))) {
      readable.push(name);
    } else {
      redacted.push(name);
    }
  }

  return { readable, redacted };
}

export function validateWriteMask(
  principal: Principal,
  entityPerms: EntityPermissions,
  roles: ReadonlyMap<RoleName, RoleDefinition>,
  patchFields: readonly string[],
): WriteMaskResult {
  const effective = resolveEffectiveRoles(principal, roles);
  const fields = entityPerms.fields;

  for (const name of patchFields) {
    const rule = fields?.[name]?.update;
    if (rule === undefined) continue;
    if (!rule.roles.some((r) => effective.has(r))) {
      return { ok: false, rejectedField: name };
    }
  }

  return { ok: true };
}
