import {
  computeClassifiedFieldRedaction,
  type AbacEnforcement,
  type ClassifiedField,
  type EntityPermissions,
  type Principal,
  type RoleDefinition,
  type RoleName,
  type SensitiveFieldPolicy,
} from "@crossengin/auth";
import { principalAbacAttributes, type ResolvedPrincipal } from "@crossengin/api-gateway";

export interface PrincipalRoles {
  readonly primaryRole: RoleName;
  readonly secondaryRoles?: readonly RoleName[];
}

export interface ResponseRedactionSpec {
  readonly classifiedFields: readonly ClassifiedField[];
  readonly roles: ReadonlyMap<RoleName, RoleDefinition>;
  readonly rolesForPrincipal: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  readonly entityPermissions?: EntityPermissions;
  readonly policy?: SensitiveFieldPolicy;
  /**
   * The entity the spec is about, plus the evaluator that discharges an ABAC
   * obligation on one of its field grants. Absent — or present with no
   * evaluator — leaves an obligated field redacted, which is the same answer:
   * omitting this is a caller with no evaluator, never a caller opting out of
   * the obligation.
   */
  readonly abac?: AbacEnforcement;
}

export interface RedactionRegistry {
  specFor(operationId: string): ResponseRedactionSpec | null;
}

export class MapRedactionRegistry implements RedactionRegistry {
  private readonly specs: Map<string, ResponseRedactionSpec> = new Map();

  register(operationId: string, spec: ResponseRedactionSpec): this {
    this.specs.set(operationId, spec);
    return this;
  }

  specFor(operationId: string): ResponseRedactionSpec | null {
    return this.specs.get(operationId) ?? null;
  }
}

const UNPRIVILEGED_ROLE = "__unprivileged__";

/**
 * Fail-closed: a role the spec's `roles` map doesn't know (anonymous,
 * a stale token role, a typo) is mapped to an unprivileged sentinel rather
 * than throwing, so an unrecognized principal sees the most-redacted view.
 */
export function computeRedactedFields(
  spec: ResponseRedactionSpec,
  principal: ResolvedPrincipal | null,
): readonly string[] {
  const { primaryRole, secondaryRoles } = spec.rolesForPrincipal(principal);
  const requested = [primaryRole, ...(secondaryRoles ?? [])];
  const safeRoles = new Map(spec.roles);
  if (!safeRoles.has(UNPRIVILEGED_ROLE)) {
    safeRoles.set(UNPRIVILEGED_ROLE, { name: UNPRIVILEGED_ROLE });
  }
  const mapped = requested.map((r) => (spec.roles.has(r) ? r : UNPRIVILEGED_ROLE));
  const authPrincipal: Principal = {
    kind: "user",
    tenantId: (principal?.tenantId ?? "") as Principal["tenantId"],
    userId: (principal?.principalId ?? null) as Principal["userId"],
    primaryRole: mapped[0] ?? UNPRIVILEGED_ROLE,
    secondaryRoles: mapped.slice(1),
    // Resolved in the auth stage. `null` means no directory was consulted, which keeps an obligated
    // field redacted rather than letting a policy be answered from attributes nobody gathered.
    abacAttributes: principalAbacAttributes(principal),
    mfaProofAgeSeconds: principal?.mfaProofAgeSeconds ?? null,
  };
  return computeClassifiedFieldRedaction(
    authPrincipal,
    spec.entityPermissions ?? {},
    safeRoles,
    spec.classifiedFields,
    spec.policy,
    spec.abac,
  ).redacted;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Removes the named fields wherever they appear in a JSON value (records,
 * arrays, and `{data: [...]}`-style wrappers are all handled by walking the
 * tree). A redacted field is dropped entirely rather than nulled.
 */
export function redactJsonValue(value: unknown, redacted: ReadonlySet<string>): unknown {
  if (redacted.size === 0) return value;
  if (Array.isArray(value)) {
    return value.map((v) => redactJsonValue(v, redacted));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (redacted.has(k)) continue;
      out[k] = redactJsonValue(v, redacted);
    }
    return out;
  }
  return value;
}
