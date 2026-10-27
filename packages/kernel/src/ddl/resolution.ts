import {
  classifiedFields,
  type ClassifiedField,
  type Entity,
  type Field,
  type Trait,
} from "@crossengin/types/meta-schema";
import { BUILT_IN_TRAIT_FIELDS } from "./built-in-traits.js";
import { columnNameForField } from "./column.js";
import { FieldNameCollisionError, ReservedFieldNameError, UnknownTraitError } from "./errors.js";

export function expandTraits(entity: Entity, customTraits: readonly Trait[]): readonly Field[] {
  if (!entity.traits || entity.traits.length === 0) return [];

  const customByName = new Map(customTraits.map((t) => [t.name, t]));
  const result: Field[] = [];
  const seen = new Set<string>();

  for (const traitName of entity.traits) {
    const builtin = BUILT_IN_TRAIT_FIELDS.get(traitName);
    const traitFields = builtin ?? customByName.get(traitName)?.fields ?? null;

    if (traitFields === null) {
      throw new UnknownTraitError(traitName);
    }

    for (const field of traitFields) {
      if (seen.has(field.name)) {
        throw new FieldNameCollisionError(
          entity.name,
          field.name,
          `appears in multiple traits applied to entity`,
        );
      }
      seen.add(field.name);
      result.push(field);
    }
  }

  return result;
}

/**
 * Every domain field an entity resolves to: its own fields, then whatever its traits
 * contribute. This is the one answer to "which fields of this entity become columns?",
 * shared by `validateManifest`'s reference checks and by the serving store's column plan,
 * so validation cannot say a field exists that the served table has no column for.
 *
 * The implicit `id` primary key is *not* included — it is a system column the store types
 * for itself (TEXT, paired with `tenant_id` in the primary key), so it is not a domain
 * field. `resolvedFieldNames` adds it, since for an existence question it plainly exists.
 *
 * Unlike `expandTraits` this tolerates a name supplied twice: the first wins. Rejecting a
 * genuine collision belongs to `checkEntityFieldNames`, not to an existence check.
 */
export function resolvedFields(entity: Entity, customTraits: readonly Trait[]): readonly Field[] {
  const customByName = new Map(customTraits.map((t) => [t.name, t]));
  const out: Field[] = [];
  const seen = new Set<string>();
  const add = (field: Field): void => {
    if (seen.has(field.name)) return;
    seen.add(field.name);
    out.push(field);
  };
  for (const field of entity.fields) add(field);
  for (const traitName of entity.traits ?? []) {
    const traitFields = BUILT_IN_TRAIT_FIELDS.get(traitName) ?? customByName.get(traitName)?.fields;
    for (const field of traitFields ?? []) add(field);
  }
  return out;
}

/**
 * Every field name an entity resolves to, as the emitted table has them: the implicit `id`
 * primary key plus every domain field from `resolvedFields`.
 *
 * This is the one answer to "does this entity have that field?", shared by every reference
 * check in `validateManifest` — relations, permissions, views and search — so they cannot
 * disagree about what exists.
 */
export function resolvedFieldNames(
  entity: Entity,
  customTraits: readonly Trait[],
): ReadonlySet<string> {
  const names = new Set<string>(["id"]);
  for (const field of resolvedFields(entity, customTraits)) names.add(field.name);
  return names;
}

/**
 * Which of an entity's fields are classified, **as the served table has them**: its own fields and
 * whatever its traits contribute.
 *
 * This is the one answer to that question, for the reason `resolvedFields` is the one answer to
 * "which fields become columns?" — so what a role may read, what it may write, which column is
 * encrypted at rest, which value may ride in a cursor and which field a boot survey counts are all
 * derived from one resolution and cannot disagree about what is classified.
 *
 * It exists because five call sites were spelling it by hand as
 * `classifiedFields([...resolvedFields(entity, traits)])` while three read `entity.fields`
 * directly, and the three were invisible precisely because `classifiedFields` used to take an
 * entity: the narrow answer needed no workaround and the wide one did. A trait-contributed
 * classified field was therefore served unredacted and writable by anybody, while the boot surveys
 * reported it as classified — two readings of one declaration, disagreeing, with the safe one in
 * the minority.
 */
export function resolvedClassifiedFields(
  entity: Entity,
  customTraits: readonly Trait[],
): readonly ClassifiedField[] {
  return classifiedFields(resolvedFields(entity, customTraits));
}

/**
 * Field names the emitted table already has, which a declaration may therefore not use.
 *
 * One spelling, because `validateManifest` refuses these in a *manifest* and this module refuses
 * them in a *resolution*, and two literals would eventually disagree about which names the store
 * claims.
 *
 * **`emitEntityTableDdl` writes four columns of its own and the set holds two of them**, which is a
 * measurement rather than a preference. `id` and `tenant_id` are **duplicated** — the emitted
 * `CREATE TABLE` carries `"id" TEXT NOT NULL` beside `"id" TEXT`, three `"id"` tokens in one
 * statement, and Postgres answers `42701 column "id" specified more than once`, so the manifest
 * parses, validates, hashes and cannot be served at all. The first version of this comment said
 * `tenant_id` was "refused earlier as a reserved prefix", and there is **no such refusal**: driven
 * through `validateManifest` itself, `tenant_id` was accepted and emitted the same duplicate, so
 * the sentence justifying a one-member set was the only thing keeping it at one.
 *
 * `created_at` and `updated_at` are **not** here and must not be, because `BUILT_IN_TRAIT_FIELDS`'
 * `auditable` supplies exactly those two names — which is *why* the emitter **overrides** rather
 * than duplicating them. That override is its own defect and a quieter one (a declared
 * `created_at: text` replaces `TIMESTAMPTZ NOT NULL DEFAULT …`, so the table serves and the audit
 * stamp becomes a caller-supplied column), and a name refusal is the wrong instrument for it: an
 * own field colliding with a trait-supplied one is already refused, so the uncovered case is an own
 * `created_at` on an entity *without* `auditable`, where what is wrong is the **type**. Register
 * P2.12c.
 */
export const RESERVED_ENTITY_FIELD_NAMES: readonly string[] = ["id", "tenant_id"];

/**
 * Refuses an **own** field that is reserved or collides with one a trait supplies.
 *
 * The `traitFields` argument is what keeps provenance: the reserved-name test runs over
 * `entity.fields` alone, so a trait-contributed field is never read as an own declaration. That is
 * load-bearing rather than incidental — a caller that pre-expanded an entity into
 * `{...entity, traits: [], fields: [...own, ...trait]}` to get the old side of a diff resolved
 * against its own traits made this function throw `ReservedFieldNameError` for a trait supplying
 * `id`, on a manifest `ManifestSchema` parses. `DiffContext.oldCustomTraits` exists so no caller
 * has to fabricate that entity.
 *
 * A trait field that is itself reserved is `validateManifest`'s to refuse, not this function's:
 * here there is no trait to name in the error and no index to point at, and the same trait reaches
 * every entity carrying it.
 */
export function checkEntityFieldNames(entity: Entity, traitFields: readonly Field[]): void {
  const traitNames = new Set(traitFields.map((f) => f.name));
  for (const field of entity.fields) {
    if (RESERVED_ENTITY_FIELD_NAMES.includes(field.name)) {
      throw new ReservedFieldNameError(entity.name, field.name);
    }
    if (traitNames.has(field.name)) {
      throw new FieldNameCollisionError(
        entity.name,
        field.name,
        `collides with a trait-supplied field`,
      );
    }
  }
}

export function buildColumnNameMap(fields: readonly Field[]): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const field of fields) {
    map.set(field.name, columnNameForField(field));
  }
  return map;
}

export interface ResolvedIndex {
  readonly columns: readonly string[];
  readonly kind?: "btree" | "gin" | "gist";
  readonly unique?: boolean;
}

export function computeResolvedIndexes(
  entity: Entity,
  customTraits: readonly Trait[],
): readonly ResolvedIndex[] {
  const traitFields = expandTraits(entity, customTraits);
  const allFields: readonly Field[] = [...entity.fields, ...traitFields];
  const columnMap = buildColumnNameMap(allFields);

  const results: ResolvedIndex[] = [];

  for (const field of allFields) {
    const columnName = columnMap.get(field.name) ?? field.name;
    if (field.type.kind === "reference") {
      results.push({ columns: [columnName] });
      continue;
    }
    if (field.type.kind === "enum") {
      results.push({ columns: [columnName] });
      continue;
    }
    if (field.indexed === true) {
      results.push({ columns: [columnName] });
      continue;
    }
    if (typeof field.indexed === "object" && field.indexed !== null) {
      results.push({ columns: [columnName], kind: field.indexed.kind });
    }
  }

  if (entity.indexes) {
    for (const idx of entity.indexes) {
      const cols = idx.fields.map((f) => columnMap.get(f) ?? f);
      const resolved: ResolvedIndex = {
        columns: cols,
        ...(idx.kind !== undefined ? { kind: idx.kind } : {}),
        ...(idx.unique !== undefined ? { unique: idx.unique } : {}),
      };
      results.push(resolved);
    }
  }

  return results;
}
