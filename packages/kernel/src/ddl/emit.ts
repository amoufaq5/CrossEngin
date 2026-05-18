import type { Entity, Field, Trait } from "@crossengin/types/meta-schema";
import { TENANT_ID_COLUMN, TENANT_OWNED_TRAIT } from "./built-in-traits.js";
import { emitColumn } from "./column.js";
import { indexName, qualifyTable, quoteIdent, toTableName } from "./identifiers.js";
import {
  buildColumnNameMap,
  checkEntityFieldNames,
  computeResolvedIndexes,
  expandTraits,
  type ResolvedIndex,
} from "./resolution.js";

const TENANT_RLS_USING =
  "tenant_id = current_setting('app.current_tenant_id', true)::UUID";

const META_TENANTS_SCHEMA = "meta";
const META_TENANTS_TABLE = "tenants";

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

export function isTenantOwned(entity: Entity): boolean {
  return (entity.traits ?? []).includes(TENANT_OWNED_TRAIT);
}

export function emitTenantFk(entity: Entity, context: EmitContext): string {
  const tableName = toTableName(entity.name);
  const constraintName = `${tableName}_tenant_fk`;
  return (
    `ALTER TABLE ${qualifyTable(context.schema, tableName)} ` +
    `ADD CONSTRAINT ${quoteIdent(constraintName)} ` +
    `FOREIGN KEY (${quoteIdent(TENANT_ID_COLUMN)}) ` +
    `REFERENCES ${quoteIdent(META_TENANTS_SCHEMA)}.${quoteIdent(META_TENANTS_TABLE)}("id") ` +
    `ON DELETE CASCADE;`
  );
}

export function emitTenantRls(entity: Entity, context: EmitContext): string[] {
  const tableName = toTableName(entity.name);
  const qualified = qualifyTable(context.schema, tableName);
  const policyName = `${tableName}_tenant_isolation`;
  return [
    `ALTER TABLE ${qualified} ENABLE ROW LEVEL SECURITY;`,
    `CREATE POLICY ${quoteIdent(policyName)} ON ${qualified} USING (${TENANT_RLS_USING});`,
  ];
}

export function emitEntity(entity: Entity, context: EmitContext): string[] {
  const statements: string[] = [
    emitCreateTable(entity, context),
    ...emitIndexes(entity, context),
  ];
  if (isTenantOwned(entity)) {
    statements.push(emitTenantFk(entity, context));
    statements.push(...emitTenantRls(entity, context));
  }
  return statements;
}

function makeIndex(schema: string, tableName: string, idx: ResolvedIndex): string {
  const using =
    idx.kind !== undefined && idx.kind !== "btree" ? ` USING ${idx.kind.toUpperCase()}` : "";
  const uniqueKw = idx.unique === true ? "UNIQUE " : "";
  const cols = idx.columns.map(quoteIdent).join(", ");
  return `CREATE ${uniqueKw}INDEX ${quoteIdent(indexName(tableName, idx.columns))} ON ${qualifyTable(schema, tableName)}${using} (${cols});`;
}
