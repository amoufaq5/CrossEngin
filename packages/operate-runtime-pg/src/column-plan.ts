import { columnNameForField, fieldTypeToPostgresType } from "@crossengin/kernel/ddl";
import type { Manifest } from "@crossengin/kernel/manifest";
import { toTableName } from "@crossengin/kernel/ddl";
import {
  requiresEncryptionAtRest,
  type DataClassification,
  type Entity,
  type Field,
  type OnDelete,
} from "@crossengin/types/meta-schema";

/** One manifest field's mapping to a typed SQL column. */
export interface ColumnMapping {
  readonly field: string;
  readonly column: string;
  readonly sqlType: string;
  readonly notNull: boolean;
  readonly classification: DataClassification | null;
  readonly encryptAtRest: boolean;
  /** For a reference field: the target entity name (so a FK can be emitted), else null. */
  readonly referenceTarget: string | null;
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
  const isReference = field.type.kind === "reference";
  return {
    field: field.name,
    column: columnNameForField(field),
    // Reference columns are TEXT, not UUID: they hold the target's TEXT `id`
    // (the column store keeps TEXT ids for cross-store parity), so a composite
    // FK to `(tenant_id, id)` type-checks.
    sqlType: isReference ? "TEXT" : fieldTypeToPostgresType(field.type),
    notNull: field.required === true,
    classification,
    encryptAtRest: classification !== null && requiresEncryptionAtRest(classification),
    referenceTarget: field.type.kind === "reference" ? field.type.target : null,
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

/** The distinct reference targets of a plan (deduped, in column order). */
export function referencedEntities(plan: EntityTablePlan): readonly string[] {
  const seen = new Set<string>();
  for (const c of plan.columns) {
    if (c.referenceTarget !== null) seen.add(c.referenceTarget);
  }
  return [...seen];
}

/**
 * Indexes the manifest's `many_to_one` relations by `"<fromEntity>.<field>"` →
 * its `onDelete` policy, so the FK emitter can choose RESTRICT / CASCADE /
 * SET NULL per reference instead of a blanket default. Only `many_to_one`
 * relations carry a FK-bearing column on the `from` entity.
 */
export function relationDeleteIndex(manifest: Manifest): ReadonlyMap<string, OnDelete> {
  const out = new Map<string, OnDelete>();
  for (const rel of manifest.relations ?? []) {
    if (rel.kind === "many_to_one" && rel.onDelete !== undefined) {
      out.set(`${rel.from}.${rel.field}`, rel.onDelete);
    }
  }
  return out;
}

/**
 * Orders entity names so a referenced entity precedes the entity that references
 * it (Kahn's algorithm over the reference graph) — the order to create tables in
 * so a FK target already exists. References to entities not in the set are
 * ignored; on a cycle the remaining nodes are appended in insertion order (FKs
 * are added in a second pass, so a cycle is still safe to apply).
 */
export function topologicalEntityOrder(plans: ReadonlyMap<string, EntityTablePlan>): readonly string[] {
  const names = [...plans.keys()];
  const present = new Set(names);
  const deps = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  for (const name of names) {
    deps.set(name, new Set());
    indegree.set(name, 0);
  }
  for (const name of names) {
    const plan = plans.get(name);
    if (plan === undefined) continue;
    for (const target of referencedEntities(plan)) {
      if (!present.has(target) || target === name) continue;
      // edge target → name; name depends on target
      const set = deps.get(name);
      if (set !== undefined && !set.has(target)) {
        set.add(target);
        indegree.set(name, (indegree.get(name) ?? 0) + 1);
      }
    }
  }
  const ready = names.filter((n) => (indegree.get(n) ?? 0) === 0);
  const ordered: string[] = [];
  const emitted = new Set<string>();
  while (ready.length > 0) {
    const next = ready.shift()!;
    if (emitted.has(next)) continue;
    ordered.push(next);
    emitted.add(next);
    for (const name of names) {
      if (emitted.has(name)) continue;
      const set = deps.get(name);
      if (set?.has(next)) {
        set.delete(next);
        if (set.size === 0) ready.push(name);
      }
    }
  }
  // append any nodes left in a cycle, in insertion order
  for (const name of names) {
    if (!emitted.has(name)) ordered.push(name);
  }
  return ordered;
}
