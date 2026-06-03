import { columnNameForField, fieldTypeToPostgresType } from "@crossengin/kernel/ddl";
import type { Manifest } from "@crossengin/kernel/manifest";
import { toTableName } from "@crossengin/kernel/ddl";
import {
  requiresEncryptionAtRest,
  type DataClassification,
  type Entity,
  type Field,
} from "@crossengin/types/meta-schema";

/** One manifest field's mapping to a typed SQL column. */
export interface ColumnMapping {
  readonly field: string;
  readonly column: string;
  readonly sqlType: string;
  readonly notNull: boolean;
  readonly classification: DataClassification | null;
  readonly encryptAtRest: boolean;
}

/** The full plan for one entity's per-tenant table (domain columns only). */
export interface EntityTablePlan {
  readonly entity: string;
  readonly schema: string;
  readonly table: string;
  readonly columns: readonly ColumnMapping[];
}

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

function mappingForField(field: Field): ColumnMapping {
  const classification = field.classification ?? null;
  return {
    field: field.name,
    column: columnNameForField(field),
    sqlType: fieldTypeToPostgresType(field.type),
    notNull: field.required === true,
    classification,
    encryptAtRest: classification !== null && requiresEncryptionAtRest(classification),
  };
}

/**
 * Derives the column plan for one entity: each manifest field → a typed column
 * (via the kernel's `fieldTypeToPostgresType` + `columnNameForField`), carrying
 * its classification + at-rest-encryption flag. System columns (`tenant_id`,
 * `id`, timestamps) are added by the DDL emitter, not here.
 */
export function columnPlanForEntity(entity: Entity, opts: { readonly schema: string }): EntityTablePlan {
  if (!SCHEMA_RE.test(opts.schema)) {
    throw new Error(`invalid schema name: ${JSON.stringify(opts.schema)}`);
  }
  return {
    entity: entity.name,
    schema: opts.schema,
    table: toTableName(entity.name),
    columns: entity.fields.map(mappingForField),
  };
}

/** Builds a `field → mapping` lookup for one plan (used to map records ↔ rows). */
export function columnIndex(plan: EntityTablePlan): ReadonlyMap<string, ColumnMapping> {
  return new Map(plan.columns.map((c) => [c.field, c]));
}

/** Derives a plan for every entity in a resolved manifest, keyed by entity name. */
export function columnPlansForManifest(
  manifest: Manifest,
  opts: { readonly schema: string },
): ReadonlyMap<string, EntityTablePlan> {
  const out = new Map<string, EntityTablePlan>();
  for (const entity of manifest.entities ?? []) {
    out.set(entity.name, columnPlanForEntity(entity, opts));
  }
  return out;
}
