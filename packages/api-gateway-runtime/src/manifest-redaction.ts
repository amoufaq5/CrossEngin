import type { Entity } from "@crossengin/types/meta-schema";
import type {
  AbacBatchEvaluator,
  AbacEvaluator,
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
  type ResponseRecordShape,
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
  /**
   * The entity's classified fields **as the served table has them**, by entity name.
   *
   * Required, and deliberately with no fallback to `entity.fields` — that fallback *was* the
   * defect. A trait contributes real columns, which is why `validateManifest`, the column plan, the
   * DDL emitter and `listConfigForEntity` all read `resolvedFields` rather than `entity.fields`; so
   * an entity whose only classified field arrives from a trait carries that field in its served
   * table and not in its own list. Reading the raw list here answered "no classified fields",
   * returned `null`, and registered **no spec at all** — so every response carrying that entity's
   * records went out with the classified field in the clear. It failed *open*, and reported success.
   *
   * The gateway cannot derive the answer itself. Merging a trait's fields needs
   * `BUILT_IN_TRAIT_FIELDS`, which lives in `@crossengin/kernel`, and this package deliberately does
   * not depend on it: `RedactionManifestInput` is a structural seam declaring `entities`,
   * `permissions` and `roles` and **not** `traits`, which is the shape of the defect rather than an
   * oversight in it. So the caller that already holds the kernel's answer
   * (`resolvedClassifiedFields`) supplies it, and the compiler asks rather than a default guessing
   * — ADR-0338's rule, which this interface's sibling `operationsForEntity` already follows: a
   * default that cannot possibly be correct fails silently in the unsafe direction.
   *
   * An entity that resolves to no classified field still yields `null` and registers nothing, and
   * that is correct rather than a gap: `[]` is the resolver's **answer** — the same answer the raw
   * read used to give for a genuinely unclassified entity — and because the option is required it
   * can never be confused with nobody having looked.
   */
  readonly classifiedFieldsForEntity: (entityName: string) => readonly ClassifiedField[];
  /**
   * Discharges an ABAC obligation on a field `read` grant. One evaluator for
   * the whole manifest, not one per entity: the obligation's evaluation input
   * already carries the entity, and a per-entity resolver would let the read
   * side and the write side be given different evaluators for one grant — the
   * divergence ADR-0329 put `privilegedForClass` behind one definition to
   * prevent, and ADR-0339 found had happened anyway.
   */
  readonly abacEvaluator?: AbacEvaluator;
  /**
   * The **optional sibling** of `abacEvaluator`, never a replacement: a deployment that supplies
   * only the single evaluator gets exactly today's behaviour at exactly today's cost, and one
   * supplied here without `abacEvaluator` refuses every obligation rather than being promoted into
   * its place.
   *
   * It exists because response redaction is the one evaluator reader in the repo with a fan-out —
   * a page of N records times F obligated fields, all of them one principal's answer about one
   * entity — so a deployment whose policy layer is a network call pays N × F round trips for one
   * response. Every other seam asks about a single act, which is why none of them carries one.
   */
  readonly abacBatchEvaluator?: AbacBatchEvaluator;
}

/**
 * One operation serving an entity, and where that operation's response puts the records.
 *
 * The shape rides along with the id rather than being derivable from it: `patient.admit` is a
 * workflow transition whose id comes from the manifest and whose body is one record, and nothing
 * about the *string* says so. The caller deriving the routes knows both facts at once, so it says
 * both at once.
 */
export interface RedactedOperation {
  readonly operationId: string;
  readonly recordShape: ResponseRecordShape;
}

export interface ManifestRedactionOptions extends RedactionSpecOptions {
  /**
   * Every operation whose response can carry this entity's records — not the
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
   *
   * Since ADR-0342's field-`read` closure each entry also carries its response shape, for the same
   * reason: a shape computed here would be computed from the id, and the id does not say.
   */
  readonly operationsForEntity: (entityName: string) => readonly RedactedOperation[];
}

/**
 * An entity's spec minus the one member that is per-operation. Everything here is shared by
 * reference across that entity's operations; only `recordShape` is added per registration, which is
 * what ends ADR-0338's "one spec object for all of an entity's operations" — the honest consequence
 * of the shape being a property of the operation rather than of the entity.
 */
export type EntityRedactionSpec = Omit<ResponseRedactionSpec, "recordShape">;

/**
 * An entity resolves to a classified field and the caller's index names no
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
): EntityRedactionSpec | null {
  // The resolver and never `entity.fields`: the entity is here to be *named*, not to be measured.
  // A trait's columns are in the served table and not in that list, so reading it is exactly the
  // open failure `classifiedFieldsForEntity` exists to close.
  const classifiedFields = options.classifiedFieldsForEntity(entity.name);
  if (classifiedFields.length === 0) return null;
  const policy = options.policyForEntity?.(entity.name);
  return {
    classifiedFields,
    roles,
    rolesForPrincipal: options.rolesForPrincipal,
    ...(entityPermissions !== undefined ? { entityPermissions } : {}),
    ...(policy !== undefined ? { policy } : {}),
    // Always set, even with no evaluator: the entity is always known here, and a spec that carries
    // it is checkable. Only the evaluators are conditional.
    abac: {
      entity: entity.name,
      ...(options.abacEvaluator !== undefined ? { evaluator: options.abacEvaluator } : {}),
      ...(options.abacBatchEvaluator !== undefined
        ? { evaluateBatch: options.abacBatchEvaluator }
        : {}),
    },
  };
}

/**
 * Builds a `RedactionRegistry` from a manifest: every entity that *resolves to* a
 * classified field contributes a `ResponseRedactionSpec`, registered against
 * every operation `operationsForEntity` names for it — which the caller
 * derives from the routes it actually registered, since nothing here can know
 * them. Entities with no classified fields are skipped; an entity that has them
 * and no operation is a `RedactionCoverageError` rather than a silent omission.
 *
 * "Resolves to" is load-bearing and is the one thing `manifest.entities` cannot answer: the
 * classification set comes from `classifiedFieldsForEntity`, because a trait-contributed column is
 * served and is not in `entity.fields`.
 *
 * One spec per operation now, because `recordShape` is per operation; the shared members stay
 * shared by reference, so the per-operation object is a spread of one base and a string.
 */
export function redactionRegistryFromManifest(
  manifest: RedactionManifestInput,
  options: ManifestRedactionOptions,
): MapRedactionRegistry {
  const registry = new MapRedactionRegistry();
  const roles = rolesMapOf(manifest.roles);

  for (const entity of manifest.entities ?? []) {
    const base = redactionSpecForEntity(
      entity,
      roles,
      options,
      manifest.permissions?.[entity.name],
    );
    if (base === null) continue;
    const operations = options.operationsForEntity(entity.name);
    if (operations.length === 0) throw new RedactionCoverageError(entity.name);
    for (const operation of operations) {
      registry.register(operation.operationId, { ...base, recordShape: operation.recordShape });
    }
  }

  return registry;
}
