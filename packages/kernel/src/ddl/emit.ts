import type { Entity, Field, Trait } from "@crossengin/types/meta-schema";
import { BUILT_IN_TRAIT_FIELDS } from "./built-in-traits.js";
import { columnNameForField, emitColumn } from "./column.js";
import { FieldNameCollisionError, ReservedFieldNameError, UnknownTraitError } from "./errors.js";
import { indexName, qualifyTable, quoteIdent, toTableName } from "./identifiers.js";

export interface EmitContext {
  readonly schema: string;
  readonly customTraits?: readonly Trait[];
}

const ID_FIELD: Field = {
  name: "id",
  type: { kind: "uuid" },
  required: true,
  default: { kind: "expression", expression: "uuid_generate_v7()" },
};

function expandTraits(entity: Entity, customTraits: readonly Trait[]): readonly Field[] {
  if (!entity.traits || entity.traits.length === 0) return [];

  const customByName = new Map(customTraits.map((t) => [t.name, t]));
  const result: Field[] = [];
  const seen = new Set<string>();

  for (const traitName of entity.traits) {
    const builtin = BUILT_IN_TRAIT_FIELDS.get(traitName);
    const traitFields =
      builtin ?? customByName.get(traitName)?.fields ?? null;

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

function checkEntityFieldNames(entity: Entity, traitFields: readonly Field[]): void {
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

function buildColumnNameMap(fields: readonly Field[]): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const field of fields) {
    map.set(field.name, columnNameForField(field));
  }
  return map;
}

export function emitCreateTable(entity: Entity, context: EmitContext): string {
  const traitFields = expandTraits(entity, context.customTraits ?? []);
  checkEntityFieldNames(entity, traitFields);

  const tableName = toTableName(entity.name);
  const allFields: readonly Field[] = [ID_FIELD, ...entity.fields, ...traitFields];
  const columnMap = buildColumnNameMap(allFields);

  const lines: string[] = allFields.map((f) => "  " + emitColumn(f, { schema: context.schema }));

  lines.push(`  PRIMARY KEY (${quoteIdent("id")})`);

  for (const field of allFields) {
    const unique = field.unique;
    if (typeof unique === "object" && unique !== null) {
      const cols = [field.name, ...unique.scope].map((n) => quoteIdent(columnMap.get(n) ?? n));
      lines.push(`  UNIQUE (${cols.join(", ")})`);
    }
  }

  return `CREATE TABLE ${qualifyTable(context.schema, tableName)} (\n${lines.join(",\n")}\n);`;
}

export function emitIndexes(entity: Entity, context: EmitContext): string[] {
  const traitFields = expandTraits(entity, context.customTraits ?? []);
  const tableName = toTableName(entity.name);
  const allFields: readonly Field[] = [...entity.fields, ...traitFields];
  const columnMap = buildColumnNameMap(allFields);

  const statements: string[] = [];

  for (const field of allFields) {
    const columnName = columnMap.get(field.name) ?? field.name;
    if (field.type.kind === "reference") {
      statements.push(makeIndex(context.schema, tableName, [columnName]));
      continue;
    }
    if (field.type.kind === "enum") {
      statements.push(makeIndex(context.schema, tableName, [columnName]));
      continue;
    }
    if (field.indexed === true) {
      statements.push(makeIndex(context.schema, tableName, [columnName]));
      continue;
    }
    if (typeof field.indexed === "object" && field.indexed !== null) {
      statements.push(makeIndex(context.schema, tableName, [columnName], field.indexed.kind));
    }
  }

  if (entity.indexes) {
    for (const index of entity.indexes) {
      const cols = index.fields.map((f) => columnMap.get(f) ?? f);
      statements.push(makeIndex(context.schema, tableName, cols, index.kind, index.unique));
    }
  }

  return statements;
}

export function emitEntity(entity: Entity, context: EmitContext): string[] {
  return [emitCreateTable(entity, context), ...emitIndexes(entity, context)];
}

function makeIndex(
  schema: string,
  tableName: string,
  columns: readonly string[],
  kind?: "btree" | "gin" | "gist",
  unique?: boolean,
): string {
  const using = kind !== undefined && kind !== "btree" ? ` USING ${kind.toUpperCase()}` : "";
  const uniqueKw = unique === true ? "UNIQUE " : "";
  const cols = columns.map(quoteIdent).join(", ");
  return `CREATE ${uniqueKw}INDEX ${quoteIdent(indexName(tableName, columns))} ON ${qualifyTable(schema, tableName)}${using} (${cols});`;
}
