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
  /**
   * Roles privileged for **every** sensitive class. Its meaning is unchanged, deliberately: a
   * deployment that grants `--audit-read-sensitive-role` today reads pii *and* phi, and narrowing
   * this field would silently revoke access it already has.
   */
  readonly privilegedRoles?: readonly RoleName[];
  /**
   * Per-class grants, which `privilegedRoles` cannot express (ADR-0329).
   *
   * The gap: a support role that should read a customer's `pii` and never a patient's `phi` had no
   * way to say so — the grant was wholesale, so a deployment either exposed every class to that role
   * or redacted every class from it, and the second is what a HIPAA deployment is forced into.
   *
   * **A class with an entry here is authoritative for that class**, and `privilegedRoles` applies
   * only to classes with no entry. That is what makes the narrowing possible at all: read as a union
   * instead, a wholesale grantee could never be withheld from `phi`, which is the whole point. So
   * `{phi: []}` withholds phi from everyone including a wholesale grantee, and an empty array is a
   * refusal rather than "fall through" — the fail-closed reading of an explicit empty list.
   */
  readonly privilegedRolesByClass?: Readonly<
    Partial<Record<DataClassification, readonly RoleName[]>>
  >;
  readonly redactByDefault?: (classification: DataClassification) => boolean;
}

/**
 * Whether the principal's effective roles may read a value of this class.
 *
 * One function, two callers (read redaction and the write mask), so the per-class rule cannot
 * diverge between what a role may see and what it may change.
 */
function privilegedForClass(
  policy: SensitiveFieldPolicy,
  effective: ReadonlySet<RoleName>,
  classification: DataClassification,
): boolean {
  const perClass = policy.privilegedRolesByClass?.[classification];
  const granted = perClass ?? policy.privilegedRoles ?? [];
  return granted.some((r) => effective.has(r));
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
      // Asked per class, not once per principal: a role may be privileged for `pii` and not for
      // `phi`, and a single `hasPrivilege` computed outside the loop could not express that.
      if (privilegedForClass(policy, effective, field.classification)) readable.push(field.name);
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
      // The same per-class question the read path asks, through the same function, so a role cannot
      // end up able to *write* a class it may not read (ADR-0329).
      !privilegedForClass(policy, effective, field.classification)
    ) {
      return { ok: false, rejectedField: field.name };
    }
  }

  return { ok: true };
}
