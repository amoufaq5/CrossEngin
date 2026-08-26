import type { Entity, Field, Trait } from "@crossengin/types/meta-schema";
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

export function checkEntityFieldNames(entity: Entity, traitFields: readonly Field[]): void {
  const traitNames = new Set(traitFields.map((f) => f.name));
  for (const field of entity.fields) {
    if (field.name === "id") {
      throw new ReservedFieldNameError(entity.name, "id");
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
