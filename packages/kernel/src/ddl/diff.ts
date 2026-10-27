import type { DefaultValue, Entity, Field, Trait } from "@crossengin/types/meta-schema";
import { columnNameForField } from "./column.js";
import { EntityRenameNotSupportedError, UnsupportedDiffChangeError } from "./errors.js";
import { fieldTypeToPostgresType } from "./field-type.js";
import { toTableName } from "./identifiers.js";
import {
  buildColumnNameMap,
  checkEntityFieldNames,
  computeResolvedIndexes,
  expandTraits,
  type ResolvedIndex,
} from "./resolution.js";

export interface FieldModification {
  readonly name: string;
  readonly columnName: string;
  readonly typeChange?: { readonly from: string; readonly to: string };
  readonly nullabilityChange?: { readonly from: boolean; readonly to: boolean };
  readonly defaultChange?: {
    readonly from: DefaultValue | undefined;
    readonly to: DefaultValue | undefined;
  };
}

export interface EntityDiff {
  readonly tableName: string;
  readonly addedFields: readonly Field[];
  readonly removedFields: readonly string[];
  readonly modifiedFields: readonly FieldModification[];
  readonly addedIndexes: readonly ResolvedIndex[];
  readonly removedIndexes: readonly ResolvedIndex[];
  readonly destructive: boolean;
}

/**
 * Which trait definitions each side resolves against — **both or neither**, never one.
 *
 * `oldCustomTraits` exists because a trait whose field changed type, or that the new manifest's
 * trait no longer declares, used to resolve the old entity against the *new* definition: both
 * sides came back identical and the diff reported nothing while the served table genuinely gains,
 * loses or retypes that column. Two lists rather than a caller pre-expanding the old entity into a
 * fabricated `{...entity, traits: [], fields: [...own, ...trait]}` — this function already has a
 * mechanism for *which traits apply* and applying one list to both sides was the whole defect, so
 * giving it two is the direct fix, and it keeps trait provenance, which the fabricated entity
 * destroyed. That mattered: with trait fields merged into `fields`, the `checkEntityFieldNames`
 * call below read a trait-contributed field as an own field and threw `ReservedFieldNameError`
 * for a trait supplying `id` — a manifest `ManifestSchema` parses.
 *
 * The **union is the fence**, and it replaced `oldCustomTraits?: readonly Trait[]` defaulting to
 * `customTraits`. That default was the pre-fix behaviour kept as what silence buys, so a caller
 * supplying one list and forgetting the other got the original defect back with the type valid —
 * ADR-0386's shape, where an optional field with a safe-looking default makes its own omission
 * unobservable, in the increment that fixed the defect. There is no honest default either:
 * `customTraits` restores the bug and `[]` makes every trait field read as *added*, so the
 * compiler asks instead (ADR-0338). It costs nothing to ask — the diff's own suite passes no
 * context at all, which the first member admits, and `computeManifestDiff` is the one live caller
 * and holds two manifests by construction.
 */
export type DiffContext =
  | {
      /** No custom trait anywhere, so both entities resolve against the built-ins alone. */
      readonly customTraits?: undefined;
      readonly oldCustomTraits?: undefined;
    }
  | {
      readonly customTraits: readonly Trait[];
      /** The trait definitions the **old** entity resolves against. */
      readonly oldCustomTraits: readonly Trait[];
    };

export function computeEntityDiff(
  old: Entity,
  next: Entity,
  context: DiffContext = {},
): EntityDiff {
  if (old.name !== next.name) {
    throw new EntityRenameNotSupportedError(old.name, next.name);
  }

  // Both `?? []`, which is the union's whole point: a context supplying one list and not the other
  // is a compile error, so there is no asymmetric fallback left for a caller to inherit.
  const customTraits = context.customTraits ?? [];
  const oldCustomTraits = context.oldCustomTraits ?? [];

  const oldTraitFields = expandTraits(old, oldCustomTraits);
  checkEntityFieldNames(old, oldTraitFields);
  const newTraitFields = expandTraits(next, customTraits);
  checkEntityFieldNames(next, newTraitFields);

  const oldAllFields: readonly Field[] = [...old.fields, ...oldTraitFields];
  const newAllFields: readonly Field[] = [...next.fields, ...newTraitFields];

  const oldByName = new Map(oldAllFields.map((f) => [f.name, f]));
  const newByName = new Map(newAllFields.map((f) => [f.name, f]));

  const oldColumnMap = buildColumnNameMap(oldAllFields);

  const addedFields: Field[] = [];
  const removedFields: string[] = [];
  const modifiedFields: FieldModification[] = [];

  for (const [name, newField] of newByName) {
    const oldField = oldByName.get(name);
    if (oldField === undefined) {
      addedFields.push(newField);
      continue;
    }
    const mod = computeFieldModification(next.name, oldField, newField);
    if (mod !== null) {
      modifiedFields.push(mod);
    }
  }

  for (const [name] of oldByName) {
    if (!newByName.has(name)) {
      removedFields.push(oldColumnMap.get(name) ?? name);
    }
  }

  const oldIndexes = computeResolvedIndexes(old, oldCustomTraits);
  const newIndexes = computeResolvedIndexes(next, customTraits);
  const addedIndexes = newIndexes.filter((idx) => !indexesContain(oldIndexes, idx));
  const removedIndexes = oldIndexes.filter((idx) => !indexesContain(newIndexes, idx));

  const destructive = removedFields.length > 0;

  return {
    tableName: toTableName(old.name),
    addedFields,
    removedFields,
    modifiedFields,
    addedIndexes,
    removedIndexes,
    destructive,
  };
}

function computeFieldModification(
  entityName: string,
  oldField: Field,
  newField: Field,
): FieldModification | null {
  if (oldField.type.kind !== newField.type.kind) {
    throw new UnsupportedDiffChangeError(
      entityName,
      newField.name,
      `field type kind changed from '${oldField.type.kind}' to '${newField.type.kind}'; requires manifest 'transform:' directive (Phase 2)`,
    );
  }

  if (oldField.type.kind === "enum" && newField.type.kind === "enum") {
    if (!stringArrayEquals(oldField.type.values, newField.type.values)) {
      throw new UnsupportedDiffChangeError(
        entityName,
        newField.name,
        `enum values changed; requires named CHECK constraint management (Phase 2)`,
      );
    }
  }

  if (oldField.type.kind === "integer" && newField.type.kind === "integer") {
    if (oldField.type.min !== newField.type.min || oldField.type.max !== newField.type.max) {
      throw new UnsupportedDiffChangeError(
        entityName,
        newField.name,
        `integer range changed; requires named CHECK constraint management (Phase 2)`,
      );
    }
  }

  if (oldField.type.kind === "decimal" && newField.type.kind === "decimal") {
    if (
      oldField.type.min !== newField.type.min ||
      oldField.type.max !== newField.type.max ||
      oldField.type.precision !== newField.type.precision ||
      oldField.type.scale !== newField.type.scale
    ) {
      throw new UnsupportedDiffChangeError(
        entityName,
        newField.name,
        `decimal parameters changed; requires either typed ALTER with USING or named CHECK constraint management (Phase 2)`,
      );
    }
  }

  if (!deepEqual(oldField.unique, newField.unique)) {
    throw new UnsupportedDiffChangeError(
      entityName,
      newField.name,
      `unique constraint changed; requires named UNIQUE constraint management (Phase 2)`,
    );
  }

  const columnName = columnNameForField(newField);
  const oldPgType = fieldTypeToPostgresType(oldField.type);
  const newPgType = fieldTypeToPostgresType(newField.type);

  let result: FieldModification = { name: newField.name, columnName };
  let changed = false;

  if (oldPgType !== newPgType) {
    result = { ...result, typeChange: { from: oldPgType, to: newPgType } };
    changed = true;
  }

  const oldRequired = oldField.required === true;
  const newRequired = newField.required === true;
  if (oldRequired !== newRequired) {
    result = { ...result, nullabilityChange: { from: oldRequired, to: newRequired } };
    changed = true;
  }

  if (!deepEqual(oldField.default, newField.default)) {
    result = { ...result, defaultChange: { from: oldField.default, to: newField.default } };
    changed = true;
  }

  return changed ? result : null;
}

function indexesContain(haystack: readonly ResolvedIndex[], needle: ResolvedIndex): boolean {
  return haystack.some((idx) => resolvedIndexEquals(idx, needle));
}

function resolvedIndexEquals(a: ResolvedIndex, b: ResolvedIndex): boolean {
  return (
    stringArrayEquals(a.columns, b.columns) &&
    (a.kind ?? "btree") === (b.kind ?? "btree") &&
    (a.unique ?? false) === (b.unique ?? false)
  );
}

function stringArrayEquals(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object") return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (Array.isArray(b)) return false;
  const aKeys = Object.keys(a as object);
  const bKeys = Object.keys(b as object);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}
