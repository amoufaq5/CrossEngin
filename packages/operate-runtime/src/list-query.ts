import { resolvedFields } from "@crossengin/kernel/ddl";
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
  /**
   * Every field name the entity resolves to, plus `id`.
   *
   * It exists for exactly one question, and it is the question that separates a refusal from a
   * shrug: `?tax_id=X` on an entity that *has* a `tax_id` and declines to filter it is a caller
   * asking for something this deployment chose not to serve, while `?utm_source=x` names nothing
   * and is an ordinary unknown query parameter that every HTTP surface ignores. Only the first may
   * be refused, and without this list the two are indistinguishable.
   *
   * Required rather than optional, because an optional field can be forgotten with the type still
   * valid and the consequence of forgetting it is that every refusal silently stops firing — the
   * permissive direction. There are two construction sites in the workspace.
   */
  readonly fields: readonly string[];
}

/**
 * A query surface the caller asked for that this entity does not serve.
 *
 * Both reasons are *manifest* facts rather than store ones: the field exists and is not in
 * `filterableFields`, or `?q` arrived at an entity with no searchable field at all. A surface the
 * manifest declares and the **store** cannot serve is a different fact with a different remedy —
 * see `ListSurfaceUnserveable` in `store.ts`.
 *
 * There is deliberately no `not_sortable` member, and `parseListQuery` says why: an unhonoured sort
 * returns the right rows in the wrong order, which is not the same kind of wrong as a page holding
 * rows the caller asked to exclude.
 */
export const UNSERVED_LIST_REASONS = ["not_filterable", "not_searchable"] as const;
export type UnservedListReason = (typeof UNSERVED_LIST_REASONS)[number];

export interface UnservedListSurface {
  readonly surface: "filter" | "search";
  readonly reason: UnservedListReason;
  /** The field asked for; `null` for `?q`, which names no single field. */
  readonly field: string | null;
}

/** The resolved query, plus every surface the caller asked for that the entity does not serve. */
export interface ParsedListQuery {
  readonly query: ListQuery;
  readonly unserved: readonly UnservedListSurface[];
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
// `EntityLike` lived here: a structural `{name, fields?}` that omitted `traits`, which is what made
// the narrow read the only read this module had. It is gone — `resolvedFieldsOf` takes the real
// `Entity` out of `manifest.entities` and asks the kernel, so there is no entity-shaped local that
// cannot see a trait.

/**
 * Every field the entity resolves to — its own and whatever its traits contribute — which is the
 * list the served table has columns for.
 *
 * One private resolution read by all three field-derived outputs of this module, because they used
 * to disagree: `entityFieldNames` resolved traits while `textFieldsOf` and `referenceFieldsOf`
 * read `ent.fields`, so one function answered about the served table and two about the entity
 * declaration, inside `listConfigForEntity`. `ListConfig.fields` therefore held a trait field that
 * `searchableFields` and `filterableFields` could not — and since ADR-0359 `fields` is what decides
 * whether an unknown query parameter is ignored or refused, so the split had become
 * authorization-adjacent: a trait-contributed field was *declared* and *unserveable* at once.
 *
 * Behaviour-identical on every shipped pack, measured rather than assumed: not one of the eight
 * built-in trait fields is a `SEARCHABLE_KINDS` member or a `reference` (they are `datetime`,
 * `uuid`, `integer` and `boolean`), and no pack declares a custom trait. So only a custom trait can
 * change an answer here — and when one does, a trait-contributed text field becomes searchable,
 * which on the column store means `?q` can collapse the whole OR group and
 * `UNSERVEABLE_SURFACE_REFUSES.search` refuses the request rather than widening it.
 */
function resolvedFieldsOf(manifest: Manifest, entity: string): readonly FieldLike[] {
  const ent = (manifest.entities ?? []).find((e) => e.name === entity);
  if (ent === undefined) return [];
  return resolvedFields(ent, manifest.traits ?? []);
}

/** The entity's text-like field names (searchable), in resolved declaration order. */
function textFieldsOf(manifest: Manifest, entity: string): readonly string[] {
  return resolvedFieldsOf(manifest, entity)
    .filter((f) => SEARCHABLE_KINDS.has(f.type?.kind ?? ""))
    .map((f) => f.name);
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

/** The entity's reference (foreign-key) field names, in resolved declaration order. */
function referenceFieldsOf(manifest: Manifest, entity: string): readonly string[] {
  return resolvedFieldsOf(manifest, entity)
    .filter((f) => f.type?.kind === "reference")
    .map((f) => f.name);
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
  const fields = entityFieldNames(manifest, entity);
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
      fields,
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
    fields,
  };
}

/**
 * Every field name the entity resolves to, plus `id`.
 *
 * Through the kernel's `resolvedFields` — the same function `validateManifest`, the column plan and
 * the three sibling decorators in this package use — so a field a **trait** contributes counts,
 * and this list cannot disagree with the set the served table has columns for. `id` is added for
 * the reason `resolvedFieldNames` adds it: it is not a domain field, and for an existence question
 * it plainly exists.
 */
function entityFieldNames(manifest: Manifest, entity: string): readonly string[] {
  // Through the same `resolvedFieldsOf` as the searchable and reference sets, so the three cannot
  // disagree about an entity's fields again. An unknown entity answers `["id"]` here rather than
  // `[]`, which is the one place the three differ and is deliberate: for an existence question `id`
  // plainly exists, while an unknown entity has no searchable or reference field to name.
  return ["id", ...resolvedFieldsOf(manifest, entity).map((f) => f.name)];
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
 * Parses a request query into a resolved `ListQuery`, honoring the entity's `ListConfig`:
 * `?limit` (clamped to the view's max), `?cursor` (opaque), `?sort=<field>&order=asc|desc`, and
 * equality filters on any non-reserved param whose key is a filterable column.
 *
 * It also reports, in `unserved`, every surface the caller asked for that this entity does not
 * serve — and that half is the point. This function used to drop those silently, under a comment
 * that read *"Unknown / non-filterable params are ignored, so an arbitrary query can't widen the
 * result set"*, which is **exactly backwards about the dangerous half**. It is true of the surface:
 * a caller cannot filter on a column the manifest did not expose. It is false of the answer:
 * ignoring `?tax_id=X` returns every vendor, which is the rows the caller asked to *exclude*.
 * Two readings of "widen", and the response was indistinguishable from one where the filter had
 * been applied — so a client that believes it filtered acts on the whole table. `?sort=` was the
 * same shape one axis over: an unsortable value fell back to the view's default, so a caller was
 * handed a different order under a 200.
 *
 * It reports rather than throws, because the status and the sentence belong to the handler and this
 * module is pure. The empty array is the normal case.
 */
export function parseListQuery(
  query: Readonly<Record<string, string | readonly string[]>>,
  config: ListConfig,
): ParsedListQuery {
  const limit = clampLimit(firstValue(query["limit"]), config);
  const cursor = firstValue(query["cursor"]) ?? null;
  const unserved: UnservedListSurface[] = [];

  const sortField = firstValue(query["sort"]);
  const orderRaw = firstValue(query["order"]);
  const direction: "asc" | "desc" = orderRaw === "desc" ? "desc" : "asc";
  // An unsortable `?sort` still falls back to the view's default, and that is a deliberate
  // asymmetry with the filter below rather than an oversight.
  //
  // The question the two answer differently is **whether the answer is wrong or merely not the one
  // asked for**. A dropped filter puts rows in the page that are not answers to the caller's
  // question — they asked to exclude them — so the response is false. An unhonoured sort returns
  // exactly the right rows under the default ordering: correct data, in an order the caller did not
  // choose, which they can see by looking at it and which discloses nothing.
  //
  // And the costs are not symmetric either, measured across the seven resolved packs: 243 of 375
  // entities have no list view and so declare **no sortable field at all**, so refusing here would
  // turn `?sort=` into a 400 on nearly two thirds of every pack's collections — where the rows were
  // never wrong. ADR-0338's rule is to refuse where nothing worked before and to leave alone what
  // did. The sharper half of this surface — a sortable field whose *value* rides out in the cursor
  // — is ADR-0357's survey and is reported at boot rather than per request.
  const sortAsked = sortField !== undefined && config.sortableFields.includes(sortField);
  const sort: readonly ListSort[] = sortAsked
    ? [{ field: sortField, direction }]
    : config.defaultSort;

  const fields = new Set(config.fields);
  const filterable = new Set(config.filterableFields);
  const filters: ListFilter[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (RESERVED_PARAMS.has(key)) continue;
    const parsed = parseFilterKey(key);
    if (parsed === null) continue;
    if (!filterable.has(parsed.field)) {
      // Only when it names a real field of the entity. `?utm_source=x` names nothing and is left
      // alone; `?tax_id=X` on an entity that has `tax_id` and declines to filter it is refused.
      if (fields.has(parsed.field)) {
        unserved.push({ surface: "filter", reason: "not_filterable", field: parsed.field });
      }
      continue;
    }
    if (parsed.op === "in") {
      const values = inValues(value);
      if (values.length > 0) filters.push({ field: parsed.field, op: "in", value: values });
      continue;
    }
    const v = firstValue(value);
    if (v !== undefined) filters.push({ field: parsed.field, op: parsed.op, value: v });
  }

  // Cross-field free-text search: `?q=term` matches ANY searchable field. An entity with no
  // searchable field cannot serve it at all, and dropping it there is the widest drop of the three
  // — `?q=anything` matched every row — so it is reported rather than ignored.
  const q = firstValue(query["q"]);
  const wants = q !== undefined && q.trim() !== "";
  if (wants && config.searchableFields.length === 0) {
    unserved.push({ surface: "search", reason: "not_searchable", field: null });
  }
  const search: ListSearch | undefined =
    wants && config.searchableFields.length > 0
      ? { term: q!.trim(), fields: config.searchableFields }
      : undefined;

  return {
    query: { limit, cursor, sort, filters, ...(search !== undefined ? { search } : {}) },
    unserved,
  };
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
