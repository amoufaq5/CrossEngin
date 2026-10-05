import { compareInstantText } from "./datetime.js";
import { compareDecimalText } from "./decimal.js";

export type EntityRecord = Record<string, unknown>;

export interface ListSort {
  readonly field: string;
  readonly direction: "asc" | "desc";
}

/**
 * How a field's values must be **compared and ordered**, independent of how a backend happens to
 * spell them.
 *
 * It exists because one of the two Postgres stores holds every field as text. `document ->> 'f'`
 * is TEXT whichever way the JSON held the value, so without a declared comparison type a
 * `decimal` or an `integer` sorts lexicographically — `"100.00"` before `"9.00"`, `"10"` before
 * `"9"` — while `ColumnMappedEntityStore`, whose columns are real `NUMERIC`/`INTEGER`, sorts the
 * same field numerically. Two implementations of one `EntityStore` then disagree about row
 * *order*, which ADR-0331 established surfaces as a production pagination failure rather than as a
 * test failure: the keyset cursor is built from the ordering, so a disagreement does not merely
 * reorder a page, it skips and repeats rows at every page boundary.
 *
 * Three members. `boolean`, `date` and `time` are deliberately `text` — see
 * `FIELD_LIST_VALUE_TYPES`, which records per field kind why. `datetime` is `timestamptz` for one
 * narrow reason that is *not* about the canonical wire form: that form is fixed-width and always
 * `Z`, so its byte order is chronological by construction, and `withDatetimeWireType` plus
 * `validateBody` mean nothing else can be written from now on. The cast is for the rows written
 * **before** that was true, whose spellings are not all canonical: `2026-01-31T19:00:00+09:00` is
 * the same instant as `2026-01-31T10:00:00.000Z` and sorts nine hours away from it as text. So a
 * JSONB store comparing bytes and a `ColumnMappedEntityStore` comparing a real `TIMESTAMPTZ` place
 * such a row differently, and since the keyset cursor is built from the ordering, that is the skip
 * -and-repeat failure ADR-0331 established rather than a cosmetic reorder.
 */
export const LIST_VALUE_TYPES = ["text", "numeric", "timestamptz"] as const;
export type ListValueType = (typeof LIST_VALUE_TYPES)[number];

/**
 * Comparison operators a list filter can use. `in` takes an array of values;
 * `contains` is a case-insensitive substring match (typeahead search).
 */
export const FILTER_OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "contains"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export interface ListFilter {
  readonly field: string;
  /** Defaults to `eq`. */
  readonly op?: FilterOp;
  readonly value: string | readonly string[];
}

/** A free-text search: match a `term` against ANY of `fields` (OR of substring/contains). */
export interface ListSearch {
  readonly term: string;
  readonly fields: readonly string[];
}

/** A resolved list query: limit + opaque keyset cursor + sort + typed filters. */
export interface ListQuery {
  readonly limit: number;
  readonly cursor: string | null;
  readonly sort: readonly ListSort[];
  readonly filters: readonly ListFilter[];
  /**
   * Optional cross-field free-text search (the `?q` param). Matches when `term` is a
   * substring of ANY listed field — an OR group, applied in addition to (AND with) the
   * typed `filters`. Absent when no `?q` was given.
   */
  readonly search?: ListSearch;
  /**
   * Optional field-selection hint (the `?fields` projection). A store MAY use it
   * to SELECT fewer columns; the handler still applies the exact projection, so
   * a store that ignores it is correct (just less efficient).
   */
  readonly fields?: readonly string[];
  /**
   * Per-field comparison types for the fields this query orders or filters on, absent entries
   * meaning `text`. A store MAY use it to compare and order a field on its declared type instead
   * of on however the storage spells it; a store whose columns already carry the type (the column
   * store) is correct either way.
   *
   * It travels with the *query* rather than sitting on the store because one `PostgresEntityStore`
   * instance serves **several tenants' manifests** — `operate-server`'s per-tenant JSONB fallback
   * is a single shared store, and two tenants author independently, so tenant A's `Invoice.amount`
   * and tenant B's are different types with the same name (ADR-0314). A field-type index held on
   * the instance would be one tenant's answer applied to every tenant. `withListValueTypes`
   * attaches it per call, from the manifest the gateway was compiled with.
   */
  readonly valueTypes?: ReadonlyMap<string, ListValueType>;
}

export interface ListPage {
  readonly records: readonly EntityRecord[];
  readonly nextCursor: string | null;
}

export interface EntityStore {
  list(tenantId: string, entity: string): Promise<readonly EntityRecord[]>;
  listPage(tenantId: string, entity: string, query: ListQuery): Promise<ListPage>;
  get(tenantId: string, entity: string, id: string): Promise<EntityRecord | null>;
  create(tenantId: string, entity: string, record: EntityRecord): Promise<EntityRecord>;
  update(
    tenantId: string,
    entity: string,
    id: string,
    patch: EntityRecord,
  ): Promise<EntityRecord | null>;
  remove(tenantId: string, entity: string, id: string): Promise<boolean>;
}

/**
 * An EntityStore that can run a unit of work atomically. The callback receives a
 * transaction-bound store; every read/write through it shares one transaction,
 * committed when the callback resolves and rolled back if it throws — so a
 * handler's guard → write → effect sequence is all-or-nothing.
 */
export interface TransactionalEntityStore extends EntityStore {
  withTransaction<T>(tenantId: string, fn: (tx: EntityStore) => Promise<T>): Promise<T>;
}

/** Narrows a store to one that supports atomic units of work. */
export function isTransactional(store: EntityStore): store is TransactionalEntityStore {
  return typeof (store as Partial<TransactionalEntityStore>).withTransaction === "function";
}

/**
 * A keyset position: the previous page's last row — its sort-field values (aligned to
 * `ListQuery.sort`) + id.
 *
 * A component is **`null` when the row had no value for that sort field**, and that is a widening
 * of the format rather than a replacement of it. It closes the hole `list-sql.ts` named: `keysetOf`
 * used to render a missing value as `""`, which for a text key is a value a genuine empty string
 * also produces, so the seek could not tell "the cursor is in the NULL tail" from "the cursor sits
 * on an empty string". Telling them apart needs a format that can hold a null.
 *
 * It **does not invalidate a cursor in flight**: a `string[]` is a valid `(string | null)[]`, so
 * every token already issued still decodes and still means what it meant. The one behavioural
 * difference is at a page boundary that sat on a missing value, where an old token may repeat or
 * skip a row once — bounded, one-off, and strictly better than the wrong answer it replaces. That
 * is why the format could be widened rather than versioned, and why nothing here refuses an old
 * token: there is no old token this store cannot parse.
 */
export interface KeysetCursor {
  readonly k: readonly (string | null)[];
  readonly id: string;
}

/** Encodes a keyset position into an opaque cursor token. */
export function encodeKeyset(cursor: KeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

/** Decodes a keyset cursor; a malformed/absent cursor reads as null (start from the beginning). */
export function decodeKeyset(cursor: string | null): KeysetCursor | null {
  if (cursor === null) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      Array.isArray((parsed as KeysetCursor).k) &&
      typeof (parsed as KeysetCursor).id === "string"
    ) {
      const k = (parsed as KeysetCursor).k;
      if (k.every((v) => typeof v === "string" || v === null)) return parsed as KeysetCursor;
    }
  } catch {
    return null;
  }
  return null;
}

/** @deprecated offset cursors are superseded by keyset; kept for compatibility. */
export function encodeCursor(offset: number): string {
  return Buffer.from(String(Math.max(0, Math.trunc(offset)))).toString("base64url");
}

/** @deprecated see {@link encodeCursor}. */
export function decodeCursor(cursor: string | null): number {
  if (cursor === null) return 0;
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const n = Number.parseInt(decoded, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Orders two field values. Two numbers compare numerically; two **decimal numerals** compare
 * numerically too, and exactly — a `decimal` field arrives here as its canonical wire string
 * (see `decimal.ts`), and a `localeCompare` would put `"9.50"` after `"10.25"`, so this store's
 * sort would disagree with the typed store's `ORDER BY` on the very field the wire type was
 * unified for. The rule is "both sides are bare numerals" rather than "the field is declared
 * decimal" because this comparator is handed values, not declarations; the cost is that a *text*
 * field holding bare numerals also sorts numerically here, where the SQL stores sort it as text.
 *
 * Two **instants** compare by instant for the same reason, and it is the half of the ordering fix
 * the wire form alone cannot do: once `withDatetimeWireType` is in place every written value is
 * canonical and byte order *is* chronological, but a value written before it — an offset form, or
 * one with no milliseconds — reads canonically while the JSONB document still spells it otherwise.
 * Comparing by instant orders those the way the SQL stores' guarded `::timestamptz` cast does.
 */
function compareValues(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") {
    const exact = compareDecimalText(a, b);
    if (exact !== null) return exact;
    const instant = compareInstantText(a, b);
    if (instant !== null) return instant;
  }
  return String(a ?? "").localeCompare(String(b ?? ""));
}

/** Whether a value is absent — the thing `NULLS LAST` orders, as distinct from an empty string. */
function isMissing(value: unknown): boolean {
  return value === null || value === undefined;
}

/**
 * Orders two values on one sort key, with **NULL last in both directions**.
 *
 * The presence test sits outside the direction flip on purpose. Expressed as a comparator result
 * and negated for `desc`, a missing value would move to the front descending — which is Postgres's
 * own default, and which both SQL stores deliberately override with an explicit `NULLS LAST`,
 * because a cursor component cannot say which end of the ordering it is at. Three implementations
 * of one contract have to agree about row order or the keyset skips and repeats rows at every page
 * boundary, so the in-memory store follows the same rule rather than inheriting a different one
 * from `localeCompare`.
 *
 * That is also why the previous spelling was wrong rather than merely different: `String(a ?? "")`
 * rendered a missing value as the empty string, which sorts *first* ascending — so the in-memory
 * store put the tail at the head on every ascending sort over a nullable field.
 */
function orderBy(a: unknown, b: unknown, direction: "asc" | "desc"): number {
  const am = isMissing(a);
  const bm = isMissing(b);
  if (am || bm) return am && bm ? 0 : am ? 1 : -1;
  const cmp = compareValues(a, b);
  return direction === "desc" ? -cmp : cmp;
}

/** Coerces a string filter/cursor value to a number when the sample record value is numeric. */
function coerceLike(value: string, sample: unknown): unknown {
  if (typeof sample === "number") {
    const n = Number(value);
    return Number.isNaN(n) ? value : n;
  }
  return value;
}

/**
 * Equality for a filter value against a record value. Two bare numerals compare as numbers, so
 * `?amount=10.25` matches a scale-3 field's canonical `"10.250"` — which is what the SQL stores
 * do, since they compare a decimal filter on the native `NUMERIC` type. Without it, padding a
 * decimal to its declared scale would stop an `eq` filter matching the value a client typed.
 */
function equalsValue(recordValue: unknown, filterValue: string): boolean {
  const text = String(recordValue ?? "");
  if (text === filterValue) return true;
  return compareDecimalText(text, filterValue) === 0;
}

/** Evaluates one typed filter against a record (pure; mirrors the SQL the stores emit). */
export function matchesFilter(record: EntityRecord, filter: ListFilter): boolean {
  const rv = record[filter.field];
  const op = filter.op ?? "eq";
  if (op === "in") {
    const arr = Array.isArray(filter.value) ? filter.value : [filter.value as string];
    return arr.some((v) => equalsValue(rv, v));
  }
  const fv = Array.isArray(filter.value) ? (filter.value[0] ?? "") : (filter.value as string);
  if (op === "eq") return equalsValue(rv, fv);
  if (op === "ne") return !equalsValue(rv, fv);
  if (op === "contains") return String(rv ?? "").toLowerCase().includes(fv.toLowerCase());
  // A missing value satisfies no ordered comparison, which is what the SQL stores do by
  // construction: `document ->> 'f' < $1` evaluates to NULL for an absent key, and NULL is not
  // true. Rendering it `""` made `lt` *match* every row with no value, so the in-memory store
  // returned rows the two Postgres stores filtered out.
  if (isMissing(rv)) return false;
  const cmp = compareValues(rv, coerceLike(fv, rv));
  if (op === "gt") return cmp > 0;
  if (op === "gte") return cmp >= 0;
  if (op === "lt") return cmp < 0;
  return cmp <= 0; // lte
}

/**
 * Narrows a record to `id` + the requested fields (field selection). Always
 * keeps `id` so records stay identifiable; a requested field absent from the
 * record is simply omitted. Projection only narrows — classification redaction
 * still runs at the edge, so a kept-but-classified field is dropped there.
 */
export function projectRecord(record: EntityRecord, fields: readonly string[]): EntityRecord {
  const out: EntityRecord = {};
  if ("id" in record) out["id"] = record["id"];
  for (const f of fields) {
    if (f !== "id" && f in record) out[f] = record[f];
  }
  return out;
}

/**
 * Builds the keyset position of a record under a sort (its sort-field values + id).
 *
 * A missing value renders as `null` rather than `""`, which is the whole of the format widening:
 * an empty string is a value a row legitimately holds, so rendering both the same way left the
 * seek unable to tell a cursor sitting on `""` from one sitting in the NULL tail.
 */
export function keysetOf(row: EntityRecord, sort: readonly ListSort[]): KeysetCursor {
  return {
    k: sort.map((s) => {
      const value = row[s.field];
      return isMissing(value) ? null : String(value);
    }),
    id: String(row["id"] ?? ""),
  };
}

function keyOf(row: EntityRecord, sort: readonly ListSort[]): KeysetCursor {
  return keysetOf(row, sort);
}

/**
 * True when `row` sorts strictly after the keyset `cursor` under the given sort (+ id tiebreaker).
 *
 * The NULL arms mirror `NULLS LAST` exactly, in both directions:
 *
 * - a **null cursor component** puts the cursor in the tail, and nothing sorts after the tail, so a
 *   row with a value is before it and a row without one ties and falls through to the next key;
 * - a **null row value** puts the row in the tail, which is after any non-null cursor component.
 *
 * A component absent altogether (a cursor shorter than the sort, which `encodeKeyset` never
 * produces) reads as null, so a malformed token yields an empty page rather than a silent rewind
 * to the start of the table.
 */
function isAfter(row: EntityRecord, cursor: KeysetCursor, sort: readonly ListSort[]): boolean {
  for (let i = 0; i < sort.length; i += 1) {
    const s = sort[i]!;
    const component = cursor.k[i] ?? null;
    const value = row[s.field];
    if (component === null) {
      if (!isMissing(value)) return false;
      continue;
    }
    if (isMissing(value)) return true;
    const cmp = compareValues(value, coerceLike(component, value));
    const dirCmp = s.direction === "desc" ? -cmp : cmp;
    if (dirCmp !== 0) return dirCmp > 0;
  }
  return String(row["id"] ?? "") > cursor.id;
}

/**
 * Pure filter → sort → **keyset-seek** slice over an in-memory record set. Shared
 * by the in-memory store; the Postgres stores push the same semantics into SQL.
 * Records are totally ordered by the sort fields + an `id` tiebreaker, so the
 * cursor is a stable position (no offset drift on inserts/deletes).
 */
/** Whether a record matches a free-text search: `term` is a substring of ANY listed field. */
export function matchesSearch(record: EntityRecord, search: ListSearch): boolean {
  const needle = search.term.trim().toLowerCase();
  if (needle === "") return true;
  return search.fields.some((f) => String(record[f] ?? "").toLowerCase().includes(needle));
}

export function applyListQuery(records: readonly EntityRecord[], query: ListQuery): ListPage {
  const rows = records.filter(
    (r) =>
      query.filters.every((f) => matchesFilter(r, f)) &&
      (query.search === undefined || matchesSearch(r, query.search)),
  );
  rows.sort((a, b) => {
    for (const s of query.sort) {
      const cmp = orderBy(a[s.field], b[s.field], s.direction);
      if (cmp !== 0) return cmp;
    }
    return compareValues(a["id"], b["id"]);
  });
  const cursor = decodeKeyset(query.cursor);
  let start = 0;
  if (cursor !== null) {
    while (start < rows.length && !isAfter(rows[start]!, cursor, query.sort)) start += 1;
  }
  const slice = rows.slice(start, start + query.limit);
  const hasMore = start + slice.length < rows.length;
  const last = slice[slice.length - 1];
  const nextCursor = hasMore && last !== undefined ? encodeKeyset(keyOf(last, query.sort)) : null;
  return { records: slice, nextCursor };
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `rec_${Date.now().toString(36)}${counter.toString(36).padStart(4, "0")}`;
}

/**
 * In-memory `EntityStore`, keyed by `(tenantId, entity)` — the test/dev binding.
 * The Postgres binding (entity-schema tables under RLS) is the next increment.
 */
export class InMemoryEntityStore implements EntityStore {
  private readonly records: Map<string, Map<string, EntityRecord>> = new Map();

  private bucket(tenantId: string, entity: string): Map<string, EntityRecord> {
    const key = `${tenantId}\u0000${entity}`;
    let b = this.records.get(key);
    if (b === undefined) {
      b = new Map();
      this.records.set(key, b);
    }
    return b;
  }

  async list(tenantId: string, entity: string): Promise<readonly EntityRecord[]> {
    return [...this.bucket(tenantId, entity).values()];
  }

  async listPage(tenantId: string, entity: string, query: ListQuery): Promise<ListPage> {
    return applyListQuery([...this.bucket(tenantId, entity).values()], query);
  }

  async get(tenantId: string, entity: string, id: string): Promise<EntityRecord | null> {
    return this.bucket(tenantId, entity).get(id) ?? null;
  }

  async create(tenantId: string, entity: string, record: EntityRecord): Promise<EntityRecord> {
    const id = typeof record["id"] === "string" ? (record["id"] as string) : nextId();
    const stored: EntityRecord = { ...record, id };
    this.bucket(tenantId, entity).set(id, stored);
    return stored;
  }

  async update(
    tenantId: string,
    entity: string,
    id: string,
    patch: EntityRecord,
  ): Promise<EntityRecord | null> {
    const bucket = this.bucket(tenantId, entity);
    const existing = bucket.get(id);
    if (existing === undefined) return null;
    const merged: EntityRecord = { ...existing, ...patch, id };
    bucket.set(id, merged);
    return merged;
  }

  async remove(tenantId: string, entity: string, id: string): Promise<boolean> {
    return this.bucket(tenantId, entity).delete(id);
  }

  /**
   * Runs `fn` against this store, restoring a snapshot of all records if it
   * throws — giving the in-memory store the same all-or-nothing semantics the
   * Postgres store gets from a real transaction (useful for testing rollback).
   */
  async withTransaction<T>(_tenantId: string, fn: (tx: EntityStore) => Promise<T>): Promise<T> {
    const snapshot = new Map([...this.records].map(([k, v]) => [k, new Map(v)] as const));
    try {
      return await fn(this);
    } catch (e) {
      this.records.clear();
      for (const [k, v] of snapshot) this.records.set(k, v);
      throw e;
    }
  }
}
