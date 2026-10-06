import { entityClassifiedFields, type Entity } from "@crossengin/types/meta-schema";
import type {
  ClassifiedField,
  EntityPermissions,
  RoleDefinition,
  RoleName,
  SensitiveFieldPolicy,
} from "@crossengin/auth";
import type { ResolvedPrincipal } from "@crossengin/api-gateway";
import {
  MapRedactionRegistry,
  type PrincipalRoles,
  type ResponseRedactionSpec,
} from "./redaction.js";

/**
 * The subset of a kernel `Manifest` the redaction builder reads. A full
 * `Manifest` is assignable to this, so `redactionRegistryFromManifest(manifest, …)`
 * works without `api-gateway-runtime` depending on `@crossengin/kernel`.
 */
export interface RedactionManifestInput {
  readonly entities?: readonly Entity[];
  readonly permissions?: Readonly<Record<string, EntityPermissions>>;
  readonly roles?: Readonly<Record<string, RoleDefinition>>;
}

/** What composing one entity's spec needs — no operation mapping is involved. */
export interface RedactionSpecOptions {
  readonly rolesForPrincipal: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  readonly policyForEntity?: (entityName: string) => SensitiveFieldPolicy | undefined;
}

export interface ManifestRedactionOptions extends RedactionSpecOptions {
  /**
   * Every operationId whose response can carry this entity's records — not the
   * read ones, all of them. Required, and deliberately with no default: the
   * operationIds of an entity's lifecycle transitions come out of the
   * *manifest's workflows*, so a `(entityName: string) => string[]` computed
   * from the name alone structurally cannot name them. Any default here is
   * therefore a mapping that is wrong for exactly the write operations whose
   * responses carry the record, and wrong *silently* — the registry looks
   * populated and the gateway redacts nothing on create, update, delete or any
   * transition. The one that used to live here was wrong twice over on top of
   * that (`<entity>.get` matched no derived operation, and it lower-cased where
   * the real id camel-cases, so a multi-word entity matched nothing at all),
   * because nothing ever compared it against the ids route derivation emits.
   * So the caller that derives the routes supplies the index; fail closed means
   * demanding the answer rather than guessing half of it.
   */
  readonly operationsForEntity: (entityName: string) => readonly string[];
}

/**
 * An entity declares a classified field and the caller's index names no
 * operation for it — so the spec has nowhere to be registered and every
 * response carrying that entity's records would go out unredacted. A refusal,
 * because the alternative is a server that serves PHI in the clear and reports
 * success; the message names the entity so the wiring bug is fixable.
 */
export class RedactionCoverageError extends Error {
  constructor(readonly entity: string) {
    super(`${entity}: declares classified fields but no operationId serves it, so no redaction spec could be registered`);
    this.name = "RedactionCoverageError";
  }
}

function rolesMapOf(
  roles: Readonly<Record<string, RoleDefinition>> | undefined,
): ReadonlyMap<RoleName, RoleDefinition> {
  return new Map(Object.entries(roles ?? {}));
}

export function redactionSpecForEntity(
  entity: Entity,
  roles: ReadonlyMap<RoleName, RoleDefinition>,
  options: RedactionSpecOptions,
  entityPermissions?: EntityPermissions,
): ResponseRedactionSpec | null {
  const classified = entityClassifiedFields(entity);
  if (classified.length === 0) return null;
  const classifiedFields: ClassifiedField[] = classified.map((c) => ({
    name: c.field,
    classification: c.classification,
  }));
  const policy = options.policyForEntity?.(entity.name);
  return {
    classifiedFields,
    roles,
    rolesForPrincipal: options.rolesForPrincipal,
    ...(entityPermissions !== undefined ? { entityPermissions } : {}),
    ...(policy !== undefined ? { policy } : {}),
  };
}

/**
 * Builds a `RedactionRegistry` from a manifest: every entity that declares a
 * classified field contributes a `ResponseRedactionSpec`, registered against
 * every operationId `operationsForEntity` names for it — which the caller
 * derives from the routes it actually registered, since nothing here can know
 * them. Entities with no classified fields are skipped; an entity that has them
 * and no operation is a `RedactionCoverageError` rather than a silent omission.
 */
export function redactionRegistryFromManifest(
  manifest: RedactionManifestInput,
  options: ManifestRedactionOptions,
): MapRedactionRegistry {
  const registry = new MapRedactionRegistry();
  const roles = rolesMapOf(manifest.roles);

  for (const entity of manifest.entities ?? []) {
    const spec = redactionSpecForEntity(
      entity,
      roles,
      options,
      manifest.permissions?.[entity.name],
    );
    if (spec === null) continue;
    const operationIds = options.operationsForEntity(entity.name);
    if (operationIds.length === 0) throw new RedactionCoverageError(entity.name);
    for (const operationId of operationIds) {
      registry.register(operationId, spec);
    }
  }

  return registry;
}
