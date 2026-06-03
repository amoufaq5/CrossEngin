import type { Entity, Field, Trait } from "@crossengin/types/meta-schema";
import { requiresEncryptionAtRest } from "@crossengin/types/meta-schema";
import { columnNameForField, emitColumn } from "./column.js";
import { indexName, qualifyTable, quoteIdent, toTableName } from "./identifiers.js";
import {
  buildColumnNameMap,
  checkEntityFieldNames,
  computeResolvedIndexes,
  expandTraits,
  type ResolvedIndex,
} from "./resolution.js";

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
  const tableName = toTableName(entity.name);
  const indexes = computeResolvedIndexes(entity, context.customTraits ?? []);
  return indexes.map((idx) => makeIndex(context.schema, tableName, idx));
}

export function emitColumnComments(entity: Entity, context: EmitContext): string[] {
  const tableName = toTableName(entity.name);
  const comments: string[] = [];
  for (const field of entity.fields) {
    if (field.classification === undefined) continue;
    const column = columnNameForField(field);
    const directives = [`crossengin.data_class=${field.classification}`];
    if (requiresEncryptionAtRest(field.classification)) {
      directives.push("crossengin.encrypt=at_rest");
    }
    comments.push(
      `COMMENT ON COLUMN ${qualifyTable(context.schema, tableName)}.${quoteIdent(column)} IS '${directives.join("; ")}';`,
    );
  }
  return comments;
}

export function emitEntity(entity: Entity, context: EmitContext): string[] {
  return [
    emitCreateTable(entity, context),
    ...emitIndexes(entity, context),
    ...emitColumnComments(entity, context),
  ];
}

function makeIndex(schema: string, tableName: string, idx: ResolvedIndex): string {
  const using =
    idx.kind !== undefined && idx.kind !== "btree" ? ` USING ${idx.kind.toUpperCase()}` : "";
  const uniqueKw = idx.unique === true ? "UNIQUE " : "";
  const cols = idx.columns.map(quoteIdent).join(", ");
  return `CREATE ${uniqueKw}INDEX ${quoteIdent(indexName(tableName, idx.columns))} ON ${qualifyTable(schema, tableName)}${using} (${cols});`;
}
