import {
  isSensitiveDataClass,
  type DataClassification,
} from "@crossengin/types/meta-schema";
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

export interface ClassifiedField {
  readonly name: string;
  readonly classification?: DataClassification;
}

export interface SensitiveFieldPolicy {
  readonly privilegedRoles?: readonly RoleName[];
  readonly redactByDefault?: (classification: DataClassification) => boolean;
}

function defaultRedacts(policy: SensitiveFieldPolicy, c: DataClassification): boolean {
  return policy.redactByDefault !== undefined
    ? policy.redactByDefault(c)
    : isSensitiveDataClass(c);
}

/**
 * Like {@link computeFieldRedaction} but classification-aware: a sensitive
 * field (pii/phi/regulated/commercial_sensitive by default) with no explicit
 * `read` grant defaults to redacted unless the principal holds a privileged
 * role. Explicit per-field `read` rules still win.
 */
export function computeClassifiedFieldRedaction(
  principal: Principal,
  entityPerms: EntityPermissions,
  roles: ReadonlyMap<RoleName, RoleDefinition>,
  fields: readonly ClassifiedField[],
  policy: SensitiveFieldPolicy = {},
): FieldRedactionResult {
  const effective = resolveEffectiveRoles(principal, roles);
  const fieldPerms = entityPerms.fields;
  const privileged = new Set(policy.privilegedRoles ?? []);
  const hasPrivilege = [...privileged].some((r) => effective.has(r));
  const readable: string[] = [];
  const redacted: string[] = [];

  for (const field of fields) {
    const rule = fieldPerms?.[field.name]?.read;
    if (rule !== undefined) {
      if (rule.roles.some((r) => effective.has(r))) readable.push(field.name);
      else redacted.push(field.name);
      continue;
    }
    if (field.classification !== undefined && defaultRedacts(policy, field.classification)) {
      if (hasPrivilege) readable.push(field.name);
      else redacted.push(field.name);
      continue;
    }
    readable.push(field.name);
  }

  return { readable, redacted };
}

/**
 * Write-mask that additionally defaults sensitive fields (no explicit
 * `update` grant) to writable only by a privileged role. Explicit `update`
 * rules still win.
 */
export function validateClassifiedWriteMask(
  principal: Principal,
  entityPerms: EntityPermissions,
  roles: ReadonlyMap<RoleName, RoleDefinition>,
  patchFields: readonly ClassifiedField[],
  policy: SensitiveFieldPolicy = {},
): WriteMaskResult {
  const effective = resolveEffectiveRoles(principal, roles);
  const fieldPerms = entityPerms.fields;
  const privileged = new Set(policy.privilegedRoles ?? []);
  const hasPrivilege = [...privileged].some((r) => effective.has(r));

  for (const field of patchFields) {
    const rule = fieldPerms?.[field.name]?.update;
    if (rule !== undefined) {
      if (!rule.roles.some((r) => effective.has(r))) {
        return { ok: false, rejectedField: field.name };
      }
      continue;
    }
    if (
      field.classification !== undefined &&
      defaultRedacts(policy, field.classification) &&
      !hasPrivilege
    ) {
      return { ok: false, rejectedField: field.name };
    }
  }

  return { ok: true };
}
