import type { DefaultValue, Entity, Field, Trait } from "@crossengin/types/meta-schema";
import { columnNameForField, emitColumn } from "./column.js";
import { EntityRenameNotSupportedError, UnsupportedDiffChangeError } from "./errors.js";
import { fieldTypeToPostgresType } from "./field-type.js";
import { indexName, qualifyTable, quoteIdent, toTableName } from "./identifiers.js";
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

export interface DiffContext {
  readonly customTraits?: readonly Trait[];
}

export interface DiffEmitContext {
  readonly schema: string;
}

export function computeEntityDiff(
  old: Entity,
  next: Entity,
  context: DiffContext = {},
): EntityDiff {
  if (old.name !== next.name) {
    throw new EntityRenameNotSupportedError(old.name, next.name);
  }

  const customTraits = context.customTraits ?? [];

  const oldTraitFields = expandTraits(old, customTraits);
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

  const oldIndexes = computeResolvedIndexes(old, customTraits);
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

export function emitDiff(diff: EntityDiff, context: DiffEmitContext): string[] {
  const statements: string[] = [];
  const table = qualifyTable(context.schema, diff.tableName);

  for (const idx of diff.removedIndexes) {
    statements.push(
      `DROP INDEX ${quoteIdent(context.schema)}.${quoteIdent(indexName(diff.tableName, idx.columns))};`,
    );
  }

  for (const colName of diff.removedFields) {
    statements.push(`ALTER TABLE ${table} DROP COLUMN ${quoteIdent(colName)};`);
  }

  for (const field of diff.addedFields) {
    const colDef = emitColumn(field, { schema: context.schema });
    statements.push(`ALTER TABLE ${table} ADD COLUMN ${colDef};`);
  }

  for (const mod of diff.modifiedFields) {
    if (mod.typeChange) {
      statements.push(
        `ALTER TABLE ${table} ALTER COLUMN ${quoteIdent(mod.columnName)} TYPE ${mod.typeChange.to};`,
      );
    }
    if (mod.nullabilityChange) {
      const op = mod.nullabilityChange.to ? "SET NOT NULL" : "DROP NOT NULL";
      statements.push(`ALTER TABLE ${table} ALTER COLUMN ${quoteIdent(mod.columnName)} ${op};`);
    }
    if (mod.defaultChange) {
      if (mod.defaultChange.to === undefined) {
        statements.push(
          `ALTER TABLE ${table} ALTER COLUMN ${quoteIdent(mod.columnName)} DROP DEFAULT;`,
        );
      } else {
        const sql = renderDefault(mod.defaultChange.to);
        statements.push(
          `ALTER TABLE ${table} ALTER COLUMN ${quoteIdent(mod.columnName)} SET DEFAULT ${sql};`,
        );
      }
    }
  }

  for (const idx of diff.addedIndexes) {
    statements.push(makeCreateIndex(context.schema, diff.tableName, idx));
  }

  return statements;
}

function renderDefault(value: DefaultValue): string {
  if (value.kind === "expression") return value.expression;
  if (value.kind === "sequence") return `sequence:${value.sequence}`;
  return renderLiteral(value.value);
}

function renderLiteral(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`unsupported numeric literal: ${value}`);
    }
    return String(value);
  }
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === "object") {
    return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
  }
  throw new Error(`unsupported literal type: ${typeof value}`);
}

function makeCreateIndex(schema: string, tableName: string, idx: ResolvedIndex): string {
  const using =
    idx.kind !== undefined && idx.kind !== "btree" ? ` USING ${idx.kind.toUpperCase()}` : "";
  const uniqueKw = idx.unique === true ? "UNIQUE " : "";
  const cols = idx.columns.map(quoteIdent).join(", ");
  return `CREATE ${uniqueKw}INDEX ${quoteIdent(indexName(tableName, idx.columns))} ON ${qualifyTable(schema, tableName)}${using} (${cols});`;
}

export function diffAndEmit(
  old: Entity,
  next: Entity,
  context: { schema: string; customTraits?: readonly Trait[] },
): string[] {
  const diff = computeEntityDiff(old, next, { customTraits: context.customTraits });
  return emitDiff(diff, { schema: context.schema });
}
