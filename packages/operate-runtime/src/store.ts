export type EntityRecord = Record<string, unknown>;

export interface ListSort {
  readonly field: string;
  readonly direction: "asc" | "desc";
}

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

/** A resolved list query: limit + opaque keyset cursor + sort + typed filters. */
export interface ListQuery {
  readonly limit: number;
  readonly cursor: string | null;
  readonly sort: readonly ListSort[];
  readonly filters: readonly ListFilter[];
  /**
   * Optional field-selection hint (the `?fields` projection). A store MAY use it
   * to SELECT fewer columns; the handler still applies the exact projection, so
   * a store that ignores it is correct (just less efficient).
   */
  readonly fields?: readonly string[];
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

/** A keyset position: the previous page's last row — its sort-field values (aligned to `ListQuery.sort`) + id. */
export interface KeysetCursor {
  readonly k: readonly string[];
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
      if (k.every((v) => typeof v === "string")) return parsed as KeysetCursor;
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

function compareValues(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a ?? "").localeCompare(String(b ?? ""));
}

/** Coerces a string filter/cursor value to a number when the sample record value is numeric. */
function coerceLike(value: string, sample: unknown): unknown {
  if (typeof sample === "number") {
    const n = Number(value);
    return Number.isNaN(n) ? value : n;
  }
  return value;
}

/** Evaluates one typed filter against a record (pure; mirrors the SQL the stores emit). */
export function matchesFilter(record: EntityRecord, filter: ListFilter): boolean {
  const rv = record[filter.field];
  const op = filter.op ?? "eq";
  if (op === "in") {
    const arr = Array.isArray(filter.value) ? filter.value : [filter.value as string];
    return arr.some((v) => String(rv ?? "") === v);
  }
  const fv = Array.isArray(filter.value) ? (filter.value[0] ?? "") : (filter.value as string);
  if (op === "eq") return String(rv ?? "") === fv;
  if (op === "ne") return String(rv ?? "") !== fv;
  if (op === "contains") return String(rv ?? "").toLowerCase().includes(fv.toLowerCase());
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

/** Builds the keyset position of a record under a sort (its sort-field values + id). */
export function keysetOf(row: EntityRecord, sort: readonly ListSort[]): KeysetCursor {
  return { k: sort.map((s) => String(row[s.field] ?? "")), id: String(row["id"] ?? "") };
}

function keyOf(row: EntityRecord, sort: readonly ListSort[]): KeysetCursor {
  return keysetOf(row, sort);
}

/** True when `row` sorts strictly after the keyset `cursor` under the given sort (+ id tiebreaker). */
function isAfter(row: EntityRecord, cursor: KeysetCursor, sort: readonly ListSort[]): boolean {
  for (let i = 0; i < sort.length; i += 1) {
    const s = sort[i]!;
    const cmp = compareValues(row[s.field], coerceLike(cursor.k[i] ?? "", row[s.field]));
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
export function applyListQuery(records: readonly EntityRecord[], query: ListQuery): ListPage {
  const rows = records.filter((r) => query.filters.every((f) => matchesFilter(r, f)));
  rows.sort((a, b) => {
    for (const s of query.sort) {
      const cmp = compareValues(a[s.field], b[s.field]);
      if (cmp !== 0) return s.direction === "desc" ? -cmp : cmp;
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
    const key = `${tenantId} ${entity}`;
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
