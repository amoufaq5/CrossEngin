import type { Manifest } from "@crossengin/kernel/manifest";

import type { FilterOp, ListFilter, ListQuery, ListSearch, ListSort } from "./store.js";

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 500;

/** Manifest field-type kinds whose values are free-text-searchable. */
const SEARCHABLE_KINDS = new Set(["text", "long_text", "email", "slug", "phone", "url", "string"]);

/** The per-entity list behavior derived from its manifest `ListView`. */
export interface ListConfig {
  readonly defaultLimit: number;
  readonly maxLimit: number;
  readonly defaultSort: readonly ListSort[];
  readonly sortableFields: readonly string[];
  readonly filterableFields: readonly string[];
  /** Text-like fields the `?q` free-text search matches against (OR of contains). */
  readonly searchableFields: readonly string[];
}

const RESERVED_PARAMS = new Set(["limit", "cursor", "sort", "order", "fields", "q"]);

/**
 * Parses a `?fields=a,b,c` projection into a field list, or null when absent
 * (no projection → full records). Values are comma-split, trimmed, and deduped.
 */
export function parseFields(
  query: Readonly<Record<string, string | readonly string[]>>,
): readonly string[] | null {
  const raw = query["fields"];
  if (raw === undefined) return null;
  const joined = Array.isArray(raw) ? raw.join(",") : (raw as string);
  const fields = [...new Set(joined.split(",").map((s) => s.trim()).filter((s) => s.length > 0))];
  return fields.length > 0 ? fields : null;
}

interface ListViewLike {
  readonly kind: string;
  readonly entity: string;
  readonly pageSize?: number;
  readonly sort?: ReadonlyArray<{ field: string; direction?: "asc" | "desc" }>;
  readonly columns?: ReadonlyArray<{ field: string; sortable?: boolean; filterable?: boolean; hidden?: boolean }>;
}

interface LifecycleLike {
  readonly kind: string;
  readonly entity: string;
  readonly stateField: string;
}

interface FieldLike {
  readonly name: string;
  readonly type?: { readonly kind?: string };
}
interface EntityLike {
  readonly name: string;
  readonly fields?: readonly FieldLike[];
}

/** The entity's text-like field names (searchable), in declaration order. */
function textFieldsOf(manifest: Manifest, entity: string): readonly string[] {
  const ent = ((manifest.entities ?? []) as ReadonlyArray<EntityLike>).find((e) => e.name === entity);
  if (ent === undefined) return [];
  return (ent.fields ?? []).filter((f) => SEARCHABLE_KINDS.has(f.type?.kind ?? "")).map((f) => f.name);
}

/**
 * The searchable field set for an entity: its text-like fields, narrowed to the view's
 * visible columns when a list view exists (so search matches what the user sees). With no
 * view, all text-like fields are searchable.
 */
function searchableFieldsFor(
  manifest: Manifest,
  entity: string,
  visibleColumns: readonly string[] | null,
): readonly string[] {
  const textFields = textFieldsOf(manifest, entity);
  if (visibleColumns === null) return textFields;
  const visible = new Set(visibleColumns);
  return textFields.filter((f) => visible.has(f));
}

/** The lifecycle `stateField` for an entity, if a workflow declares one. */
function lifecycleStateField(manifest: Manifest, entity: string): string | null {
  for (const wf of Object.values(manifest.workflows ?? {}) as ReadonlyArray<LifecycleLike>) {
    if (wf.kind === "entityLifecycle" && wf.entity === entity) return wf.stateField;
  }
  return null;
}

/** Ensures the lifecycle state field is filterable so the work-queue inbox can push `?state[in]=…` server-side. */
function withLifecycleStateFilter(
  manifest: Manifest,
  entity: string,
  filterableFields: readonly string[],
): readonly string[] {
  const sf = lifecycleStateField(manifest, entity);
  if (sf === null || filterableFields.includes(sf)) return filterableFields;
  return [...filterableFields, sf];
}

/** The entity's reference (foreign-key) field names, in declaration order. */
function referenceFieldsOf(manifest: Manifest, entity: string): readonly string[] {
  const ent = ((manifest.entities ?? []) as ReadonlyArray<EntityLike>).find((e) => e.name === entity);
  if (ent === undefined) return [];
  return (ent.fields ?? []).filter((f) => f.type?.kind === "reference").map((f) => f.name);
}

/**
 * Ensures reference (FK) fields are filterable so a related-records query can push `?<ref>=<id>` into
 * SQL — the natural join keys for "the children pointing at this record", the same principle as the
 * lifecycle-state filter. Additive: a reference already filterable is unchanged.
 */
function withReferenceFilters(
  manifest: Manifest,
  entity: string,
  filterableFields: readonly string[],
): readonly string[] {
  const refs = referenceFieldsOf(manifest, entity);
  if (refs.length === 0) return filterableFields;
  const set = new Set(filterableFields);
  for (const r of refs) set.add(r);
  return [...set];
}

/**
 * Derives the `ListConfig` for an entity from the first `ListView` in the
 * manifest that targets it: default page size + default sort + the set of
 * sortable / filterable column fields. With no matching view, lists still
 * paginate at the default size but expose no sort/filter surface — except the
 * lifecycle `stateField`, which is always filterable so the inbox's work-queue
 * filter is pushed into SQL rather than scanned client-side.
 */
export function listConfigForEntity(manifest: Manifest, entity: string): ListConfig {
  const views = Object.values(manifest.views ?? {}) as ReadonlyArray<ListViewLike>;
  const view = views.find((v) => v.kind === "list" && v.entity === entity);
  if (view === undefined) {
    return {
      defaultLimit: DEFAULT_PAGE_SIZE,
      maxLimit: MAX_PAGE_SIZE,
      defaultSort: [],
      sortableFields: [],
      filterableFields: withReferenceFilters(manifest, entity, withLifecycleStateFilter(manifest, entity, [])),
      searchableFields: searchableFieldsFor(manifest, entity, null),
    };
  }
  const columns = view.columns ?? [];
  const visibleColumns = columns.filter((c) => c.hidden !== true).map((c) => c.field);
  const sortableFields = columns.filter((c) => c.hidden !== true && c.sortable !== false).map((c) => c.field);
  const filterableFields = columns.filter((c) => c.hidden !== true && c.filterable !== false).map((c) => c.field);
  const defaultSort: ListSort[] = (view.sort ?? []).map((s) => ({ field: s.field, direction: s.direction ?? "asc" }));
  return {
    defaultLimit: view.pageSize ?? DEFAULT_PAGE_SIZE,
    maxLimit: MAX_PAGE_SIZE,
    defaultSort,
    sortableFields,
    filterableFields: withReferenceFilters(manifest, entity, withLifecycleStateFilter(manifest, entity, filterableFields)),
    searchableFields: searchableFieldsFor(manifest, entity, visibleColumns),
  };
}

function firstValue(v: string | readonly string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : (v as string);
}

function clampLimit(raw: string | undefined, config: ListConfig): number {
  if (raw === undefined) return Math.min(config.defaultLimit, config.maxLimit);
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return Math.min(config.defaultLimit, config.maxLimit);
  return Math.min(n, config.maxLimit);
}

/**
 * Parses a request query into a resolved `ListQuery`, honoring the entity's
 * `ListConfig`: `?limit` (clamped to the view's max), `?cursor` (opaque),
 * `?sort=<field>&order=asc|desc` (only when the field is sortable, else the
 * view's default sort), and equality filters on any non-reserved param whose
 * key is a filterable column. Unknown / non-filterable params are ignored, so
 * an arbitrary query can't widen the result set.
 */
export function parseListQuery(
  query: Readonly<Record<string, string | readonly string[]>>,
  config: ListConfig,
): ListQuery {
  const limit = clampLimit(firstValue(query["limit"]), config);
  const cursor = firstValue(query["cursor"]) ?? null;

  const sortField = firstValue(query["sort"]);
  const orderRaw = firstValue(query["order"]);
  const direction: "asc" | "desc" = orderRaw === "desc" ? "desc" : "asc";
  const sort: readonly ListSort[] =
    sortField !== undefined && config.sortableFields.includes(sortField)
      ? [{ field: sortField, direction }]
      : config.defaultSort;

  const filters: ListFilter[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (RESERVED_PARAMS.has(key)) continue;
    const parsed = parseFilterKey(key);
    if (parsed === null || !config.filterableFields.includes(parsed.field)) continue;
    if (parsed.op === "in") {
      const values = inValues(value);
      if (values.length > 0) filters.push({ field: parsed.field, op: "in", value: values });
      continue;
    }
    const v = firstValue(value);
    if (v !== undefined) filters.push({ field: parsed.field, op: parsed.op, value: v });
  }

  // Cross-field free-text search: `?q=term` matches ANY searchable field. Ignored when the
  // entity has no searchable fields, so an arbitrary `?q` can't widen the result set.
  const q = firstValue(query["q"]);
  const search: ListSearch | undefined =
    q !== undefined && q.trim() !== "" && config.searchableFields.length > 0
      ? { term: q.trim(), fields: config.searchableFields }
      : undefined;

  return { limit, cursor, sort, filters, ...(search !== undefined ? { search } : {}) };
}

const FILTER_KEY_RE = /^([a-z][a-z0-9_]*)(?:\[(eq|ne|gt|gte|lt|lte|in|contains)\])?$/;

/** Parses a filter param key: `field` → eq, `field[op]` → that operator. */
function parseFilterKey(key: string): { field: string; op: FilterOp } | null {
  const m = FILTER_KEY_RE.exec(key);
  if (m === null) return null;
  return { field: m[1]!, op: (m[2] as FilterOp | undefined) ?? "eq" };
}

/** Splits an `in` filter value into a list (repeated param or comma-separated). */
function inValues(value: string | readonly string[]): string[] {
  if (Array.isArray(value)) return [...value];
  return (value as string)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Which query surface addressed a withheld field, and which field it was. */
export interface WithheldAddressing {
  readonly surface: "sort" | "filter" | "search";
  readonly field: string;
}

/**
 * The first place a query addresses rows by a withheld field, or null when it addresses none.
 *
 * The rule it enforces: **while rows are being withheld, a caller may not address rows by a field
 * they may not read.** It is asked only under a record-level policy that is dropping rows — with
 * every row visible each of these surfaces only ever tells the caller about rows they are shown
 * anyway, which is why none of them has ever needed a guard before.
 *
 * Three surfaces, one rule, two reasons:
 *
 * - **`sort` is the sharpest, and it is not only the sort a caller asks for.** The keyset cursor is
 *   `base64url(JSON.stringify({k: […sort values], id}))` — plainly reversible — and it is derived
 *   from the last row of the **store's** slice, which under row filtering may be a row the caller
 *   is never shown. So ordering by a classified field puts that field's value, for a withheld row,
 *   into a string handed straight back. `query.sort` is the view's **default** sort when the
 *   request names none, which is deliberately not exempted: measured on resolved
 *   `erp-healthcare`, `Patient`'s list view sorts by `family_name` (`pii`) by default and its
 *   first column is `mrn` (`phi`, and the field ADR-0338 made ciphertext at rest), so a
 *   record-bearing `list` policy on `Patient` refuses `GET /v1/patients` with no query string at
 *   all. That is the correct answer rather than an over-reach — the default sort really does put a
 *   withheld row's family name in the cursor — and the two remedies are to grant the caller the
 *   class or to point the view's default sort at an unclassified column.
 * - **`filter` and `search` are a chosen-predicate oracle.** The caller picks a value and the
 *   response distinguishes match from no-match — through the cursor's presence if through nothing
 *   else — so a withheld row's contents can be tested one value at a time. That channel does not
 *   exist today, because without a record policy a caller who can predicate on a row simply *sees*
 *   it.
 *
 * What it deliberately does **not** cover: the cursor still carries the **position** of a withheld
 * row — the default sort key and its id. That is irreducible, since advancing past a row means
 * naming where it was, and this guard's job is to hold the disclosure to position rather than
 * contents.
 *
 * Surfaces are checked `sort`, `filter`, `search` and the first hit is returned, so a query
 * offending on two of them names the same one every time and the refusal a caller reads is stable.
 */
export function withheldAddressing(
  query: ListQuery,
  withheldFields: ReadonlySet<string>,
): WithheldAddressing | null {
  if (withheldFields.size === 0) return null;
  for (const sort of query.sort) {
    if (withheldFields.has(sort.field)) return { surface: "sort", field: sort.field };
  }
  for (const filter of query.filters) {
    if (withheldFields.has(filter.field)) return { surface: "filter", field: filter.field };
  }
  for (const field of query.search?.fields ?? []) {
    if (withheldFields.has(field)) return { surface: "search", field };
  }
  return null;
}
