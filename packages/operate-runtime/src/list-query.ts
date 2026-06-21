import type { Manifest } from "@crossengin/kernel/manifest";

import type { FilterOp, ListFilter, ListQuery, ListSort } from "./store.js";

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 500;

/** The per-entity list behavior derived from its manifest `ListView`. */
export interface ListConfig {
  readonly defaultLimit: number;
  readonly maxLimit: number;
  readonly defaultSort: readonly ListSort[];
  readonly sortableFields: readonly string[];
  readonly filterableFields: readonly string[];
}

const RESERVED_PARAMS = new Set(["limit", "cursor", "sort", "order", "fields"]);

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
      filterableFields: withLifecycleStateFilter(manifest, entity, []),
    };
  }
  const columns = view.columns ?? [];
  const sortableFields = columns.filter((c) => c.hidden !== true && c.sortable !== false).map((c) => c.field);
  const filterableFields = columns.filter((c) => c.hidden !== true && c.filterable !== false).map((c) => c.field);
  const defaultSort: ListSort[] = (view.sort ?? []).map((s) => ({ field: s.field, direction: s.direction ?? "asc" }));
  return {
    defaultLimit: view.pageSize ?? DEFAULT_PAGE_SIZE,
    maxLimit: MAX_PAGE_SIZE,
    defaultSort,
    sortableFields,
    filterableFields: withLifecycleStateFilter(manifest, entity, filterableFields),
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

  return { limit, cursor, sort, filters };
}

const FILTER_KEY_RE = /^([a-z][a-z0-9_]*)(?:\[(eq|ne|gt|gte|lt|lte|in)\])?$/;

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
