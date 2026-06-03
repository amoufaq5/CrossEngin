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

export interface ManifestRedactionOptions {
  readonly rolesForPrincipal: (principal: ResolvedPrincipal | null) => PrincipalRoles;
  readonly operationsForEntity?: (entityName: string) => readonly string[];
  readonly policyForEntity?: (entityName: string) => SensitiveFieldPolicy | undefined;
}

function defaultOperationsForEntity(entityName: string): readonly string[] {
  const lower = entityName.toLowerCase();
  return [`${lower}.read`, `${lower}.list`, `${lower}.get`];
}

function rolesMapOf(
  roles: Readonly<Record<string, RoleDefinition>> | undefined,
): ReadonlyMap<RoleName, RoleDefinition> {
  return new Map(Object.entries(roles ?? {}));
}

export function redactionSpecForEntity(
  entity: Entity,
  roles: ReadonlyMap<RoleName, RoleDefinition>,
  options: ManifestRedactionOptions,
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
 * the operationIds that serve that entity's reads (default convention
 * `<entity>.read|list|get`, overridable via `operationsForEntity`). Entities
 * with no classified fields are skipped.
 */
export function redactionRegistryFromManifest(
  manifest: RedactionManifestInput,
  options: ManifestRedactionOptions,
): MapRedactionRegistry {
  const registry = new MapRedactionRegistry();
  const roles = rolesMapOf(manifest.roles);
  const operationsForEntity = options.operationsForEntity ?? defaultOperationsForEntity;

  for (const entity of manifest.entities ?? []) {
    const spec = redactionSpecForEntity(
      entity,
      roles,
      options,
      manifest.permissions?.[entity.name],
    );
    if (spec === null) continue;
    for (const operationId of operationsForEntity(entity.name)) {
      registry.register(operationId, spec);
    }
  }

  return registry;
}
