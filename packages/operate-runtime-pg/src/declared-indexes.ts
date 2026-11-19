import { createHash } from "node:crypto";

import { qualifyTable, quoteIdent, resolvedFields } from "@crossengin/kernel/ddl";
import type { Manifest } from "@crossengin/kernel/manifest";
import { listValueTypeFor } from "@crossengin/operate-runtime";

import type { PgConnection } from "@crossengin/kernel-pg";

import { applyIndexConcurrently, indexValidity } from "./boot-ddl.js";
import type { EntityTablePlan } from "./column-plan.js";
import { DOCUMENT_RUNTIME_INDEX_PREFIX } from "./document-integrity.js";

/**
 * The lookup indexes a manifest declares, emitted on both stores.
 *
 * `field.indexed` and `entity.indexes` were authored, validated, merged across lineage and hashed
 * into `manifestHash`, and emitted by nothing — measured on resolved `erp-core`: **163** indexed
 * fields (every one of its 79 `reference` fields among them) and **64** entity indexes, 40 of them
 * multi-column. So a list filtered or sorted on a declared field, and every `ON DELETE` check a
 * parent delete runs against a child's reference column, read the whole tenant's slice of the table.
 *
 * Every index leads with `tenant_id`, because every query either store issues carries
 * `tenant_id = $1` first, and a reference column is indexed whether or not it is declared, because
 * the column store's composite foreign key makes a parent `DELETE` scan the child for it.
 *
 * What is **not** emitted is returned with its reason rather than dropped, so a boot line can say it:
 * a column encrypted at rest (pgcrypto ciphertext is non-deterministic, so an index on it answers
 * nothing), a `gin`/`gist` kind (no pack declares one, and either needs an operator class this
 * declaration does not carry), an entity index declared `unique` (a uniqueness guarantee is the
 * field's `unique`, with its own refusal path; an index here would refuse writes nobody was told
 * about), and — on the document store — a field whose list predicate is a guarded cast, which is
 * not the expression an index on `document ->> 'f'` holds.
 */

export const DECLARED_INDEX_SOURCES = ["field", "reference", "entity_index"] as const;
export type DeclaredIndexSource = (typeof DECLARED_INDEX_SOURCES)[number];

export const DECLARED_INDEX_SKIP_REASONS = [
  "encrypted_at_rest",
  "kind_not_btree",
  "unique_entity_index",
  "cast_predicate",
  "unknown_field",
] as const;
export type DeclaredIndexSkipReason = (typeof DECLARED_INDEX_SKIP_REASONS)[number];

export interface DeclaredIndex {
  readonly entity: string;
  readonly fields: readonly string[];
  readonly source: DeclaredIndexSource;
  readonly name: string;
  /** Schema-qualified and quoted, for `to_regclass` and a `DROP`. */
  readonly qualifiedName: string;
  readonly sql: string;
}

export interface DeclaredIndexSkip {
  readonly entity: string;
  readonly fields: readonly string[];
  readonly reason: DeclaredIndexSkipReason;
}

export interface DeclaredIndexPlan {
  readonly indexes: readonly DeclaredIndex[];
  readonly skipped: readonly DeclaredIndexSkip[];
}

interface Candidate {
  readonly entity: string;
  readonly fields: readonly string[];
  readonly keys: readonly string[];
  readonly source: DeclaredIndexSource;
}

const MAX_IDENTIFIER_LEN = 63;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function digest(parts: readonly string[], length: number): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, length);
}

function isPrefix(shorter: readonly string[], longer: readonly string[]): boolean {
  return shorter.length <= longer.length && shorter.every((k, i) => longer[i] === k);
}

/**
 * Drops every candidate an index already serves: a key list that is a prefix of another candidate,
 * of the primary key, or of a unique index — so `[tenant_id]`, which the primary key
 * `(tenant_id, id)` already leads with, is never emitted, and a single-column declaration under a
 * multi-column one that starts with it costs nothing. Equal lists keep the first, in source order.
 */
function uncovered(candidates: readonly Candidate[], existing: readonly (readonly string[])[]): Candidate[] {
  const kept: Candidate[] = [];
  candidates.forEach((c, i) => {
    if (existing.some((e) => isPrefix(c.keys, e))) return;
    const coveredByOther = candidates.some(
      (o, j) => j !== i && isPrefix(c.keys, o.keys) && (o.keys.length > c.keys.length || j < i),
    );
    if (!coveredByOther) kept.push(c);
  });
  return kept;
}

function declaredCandidates(
  manifest: Manifest,
  entityName: string,
): { readonly fieldLists: readonly { fields: readonly string[]; source: DeclaredIndexSource }[]; readonly skipped: DeclaredIndexSkip[] } {
  const entity = (manifest.entities ?? []).find((e) => e.name === entityName);
  if (entity === undefined) return { fieldLists: [], skipped: [] };
  const fieldLists: { fields: readonly string[]; source: DeclaredIndexSource }[] = [];
  const skipped: DeclaredIndexSkip[] = [];
  for (const field of resolvedFields(entity, manifest.traits ?? [])) {
    const hint = field.indexed;
    const declared = hint !== undefined && hint !== false;
    if (typeof hint === "object" && hint.kind !== "btree") {
      skipped.push({ entity: entity.name, fields: [field.name], reason: "kind_not_btree" });
      continue;
    }
    if (declared) fieldLists.push({ fields: [field.name], source: "field" });
    else if (field.type.kind === "reference") fieldLists.push({ fields: [field.name], source: "reference" });
  }
  for (const idx of entity.indexes ?? []) {
    if (idx.kind !== undefined && idx.kind !== "btree") {
      skipped.push({ entity: entity.name, fields: idx.fields, reason: "kind_not_btree" });
    } else if (idx.unique === true) {
      skipped.push({ entity: entity.name, fields: idx.fields, reason: "unique_entity_index" });
    } else {
      fieldLists.push({ fields: idx.fields, source: "entity_index" });
    }
  }
  return { fieldLists, skipped };
}

/** The column store's indexes, one per entity table, each `(tenant_id, …columns)`. */
export function planColumnStoreIndexes(
  manifest: Manifest,
  plans: ReadonlyMap<string, EntityTablePlan>,
): DeclaredIndexPlan {
  const indexes: DeclaredIndex[] = [];
  const skipped: DeclaredIndexSkip[] = [];
  for (const plan of plans.values()) {
    const byField = new Map(plan.columns.map((c) => [c.field, c] as const));
    const declared = declaredCandidates(manifest, plan.entity);
    skipped.push(...declared.skipped);
    const candidates: Candidate[] = [];
    for (const list of declared.fieldLists) {
      const cols = list.fields.map((f) => byField.get(f));
      if (cols.some((c) => c === undefined)) {
        skipped.push({ entity: plan.entity, fields: list.fields, reason: "unknown_field" });
        continue;
      }
      if (cols.some((c) => c!.encryptAtRest)) {
        skipped.push({ entity: plan.entity, fields: list.fields, reason: "encrypted_at_rest" });
        continue;
      }
      candidates.push({
        entity: plan.entity,
        fields: list.fields,
        keys: ["tenant_id", ...cols.map((c) => c!.column)],
        source: list.source,
      });
    }
    const existing = [
      ["tenant_id", "id"],
      ...plan.columns
        .filter((c) => c.uniqueScope !== null && !c.encryptAtRest)
        .map((c) => ["tenant_id", ...(c.uniqueScope ?? []), c.column]),
    ];
    const qualified = qualifyTable(plan.schema, plan.table);
    for (const c of uncovered(candidates, existing)) {
      const suffix = `_ix_${digest([plan.table, ...c.keys], 12)}`;
      const name = `${plan.table.slice(0, MAX_IDENTIFIER_LEN - suffix.length)}${suffix}`;
      indexes.push({
        entity: c.entity,
        fields: c.fields,
        source: c.source,
        name,
        qualifiedName: `${quoteIdent(plan.schema)}.${quoteIdent(name)}`,
        sql: `CREATE INDEX IF NOT EXISTS ${quoteIdent(name)} ON ${qualified} (${c.keys.map(quoteIdent).join(", ")});`,
      });
    }
  }
  return { indexes, skipped };
}

/**
 * `operate_entity_records_rt_ix_`: a lookup index's name prefix, inside the runtime namespace the
 * catalog declares for this store — exported so a reader of that namespace can tell a lookup index
 * from a unique one (`…_rt_uq_`) without spelling the prefix a second time.
 */
export const DOCUMENT_LOOKUP_INDEX_PREFIX = `${DOCUMENT_RUNTIME_INDEX_PREFIX}ix_`;

export function documentLookupIndexName(entity: string, fields: readonly string[]): string {
  return `${DOCUMENT_LOOKUP_INDEX_PREFIX}${digest([entity, ...fields], 16)}`;
}

/**
 * The document store's indexes, one **partial** index per (entity, field list) on the shared table:
 * `(tenant_id, (document ->> 'f'), …) WHERE entity = 'E'`. Partial rather than one index per field
 * name across entities, because every row of the shared table would then enter every index — a
 * write to one entity paying for every other entity's declarations — where a partial index is
 * maintained only for its own entity's rows. The list predicate is `entity = $2`, a bound
 * parameter; node-postgres sends it as an unnamed statement, which Postgres plans with the value in
 * hand, so the partial predicate is provable (measured with `EXPLAIN`, see the tests' fixtures).
 *
 * Only a field whose list predicate is the bare `document ->> 'f'` is indexed: a `numeric` or
 * `timestamptz` field is compared through a guarded cast (`entity-ops.ts`), which an index on the
 * text expression cannot serve, and `timestamptz`'s cast is not even IMMUTABLE.
 */
export function planDocumentStoreIndexes(manifest: Manifest, schema: string): DeclaredIndexPlan {
  const table = qualifyTable(schema, "operate_entity_records");
  const indexes: DeclaredIndex[] = [];
  const skipped: DeclaredIndexSkip[] = [];
  const traits = manifest.traits ?? [];
  for (const entity of manifest.entities ?? []) {
    const byField = new Map(resolvedFields(entity, traits).map((f) => [f.name, f] as const));
    const declared = declaredCandidates(manifest, entity.name);
    skipped.push(...declared.skipped);
    const candidates: Candidate[] = [];
    for (const list of declared.fieldLists) {
      const fields = list.fields.map((f) => byField.get(f));
      if (fields.some((f) => f === undefined) || !list.fields.every((f) => FIELD_RE.test(f))) {
        skipped.push({ entity: entity.name, fields: list.fields, reason: "unknown_field" });
        continue;
      }
      if (fields.some((f) => listValueTypeFor(f!.type) !== "text")) {
        skipped.push({ entity: entity.name, fields: list.fields, reason: "cast_predicate" });
        continue;
      }
      candidates.push({ entity: entity.name, fields: list.fields, keys: ["tenant_id", ...list.fields], source: list.source });
    }
    // `(tenant_id, entity, record_id)` is the table's unique key, which leads with no field, so the
    // only existing coverage is another candidate. The unique indexes ADR-0423 builds are on the
    // same expressions, but they are created only for `unique` fields and a lookup there is served.
    const uniques = resolvedFields(entity, traits)
      .flatMap((f) =>
        f.unique === true
          ? [["tenant_id", f.name]]
          : typeof f.unique === "object"
            ? [["tenant_id", ...f.unique.scope, f.name]]
            : [],
      );
    for (const c of uncovered(candidates, uniques)) {
      const name = documentLookupIndexName(c.entity, c.fields);
      const exprs = c.fields.map((f) => `(document ->> '${f}')`).join(", ");
      indexes.push({
        entity: c.entity,
        fields: c.fields,
        source: c.source,
        name,
        qualifiedName: `${quoteIdent(schema)}.${quoteIdent(name)}`,
        sql: `CREATE INDEX IF NOT EXISTS ${quoteIdent(name)} ON ${table} (tenant_id, ${exprs}) WHERE entity = '${c.entity}';`,
      });
    }
  }
  return { indexes, skipped };
}

/** The boot line: what was declared, what is emitted, and what is not and why. */
export function formatDeclaredIndexPlan(store: "pg" | "pg-columns", plan: DeclaredIndexPlan): string {
  const bySource = new Map<DeclaredIndexSource, number>();
  for (const i of plan.indexes) bySource.set(i.source, (bySource.get(i.source) ?? 0) + 1);
  const byReason = new Map<DeclaredIndexSkipReason, number>();
  for (const s of plan.skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
  const sources = DECLARED_INDEX_SOURCES.map((s) => `${String(bySource.get(s) ?? 0)} ${s}`).join(", ");
  const reasons = DECLARED_INDEX_SKIP_REASONS.filter((r) => (byReason.get(r) ?? 0) > 0).map(
    (r) => `${String(byReason.get(r))} ${r}`,
  );
  return (
    `declared indexes on --store ${store}: ${String(plan.indexes.length)} (${sources})` +
    (reasons.length > 0 ? `; not emitted: ${reasons.join(", ")}` : "; every declaration emitted")
  );
}

export const DECLARED_INDEX_OUTCOMES = [
  /** Present and valid before this pass, so nothing was issued. */
  "present",
  /** Built by this pass. */
  "built",
  /** Not present, and this pass was asked only to look. */
  "absent",
  /** Not present, and this role does not own the table, so it cannot build one. */
  "not_owner",
  /** Building it failed for another reason, with Postgres's message as the detail. */
  "failed",
] as const;
export type DeclaredIndexOutcome = (typeof DECLARED_INDEX_OUTCOMES)[number];

export interface DeclaredIndexResult {
  readonly index: DeclaredIndex;
  readonly outcome: DeclaredIndexOutcome;
  readonly detail: string | null;
}

/**
 * Builds (or, with `build: false`, only looks for) each declared index. Never throws for one index:
 * a missing lookup index changes how fast a query is answered and never what it answers.
 */
export async function ensureDeclaredIndexes(
  conn: PgConnection,
  indexes: readonly DeclaredIndex[],
  opts: { readonly build: boolean },
): Promise<readonly DeclaredIndexResult[]> {
  const results: DeclaredIndexResult[] = [];
  for (const index of indexes) {
    try {
      if (!opts.build) {
        const valid = await indexValidity(conn, index.qualifiedName);
        results.push({ index, outcome: valid === true ? "present" : "absent", detail: null });
        continue;
      }
      const built = await applyIndexConcurrently(conn, index);
      results.push({ index, outcome: built ? "built" : "present", detail: null });
    } catch (err) {
      const code = (err as { readonly code?: unknown }).code;
      const detail = err instanceof Error ? err.message : String(err);
      results.push({ index, outcome: code === "42501" ? "not_owner" : "failed", detail });
    }
  }
  return results;
}

/** One line over a pass's results, naming the count of each outcome and the remedy for a gap. */
export function formatDeclaredIndexResults(results: readonly DeclaredIndexResult[], remedy: string): string {
  const counts = DECLARED_INDEX_OUTCOMES.map((o) => [o, results.filter((r) => r.outcome === o).length] as const)
    .filter(([, n]) => n > 0)
    .map(([o, n]) => `${String(n)} ${o}`);
  const gap = results.some((r) => r.outcome !== "present" && r.outcome !== "built");
  return `declared index pass: ${counts.length > 0 ? counts.join(", ") : "nothing declared"}${gap ? ` — ${remedy}` : ""}`;
}
