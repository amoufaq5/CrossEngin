import {
  computeClassifiedFieldRedaction,
  validateClassifiedWriteMask,
  type ClassifiedField,
  type EntityPermissions,
  type Principal,
  type RoleDefinition,
  type RoleName,
  type SensitiveFieldPolicy,
} from "@crossengin/auth";
import type { Manifest } from "@crossengin/kernel/manifest";
import type { Entity } from "@crossengin/types/meta-schema";

/** The viewer the models are compiled for: the set of roles it holds. */
export interface ViewerContext {
  readonly roles: readonly string[];
}

export interface CompileOptions {
  /** Resolves a per-entity sensitive-field policy (e.g. privileged roles). */
  readonly policyForEntity?: (entity: string) => SensitiveFieldPolicy | undefined;
}

/**
 * The resolved field-access decision the compiler reads when including / marking
 * a field. `read=false` drops the field from every model; `write=false` marks it
 * read-only in a form.
 */
export interface FieldAccess {
  readonly read: boolean;
  readonly write: boolean;
}

const PLACEHOLDER_TENANT = "00000000-0000-4000-8000-000000000000";
const ANONYMOUS_ROLE = "__anonymous__";

/**
 * Resolves field-level access for one entity against a manifest + a viewer. It
 * bridges the viewer's role list to an auth `Principal` (the first role is
 * primary, the rest secondary) and reuses the classification-aware redaction +
 * write-mask helpers, so the web layer never reimplements the classification
 * rules. Roles not declared in the manifest are dropped before the bridge so an
 * unknown role can never throw — it simply yields no grants (fail-closed).
 */
export class EntityFieldResolver {
  private readonly perms: EntityPermissions;
  private readonly roleDefs: ReadonlyMap<RoleName, RoleDefinition>;
  private readonly principal: Principal;
  private readonly policy: SensitiveFieldPolicy | undefined;

  constructor(
    manifest: Manifest,
    entityName: string,
    viewer: ViewerContext,
    options: CompileOptions = {},
  ) {
    this.perms = manifest.permissions?.[entityName] ?? {};
    const roleDefs = new Map<RoleName, RoleDefinition>(Object.entries(manifest.roles ?? {}));
    // Register the fail-closed sentinel so `resolveEffectiveRoles` never throws
    // on it: it inherits nothing, so it carries no grants.
    roleDefs.set(ANONYMOUS_ROLE, { name: ANONYMOUS_ROLE });
    this.roleDefs = roleDefs;
    this.policy = options.policyForEntity?.(entityName);
    this.principal = buildPrincipal(viewer.roles, this.roleDefs);
  }

  /**
   * Resolves access for the given fields in one pass. A field with no `read`
   * grant and no sensitive classification is readable; a sensitive field with no
   * explicit grant defaults to redacted unless the viewer holds a privileged
   * role.
   */
  resolve(fields: readonly ClassifiedField[]): ReadonlyMap<string, FieldAccess> {
    const redaction = computeClassifiedFieldRedaction(
      this.principal,
      this.perms,
      this.roleDefs,
      fields,
      this.policy ?? {},
    );
    const readable = new Set(redaction.readable);
    const out = new Map<string, FieldAccess>();
    for (const field of fields) {
      const read = readable.has(field.name);
      const write = read && this.canWrite(field);
      out.set(field.name, { read, write });
    }
    return out;
  }

  private canWrite(field: ClassifiedField): boolean {
    const mask = validateClassifiedWriteMask(
      this.principal,
      this.perms,
      this.roleDefs,
      [field],
      this.policy ?? {},
    );
    return mask.ok;
  }
}

/**
 * Builds an auth `Principal` from a viewer's role list, keeping only roles the
 * manifest declares (so `resolveEffectiveRoles` never throws `UnknownRoleError`
 * on an arbitrary caller role). With no known role, the principal carries a
 * sentinel `anonymous` primary that holds no grants — fail-closed.
 */
function buildPrincipal(
  roles: readonly string[],
  roleDefs: ReadonlyMap<RoleName, RoleDefinition>,
): Principal {
  const known = roles.filter((r) => roleDefs.has(r) && r !== ANONYMOUS_ROLE);
  const [primary, ...secondary] = known.length > 0 ? known : [ANONYMOUS_ROLE];
  return {
    kind: "user",
    tenantId: PLACEHOLDER_TENANT as Principal["tenantId"],
    userId: null,
    primaryRole: primary ?? ANONYMOUS_ROLE,
    secondaryRoles: secondary,
    abacAttributes: {},
    mfaProofAgeSeconds: null,
  };
}

/** The classified-field list for an entity (field name + optional classification). */
export function entityFields(entity: Entity): readonly ClassifiedField[] {
  return entity.fields.map((f) =>
    f.classification !== undefined
      ? { name: f.name, classification: f.classification }
      : { name: f.name },
  );
}

/**
 * Redacts an entity record to only the fields a viewer can read (the same access
 * the compiled models expose), so a data page sent to a frontend never carries a
 * hidden field. `id` is always kept so a row stays identifiable.
 */
export function redactRecord(
  record: Readonly<Record<string, unknown>>,
  access: ReadonlyMap<string, FieldAccess>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if ("id" in record) out["id"] = record["id"];
  for (const [key, value] of Object.entries(record)) {
    if (key === "id") continue;
    const a = access.get(key);
    if (a === undefined || a.read) out[key] = value;
  }
  return out;
}
