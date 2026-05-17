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
