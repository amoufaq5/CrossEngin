import type { Manifest } from "@crossengin/kernel/manifest";

import type { ListFilter, ListQuery, ListSort } from "./store.js";

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

const RESERVED_PARAMS = new Set(["limit", "cursor", "sort", "order"]);

interface ListViewLike {
  readonly kind: string;
  readonly entity: string;
  readonly pageSize?: number;
  readonly sort?: ReadonlyArray<{ field: string; direction?: "asc" | "desc" }>;
  readonly columns?: ReadonlyArray<{ field: string; sortable?: boolean; filterable?: boolean; hidden?: boolean }>;
}

/**
 * Derives the `ListConfig` for an entity from the first `ListView` in the
 * manifest that targets it: default page size + default sort + the set of
 * sortable / filterable column fields. With no matching view, lists still
 * paginate at the default size but expose no sort/filter surface.
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
      filterableFields: [],
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
    filterableFields,
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
    if (!config.filterableFields.includes(key)) continue;
    const v = firstValue(value);
    if (v !== undefined) filters.push({ field: key, value: v });
  }

  return { limit, cursor, sort, filters };
}
