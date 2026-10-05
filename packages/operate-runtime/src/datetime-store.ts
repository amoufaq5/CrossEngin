import { resolvedFields } from "@crossengin/kernel/ddl";
import type { Manifest } from "@crossengin/kernel/manifest";

import {
  isTemporalKind,
  toTemporalWire,
  type TemporalKind,
  type TemporalRefusal,
} from "./datetime.js";
import type {
  EntityRecord,
  EntityStore,
  ListPage,
  ListQuery,
  TransactionalEntityStore,
} from "./store.js";

/** `entity → field → temporal kind` for every `date`, `time` and `datetime` field a manifest declares. */
export type TemporalFieldIndex = ReadonlyMap<string, ReadonlyMap<string, TemporalKind>>;

/**
 * Every temporal field in a resolved manifest, keyed by entity.
 *
 * Fields come from the kernel's `resolvedFields` — the same function `validateManifest`, the column
 * plan and `decimalFieldIndexFromManifest` use — so a trait-supplied timestamp is indexed exactly
 * when it is a real served field. That matters more here than for `decimal`: the shipped packs
 * declare **23** `datetime` fields by hand and resolve to **159**, because `auditable` contributes
 * `created_at` and `updated_at` to every entity that carries it. An index built from the declared
 * fields alone would have covered one field in seven.
 */
export function temporalFieldIndexFromManifest(manifest: Manifest): TemporalFieldIndex {
  const out = new Map<string, ReadonlyMap<string, TemporalKind>>();
  const traits = manifest.traits ?? [];
  for (const entity of manifest.entities ?? []) {
    const kinds = new Map<string, TemporalKind>();
    for (const field of resolvedFields(entity, traits)) {
      if (isTemporalKind(field.type.kind)) kinds.set(field.name, field.type.kind);
    }
    if (kinds.size > 0) out.set(entity.name, kinds);
  }
  return out;
}

/** Which side of the store produced a value that cannot be a date, time or instant. */
export const TEMPORAL_WIRE_DIRECTIONS = ["inbound", "stored"] as const;
export type TemporalWireDirection = (typeof TEMPORAL_WIRE_DIRECTIONS)[number];

/**
 * Thrown when a value on a temporal field cannot be one — a word where a timestamp belongs, an
 * impossible calendar date, or an instant with no offset to read it in. It propagates out of the
 * store call, so a handler maps it to 500 and a transactional write rolls back.
 *
 * Raised in **both** directions, with the direction on the error, for `DecimalWireError`'s
 * reasons. `inbound` is a caller handing the store something it must not write, and refusing costs
 * nothing because nothing is lost and the caller is told. `stored` is the database already holding
 * such a value, which refusing makes *unreadable* — the sharper choice, taken because a wire type
 * a consumer can only usually rely on is not one, and because an unreadable row is a finding an
 * operator can act on while a silently mis-ordered page is not.
 */
export class DatetimeWireError extends Error {
  constructor(
    readonly entity: string,
    readonly field: string,
    readonly kind: TemporalKind,
    readonly reason: TemporalRefusal,
    readonly direction: TemporalWireDirection,
  ) {
    super(`${entity}.${field}: ${reason} (${kind}, ${direction})`);
    this.name = "DatetimeWireError";
  }
}

function convert(
  entity: string,
  kinds: ReadonlyMap<string, TemporalKind>,
  record: EntityRecord,
  direction: TemporalWireDirection,
): EntityRecord {
  let out: EntityRecord | null = null;
  for (const [field, kind] of kinds) {
    const value = record[field];
    if (value === undefined || value === null) continue;
    const converted = toTemporalWire(value, kind);
    if (!converted.ok) throw new DatetimeWireError(entity, field, kind, converted.reason, direction);
    if (converted.wire === value) continue;
    out ??= { ...record };
    out[field] = converted.wire;
  }
  return out ?? record;
}

/**
 * Wraps an `EntityStore` so every `date`, `time` and `datetime` field crossing it — in or out, on
 * every operation — carries the canonical wire form.
 *
 * The exact sibling of `withDecimalWireType`, for the same reason: the wire type is a property of
 * the *serving contract*, not of a backend. The JSONB store echoes whatever JSON the write put in
 * its document, so it has no wire type at all, only a memory of what some client sent; the
 * in-memory store echoes the object it was handed; and only the column store has a type, because
 * its value went through a `TIMESTAMPTZ`. Before this the two Postgres stores disagreed about a
 * timestamp's *spelling* before they could disagree about its order — the column store
 * canonicalises through `isoInstant` (ADR-0331) while the JSONB store echoes.
 *
 * Writes are converted too, not only reads, for `withDecimalWireType`'s two reasons: a
 * write-through store returns the record it stored (`ColumnMappedEntityStore.create` echoes its
 * *input*), and the write effects create journal lines directly through the store they are handed,
 * which is this one. That is also what makes the ordering correct by construction rather than by
 * convention — after this, a non-canonical spelling cannot be written at all.
 */
export function withDatetimeWireType<S extends EntityStore>(store: S, index: TemporalFieldIndex): S {
  if (index.size === 0) return store;

  const map = (
    entity: string,
    record: EntityRecord,
    direction: TemporalWireDirection,
  ): EntityRecord => {
    const kinds = index.get(entity);
    return kinds === undefined ? record : convert(entity, kinds, record, direction);
  };

  // `Object.create` rather than a fresh object literal: a store also implements interfaces this
  // decorator knows nothing about — `AssociationReader`/`Writer`/`Counter`, `ensureSchema`,
  // `pruneDanglingLinks` — and the association routes reach for them off the same store.
  const overrides: EntityStore & Partial<TransactionalEntityStore> = {
    async list(tenantId, entity) {
      return (await store.list(tenantId, entity)).map((r) => map(entity, r, "stored"));
    },
    async listPage(tenantId, entity, query: ListQuery): Promise<ListPage> {
      const page = await store.listPage(tenantId, entity, query);
      return {
        records: page.records.map((r) => map(entity, r, "stored")),
        nextCursor: page.nextCursor,
      };
    },
    async get(tenantId, entity, id) {
      const record = await store.get(tenantId, entity, id);
      return record === null ? null : map(entity, record, "stored");
    },
    async create(tenantId, entity, record) {
      const created = await store.create(tenantId, entity, map(entity, record, "inbound"));
      return map(entity, created, "stored");
    },
    async update(tenantId, entity, id, patch) {
      const updated = await store.update(tenantId, entity, id, map(entity, patch, "inbound"));
      return updated === null ? null : map(entity, updated, "stored");
    },
    remove(tenantId, entity, id) {
      return store.remove(tenantId, entity, id);
    },
  };
  const transactional = store as Partial<TransactionalEntityStore>;
  if (typeof transactional.withTransaction === "function") {
    overrides.withTransaction = (tenantId, fn) =>
      transactional.withTransaction!(tenantId, (tx) => fn(withDatetimeWireType(tx, index)));
  }
  return Object.assign(Object.create(store) as S, overrides);
}
