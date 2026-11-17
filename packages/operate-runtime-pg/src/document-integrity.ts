import { createHash } from "node:crypto";

import { resolvedFields } from "@crossengin/kernel/ddl";
import type { Manifest } from "@crossengin/kernel/manifest";
import type { PgConnection } from "@crossengin/kernel-pg";
import {
  ReferencedRecordInUse,
  ReferenceNotFound,
  UniqueViolation,
  type EntityRecord,
} from "@crossengin/operate-runtime";
import type { OnDelete } from "@crossengin/types/meta-schema";

import { relationDeleteIndex } from "./column-plan.js";

/**
 * What the JSONB document store enforces of a manifest: its declared `unique` fields and its
 * `reference` fields.
 *
 * Until this module the store enforced neither. `meta.operate_entity_records` is one table shared
 * by every entity, whose only UNIQUE is `(tenant_id, entity, record_id)`, so two invoices could carry
 * one `invoice_number` — measured to post the general ledger twice under that number — and a
 * reference could name a record that never existed, or one deleted afterwards. The column store
 * gets both from its DDL (a unique index per field, a composite foreign key per reference); this is
 * the same pair of guarantees for a table that cannot carry per-entity DDL:
 *
 * - **uniqueness** by one partial unique *expression* index per (entity, field) —
 *   `(tenant_id, …scope, (document ->> 'field')) WHERE entity = 'E'` — created at boot from the
 *   served manifest, so the database refuses the duplicate and the race is the database's;
 * - **references** by one indexed lookup per written reference (the `(tenant_id, entity,
 *   record_id)` key), taken `FOR KEY SHARE`, and on delete by applying each reference's declared
 *   `onDelete` exactly as the column store's foreign key does: `restrict` refuses, `cascade`
 *   deletes the referencing records, `set_null` nulls the field.
 */

/**
 * The name prefix of every index this store creates at run time. The catalog declares it on
 * `META_OPERATE_ENTITY_RECORDS` as `runtimeIndexPrefix`, which is what stops the reconciler
 * reporting these indexes as undeclared on every drift check and every `apply`: the catalog cannot
 * know a manifest, so it declares the namespace instead of the members. A test pins the two
 * spellings equal.
 */
export const DOCUMENT_RUNTIME_INDEX_PREFIX = "operate_entity_records_rt_";

const ENTITY_RE = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PG_UNIQUE_VIOLATION = "23505";
const PG_INSUFFICIENT_PRIVILEGE = "42501";

/** One declared `unique` field, as the index that enforces it on the document table. */
export interface DocumentUniqueIndex {
  readonly entity: string;
  readonly field: string;
  /** `[]` for tenant-wide; the scope's field names for `unique: {scope}`. */
  readonly scope: readonly string[];
  readonly name: string;
  readonly sql: string;
}

/** One `reference` field and the delete rule the column store's foreign key would carry. */
export interface DocumentReferenceEdge {
  readonly entity: string;
  readonly field: string;
  readonly target: string;
  readonly onDelete: OnDelete;
  readonly required: boolean;
}

export interface DocumentIntegrityPlan {
  readonly uniqueIndexes: readonly DocumentUniqueIndex[];
  /** Index name → the (entity, field) it enforces, for turning a `23505` into a `UniqueViolation`. */
  readonly uniqueByIndex: ReadonlyMap<string, { readonly entity: string; readonly field: string }>;
  /** Reference fields by the entity that carries them. */
  readonly referencesFrom: ReadonlyMap<string, readonly DocumentReferenceEdge[]>;
  /** Reference fields by the entity they point at — what a delete of that entity must consult. */
  readonly referencesTo: ReadonlyMap<string, readonly DocumentReferenceEdge[]>;
  /** False only under `--allow-dangling-references`; the unique indexes are unaffected by it. */
  readonly enforceReferences: boolean;
}

function scopeOf(unique: boolean | { readonly scope: readonly string[] } | undefined): readonly string[] | null {
  if (unique === undefined || unique === false) return null;
  return unique === true ? [] : unique.scope;
}

/**
 * Deterministic from (entity, field, scope) and nothing else, so two replicas booting together
 * name one index and `IF NOT EXISTS` makes the second a no-op. A hash rather than the names
 * because an entity and a field can each be 63 characters and the identifier limit is 63 in all.
 */
export function documentUniqueIndexName(entity: string, field: string, scope: readonly string[]): string {
  const digest = createHash("sha256").update(JSON.stringify([entity, field, scope])).digest("hex");
  return `${DOCUMENT_RUNTIME_INDEX_PREFIX}uq_${digest.slice(0, 16)}`;
}

function jsonText(field: string): string {
  return `(document ->> '${field}')`;
}

/**
 * Plans what the document store enforces of `manifest` on `table`.
 *
 * Over `resolvedFields`, as the column plan is, so a trait-contributed unique or reference field is
 * enforced on both stores. A reference to an entity the manifest does not declare is skipped,
 * which is the column store's `knownEntities` rule. A name that cannot be interpolated safely is
 * refused rather than skipped, since skipping would withhold a guarantee in silence; the kernel's
 * own name rules make that unreachable from a validated manifest.
 */
export function planDocumentIntegrity(
  manifest: Manifest,
  table: string,
  opts: { readonly enforceReferences?: boolean } = {},
): DocumentIntegrityPlan {
  const traits = manifest.traits ?? [];
  const entities = manifest.entities ?? [];
  const known = new Set(entities.map((e) => e.name));
  const onDeleteOf = relationDeleteIndex(manifest);
  const uniqueIndexes: DocumentUniqueIndex[] = [];
  const from = new Map<string, DocumentReferenceEdge[]>();
  const to = new Map<string, DocumentReferenceEdge[]>();
  for (const entity of entities) {
    if (!ENTITY_RE.test(entity.name)) throw new Error(`entity name cannot be indexed: ${JSON.stringify(entity.name)}`);
    for (const field of resolvedFields(entity, traits)) {
      const scope = scopeOf(field.unique);
      if (scope !== null) {
        for (const f of [...scope, field.name]) {
          if (!FIELD_RE.test(f)) throw new Error(`field name cannot be indexed: ${JSON.stringify(f)}`);
        }
        const name = documentUniqueIndexName(entity.name, field.name, scope);
        const cols = ["tenant_id", ...scope.map(jsonText), jsonText(field.name)].join(", ");
        uniqueIndexes.push({
          entity: entity.name,
          field: field.name,
          scope,
          name,
          sql: `CREATE UNIQUE INDEX IF NOT EXISTS "${name}" ON ${table} (${cols}) WHERE entity = '${entity.name}'`,
        });
      }
      if (field.type.kind === "reference" && known.has(field.type.target)) {
        if (!FIELD_RE.test(field.name)) throw new Error(`field name cannot be queried: ${JSON.stringify(field.name)}`);
        const edge: DocumentReferenceEdge = {
          entity: entity.name,
          field: field.name,
          target: field.type.target,
          onDelete: onDeleteOf.get(`${entity.name}.${field.name}`) ?? "restrict",
          required: field.required === true,
        };
        from.set(entity.name, [...(from.get(entity.name) ?? []), edge]);
        to.set(edge.target, [...(to.get(edge.target) ?? []), edge]);
      }
    }
  }
  return {
    uniqueIndexes,
    uniqueByIndex: new Map(uniqueIndexes.map((i) => [i.name, { entity: i.entity, field: i.field }] as const)),
    referencesFrom: from,
    referencesTo: to,
    enforceReferences: opts.enforceReferences ?? true,
  };
}

export const DOCUMENT_UNIQUE_INDEX_OUTCOMES = [
  /** The index exists and Postgres reports it valid and ready. */
  "enforced",
  /** Building it raised `23505`: rows already holding duplicates are in the table. */
  "existing_duplicates",
  /** The connecting role does not own the table, so it cannot create an index on it. */
  "not_owner",
  /** An index of that name exists and is not valid — a failed `CREATE INDEX CONCURRENTLY` leaves one. */
  "invalid_index",
  /** Any other failure, with Postgres's own message as the detail. */
  "failed",
] as const;
export type DocumentUniqueIndexOutcome = (typeof DOCUMENT_UNIQUE_INDEX_OUTCOMES)[number];

export interface DocumentUniqueIndexResult {
  readonly index: DocumentUniqueIndex;
  readonly outcome: DocumentUniqueIndexOutcome;
  readonly detail: string | null;
}

/** A runtime index on the table that the served manifest no longer produces. Reported, never dropped. */
export interface StaleDocumentIndex {
  readonly name: string;
  readonly dropSql: string;
}

export interface DocumentIndexEnsureReport {
  readonly results: readonly DocumentUniqueIndexResult[];
  readonly stale: readonly StaleDocumentIndex[];
}

/**
 * Creates the plan's unique indexes, one statement each and each outside any transaction, so one
 * index refused by existing duplicates rolls back alone and leaves the others — ADR-0360's
 * per-statement discipline, here without a savepoint because there is no enclosing transaction to
 * poison. Never throws for a single index: a refusal is reported, because the table serves
 * correctly without the index minus the guarantee, and the boot line says which.
 *
 * **Not `CONCURRENTLY`.** A failed concurrent build leaves an *invalid* index behind, which a
 * later `IF NOT EXISTS` would accept as present while it enforces nothing — so the cost of the plain
 * form (it holds a `SHARE` lock, blocking writes to the shared table while it builds) is paid at
 * boot instead. And validity is **read back** from `pg_index` rather than inferred from the
 * statement succeeding, so an index someone else built concurrently and left invalid is reported
 * as `invalid_index` rather than counted.
 *
 * An index carrying the prefix that the plan does not name is reported as stale with its `DROP`,
 * and never dropped: the store is additive, as the column store is, and dropping a constraint on
 * boot is a loosening nobody approved.
 */
export async function ensureDocumentUniqueIndexes(
  conn: PgConnection,
  plan: DocumentIntegrityPlan,
  schema: string,
): Promise<DocumentIndexEnsureReport> {
  const results: DocumentUniqueIndexResult[] = [];
  for (const index of plan.uniqueIndexes) {
    try {
      await conn.query(index.sql);
      results.push({ index, outcome: "enforced", detail: null });
    } catch (err) {
      const code = (err as { readonly code?: unknown }).code;
      const message = err instanceof Error ? err.message : String(err);
      const outcome: DocumentUniqueIndexOutcome =
        code === PG_UNIQUE_VIOLATION
          ? "existing_duplicates"
          : code === PG_INSUFFICIENT_PRIVILEGE
            ? "not_owner"
            : "failed";
      results.push({ index, outcome, detail: message });
    }
  }
  const live = await conn.query<{ readonly name: string; readonly valid: boolean }>(
    `SELECT i.relname AS name, (x.indisvalid AND x.indisready) AS valid
       FROM pg_index x
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_class t ON t.oid = x.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = 'operate_entity_records' AND starts_with(i.relname, $2)`,
    [schema, DOCUMENT_RUNTIME_INDEX_PREFIX],
  );
  const liveByName = new Map(live.rows.map((r) => [r.name, r.valid] as const));
  const verified = results.map((r): DocumentUniqueIndexResult => {
    // A non-owner is refused `must be owner` (42501) even by `CREATE … IF NOT EXISTS` over an index
    // that already exists — measured on PG 16, the ownership check runs before the existence check.
    // That is the shipped deployment's ordinary case: the API connects as a confined role that owns
    // nothing (ADR-0424), and the owner-run `document-indexes` step built the index before the API
    // booted. So a refusal whose index is present and valid is enforcement, not a gap; only an
    // absent one is `not_owner`.
    if (r.outcome === "not_owner" && liveByName.get(r.index.name) === true) {
      return { index: r.index, outcome: "enforced", detail: null };
    }
    if (r.outcome !== "enforced") return r;
    const valid = liveByName.get(r.index.name);
    if (valid === true) return r;
    return {
      index: r.index,
      outcome: valid === false ? "invalid_index" : "failed",
      detail:
        valid === false
          ? "an index of this name exists and Postgres reports it invalid, so it enforces nothing"
          : "the CREATE succeeded and no index of this name is present afterwards",
    };
  });
  const planned = new Set(plan.uniqueIndexes.map((i) => i.name));
  const stale = [...liveByName.keys()]
    .filter((name) => !planned.has(name))
    .sort()
    .map((name) => ({ name, dropSql: `DROP INDEX "${schema}"."${name}";` }));
  return { results: verified, stale };
}

/** Re-throws a `23505` from one of the plan's indexes as a `UniqueViolation`; anything else untouched. */
export function rethrowDocumentUniqueViolation(plan: DocumentIntegrityPlan | null, err: unknown): never {
  if (plan !== null && (err as { readonly code?: unknown }).code === PG_UNIQUE_VIOLATION) {
    const constraint = (err as { readonly constraint?: unknown }).constraint;
    const owner = typeof constraint === "string" ? plan.uniqueByIndex.get(constraint) : undefined;
    if (owner !== undefined) throw new UniqueViolation(owner.entity, owner.field);
  }
  throw err;
}

/** The id a reference value names, or `null` for a value no record id can equal. */
function referencedId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Refuses a write whose reference fields name no record in this tenant.
 *
 * Only the fields this write *sets to a new value* are checked — a field absent from `changed`, or
 * holding the value it already held, is not, which is when Postgres re-checks a foreign key too. So
 * a record already carrying a dangling id from before this check existed can still be edited.
 * `null` is no reference and is admitted. The lookup is `FOR KEY SHARE`, so a concurrent delete of
 * the target waits for this transaction rather than slipping between the check and the commit.
 */
export async function checkReferences(
  tx: PgConnection,
  table: string,
  plan: DocumentIntegrityPlan | null,
  tenantId: string,
  entity: string,
  next: EntityRecord,
  previous: EntityRecord | null,
): Promise<void> {
  if (plan === null || !plan.enforceReferences) return;
  for (const edge of plan.referencesFrom.get(entity) ?? []) {
    if (!Object.prototype.hasOwnProperty.call(next, edge.field)) continue;
    const value = next[edge.field];
    if (value === null || value === undefined) continue;
    if (previous !== null && previous[edge.field] === value) continue;
    const id = referencedId(value);
    if (id === null) throw new ReferenceNotFound(entity, edge.field, edge.target);
    const res = await tx.query(
      `SELECT 1 FROM ${table} WHERE tenant_id = $1 AND entity = $2 AND record_id = $3 FOR KEY SHARE`,
      [tenantId, edge.target, id],
    );
    if (res.rows.length === 0) throw new ReferenceNotFound(entity, edge.field, edge.target);
  }
}

interface RowRef {
  readonly entity: string;
  readonly id: string;
}

const keyOf = (r: RowRef): string => `${r.entity}\u0000${r.id}`;

/**
 * Deletes one record and applies every reference's `onDelete` to the records pointing at it,
 * as one unit inside the caller's transaction.
 *
 * The closure under `cascade` is computed first, each row locked `FOR UPDATE` as it is reached (so a
 * concurrent write naming one waits on its `FOR KEY SHARE`); then every `restrict` edge into a row
 * of that closure is asked for a referencing row *outside* it, and one is a `ReferencedRecordInUse`
 * before anything is written; then `set_null` edges null their field — except on a `required`
 * field, where the column store's `NOT NULL` would refuse the same delete, so it is refused here as
 * `restrict` is; then the closure is deleted. Answers whether the named record existed.
 *
 * A `restrict` is judged against the closure as a whole, and that is not exactly Postgres. Measured
 * on PG 16: a row the cascade itself removes does not block when it is removed by the same
 * statement as its target (two siblings cascaded from one parent, one restricting the other) or is
 * the target itself (a self-reference), but *does* block when it is reached one cascade level later
 * than the row it restricts — Postgres checks per statement, in trigger order, which a closure has
 * no notion of. So the column store refuses that last shape and this store allows it: laxer in one
 * shape, never stricter, and only for a referencing row the same delete destroys.
 */
export async function removeWithReferences(
  tx: PgConnection,
  table: string,
  plan: DocumentIntegrityPlan,
  tenantId: string,
  entity: string,
  id: string,
): Promise<boolean> {
  const head = await tx.query(
    `SELECT 1 FROM ${table} WHERE tenant_id = $1 AND entity = $2 AND record_id = $3 FOR UPDATE`,
    [tenantId, entity, id],
  );
  if (head.rows.length === 0) return false;

  const closure = new Map<string, RowRef>([[keyOf({ entity, id }), { entity, id }]]);
  const queue: RowRef[] = [{ entity, id }];
  const nullings: { readonly ref: RowRef; readonly field: string }[] = [];
  const restricts: { readonly target: RowRef; readonly edge: DocumentReferenceEdge }[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const edge of plan.referencesTo.get(node.entity) ?? []) {
      if (edge.onDelete === "restrict" || (edge.onDelete === "set_null" && edge.required)) {
        restricts.push({ target: node, edge });
        continue;
      }
      const rows = await tx.query<{ readonly record_id: string }>(
        `SELECT record_id FROM ${table}
          WHERE tenant_id = $1 AND entity = $2 AND document ->> '${edge.field}' = $3
          ORDER BY record_id FOR UPDATE`,
        [tenantId, edge.entity, node.id],
      );
      for (const row of rows.rows) {
        const ref = { entity: edge.entity, id: row.record_id };
        if (edge.onDelete === "cascade") {
          if (!closure.has(keyOf(ref))) {
            closure.set(keyOf(ref), ref);
            queue.push(ref);
          }
        } else {
          nullings.push({ ref, field: edge.field });
        }
      }
    }
  }

  for (const { target, edge } of restricts) {
    const exclude = [...closure.values()].filter((r) => r.entity === edge.entity).map((r) => r.id);
    const blocking = await tx.query(
      `SELECT 1 FROM ${table}
        WHERE tenant_id = $1 AND entity = $2 AND document ->> '${edge.field}' = $3
          AND NOT (record_id = ANY($4::text[]))
        LIMIT 1`,
      [tenantId, edge.entity, target.id, exclude],
    );
    if (blocking.rows.length > 0) throw new ReferencedRecordInUse(target.entity, edge.entity, edge.field);
  }

  for (const { ref, field } of nullings) {
    if (closure.has(keyOf(ref))) continue;
    await tx.query(
      `UPDATE ${table} SET document = jsonb_set(document, ARRAY[$4::text], 'null'::jsonb)
        WHERE tenant_id = $1 AND entity = $2 AND record_id = $3`,
      [tenantId, ref.entity, ref.id, field],
    );
  }

  for (const ref of closure.values()) {
    await tx.query(`DELETE FROM ${table} WHERE tenant_id = $1 AND entity = $2 AND record_id = $3`, [
      tenantId,
      ref.entity,
      ref.id,
    ]);
  }
  return true;
}
