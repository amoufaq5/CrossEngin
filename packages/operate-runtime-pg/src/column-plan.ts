import { columnNameForField, emitDefault, fieldTypeToPostgresType } from "@crossengin/kernel/ddl";
import type { Manifest } from "@crossengin/kernel/manifest";
import { resolvedFields, toTableName } from "@crossengin/kernel/ddl";
import {
  requiresEncryptionAtRest,
  type DataClassification,
  type Entity,
  type Field,
  type OnDelete,
  type Trait,
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
  /**
   * SQL to follow `DEFAULT`, or null for none. Load-bearing for trait-supplied columns: the
   * `auditable` trait's `created_at` is NOT NULL with `now()`, and an insert that omits it
   * would fail without the default.
   */
  readonly defaultSql: string | null;
}

/** The full plan for one entity's per-tenant table (domain columns only). */
export interface EntityTablePlan {
  readonly entity: string;
  readonly schema: string;
  readonly table: string;
  readonly columns: readonly ColumnMapping[];
}

const SCHEMA_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * The SQL types this store has no wire form for, and the reason — one entry, `INTERVAL`, which a
 * manifest `duration` field compiles to.
 *
 * ## The decision: `duration` is refused, and it is refused *here*
 *
 * ADR-0331 and ADR-0332 both left `duration` open and nothing has reached it, because nothing in
 * the catalog, the 145 `META_TABLES` or the seven packs declares one. The refusal used to fire at
 * the first **read** (`UndecidedWireTypeError` out of `readColumn`), which is the trap: a manifest
 * declaring a `duration` provisioned a table, served every other field, and failed on the first
 * page of the one entity that had it. Refusing at **plan** time makes it a boot failure naming the
 * entity and the field, which is where a configuration error belongs.
 *
 * ## Why not pick a wire form instead
 *
 * The candidates are an ISO-8601 duration string, an integer count of seconds, or refusal. All
 * three were measured on PostgreSQL 16.13 and neither of the first two works:
 *
 * - **An integer count of seconds is lossy by construction.** `interval '1 mon'` has no fixed
 *   second count — it is a *calendar* offset, not a quantity — so converting it to seconds picks
 *   a month length the value does not carry.
 * - **An ISO-8601 string is lossless but is not an ordering key.** Its text order is not its
 *   duration order (`PT2H` sorts before `PT10M`), so it would need the same guarded cast a
 *   `decimal` gets — and `interval_in` is **STABLE**, not IMMUTABLE (`pg_proc.provolatile = 's'`),
 *   so `CREATE INDEX … ((document ->> 'f')::interval)` is **refused** and the parse depends on the
 *   session's `IntervalStyle`. Two replicas with different `IntervalStyle` would order the same
 *   rows differently, which is the disagreement this whole seam exists to end.
 * - **`interval` is not even a total order on the values.** `interval 'P1M' = interval 'P30D'` is
 *   **true** (measured) while the two wire strings differ, so a sort cannot distinguish two values
 *   a round trip must keep distinct — and the output spelling is a session GUC as well, so
 *   `(interval)::text` is `P1Y2M3DT4H5M6.5S` under `iso_8601` and `1 year 2 mons …` under
 *   `postgres`. A wire form would therefore need a *second* renderer in JS that agrees with
 *   Postgres's parser, for a field nobody has declared — ADR-0332's two-spellings defect, invented
 *   on purpose.
 * - Negative durations have no round-tripping ISO spelling either: `interval '-PT1H'` **raises**.
 *
 * ## What would unblock it
 *
 * Not a wire form for `INTERVAL` — a different *field type*. A `duration` declared with a unit
 * (`{kind: "duration", unit: "seconds" | "milliseconds"}`) compiles to `BIGINT`, which is a scalar,
 * is a total order, is lossless for its unit, and needs no new `ListValueType` at all because
 * `numeric` already covers it. That is a kernel change to `FieldType`, not a store change, and it
 * is the shape to add when somebody actually wants one.
 */
const UNDECIDED_SQL_TYPES: ReadonlyMap<string, string> = new Map([
  ["INTERVAL", "a 'duration' field has no decided wire type"],
]);

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
    defaultSql: field.default !== undefined ? emitDefault(field.default) : null,
  };
}

/**
 * Derives the column plan for one entity: every field it *resolves* to — its own plus
 * whatever its traits contribute — mapped to a typed column via the kernel's
 * `fieldTypeToPostgresType` + `columnNameForField`, carrying its classification,
 * at-rest-encryption flag and default.
 *
 * Trait fields are included because the manifest says they are fields: classifying,
 * granting or listing `created_by` is meaningless if no column exists for it. Resolution
 * goes through the kernel's `resolvedFields`, the same function `validateManifest` uses, so
 * validation cannot accept a field this store has no column for.
 *
 * `tenant_id` and `id` remain system columns added by the DDL emitter, not planned here.
 */
export function columnPlanForEntity(
  entity: Entity,
  opts: { readonly schema: string; readonly traits?: readonly Trait[] },
): EntityTablePlan {
  if (!SCHEMA_RE.test(opts.schema)) {
    throw new Error(`invalid schema name: ${JSON.stringify(opts.schema)}`);
  }
  const columns = resolvedFields(entity, opts.traits ?? []).map(mappingForField);
  for (const column of columns) {
    // At plan time, not at the first read: see `UNDECIDED_SQL_TYPES`. A manifest that cannot be
    // served is a configuration error, and the one thing worse than refusing it is provisioning a
    // table for it and failing on somebody's first page.
    const base = column.sqlType.endsWith("[]") ? column.sqlType.slice(0, -2) : column.sqlType;
    const reason = UNDECIDED_SQL_TYPES.get(base);
    if (reason !== undefined) {
      throw new UndecidedColumnTypeError(entity.name, column.field, base, reason);
    }
  }
  return {
    entity: entity.name,
    schema: opts.schema,
    table: toTableName(entity.name),
    columns,
  };
}

/**
 * Thrown when an entity declares a field whose Postgres type this store has no wire form for.
 *
 * Carries the entity as well as the field, because the plan is built per entity and an operator
 * reading a boot failure needs to know which entity to edit, not only which field name — a name
 * that may well be declared on several.
 */
export class UndecidedColumnTypeError extends Error {
  constructor(
    readonly entity: string,
    readonly field: string,
    readonly sqlType: string,
    readonly reason: string,
  ) {
    super(`${entity}.${field}: cannot plan a ${sqlType} column — ${reason}`);
    this.name = "UndecidedColumnTypeError";
  }
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
  const traits = manifest.traits ?? [];
  for (const entity of manifest.entities ?? []) {
    out.set(entity.name, columnPlanForEntity(entity, { ...opts, traits }));
  }
  return out;
}

/**
 * Whether any planned column is stored as pgcrypto ciphertext, i.e. whether the
 * `pgcrypto` extension has to exist before the DDL is applied. Derived from the
 * plans rather than from the manifest so it cannot disagree with what the emitter
 * will actually write.
 */
export function plansRequirePgcrypto(plans: ReadonlyMap<string, EntityTablePlan>): boolean {
  for (const plan of plans.values()) {
    if (plan.columns.some((c) => c.encryptAtRest)) return true;
  }
  return false;
}

/** The distinct reference targets of a plan (deduped, in column order). */
export function referencedEntities(plan: EntityTablePlan): readonly string[] {
  const seen = new Set<string>();
  for (const c of plan.columns) {
    if (c.referenceTarget !== null) seen.add(c.referenceTarget);
  }
  return [...seen];
}

/** The plan for one `many_to_many` join table: two tenant-scoped link columns. */
export interface JoinTablePlan {
  readonly schema: string;
  readonly table: string;
  readonly leftEntity: string;
  readonly rightEntity: string;
  readonly leftColumn: string;
  readonly rightColumn: string;
}

/**
 * Derives a join-table plan per `many_to_many` relation: the table is
 * `<left>_<right>` (snake), with `<left>_id` / `<right>_id` link columns (a
 * self-relation disambiguates to `<table>_left_id` / `<table>_right_id`).
 * Duplicate table names (e.g. a relation declared twice) are emitted once.
 */
export function joinTablePlansForManifest(
  manifest: Manifest,
  opts: { readonly schema: string },
): readonly JoinTablePlan[] {
  if (!SCHEMA_RE.test(opts.schema)) {
    throw new Error(`invalid schema name: ${JSON.stringify(opts.schema)}`);
  }
  const out: JoinTablePlan[] = [];
  const seen = new Set<string>();
  for (const rel of manifest.relations ?? []) {
    if (rel.kind !== "many_to_many") continue;
    const leftTable = toTableName(rel.left);
    const rightTable = toTableName(rel.right);
    const table = `${leftTable}_${rightTable}`;
    if (seen.has(table)) continue;
    seen.add(table);
    const selfRef = rel.left === rel.right;
    out.push({
      schema: opts.schema,
      table,
      leftEntity: rel.left,
      rightEntity: rel.right,
      leftColumn: selfRef ? `${leftTable}_left_id` : `${leftTable}_id`,
      rightColumn: selfRef ? `${rightTable}_right_id` : `${rightTable}_id`,
    });
  }
  return out;
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
 * ignored.
 *
 * **A cycle is not an error here.** The remaining nodes are appended in insertion
 * order, because `ensureSchema` adds foreign keys in a *second pass* once every
 * table exists — so two entities that reference each other apply cleanly. The
 * kernel once carried a rival `topologicalSort` that threw `CycleDetectedError`
 * instead; that was right only for the emitter which put FKs inline in
 * `CREATE TABLE`, and it was deleted with it (ADR-0285). This is the single
 * implementation.
 *
 * The graph is read from `plan.columns`, not the entity's own fields, so a
 * reference contributed by a **trait** orders the tables too — the entity's
 * field list alone would miss it.
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
