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
 * An expected-value precondition on one field: the stored row must currently
 * hold `value` for `field`, or the write does not happen.
 *
 * `null` means "absent or SQL NULL" — the two are one state as far as a store is
 * concerned, because a record's absent field and a nullable column's NULL both
 * read back as "no value". A precondition is therefore expressible for a row
 * that has never been written to, which is what a counter guard needs: its first
 * increment expects nothing there.
 *
 * Everything else compares **as text**, exactly as a `ListFilter` with `eq`
 * does. A precondition is a guard's own prior read handed back to the store, and
 * a guard reads through `EntityRecord`, where an integer column arrives as a
 * number from the column store and as a JSON number or string from the document
 * store. Comparing as text is the one rule that gives the same answer for all
 * three, and it is the rule the existing filter path already uses.
 */
export interface FieldPrecondition {
  readonly field: string;
  readonly value: string | number | boolean | null;
}

/**
 * What a conditional update did. Three outcomes, kept apart on purpose:
 *
 * - `applied` — every precondition held and the patch was written.
 * - `precondition_failed` — the row exists and at least one precondition did not
 *   hold, so nothing was written. This is the concurrent-writer case.
 * - `not_found` — no such row, so there was nothing to compare against. A caller
 *   that must distinguish "someone else got there first" from "it was never
 *   there" cannot be handed one code for both.
 */
export const CONDITIONAL_UPDATE_OUTCOMES = ["applied", "precondition_failed", "not_found"] as const;
export type ConditionalUpdateOutcome = (typeof CONDITIONAL_UPDATE_OUTCOMES)[number];

/** The result of `updateIf`: the outcome, plus the record when one is available. */
export interface ConditionalUpdateResult {
  readonly outcome: ConditionalUpdateOutcome;
  /**
   * On `applied`, the merged record. On `precondition_failed`, the row as it
   * actually stands — the value that beat the caller's expectation, so a refusal
   * can say what it lost to rather than only that it lost. On `not_found`, null.
   */
  readonly record: EntityRecord | null;
}

/**
 * An `EntityStore` that can write **only if** the row still looks the way the
 * caller last read it: compare-and-set, the missing half of every read-then-write
 * guard built on this contract.
 *
 * Without it a guard reads a row, decides, and writes, and two interleaved
 * requests both pass a check that should admit one — the read is not held
 * against the write by anything. `updateIf` closes that window by moving the
 * decision's evidence into the write's own predicate: the expectations become
 * part of the `UPDATE ... WHERE`, so the loser's write matches no row and is
 * reported rather than silently overwriting the winner's.
 *
 * It is a **separate capability interface**, not a member of `EntityStore`, for
 * the same reason `TransactionalEntityStore` is: every existing implementation
 * (in-process fakes, wrappers, adapters) keeps compiling, and a caller asks with
 * {@link isConditional} and keeps its non-atomic path for a store that cannot.
 * A store that cannot compare-and-set is still correct, just racy — so the
 * narrowing is a capability check, never an assertion.
 */
export interface ConditionalEntityStore extends EntityStore {
  updateIf(
    tenantId: string,
    entity: string,
    id: string,
    patch: EntityRecord,
    expect: readonly FieldPrecondition[],
  ): Promise<ConditionalUpdateResult>;
}

/** Narrows a store to one that supports compare-and-set writes. */
export function isConditional(store: EntityStore): store is ConditionalEntityStore {
  return typeof (store as Partial<ConditionalEntityStore>).updateIf === "function";
}

/**
 * Whether a record satisfies every precondition. The single definition of the
 * comparison, shared by the in-memory store and mirrored by the SQL the Postgres
 * stores emit — so a guard that passes an in-memory test means the same thing
 * against a real table.
 *
 * `null` matches an absent key and a stored `null` alike; anything else compares
 * as text. An empty precondition list vacuously holds, which makes `updateIf`
 * with no expectations behave exactly like `update`.
 */
export function matchesPreconditions(
  record: EntityRecord,
  expect: readonly FieldPrecondition[],
): boolean {
  return expect.every((p) => {
    const actual = record[p.field];
    if (p.value === null) return actual === undefined || actual === null;
    if (actual === undefined || actual === null) return false;
    return String(actual) === String(p.value);
  });
}

/**
 * Builds the precondition that a field is unchanged from what a caller read —
 * the common case, and the one worth having a name for so a guard does not
 * hand-roll the absent-is-null rule.
 *
 * A value the store cannot express as a precondition (an object, an array) reads
 * as `null`, i.e. "expected absent", which would be wrong — so such a value is
 * refused rather than silently weakened. Fail closed: a precondition that
 * quietly means something else is worse than no precondition at all, because the
 * caller believes it has one.
 */
export function expectUnchanged(field: string, read: unknown): FieldPrecondition {
  if (read === undefined || read === null) return { field, value: null };
  if (typeof read === "string" || typeof read === "number" || typeof read === "boolean") {
    return { field, value: read };
  }
  throw new Error(
    `cannot build a precondition on '${field}': a ${typeof read} value is not comparable`,
  );
}

/**
 * The version string a read of this record PUBLISHED — the value a client holding
 * the response can echo back as a precondition — or null when the record carries
 * no version at all.
 *
 * It exists because the stores do not agree on the type. The document store keeps
 * whatever the handler wrote, a string; the column store returns what the driver
 * gives for `TIMESTAMPTZ`, which is a JS `Date`. The guard tested
 * `typeof === "string"` and so, on the column store, never compared anything: a
 * deliberately stale precondition was answered **200**, measured live (ADR-0285).
 *
 * The normalisation is deliberately the SAME lossy step the response body goes
 * through — `JSON.stringify` of a `Date` is its `toISOString()` — so the loss
 * cancels. A row whose `updated_at` carries microseconds (a column default
 * `now()`, never a handler-written ISO string) publishes a millisecond version,
 * and re-reading it publishes that same millisecond version, so an echoed value
 * still compares equal. Comparing in SQL instead would NOT have this property:
 * `timestamptz::text` renders microseconds the published value never had.
 */
export function publishedVersion(record: EntityRecord): string | null {
  const raw = record["updated_at"];
  if (typeof raw === "string") return raw;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.toISOString();
  return null;
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
export class InMemoryEntityStore implements ConditionalEntityStore {
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

  /**
   * Compare-and-set. Single-threaded JavaScript makes this trivially atomic here
   * — nothing can interleave between the check and the set — which is exactly
   * why an in-memory test cannot demonstrate the race the Postgres stores have.
   * What it *can* do is pin the semantics: which outcome each case yields, and
   * that a failed precondition writes nothing.
   */
  async updateIf(
    tenantId: string,
    entity: string,
    id: string,
    patch: EntityRecord,
    expect: readonly FieldPrecondition[],
  ): Promise<ConditionalUpdateResult> {
    const bucket = this.bucket(tenantId, entity);
    const existing = bucket.get(id);
    if (existing === undefined) return { outcome: "not_found", record: null };
    if (!matchesPreconditions(existing, expect)) {
      return { outcome: "precondition_failed", record: existing };
    }
    const merged: EntityRecord = { ...existing, ...patch, id };
    bucket.set(id, merged);
    return { outcome: "applied", record: merged };
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
